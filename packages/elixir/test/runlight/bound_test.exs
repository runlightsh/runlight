defmodule Runlight.BoundTest do
  @moduledoc """
  Every value reaches the database as a bound parameter, never as text in a statement: the statements handed to
  the driver are kept (`Runlight.Test.Recording`) while every scenario of conformance/http.json is replayed and
  while marked values are written and read, and none of them holds a value.
  """
  use ExUnit.Case, async: false

  alias Runlight.Accounts
  alias Runlight.Db
  alias Runlight.Http.Request
  alias Runlight.JS
  alias Runlight.Store
  alias Runlight.Test.Conformance
  alias Runlight.Test.Recording
  alias Runlight.Test.Stores

  @moduletag timeout: 900_000

  @chrome "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
  @now 1_791_471_600_000

  # What a statement of Runlight's never holds: the scenarios' names, addresses, tokens, and user agents, and any
  # number as long as a time in milliseconds. The longest number a statement does hold is a lock's id.
  @never ~r/example|conformance|mozilla|\w@\w|marker|\d{9,}/i

  defp recording(kind, url) do
    {store, cleanup} = Stores.store(kind, url)
    on_exit(cleanup)
    Recording.over(store)
  end

  defp offenders, do: for({sql, _} <- Recording.statements(), Regex.match?(@never, sql), uniq: true, do: sql)

  test "the statements written for each database hold a placeholder where each value goes" do
    assert Db.postgres_bound(
             ~s(SELECT "key" FROM t WHERE a = ? AND b = ? AND c IS ? AND d > ? AND e = ? AND f LIKE '%?'),
             [
               "x' OR 1=1 --",
               7,
               nil,
               1.5,
               true
             ]
           ) ==
             {~s(SELECT "key" FROM t WHERE a = $1::text AND b = $2::bigint AND c IS NULL AND d > $3::double precision AND e = $4::boolean AND f LIKE '%?'),
              ["x' OR 1=1 --", 7, 1.5, true]}

    assert Db.mysql_bound(~s(SELECT "key" FROM t WHERE a = ? AND b LIKE ? ESCAPE '\\' AND c = ?), [
             "x\\' OR 1=1 --",
             5,
             nil
           ]) ==
             {"SELECT `key` FROM t WHERE a = ? AND b LIKE ? ESCAPE '\\\\' AND c = ?", ["x\\' OR 1=1 --", 5, nil]}

    assert_raise ArgumentError, fn -> Db.postgres_bound("SELECT ?", []) end
    assert_raise ArgumentError, fn -> Db.mysql_bound("SELECT 1", [1]) end
  end

  for {kind, url} <- Stores.kinds(), not String.ends_with?(Atom.to_string(kind), "+prefix") do
    @kind kind
    @url url

    test "#{kind}: replaying every conformance scenario writes no value into a statement" do
      Recording.start()

      for scenario <- Conformance.scenarios() do
        {store, cleanup} = Stores.store(@kind, @url)

        try do
          answers = Conformance.play(scenario, Recording.over(store))
          assert length(answers) == length(scenario["steps"])
        after
          cleanup.()
        end
      end

      statements = Recording.statements()
      assert length(statements) > 5000
      assert Enum.any?(statements, fn {_, params} -> "example.com" in params end), "the values were bound"
      assert offenders() == []
    end

    test "#{kind}: marked values, salts, and hashes are bound, and a failed statement's error holds none" do
      store = recording(@kind, @url)
      rl = Runlight.new(store: store, site: [hostnames: ["example.com"], timezone: "UTC"], now: fn -> @now end)
      Runlight.init(rl)
      Recording.start()

      Runlight.collect(
        rl,
        Request.new("https://example.com/runlight/e",
          method: "POST",
          headers: [{"user-agent", @chrome}],
          body:
            JS.stringify(
              JS.obj(
                k: "event",
                u: "https://example.com/marker-path?utm_source=marker-utm",
                r: "https://marker-referrer.test/",
                n: "marker-event",
                p: JS.obj("marker-key": "marker-value' OR 1=1 --")
              )
            ),
          remote_address: "203.0.113.9"
        )
      )

      acc = Accounts.new(rl, String.duplicate("s", 64))
      user = Accounts.set_password(acc, "marker@example.com", "marker password", @now)
      Store.set_setting(rl.store, "marker-setting", "marker\\' value")
      assert Store.setting(rl.store, "marker-setting") == "marker\\' value"

      query = %{
        site: "default",
        from: @now - 3_600_000,
        to: @now + 3_600_000,
        filters: [%{dimension: "page", op: "contains", value: "marker-path"}]
      }

      assert [key] = Store.event_prop_keys(rl.store, query, "marker-event")
      assert key["key"] == "marker-key"
      assert [value] = Store.event_prop_values(rl.store, query, "marker-event", "marker-key", 10)
      assert value["value"] == "marker-value' OR 1=1 --"
      assert [_] = Store.breakdown(rl.store, query, "event", 10, 0)

      [salt] = Store.all_rows(rl.store, "SELECT salt FROM rl_salts", [])
      [visit] = Store.all_rows(rl.store, "SELECT visitor FROM rl_sessions", [])
      secrets = [salt["salt"], visit["visitor"], user["hash"]]

      statements = Recording.statements()
      bound = statements |> Enum.flat_map(&elem(&1, 1)) |> Enum.filter(&is_binary/1)
      for secret <- secrets, do: assert(secret in bound, "#{secret} was bound")
      assert Enum.any?(bound, &(&1 =~ "marker-value"))
      for {sql, _} <- statements, secret <- secrets, do: refute(sql =~ secret)
      assert offenders() == []

      error =
        try do
          Db.run(rl.store.db, "INSERT INTO rl_no_such_table (a) VALUES (?)", ["a-marker-value"])
          nil
        rescue
          error -> error
        end

      assert Exception.message(error) =~ "rl_no_such_table"
      refute Exception.message(error) =~ "a-marker-value"
    end
  end
end
