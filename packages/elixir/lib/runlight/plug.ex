if Code.ensure_loaded?(Plug.Conn) do
  defmodule Runlight.Plug do
    @moduledoc """
    The dashboard, its API, and the tracker as a Plug: the SDK's
    `rl.routes()`, the same answers byte for byte, so the dashboard, the MCP
    server, and every port's tools work against an Elixir app as they do
    against a Node one.

    In Phoenix, forward to it outside the `:browser` pipeline (the routes have
    their own cross-site checks, and Phoenix's CSRF plug would refuse the
    tracker's posts):

        # lib/my_app_web/router.ex
        scope "/" do
          forward "/runlight", Runlight.Plug
        end

    and in a `Plug.Router` the same way. The base path is where the router
    mounted it. Options are `Runlight.Routes`'s, plus `:instance`, the
    instance's name (default `Runlight`). Phoenix calls `init/1` when the
    router compiles, so nothing is read there: the token and the instance are
    read on the first request.

    A request on a link domain added in Settings, such as go.example.com, is
    answered with its redirect or a 404 before anything else, as every one of
    these Plugs does; on every other host the request carries on.

    The connection's own address is passed on for the visitor's daily hash
    when no trusted proxy header names the client (see the instance's
    `:trust_proxy`).

    A Phoenix endpoint's `Plug.Parsers` reads form and JSON bodies before the
    router forwards here. Those reach the routes as the client sent them, a
    form as a form and JSON as JSON, rebuilt from what the parsers made of
    them. To hand on the exact bytes instead, give the parsers this module's
    reader:

        plug Plug.Parsers,
          parsers: [:urlencoded, :multipart, :json],
          json_decoder: Phoenix.json_library(),
          body_reader: {Runlight.Plug, :body_reader, []}

    The tracker sends each visit as JSON when it posts to the app's own site,
    so the parsers read those too, and they are counted the same either way.
    A body that claims to be JSON and is not gets the parsers' own 400 rather
    than Runlight's 202; the tracker never sends one.
    """

    @behaviour Plug

    alias Runlight.Http.Request
    alias Runlight.Http.Response
    alias Runlight.State

    require Logger

    # The tracker's posts are under 8 KB; everything else, such as a link import of 5,000 rows, under 10 MB.
    @max_collect 16 * 1024
    @max_body 10 * 1024 * 1024
    # Methods no route or link answers, so a request with one is the app's.
    @unsupported ["TRACE", "TRACK", "CONNECT"]

    @impl Plug
    def init(opts) when is_list(opts), do: opts

    @impl Plug
    def call(%Plug.Conn{} = conn, opts) do
      case running(opts) do
        nil -> not_running(conn)
        rl -> serve(conn, rl, opts)
      end
    end

    @doc false
    # The instance the options name, or nil while none is running: before its process has started, or while it
    # is being started again.
    def running(opts) do
      Runlight.instance(Keyword.get(opts, :instance, Runlight))
    rescue
      ArgumentError -> nil
    end

    defp not_running(conn) do
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.put_resp_header("retry-after", "5")
      |> Plug.Conn.send_resp(
        503,
        ~s({"error":"Runlight is not running. Start {Runlight, opts} in your supervision tree.","code":"not_running"})
      )
      |> Plug.Conn.halt()
    end

    defp serve(conn, rl, opts) do
      base = Keyword.get(opts, :base_path) || mount(conn)
      routes_opts = opts |> Keyword.delete(:instance) |> Keyword.put(:base_path, base)
      routes = routes(rl, routes_opts)

      case link_domain(conn, rl) do
        {:answered, conn} ->
          conn

        {:pass, conn} ->
          case request(conn, if(String.ends_with?(conn.request_path, "/e"), do: @max_collect, else: @max_body)) do
            {:ok, request, conn} -> answer(conn, Runlight.Routes.handle(routes, request))
            {:too_large, conn} -> too_large(conn)
            {:broken, reason, conn} -> broken(conn, reason)
          end
      end
    end

    @doc false
    # A request on a link domain answered with its redirect or a 404, or the connection untouched for every other
    # host. The body is never read here, so whatever comes next still can. Nor does anything that goes wrong here
    # stop the request: it carries on as it would on any other host.
    def link_domain(%Plug.Conn{method: method} = conn, _rl) when method in @unsupported, do: {:pass, conn}

    def link_domain(conn, rl) do
      {:ok, request, _} = request(%{conn | body_params: %{}, method: "GET"}, 0)

      found =
        try do
          Runlight.link_domain_response(rl, %{request | method: conn.method, body: ""})
        rescue
          error ->
            Logger.error("Runlight: could not look for a link domain: #{Exception.message(error)}")
            nil
        end

      case found do
        nil -> {:pass, conn}
        response -> {:answered, answer(conn, response)}
      end
    end

    # The routes are made once per instance and options, so their state (a development secret, caches) holds.
    defp routes(rl, opts) do
      key = {:plug_routes, :erlang.phash2(opts)}

      case State.get(rl.table, key) do
        nil ->
          State.one_at_a_time(rl.table, key, fn ->
            State.get(rl.table, key) || State.put(rl.table, key, Runlight.routes(rl, opts))
          end)

        routes ->
          routes
      end
    end

    defp mount(%Plug.Conn{script_name: []}), do: "/runlight"
    defp mount(%Plug.Conn{script_name: parts}), do: "/" <> Enum.join(parts, "/")

    @doc false
    # The request as the routes read it: the URL as sent, the headers, the body (up to `limit`), and the
    # connection's address.
    def request(conn, limit) do
      headers =
        if List.keymember?(conn.req_headers, "host", 0),
          do: conn.req_headers,
          else: conn.req_headers ++ [{"host", authority(conn)}]

      proto = scheme(conn)
      host = Enum.find_value(headers, "localhost", fn {k, v} -> if k == "host", do: v end)
      query = if conn.query_string == "", do: "", else: "?" <> conn.query_string

      url = address(proto, host, conn.request_path <> query)

      case read_body(conn, limit) do
        {:ok, body, conn} ->
          address = remote_address(conn)

          {:ok,
           %Request{
             url: url,
             method: conn.method,
             headers: headers,
             body: body,
             remote_address: address,
             ref: make_ref()
           }, conn}

        other ->
          other
      end
    end

    # The request's address, or the same path on localhost when the Host header makes no address at all (a port
    # past 65535, say), where the Node adapter falls back to localhost too. The host comes from the Host header
    # alone: the path is written after it, so one starting // or /\ stays a path and never names a host of its own.
    @doc false
    def address(proto, host, target) do
      # A Host that is empty, or holds what ends a host, would have the path or a name after an @ read as the host.
      named = host != "" and not String.contains?(host, ["/", "\\", "?", "#", "@"])
      url = "#{proto}://#{host}#{target}"
      fallback = "#{proto}://localhost#{target}"

      cond do
        named and Runlight.Url.parse(url) != nil -> url
        Runlight.Url.parse(fallback) != nil -> fallback
        true -> "http://localhost/"
      end
    end

    # The address the connection came from, or "" when it has none, as over a Unix socket, where a proxy on this
    # computer is what connects.
    @doc false
    def remote_address(conn) do
      case conn.remote_ip do
        ip when is_tuple(ip) and tuple_size(ip) in [4, 8] ->
          case :inet.ntoa(ip) do
            {:error, _} -> ""
            text -> to_string(text)
          end

        _ ->
          ""
      end
    end

    # The first x-forwarded-proto of http or https, as the Node adapter honours it, else the connection's own.
    @doc false
    def scheme(conn) do
      forwarded =
        conn.req_headers
        |> Enum.find_value("", fn {k, v} -> if k == "x-forwarded-proto", do: v end)
        |> String.split(",")
        |> hd()
        |> String.trim()
        |> String.downcase()

      cond do
        forwarded in ["http", "https"] -> forwarded
        conn.scheme == :https -> "https"
        true -> "http"
      end
    end

    defp authority(%{scheme: :http, port: 80} = conn), do: conn.host
    defp authority(%{scheme: :https, port: 443} = conn), do: conn.host
    defp authority(conn), do: "#{conn.host}:#{conn.port}"

    defp read_body(conn, limit) do
      if conn.method in ["GET", "HEAD"] do
        {:ok, "", conn}
      else
        case {conn.private[:runlight_body], conn.body_params} do
          # The bytes body_reader/2 kept while Plug.Parsers read them.
          {chunks, _} when is_list(chunks) ->
            within(IO.iodata_to_binary(Enum.reverse(chunks)), limit, conn)

          # A body a Phoenix endpoint's Plug.Parsers already read, rebuilt as the client sent it.
          {_, %{} = params} when map_size(params) > 0 and not is_struct(params) ->
            within(parsed_body(conn, params), limit, conn)

          _ ->
            read_all(conn, limit, [])
        end
      end
    end

    defp within(body, limit, conn) when byte_size(body) > limit, do: {:too_large, conn}
    defp within(body, _limit, conn), do: {:ok, body, conn}

    # JSON as JSON (a top-level array or scalar under "_json", where Plug.Parsers puts it), and a form, or anything
    # else the parsers read, as a form.
    defp parsed_body(conn, params) do
      type = conn |> Plug.Conn.get_req_header("content-type") |> List.first("") |> String.downcase()

      cond do
        not Regex.match?(~r/^application\/([^;]+\+)?json\s*(;|$)/, type) -> Plug.Conn.Query.encode(fields(params))
        Map.keys(params) == ["_json"] -> Runlight.JS.stringify(params["_json"])
        true -> Runlight.JS.stringify(params)
      end
    end

    # A form's fields without its uploaded files, which nothing here reads and a query string cannot hold.
    defp fields(%{} = params) when not is_struct(params) do
      for {key, value} <- params, not is_struct(value), into: %{}, do: {key, fields(value)}
    end

    defp fields(list) when is_list(list), do: list |> Enum.reject(&is_struct/1) |> Enum.map(&fields/1)
    defp fields(value), do: value

    defp read_all(conn, limit, acc) do
      case Plug.Conn.read_body(conn, length: limit) do
        {:ok, chunk, conn} -> {:ok, IO.iodata_to_binary(Enum.reverse([chunk | acc])), conn}
        {:more, _chunk, conn} -> {:too_large, conn}
        {:error, reason} -> {:broken, reason, conn}
      end
    end

    @doc """
    A `body_reader` for `Plug.Parsers` that keeps the bytes it reads, so a
    body the parsers have already read reaches the routes byte for byte.
    """
    @spec body_reader(Plug.Conn.t(), keyword()) ::
            {:ok, binary(), Plug.Conn.t()} | {:more, binary(), Plug.Conn.t()} | {:error, term()}
    def body_reader(conn, opts) do
      case Plug.Conn.read_body(conn, opts) do
        {status, chunk, conn} when status in [:ok, :more] ->
          {status, chunk, Plug.Conn.put_private(conn, :runlight_body, [chunk | conn.private[:runlight_body] || []])}

        error ->
          error
      end
    end

    # A body that broke off part way is never taken for the whole request: too slow is a 408, anything else a 400.
    defp broken(conn, reason) do
      {status, message} =
        if reason == :timeout,
          do: {408, "That request took too long to arrive"},
          else: {400, "That request was cut off"}

      conn
      |> Plug.Conn.put_resp_header("connection", "close")
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(status, ~s({"error":"#{message}"}))
      |> Plug.Conn.halt()
    end

    defp too_large(conn) do
      conn
      |> Plug.Conn.put_resp_header("connection", "close")
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(413, ~s({"error":"That request is too large"}))
      |> Plug.Conn.halt()
    end

    @doc false
    def answer(conn, %Response{} = response) do
      # Plug starts every answer with a cache-control of its own; the SDK's is set in its place, or none.
      conn = Plug.Conn.delete_resp_header(conn, "cache-control")

      conn =
        Enum.reduce(response.headers, conn, fn
          {"set-cookie", value}, conn -> %{conn | resp_headers: conn.resp_headers ++ [{"set-cookie", value}]}
          {name, value}, conn -> Plug.Conn.put_resp_header(conn, name, value)
        end)

      conn
      |> Plug.Conn.send_resp(response.status, response.body)
      |> Plug.Conn.halt()
    end
  end

  defmodule Runlight.Plug.Links do
    @moduledoc """
    Short links on the app's own domain: forward the instance's link path
    (default "/go") here, and `/go/{slug}` redirects to the link's
    destination, with the click recorded. A request on a link domain is
    answered as that domain's links first, so `/go/{slug}` there is a 404.

        forward "/go", Runlight.Plug.Links

    A slug no link has is the app's to answer. Forwarded from a Phoenix
    router, that raises `Phoenix.Router.NoRouteError`, so the app's own 404
    page shows; from a plain `Plug.Router`, which has no such page to hand
    it to, it is answered with a 404.

    Anywhere else, such as an endpoint or a pipeline ahead of the routes, it
    is middleware: it answers link domains and a GET for `/go/{slug}` when
    the link exists, and every other request, an unknown slug too, carries
    on to the app untouched.

        plug Runlight.Plug.Links
    """
    @behaviour Plug

    require Logger

    @impl Plug
    def init(opts), do: opts

    @impl Plug
    def call(conn, opts) do
      case Runlight.Plug.running(opts) do
        # No instance yet, so no links to follow: the request is the app's.
        nil ->
          conn

        rl ->
          case Runlight.Plug.link_domain(conn, rl) do
            {:answered, conn} ->
              conn

            {:pass, conn} ->
              if routed?(conn, rl), do: route(conn, rl), else: middleware(conn, rl)
          end
      end
    end

    # A router forwarded the link path here (it moved onto the script name), so every request is this Plug's.
    defp routed?(conn, rl),
      do: conn.script_name != [] and String.ends_with?("/" <> Enum.join(conn.script_name, "/"), rl.link_path)

    defp route(conn, rl) do
      case follow(conn, rl, conn.method) do
        %{status: 404} = missing ->
          case conn.private do
            %{phoenix_router: router} ->
              # Named at run time, since Phoenix is the app's dependency and not Runlight's.
              no_route = Module.concat([Phoenix, Router, NoRouteError])

              if Code.ensure_loaded?(no_route),
                do: raise(no_route, conn: conn, router: router),
                else: Runlight.Plug.answer(conn, missing)

            _ ->
              Runlight.Plug.answer(conn, missing)
          end

        found ->
          Runlight.Plug.answer(conn, found)
      end
    end

    defp middleware(conn, rl) do
      if conn.method == "GET" and own?(conn.request_path, rl.link_path) do
        # A link that cannot be looked up is no reason to stop the app's own answer.
        found =
          try do
            follow(conn, rl, "GET")
          rescue
            error ->
              Logger.error("Runlight: could not look for a short link: #{Exception.message(error)}")
              nil
          end

        case found do
          nil -> conn
          %{status: 404} -> conn
          found -> Runlight.Plug.answer(conn, found)
        end
      else
        conn
      end
    end

    defp own?(path, link_path), do: Regex.match?(~r/\A#{Regex.escape(link_path)}\/[^\/]+\/?\z/, path)

    # A short link reads no body, so none is read.
    defp follow(conn, rl, method) do
      {:ok, request, _} = Runlight.Plug.request(%{conn | method: "GET"}, 0)
      Runlight.link_handler(rl, %{request | method: method})
    end
  end

  defmodule Runlight.Plug.LinkDomains do
    @moduledoc """
    For an endpoint (before the router): a request on a link domain added in
    Settings, such as go.example.com, is answered with its redirect or a 404;
    every other request carries on.

        plug Runlight.Plug.LinkDomains
    """
    @behaviour Plug

    @impl Plug
    def init(opts), do: opts

    @impl Plug
    def call(conn, opts) do
      case Runlight.Plug.running(opts) do
        nil -> conn
        rl -> conn |> Runlight.Plug.link_domain(rl) |> elem(1)
      end
    end
  end

  defmodule Runlight.Plug.Observer do
    @moduledoc """
    Records page requests from known AI agents, which run no JavaScript, so
    the tracker cannot see them. Put it in a pipeline. It answers a request on
    a link domain with its redirect or a 404 and never stops any other
    request.

        plug Runlight.Plug.Observer
    """
    @behaviour Plug

    @impl Plug
    def init(opts), do: opts

    @impl Plug
    def call(conn, opts) do
      case Runlight.Plug.running(opts) do
        nil ->
          conn

        rl ->
          case Runlight.Plug.link_domain(conn, rl) do
            {:answered, conn} -> conn
            {:pass, %Plug.Conn{method: "GET"} = conn} -> observe(conn, rl)
            {:pass, conn} -> conn
          end
      end
    end

    defp observe(conn, rl) do
      host = Enum.find_value(conn.req_headers, conn.host, fn {k, v} -> if k == "host", do: v end)
      query = if conn.query_string == "", do: "", else: "?" <> conn.query_string
      url = Runlight.Plug.address(Runlight.Plug.scheme(conn), host, conn.request_path <> query)

      address = Runlight.Plug.remote_address(conn)

      Runlight.observe(rl, %Runlight.Http.Request{
        url: url,
        method: "GET",
        headers: conn.req_headers,
        remote_address: address,
        ref: make_ref()
      })

      conn
    end
  end
end
