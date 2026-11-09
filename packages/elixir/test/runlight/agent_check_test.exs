defmodule Runlight.AgentCheckTest do
  @moduledoc """
  AI agents' addresses checked against the lists their companies publish, as the SDK's agentcheck.test.ts and the
  verification and refresh tests in ingest.test.ts check them. Downloads go through a fake fetcher, never the
  network.
  """
  use ExUnit.Case, async: false

  import Bitwise

  alias Runlight.AgentCheck
  alias Runlight.Assets
  alias Runlight.Data.Agents
  alias Runlight.Db
  alias Runlight.Http.Request
  alias Runlight.Http.Response
  alias Runlight.JS
  alias Runlight.Test.FakeFetcher
  alias Runlight.Test.Stores

  @moduletag timeout: 300_000

  @gptbot "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)"
  @meta "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)"

  defp agent(name), do: Enum.find(Agents.all(), &(&1.name == name))

  defp entries(list), do: Enum.map(list, &if(&1 =~ ":", do: JS.obj(ipv6Prefix: &1), else: JS.obj(ipv4Prefix: &1)))

  test "addresses: IPv4, IPv6, IPv4 written as IPv6, brackets and zones, and junk" do
    assert AgentCheck.parse_address("20.171.206.17") == {4, 0x14ABCE11}
    assert AgentCheck.parse_address(" ::ffff:20.171.206.17 ") == {4, 0x14ABCE11}
    assert AgentCheck.parse_address("::ffff:14ab:ce11") == {4, 0x14ABCE11}
    assert AgentCheck.parse_address("[2600:1f28:365:8000::1]") == {6, 0x26001F2803658000 <<< 64 ||| 1}
    assert AgentCheck.parse_address("fe80::1%eth0") == {6, 0xFE80 <<< 112 ||| 1}
    assert AgentCheck.parse_address("::") == {6, 0}

    for junk <-
          ~w(unknown 256.1.1.1 1.2.3 1.2.3.4.5 01.2.3.4x 1::2::3 12345:: :1:: 1:2:3:4:5:6:7:8:9 ::ffff:1.2.3.256 -) ++
            [""] do
      assert AgentCheck.parse_address(junk) == nil, junk
    end
  end

  test "ranges: prefixes of any length, both families, and host bits past the length ignored" do
    list = ["20.171.206.0/24", "34.162.230.222/32", "10.1.2.3/8", "2600:1f28:365:8000::/56", "0.0.0.0/0"]
    at = fn i -> [Enum.at(list, i)] end
    assert AgentCheck.in_ranges?("20.171.206.255", at.(0))
    refute AgentCheck.in_ranges?("20.171.207.0", at.(0))
    assert AgentCheck.in_ranges?("34.162.230.222", at.(1))
    refute AgentCheck.in_ranges?("34.162.230.223", at.(1))
    assert AgentCheck.in_ranges?("10.200.0.1", at.(2)), "10.1.2.3/8 covers all of 10/8"
    assert AgentCheck.in_ranges?("2600:1f28:365:80ff:ffff::1", at.(3))
    refute AgentCheck.in_ranges?("2600:1f28:365:8100::1", at.(3))
    refute AgentCheck.in_ranges?("20.171.206.1", at.(3)), "an IPv4 address is never in an IPv6 prefix"
    assert AgentCheck.in_ranges?("203.0.113.9", at.(4)), "/0 covers every IPv4 address"
    refute AgentCheck.in_ranges?("not an address", list)
  end

  test "published lists: the shape every company uses, and anything else refused whole" do
    assert AgentCheck.read_range_list(
             JS.parse!(
               ~s({"creationTime":"x","prefixes":[{"ipv4Prefix":"20.171.206.0/24"},{"ipv6Prefix":" 2600:1f28::/56 "}]})
             )
           ) == ["20.171.206.0/24", "2600:1f28::/56"]

    for bad <- [
          "null",
          "[]",
          ~s("x"),
          "{}",
          ~s({"prefixes":[]}),
          ~s({"prefixes":"1.2.3.0/24"}),
          ~s({"prefixes":[{"ipv4Prefix":"1.2.3.0"}]}),
          ~s({"prefixes":[{"ipv4Prefix":"1.2.3.0/33"}]}),
          ~s({"prefixes":[{"ipv4Prefix":"2600::/56"}]}),
          ~s({"prefixes":[{"ipv6Prefix":"1.2.3.0/24"}]}),
          ~s({"prefixes":[{"ipv4Prefix":"1.2.3.0/24"},{"other":"x"}]})
        ] do
      assert AgentCheck.read_range_list(JS.parse!(bad)) == nil, bad
    end

    assert AgentCheck.read_range_list(JS.obj(prefixes: List.duplicate(JS.obj(ipv4Prefix: "1.2.3.0/24"), 20_001))) ==
             nil
  end

  test "an agent checks out, does not, or has nothing to check against" do
    gptbot = agent("GPTBot")
    meta = agent("meta-externalagent")
    lists = Assets.agent_range_lists()
    assert AgentCheck.check_agent(gptbot, "20.171.206.17", lists) == "verified"
    assert AgentCheck.check_agent(gptbot, "198.51.100.23", lists) == "mismatch"
    assert AgentCheck.check_agent(gptbot, "", lists) == "", "no address"
    assert AgentCheck.check_agent(gptbot, "garbage", lists) == ""
    assert AgentCheck.check_agent(meta, "157.240.0.1", lists) == "", "Meta publishes no list"

    assert AgentCheck.check_agent(gptbot, "20.171.206.17", %{}) == "",
           "a list that is missing is nothing to check against"
  end

  test "every agent with a list has it bundled, and every bundled list is read whole" do
    lists = Assets.agent_range_lists()
    for agent <- Agents.all(), agent[:ranges], do: assert(lists[agent.ranges] not in [nil, []], agent.name)

    for {url, list} <- lists do
      assert AgentCheck.read_range_list(JS.obj(prefixes: entries(list))) == list, url
    end

    assert Enum.sort(Assets.agent_range_urls()) == Enum.sort(Map.keys(lists))
  end

  defp harness(kind, url, opts \\ []) do
    {store, cleanup} = Stores.store(kind, url)
    on_exit(cleanup)
    rl = Runlight.new(Keyword.merge([store: store, site: [hostnames: ["example.com"], timezone: "UTC"]], opts))
    Runlight.init(rl)
    rl
  end

  defp observe(rl, ua, ip \\ nil, opts \\ []) do
    headers = [{"user-agent", ua}, {"host", "example.com"}] ++ if(ip, do: [{"x-forwarded-for", ip}], else: [])
    Runlight.observe(rl, Request.new("https://example.com/post", headers: headers), nil, opts)
  end

  defp agents(rl) do
    routes = Runlight.routes(rl, token: "secret")

    request =
      Request.new("https://example.com/runlight/api/breakdown?period=today&dimension=ai_agent",
        headers: [{"authorization", "Bearer secret"}]
      )

    response = Runlight.Routes.handle(routes, request)
    assert response.status == 200
    response |> Response.text() |> Jason.decode!() |> Map.fetch!("rows")
  end

  defp titles(rl) do
    rl.store.db
    |> Db.all("SELECT title FROM rl_events WHERE kind = 'fetch'", [])
    |> Enum.map(& &1["title"])
    |> Enum.sort()
  end

  for {kind, url} <- Stores.kinds() do
    @kind kind
    @url url

    test "#{kind}: an AI agent's address is checked against its company's list, and only the answer is kept" do
      rl = harness(@kind, @url)
      # In OpenAI's published GPTBot list.
      assert observe(rl, @gptbot, "20.171.206.17")
      assert observe(rl, @gptbot, "20.171.206.18")
      # Says GPTBot, comes from elsewhere.
      assert observe(rl, @gptbot, "198.51.100.23")
      # No address to check.
      assert observe(rl, @gptbot)
      # Meta publishes no list.
      assert observe(rl, @meta, "157.240.0.1")
      # A log reader's or plugin's report names the agent's address itself; it never stands in for the reporter's.
      assert observe(rl, @gptbot, "198.51.100.40", agent_ip: "20.171.206.99")

      assert agents(rl) == [
               %{"value" => "GPTBot", "visitors" => 0, "fetches" => 3, "claimed" => false},
               %{"value" => "GPTBot", "visitors" => 0, "fetches" => 2, "claimed" => true},
               %{"value" => "meta-externalagent", "visitors" => 0, "fetches" => 1, "claimed" => true}
             ]

      assert titles(rl) == ["", "", "mismatch", "verified", "verified", "verified"]
      dump = inspect(Db.all(rl.store.db, "SELECT * FROM rl_events", []), limit: :infinity, printable_limit: :infinity)

      for ip <- ["20.171.206.17", "198.51.100.23", "157.240.0.1", "198.51.100.40", "20.171.206.99"],
          do: refute(dump =~ ip, "no address: #{ip}")
    end
  end

  test "a report to /api/observe is checked from the address it names, never the reporter's" do
    rl = harness(:sqlite, nil)
    routes = Runlight.routes(rl, token: "secret")

    post = fn body ->
      Runlight.Routes.handle(
        routes,
        Request.new("https://example.com/runlight/api/observe",
          method: "POST",
          headers: [
            {"authorization", "Bearer secret"},
            {"content-type", "application/json"},
            {"x-forwarded-for", "20.171.206.17"}
          ],
          remote_address: "20.171.206.17",
          body: Jason.encode!(body)
        )
      )
    end

    page = %{url: "https://example.com/post", userAgent: @gptbot}
    assert post.(page).status == 204
    assert post.(Map.put(page, :ip, 351_391_249)).status == 204
    assert post.(Map.put(page, :ip, " [::ffff:20.171.206.11] ")).status == 204
    assert post.(Map.put(page, :ip, "198.51.100.23")).status == 204
    assert titles(rl) == ["", "", "mismatch", "verified"]
  end

  defp clock(start) do
    c = :counters.new(1, [])
    :counters.put(c, 1, start)
    {c, fn -> :counters.get(c, 1) end}
  end

  defp advance(c, ms), do: :counters.add(c, 1, ms)

  test "update_agent_ranges downloads the lists once a day, keeps a good copy over a bad download, and shares it through the database" do
    {c, now} = clock(JS.date_parse("2026-11-08T12:00:00Z"))
    {:ok, answer} = Agent.start_link(fn -> ~s({"prefixes":[{"ipv4Prefix":"192.0.2.0/24"}]}) end)

    {fetcher, sent} =
      FakeFetcher.new(fn _url, _opts ->
        {:ok, Response.new(Agent.get(answer, & &1), 200, [{"content-type", "application/json"}])}
      end)

    asked = fn -> sent |> FakeFetcher.requests() |> Enum.map(& &1["url"]) end
    rl = harness(:sqlite, nil, update_agent_ranges: true, now: now, fetcher: fetcher)

    Runlight.check(rl)
    assert "https://openai.com/gptbot.json" in asked.()
    first_round = length(asked.())
    assert first_round == length(Assets.agent_range_urls())

    [request | _] = FakeFetcher.requests(sent)
    assert request["headers"]["user-agent"] == "Runlight (+https://runlight.sh)"
    [opts | _] = FakeFetcher.inits(sent)
    assert opts[:redirect] == :follow and opts[:timeout] == 15_000 and opts[:max_bytes] == 4_000_000

    # In the downloaded list.
    assert observe(rl, @gptbot, "192.0.2.7")
    # In the bundled list only, which the download replaced.
    assert observe(rl, @gptbot, "20.171.206.17")
    advance(c, 3_600_000)
    Runlight.check(rl)
    assert length(asked.()) == first_round, "not again within the day"

    advance(c, 86_400_000)
    Agent.update(answer, fn _ -> "<html>maintenance</html>" end)
    Runlight.check(rl)
    assert length(asked.()) == first_round * 2, "a day later it tries again"
    # The bad download kept the good copy.
    assert observe(rl, @gptbot, "192.0.2.8")

    # Another process sharing the database uses the lists without downloading them.
    other = Runlight.new(store: rl.store, site: [hostnames: ["example.com"]], now: now, fetcher: fetcher)
    Runlight.check(other)
    assert length(asked.()) == first_round * 2
    assert observe(other, @gptbot, "192.0.2.9")

    assert titles(rl) == ["mismatch", "verified", "verified", "verified"]
    saved = JS.parse!(Runlight.Store.setting(rl.store, "agent-ranges"))
    assert saved["at"] == now.(), "the failed day is saved too, so it is not tried again until the next"
    assert saved["lists"]["https://openai.com/gptbot.json"] == ["192.0.2.0/24"]
  end

  test "a download that fails, is too long, or is not a list keeps what there was, and never fails the check" do
    {_c, now} = clock(JS.date_parse("2026-11-08T12:00:00Z"))

    {fetcher, _sent} =
      FakeFetcher.new(fn url, _opts ->
        cond do
          url =~ "gptbot" -> {:error, :timeout}
          url =~ "searchbot" -> {:error, :too_long}
          url =~ "claude" -> {:ok, Response.new(~s({"prefixes":[{"ipv4Prefix":"192.0.2.0/24"}]}), 404, [])}
          url =~ "chatgpt" -> {:ok, Response.new("{}", 200, [{"content-length", "4000001"}])}
          true -> raise "unreachable"
        end
      end)

    rl = harness(:sqlite, nil, update_agent_ranges: true, now: now, fetcher: fetcher)
    assert Runlight.check(rl)["ok"] == true
    assert observe(rl, @gptbot, "20.171.206.17")
    assert titles(rl) == ["verified"]
    assert JS.parse!(Runlight.Store.setting(rl.store, "agent-ranges"))["lists"] |> JS.Object.size() == 0
  end

  test "without update_agent_ranges, Runlight never downloads the lists" do
    {fetcher, sent} = FakeFetcher.new(fn _url, _opts -> {:ok, Response.new("{}", 200, [])} end)
    rl = harness(:sqlite, nil, fetcher: fetcher)
    Runlight.check(rl)
    assert FakeFetcher.requests(sent) == []
    assert Runlight.Store.setting(rl.store, "agent-ranges") == nil
  end
end
