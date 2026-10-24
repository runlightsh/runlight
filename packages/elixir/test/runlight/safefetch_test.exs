defmodule Runlight.SafefetchTest do
  @moduledoc "Ports safefetch.test.ts, replays the address and icon checks in outbound.json, and covers the icon's fetches."
  use ExUnit.Case, async: true

  alias Runlight.Http.Response
  alias Runlight.Icon
  alias Runlight.JS
  alias Runlight.Safefetch
  alias Runlight.Test.FakeFetcher
  alias Runlight.Test.Fixtures
  alias Runlight.Test.Stores

  defp instance(fetcher, now \\ 1_791_471_600_000) do
    {store, cleanup} = Stores.store(:sqlite)
    on_exit(cleanup)
    clock = :counters.new(1, [])
    :counters.put(clock, 1, now)
    {Runlight.new(store: store, fetcher: fetcher, now: fn -> :counters.get(clock, 1) end), clock}
  end

  test "link-local and cloud metadata addresses are told apart from loopback and private ones" do
    for ip <- [
          "169.254.169.254",
          "169.254.0.1",
          "100.100.100.200",
          "fe80::1",
          "fe80::a9fe:a9fe",
          "fd00:ec2::254",
          "::ffff:169.254.169.254",
          "::ffff:a9fe:a9fe",
          "64:ff9b::a9fe:a9fe",
          "::ffff:0:a9fe:a9fe"
        ],
        do: assert(Safefetch.metadata_address?(ip), ip)

    for ip <- [
          "127.0.0.1",
          "::1",
          "10.0.0.5",
          "192.168.1.20",
          "fd00::1",
          "fd00:ec2::253",
          "93.184.215.14",
          "not an address"
        ],
        do: refute(Safefetch.metadata_address?(ip), ip)

    assert Safefetch.metadata_host?("metadata.google.internal")
    assert Safefetch.metadata_host?("[fd00:ec2::254]")
    assert Safefetch.metadata_host?("169.254.169.254")
    refute Safefetch.metadata_host?("localhost"), "a model on this computer is fine"
    refute Safefetch.metadata_host?("192.168.1.20")
  end

  test "only addresses on the public internet count as public" do
    for ip <- [
          "93.184.215.14",
          "1.1.1.1",
          "2606:4700:4700::1111",
          "2a00:1450:4001:82a::200e",
          "::ffff:0:808:808",
          "64:ff9b::808:808"
        ],
        do: assert(Safefetch.public_address?(ip), ip)

    for ip <- [
          "127.0.0.1",
          "10.0.0.1",
          "172.16.5.4",
          "192.168.1.1",
          "169.254.169.254",
          "100.64.0.1",
          "0.0.0.0",
          "224.0.0.1",
          "255.255.255.255",
          "::1",
          "::",
          "fe80::1",
          "fd00::1",
          "ff02::1",
          "::ffff:127.0.0.1",
          "::ffff:7f00:1",
          "::ffff:169.254.169.254",
          "64:ff9b::a00:1",
          "2002:a00:1::",
          "2001:db8::1",
          "2001:0:4136:e378::1",
          "[::1]",
          "not an address",
          "1.2.3",
          "1.2.3.256",
          # IPv4-translated loopback, local-use NAT64, the old site-local, ORCHID, the newer documentation prefix, and
          # discard.
          "::ffff:0:7f00:1",
          "64:ff9b:1::7f00:1",
          "fec0::1",
          "2001:20::1",
          "3fff::1",
          "100::1"
        ],
        do: refute(Safefetch.public_address?(ip), ip)

    for c <- Fixtures.php("outbound.json")["ips"],
        do: assert(Safefetch.public_address?(c["ip"]) == c["public"], c["ip"])
  end

  test "a public fetch never reaches the install's own network however the address is written" do
    {fetcher, agent} = FakeFetcher.new(fn _, _ -> {:ok, Response.new("ok")} end)
    {rl, _} = instance(fetcher)

    for url <- [
          "http://127.0.0.1:1/",
          "https://127.0.0.1:1/",
          "https://[::1]:1/",
          "https://[::ffff:127.0.0.1]:1/",
          "https://localhost:1/",
          "https://LOCALHOST.:1/",
          "https://app.localhost:1/",
          "https://10.0.0.1/"
        ] do
      assert Safefetch.public_fetch(rl, url, timeout: 2000) in [{:error, :private}], url
    end

    assert FakeFetcher.requests(agent) == []
    assert Safefetch.resolves_privately?("localhost")
    refute Safefetch.resolves_privately?("name.that.does.not.resolve.invalid")
    assert Safefetch.public_addresses("name.that.does.not.resolve.invalid") == []
    assert Safefetch.public_addresses("8.8.8.8") == ["8.8.8.8"]
    assert Safefetch.public_addresses("localhost") == []
  end

  test "redirects are followed by hand under the same rules" do
    {:ok, answers} = Agent.start_link(fn -> [] end)

    hops = fn list ->
      Agent.update(answers, fn _ -> list end)

      FakeFetcher.new(fn _, _ ->
        {:ok,
         Agent.get_and_update(answers, fn
           [a | rest] -> {a, rest}
           [] -> {Response.new("end"), []}
         end)}
      end)
    end

    redirect = fn to, status -> Response.new(nil, status, [{"location", to}]) end

    {fetcher, agent} = hops.([redirect.("/next", 301), redirect.("https://1.1.1.1/last", 302), Response.new("done")])
    {rl, _} = instance(fetcher)
    {:ok, answer} = Safefetch.public_fetch(rl, "https://93.184.215.14/", timeout: 2000, redirects: 3)
    assert answer.body == "done"

    assert Enum.map(FakeFetcher.requests(agent), & &1["url"]) == [
             "https://93.184.215.14/",
             "https://93.184.215.14/next",
             "https://1.1.1.1/last"
           ]

    assert Enum.all?(FakeFetcher.inits(agent), &(&1[:redirect] == :manual))

    {fetcher, _} = hops.([redirect.("https://1.1.1.1/", 302)])
    {rl, _} = instance(fetcher)
    assert {:ok, %{status: 302}} = Safefetch.public_fetch(rl, "https://93.184.215.14/", timeout: 2000)

    for location <- ["https://10.0.0.1/", "http://1.1.1.1/", "https://[fe80::1]/", "https://localhost/"] do
      {fetcher, _} = hops.([redirect.(location, 302)])
      {rl, _} = instance(fetcher)

      assert Safefetch.public_fetch(rl, "https://93.184.215.14/", timeout: 2000, redirects: 3) == {:error, :private},
             location
    end
  end

  test "the default fetcher connects only to an address it checked" do
    # Refused before any connection: the name is resolved and checked where the connection is made.
    assert Runlight.Fetch.httpc("https://localhost:1/", public: true) == {:error, :private}
    assert Runlight.Fetch.httpc("https://127.0.0.1:1/", public: true) == {:error, :private}
    assert Runlight.Fetch.httpc("https://name.that.does.not.resolve.invalid/", public: true) == {:error, :nxdomain}
    assert Safefetch.checked_address("localhost") == {:error, :private}
    assert Safefetch.checked_address("8.8.8.8") == {:ok, "8.8.8.8"}

    {fetcher, agent} = FakeFetcher.new(fn _, _ -> {:ok, Response.new("ok")} end)
    {rl, _} = instance(fetcher)
    {:ok, _} = Safefetch.public_fetch(rl, "https://1.1.1.1/", timeout: 2000)
    assert hd(FakeFetcher.inits(agent))[:public] == true
  end

  # A server on this machine that answers every request with `head` and then a body without end.
  defp endless(head, chunked) do
    {:ok, listen} = :gen_tcp.listen(0, [:binary, active: false, reuseaddr: true, ip: {127, 0, 0, 1}])
    {:ok, port} = :inet.port(listen)
    part = :binary.copy("x", 65_536)
    part = if chunked, do: "10000\r\n" <> part <> "\r\n", else: part

    serve = fn serve ->
      case :gen_tcp.accept(listen) do
        {:ok, socket} ->
          spawn(fn ->
            {:ok, _} = :gen_tcp.recv(socket, 0, 5000)
            :ok = :gen_tcp.send(socket, head)
            Stream.repeatedly(fn -> :gen_tcp.send(socket, part) end) |> Enum.find(&(&1 != :ok))
          end)

          serve.(serve)

        {:error, _} ->
          :ok
      end
    end

    server = spawn(fn -> serve.(serve) end)
    :ok = :gen_tcp.controlling_process(listen, server)

    on_exit(fn ->
      :gen_tcp.close(listen)
      Process.exit(server, :kill)
    end)

    "http://127.0.0.1:#{port}/"
  end

  test "the default fetcher stops reading past max_bytes whatever the status" do
    for {head, chunked} <- [
          {"HTTP/1.1 500 Internal Server Error\r\nconnection: close\r\n\r\n", false},
          {"HTTP/1.1 404 Not Found\r\ntransfer-encoding: chunked\r\n\r\n", true},
          {"HTTP/1.1 503 Service Unavailable\r\ncontent-length: 100000000000\r\n\r\n", false},
          {"HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n", false}
        ],
        truncate <- [false, true] do
      url = endless(head, chunked)
      started = System.monotonic_time(:millisecond)
      answer = Runlight.Fetch.httpc(url, max_bytes: 100_000, truncate: truncate, timeout: 20_000)
      took = System.monotonic_time(:millisecond) - started
      assert took < 10_000, "#{head} took #{took}ms"

      case answer do
        {:error, :too_long} -> :ok
        {:ok, %Response{body: body}} -> assert truncate and byte_size(body) <= 100_000, head
        other -> flunk("#{inspect(head)} answered #{inspect(other)}")
      end
    end
  end

  test "an install is fetched only on the public internet with no redirect, or on this machine when code allows it" do
    {fetcher, agent} =
      FakeFetcher.new(fn _, _ -> {:ok, Response.new(nil, 302, [{"location", "https://1.1.1.1/x"}])} end)

    {rl, _} = instance(fetcher)
    local = "http://127.0.0.1:4100/runlight/api/sites"

    for url <- [
          "https://10.0.0.1/api/sites",
          "https://169.254.169.254/",
          "http://1.1.1.1/",
          "https://localhost/",
          local
        ],
        do: assert(Safefetch.install_fetch(rl, url, timeout: 2000) == {:error, :private}, url)

    assert FakeFetcher.requests(agent) == []
    refute Safefetch.install_address?(local, false)
    assert Safefetch.install_address?(local, true)
    assert Safefetch.install_address?("https://stats.example.com", false)

    {:ok, %{status: 302}} = Safefetch.install_fetch(rl, "https://1.1.1.1/api/sites", timeout: 2000)

    {:ok, %{status: 302}} =
      Safefetch.install_fetch(rl, "https://1.1.1.1/api/token", method: "POST", body: "{}", timeout: 2000)

    {:ok, %{status: 302}} = Safefetch.install_fetch(%{rl | local_installs: true}, local, timeout: 2000)
    [get, post, here] = FakeFetcher.inits(agent)
    assert get[:public] == true
    assert {post[:method], post[:body], post[:public]} == {"POST", "{}", true}
    assert here[:redirect] == :manual and here[:public] == nil
    assert length(FakeFetcher.requests(agent)) == 3
  end

  test "only a GET follows a redirect" do
    {fetcher, agent} =
      FakeFetcher.new(fn _, _ -> {:ok, Response.new(nil, 302, [{"location", "https://1.1.1.1/x"}])} end)

    {rl, _} = instance(fetcher)
    {:ok, %{status: 302}} = Safefetch.public_fetch(rl, "https://1.1.1.1/", method: "POST", redirects: 3, timeout: 2000)
    assert length(FakeFetcher.requests(agent)) == 1
  end

  test "running out of time says so" do
    {fetcher, _} = FakeFetcher.new(fn _, _ -> {:error, :timeout} end)
    {rl, _} = instance(fetcher)
    assert Safefetch.public_fetch(rl, "https://1.1.1.1/", timeout: 2000) == {:error, :timeout}
    {fetcher, _} = FakeFetcher.new(fn _, _ -> {:error, :econnrefused} end)
    {rl, _} = instance(fetcher)
    assert Safefetch.public_fetch(rl, "https://1.1.1.1/", timeout: 2000) == {:error, :econnrefused}
  end

  test "icon links match TypeScript" do
    for c <- Fixtures.php("outbound.json")["icons"],
        do: assert(Icon.icon_links(c["html"], c["base"]) == c["links"], c["html"])
  end

  test "the best linked icon is fetched with its caps, and cached for a day" do
    {fetcher, agent} =
      FakeFetcher.new(fn url, _ ->
        {:ok,
         case url do
           "https://93.184.215.14/" ->
             Response.new(~s(<link rel="apple-touch-icon" href="/touch.png"><link rel="icon" href="/i.svg">), 200, [
               {"content-type", "text/html; charset=utf-8"}
             ])

           "https://93.184.215.14/touch.png" ->
             Response.new("<html>", 200, [{"content-type", "text/html"}])

           "https://93.184.215.14/i.svg" ->
             Response.new("<svg/>", 200, [{"content-type", "Image/SVG+xml; charset=utf-8"}])

           _ ->
             Response.new("", 404)
         end}
      end)

    {rl, clock} = instance(fetcher)
    icon = Icon.fetch_icon(rl, "https://93.184.215.14")
    assert icon == %{body: "<svg/>", type: "image/svg+xml"}

    requests = FakeFetcher.requests(agent)

    assert Enum.map(requests, & &1["url"]) == [
             "https://93.184.215.14/",
             "https://93.184.215.14/touch.png",
             "https://93.184.215.14/i.svg"
           ]

    assert hd(requests)["headers"]["user-agent"] == "Runlight (+https://runlight.sh)"
    [first, second | _] = FakeFetcher.inits(agent)
    assert {first[:max_bytes], first[:truncate]} == {200_000, true}
    assert {second[:max_bytes], second[:truncate]} == {262_144, nil}
    assert first[:timeout] <= 4000

    :counters.add(clock, 1, 86_399_000)
    assert Icon.fetch_icon(rl, "https://93.184.215.14") == icon
    assert length(FakeFetcher.requests(agent)) == 3
    :counters.add(clock, 1, 1000)
    Icon.fetch_icon(rl, "https://93.184.215.14")
    assert length(FakeFetcher.requests(agent)) == 6
  end

  test "the favicon is the fallback, no icon is remembered for an hour, and a private origin is never fetched" do
    {fetcher, agent} =
      FakeFetcher.new(fn url, _ ->
        {:ok,
         if(url == "https://1.1.1.1/favicon.ico",
           do: Response.new("", 200, [{"content-type", "image/x-icon"}]),
           else: Response.new("nope", 500)
         )}
      end)

    {rl, clock} = instance(fetcher)
    assert Icon.fetch_icon(rl, "https://1.1.1.1") == nil
    assert Enum.map(FakeFetcher.requests(agent), & &1["url"]) == ["https://1.1.1.1/", "https://1.1.1.1/favicon.ico"]
    :counters.add(clock, 1, 3_599_000)
    assert Icon.fetch_icon(rl, "https://1.1.1.1") == nil
    assert length(FakeFetcher.requests(agent)) == 2
    :counters.add(clock, 1, 1000)
    Icon.fetch_icon(rl, "https://1.1.1.1")
    assert length(FakeFetcher.requests(agent)) == 4

    {fetcher, agent} = FakeFetcher.new(fn _, _ -> {:ok, Response.new("x", 200, [{"content-type", "image/png"}])} end)
    {rl, _} = instance(fetcher)
    assert Icon.fetch_icon(rl, "https://192.168.1.1") == nil
    assert FakeFetcher.requests(agent) == []
  end

  # A service someone set up, standing in for a local server: each path answers with a status and where it goes.
  defp service(routes) do
    FakeFetcher.new(fn url, _ ->
      case Map.get(routes, url) do
        {status, location} -> {:ok, Response.new("", status, [{"location", location}])}
        nil -> {:ok, Response.new("ok", 200)}
      end
    end)
  end

  test "a service fetch checks every redirect's address, and refuses a link-local or metadata one before asking it" do
    for {to, host} <- [
          {"http://169.254.169.254/latest", "169.254.169.254"},
          {"http://[fd00:ec2::254]/", "fd00:ec2::254"}
        ] do
      {fetcher, agent} = service(%{"http://127.0.0.1:8080/hook" => {302, to}})
      opts = [method: "POST", headers: [{"content-type", "application/json"}], body: "{}", timeout: 5_000]
      assert Safefetch.service_fetch(fetcher, "http://127.0.0.1:8080/hook", opts) == {:error, {:address_refused, host}}
      assert Enum.map(FakeFetcher.requests(agent), & &1["url"]) == ["http://127.0.0.1:8080/hook"], "nothing asked there"
    end

    {fetcher, agent} = service(%{})

    assert Safefetch.service_fetch(fetcher, "http://169.254.169.254/", timeout: 5_000) ==
             {:error, {:address_refused, "169.254.169.254"}}

    assert FakeFetcher.requests(agent) == []
  end

  test "a service fetch follows a redirect as fetch does, and stops after the last one" do
    sent = [
      method: "POST",
      headers: [{"content-type", "application/json"}, {"authorization", "Bearer k"}, {"cookie", "a=1"}],
      body: ~s({"a":1}),
      timeout: 5_000
    ]

    # A 303 goes on as a GET with no body and nothing that describes one, and keeps the credentials on the same origin.
    {fetcher, agent} = service(%{"http://127.0.0.1:8080/a" => {303, "/b"}})
    assert {:ok, %Response{status: 200}} = Safefetch.service_fetch(fetcher, "http://127.0.0.1:8080/a", sent)
    [_, second] = FakeFetcher.requests(agent)
    assert {second["method"], second["url"], second["body"]} == {"GET", "http://127.0.0.1:8080/b", ""}
    assert second["headers"] == JS.obj(authorization: "Bearer k", cookie: "a=1")
    assert Keyword.get(List.last(FakeFetcher.inits(agent)), :redirect) == :manual

    # A 307 keeps the method and the body.
    {fetcher, agent} = service(%{"http://127.0.0.1:8080/a" => {307, "/b"}})
    assert {:ok, _} = Safefetch.service_fetch(fetcher, "http://127.0.0.1:8080/a", sent)
    [_, second] = FakeFetcher.requests(agent)
    assert {second["method"], second["body"]} == {"POST", ~s({"a":1})}
    assert second["headers"]["content-type"] == "application/json"

    # A loop stops after five redirects, and the last answer comes back as it is.
    {fetcher, agent} = service(%{"http://127.0.0.1:8080/loop" => {302, "/loop"}})

    assert {:ok, %Response{status: 302}} =
             Safefetch.service_fetch(fetcher, "http://127.0.0.1:8080/loop", timeout: 5_000)

    assert length(FakeFetcher.requests(agent)) == 6
  end

  test "a service's redirect to another origin is refused before anything is sent there" do
    keys = [
      {"authorization", "Bearer k"},
      {"proxy-authorization", "Basic k"},
      {"cookie", "a=1"},
      {"x-api-key", "k"},
      {"api-key", "k"},
      {"x-postmark-server-token", "k"}
    ]

    for {from, status, to, refused} <- [
          {"http://127.0.0.1:8080/a", 307, "http://localhost:8080/b", "http://localhost:8080"},
          {"http://127.0.0.1:8080/a", 308, "http://127.0.0.1:9090/b", "http://127.0.0.1:9090"},
          {"https://api.example.com/a", 307, "http://198.51.100.7/b", "http://198.51.100.7"},
          {"https://api.example.com/a", 308, "http://api.example.com/b", "http://api.example.com"},
          {"https://api.example.com/a", 302, "ftp://files.example.com/b", "ftp:"}
        ] do
      {fetcher, agent} = service(%{from => {status, to}})

      sent = [method: "POST", headers: [{"content-type", "application/json"} | keys], body: ~s({"a":1}), timeout: 5_000]
      host = Runlight.Url.host(Runlight.Url.new(from))

      assert Safefetch.service_fetch(fetcher, from, sent) == {:error, {:redirect_refused, host, refused}}
      assert [_] = FakeFetcher.requests(agent), "nothing asked at #{to}"
    end

    # A metadata address named by the redirect is still refused as one.
    {fetcher, _} = service(%{"https://api.example.com/a" => {307, "http://169.254.169.254/b"}})

    assert Safefetch.service_fetch(fetcher, "https://api.example.com/a", timeout: 5_000) ==
             {:error, {:address_refused, "169.254.169.254"}}
  end

  test "the assistant and mail services say a redirect was refused" do
    {fetcher, agent} = service(%{"https://api.anthropic.com/v1/models?limit=100" => {307, "http://198.51.100.7/v1"}})
    {rl, _} = instance(fetcher)

    error =
      assert_raise Runlight.AssistantError, fn ->
        Runlight.Assistant.list_models(rl, JS.obj(provider: "anthropic", baseUrl: "", key: "sk-secret"))
      end

    assert {error.code, error.params} ==
             {"redirect_refused", [{"host", "api.anthropic.com"}, {"to", "http://198.51.100.7"}]}

    assert length(FakeFetcher.requests(agent)) == 1

    {fetcher, agent} = service(%{"https://api.postmarkapp.com/email" => {307, "http://198.51.100.7/email"}})
    message = %{to: "a@example.com", from: "r@example.com", subject: "Hi", html: "<p>Hi</p>", text: "Hi", headers: []}

    error =
      assert_raise Runlight.MailError, fn ->
        Runlight.Mail.deliver(fetcher, JS.obj(service: "postmark", serverToken: "pm-secret"), message)
      end

    assert {error.code, error.params} ==
             {"redirect_refused", [{"host", "api.postmarkapp.com"}, {"to", "http://198.51.100.7"}]}

    assert length(FakeFetcher.requests(agent)) == 1
  end

  test "a service is fetched from the address its name was checked at" do
    {:ok, listener} = :gen_tcp.listen(0, [:binary, active: false, reuseaddr: true, ip: {127, 0, 0, 1}])
    {:ok, port} = :inet.port(listener)
    me = self()

    spawn_link(fn ->
      {:ok, socket} = :gen_tcp.accept(listener, 5_000)
      {:ok, request} = :gen_tcp.recv(socket, 0, 5_000)
      send(me, {:asked, request})
      :ok = :gen_tcp.send(socket, "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
      :gen_tcp.close(socket)
    end)

    # A name on this computer is allowed, and the connection goes to the address checked, with the name as Host.
    assert {:ok, %Response{status: 200, body: "ok"}} =
             Runlight.Fetch.httpc("http://localhost:#{port}/hook", service: true, timeout: 5_000)

    assert_receive {:asked, request}
    assert request =~ ~r/host: localhost:#{port}/i
    :gen_tcp.close(listener)

    # A name that cannot be looked up fails the connection, and a name with a metadata address is refused.
    assert Runlight.Fetch.httpc("http://no-such-host.invalid/", service: true, timeout: 5_000) == {:error, :nxdomain}
    assert Safefetch.service_address("localhost") |> elem(0) == :ok
    assert Safefetch.service_address("no-such-host.invalid") == {:error, :nxdomain}

    # The profile has no proxy of its own to look a name up again.
    assert Runlight.Fetch.profile(true) == :runlight_public
  end

  test "the assistant's list of models and a mail webhook refuse a redirect to a metadata address" do
    {fetcher, _} = service(%{"http://127.0.0.1:11434/v1/models" => {302, "http://169.254.169.254/latest"}})
    {rl, _} = instance(fetcher)

    error =
      assert_raise Runlight.AssistantError, fn ->
        Runlight.Assistant.list_models(rl, JS.obj(provider: "custom", baseUrl: "http://127.0.0.1:11434/v1", key: ""))
      end

    assert {error.code, error.params} == {"address_refused", [{"host", "169.254.169.254"}]}

    assert error.message ==
             "169.254.169.254 is a link-local or cloud metadata address, which Runlight never connects to"

    {fetcher, _} = service(%{"http://127.0.0.1:8080/hook" => {307, "http://[fd00:ec2::254]/hook"}})
    message = %{to: "a@example.com", from: "r@example.com", subject: "Hi", html: "<p>Hi</p>", text: "Hi", headers: []}

    error =
      assert_raise Runlight.MailError, fn ->
        Runlight.Mail.deliver(fetcher, JS.obj(service: "webhook", url: "http://127.0.0.1:8080/hook"), message)
      end

    assert {error.code, error.params} == {"address_refused", [{"host", "fd00:ec2::254"}]}
  end

  test "a public fetch goes through an httpc profile of its own, which has no proxy" do
    # A proxy, such as one an app sets on httpc's default profile, would look the name up again itself.
    assert Runlight.Fetch.profile(false) == :default
    assert Runlight.Fetch.profile(true) == :runlight_public

    assert :httpc.get_options([:proxy, :https_proxy], :runlight_public) ==
             {:ok, [proxy: {:undefined, []}, https_proxy: {:undefined, []}]}
  end
end
