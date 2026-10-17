defmodule Runlight.SpeedTest do
  @moduledoc "The SDK's speed fixes: planner statistics kept fresh, and goals read from daily rollups (hardening.test.ts and rollups.test.ts)."
  use ExUnit.Case, async: false

  alias Runlight.Http.Request
  alias Runlight.JS
  alias Runlight.Store
  alias Runlight.Test.Stores
  alias Runlight.Time

  @moduletag timeout: 300_000

  defp at(iso), do: JS.date_parse(iso)

  defp harness(kind, url, now) do
    {store, cleanup} = Stores.store(kind, url)
    on_exit(cleanup)
    clock = :counters.new(1, [])
    :counters.put(clock, 1, now)

    rl =
      Runlight.new(
        store: store,
        site: [hostnames: ["example.com"], timezone: "UTC"],
        now: fn -> :counters.get(clock, 1) end
      )

    Runlight.init(rl)
    {rl, clock}
  end

  defp statistics_events(rl) do
    case Store.all_rows(rl.store, ~s(SELECT value FROM rl_meta WHERE "key" = 'statistics_events'), []) do
      [] -> nil
      [row] -> row["value"]
    end
  end

  defp add_events(rl, from, count, ts) do
    Store.transaction(rl.store, fn store ->
      for i <- from..(from + count - 1) do
        Store.insert_event(store, %{
          site: "default",
          ts: ts,
          kind: "pageview",
          visitor: "v",
          session: "s",
          pageview: "p#{i}",
          path: "/",
          hostname: "example.com",
          title: "",
          name: "",
          props: nil,
          engaged_ms: 0,
          scroll: nil,
          link: ""
        })
      end
    end)
  end

  for {kind, url} <- Stores.kinds() do
    @kind kind
    @url url

    test "#{kind}: planner statistics gathered on an empty database are gathered again once the events outgrow them" do
      {rl, clock} = harness(@kind, @url, at("2026-03-01T12:00:00Z"))
      now = at("2026-03-01T12:00:00Z")

      if @kind in [:sqlite, :"sqlite+prefix"] do
        Store.optimize(rl.store, true)
        assert statistics_events(rl) == "0", "gathered while empty, and noted"

        add_events(rl, 1, 1500, now)
        Store.optimize(rl.store, true)
        assert statistics_events(rl) == "1500", "gathered again once the events grew"

        [stat] = Store.all_rows(rl.store, "SELECT stat FROM sqlite_stat1 WHERE idx = 'rl_events_site_ts'", [])
        # A sample, so an estimate of the 1,500 rather than an exact count.
        assert stat["stat"] |> String.split(" ") |> hd() |> String.to_integer() > 1000

        add_events(rl, 1501, 100, now)
        Store.optimize(rl.store, true)
        assert statistics_events(rl) == "1500", "not again until they double"

        # An app that never runs the scheduled check gets them from its reports, at most hourly.
        add_events(rl, 1601, 1600, now)
        :counters.put(clock, 1, now + 7_200_000)
        Runlight.freshen_statistics(rl)
        assert statistics_events(rl) == "3200", "once for the doubled events"
        add_events(rl, 3201, 4000, now)
        Runlight.freshen_statistics(rl)
        assert statistics_events(rl) == "3200", "not again within the hour"
      else
        Store.optimize(rl.store, true)
        Runlight.freshen_statistics(rl)
        assert statistics_events(rl) == nil, "only SQLite needs this"
      end
    end

    test "#{kind}: goals by a whole path or a name come from the rollups and add up as every visit does" do
      {rl, clock} = harness(@kind, @url, at("2026-03-01T12:00:00Z"))

      hit = fn body, ip ->
        Runlight.collect(
          rl,
          Request.new("https://example.com/runlight/e",
            method: "POST",
            headers: [
              {"user-agent",
               "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"},
              {"x-forwarded-for", ip},
              {"content-type", "text/plain;charset=UTF-8"}
            ],
            body: JS.stringify(body)
          )
        )
      end

      for {day, n} <- [{"2026-03-01", 1}, {"2026-03-02", 2}, {"2026-03-03", 3}, {"2026-03-09", 4}] do
        :counters.put(clock, 1, at("#{day}T12:00:00Z"))

        for v <- 1..n do
          ip = "203.0.113.#{v}"
          hit.(JS.obj(k: "pageview", u: "https://example.com/pricing"), ip)
          hit.(JS.obj(k: "pageview", u: "https://example.com/blog/#{v}"), ip)
          hit.(JS.obj(k: "event", u: "https://example.com/pricing", n: "Signup", p: JS.obj(amount: 5 * v)), ip)
        end
      end

      goal = fn id, kind, match, mode, value ->
        JS.obj(
          id: String.duplicate(id, 24),
          site: "default",
          name: "Goal #{id}",
          kind: kind,
          match: match,
          clickBy: "",
          valueMode: mode,
          value: value,
          valueProp: if(mode == "prop", do: "amount", else: ""),
          currency: "USD",
          createdAt: 0
        )
      end

      goals = [
        goal.("a", "page", "/pricing", "none", 0),
        goal.("b", "page", "/blog/*", "none", 0),
        goal.("c", "event", "Signup", "fixed", 9.99),
        goal.("d", "event", "Signup", "prop", 0),
        goal.("e", "click", "Signup", "none", 0)
      ]

      goals = Enum.map(goals, &if(&1["kind"] == "click", do: Map.put(&1, "name", "Signup"), else: &1))
      for g <- goals, do: Store.save_goal(rl.store, g)

      :counters.put(clock, 1, at("2026-03-10T12:00:00Z"))
      build_all = fn f -> if Runlight.build_rollups(rl) > 0, do: f.(f), else: :ok end
      build_all.(build_all)

      query = %{
        site: "default",
        from: Time.start_of("2026-03-01", "UTC"),
        to: Time.start_of("2026-03-11", "UTC"),
        filters: []
      }

      rolled = Store.goal_totals_all(rl.store, query, goals)
      assert rolled[hd(goals)["id"]]["conversions"] == 10, "the pricing views of every day, rolled and raw"
      assert rolled[Enum.at(goals, 2)["id"]]["revenue"] == 99.9

      assert Store.visitors(rl.store, query) == Store.stats(rl.store, query)["visitors"]

      Store.clear_rollups(rl.store, "default")
      assert Store.goal_totals_all(rl.store, query, goals) == rolled, "the same as when every visit is read"
      assert Store.goal_totals_all(rl.store, query, []) == Runlight.JS.Object.new()
    end
  end
end
