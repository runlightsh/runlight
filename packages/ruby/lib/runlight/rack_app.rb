# frozen_string_literal: true

module Runlight
  # Runlight as a Rack app, or as Rack middleware in front of an app, answering
  # in the order the standalone server answers: a link domain added in Settings
  # first (it leaves the dashboard's own paths alone), then `{linkPath}/{slug}`
  # on the app's own domain, then the dashboard and API under the routes' base
  # path. As middleware, every other request goes on to the app, a short link
  # with no link by that name included, so the app's own 404 page answers it,
  # after AI agent fetches among them are recorded (observe), which returns at
  # once for everyone else. Alone, Runlight answers those with its own 404.
  #
  #   # config.ru, Runlight alone
  #   run Runlight::RackApp.new(runlight: RL, base_path: "/runlight")
  #
  #   # in front of an app (Sinatra, Hanami, Roda, or any Rack app)
  #   use Runlight::RackApp, runlight: RL, base_path: "/runlight"
  #
  # The routes' options (base_path, token, accounts, origin, and the rest) are
  # passed through. Once the answer is sent, the work TS does after answering (a
  # retention change's deletions) runs in the Core's idle.
  class RackApp
    INTERNAL = Json.encode({ "error" => "Internal error", "code" => "internal" })
    TOO_LARGE = Json.encode({ "error" => "That request is too large" })
    private_constant :INTERNAL, :TOO_LARGE

    attr_reader :runlight

    # app: the app behind, when used as middleware. runlight: a Runlight::Core, or a callable that returns one
    # (so an app can build it after boot). observe: whether to record AI agent fetches of the app's pages.
    def initialize(app = nil, runlight:, observe: true, **route_options)
      @app = app
      @runlight = runlight
      @observe = observe
      @route_options = route_options
      @lock = Mutex.new
      @warming = nil
      @warm_failed_at = nil
    end

    def core
      @core ||= @runlight.respond_to?(:routes) ? @runlight : @runlight.call
    end

    def routes
      @routes || @lock.synchronize { @routes ||= core.routes(@route_options) }
    end

    def call(env)
      # A request the app behind will answer keeps its body for the app; Runlight reads only its headers.
      path = "#{env["SCRIPT_NAME"]}#{env["PATH_INFO"]}"
      begin
        request = Http::Request.from_rack(env, read_body: @app.nil? || mine?(path))
      rescue Http::Request::TooLarge
        # The rest is never read, so the connection is not fit for another request.
        return [413, { "content-type" => "application/json; charset=utf-8", "connection" => "close" }, [TOO_LARGE]]
      rescue StandardError => e
        raise if @app.nil?

        # Whatever Runlight cannot read, the app behind still answers.
        warn "Runlight: #{e.message}"
        return @app.call(env)
      end
      response = answer(request)
      if response.nil?
        observe(request) if @observe && request.method == "GET"
        return @app.call(env)
      end
      status, headers, body = response.to_rack
      body = request.method == "HEAD" ? [] : body
      [status, headers, Body.new(body, -> { idle })]
    end

    # The answer to one request, or nil when it is not Runlight's and an app sits behind.
    #
    # The app's own requests never wait on Runlight: until Runlight has made its tables they go straight to
    # the app while init runs beside them (a link domain is known only once it has), and anything that goes
    # wrong in Runlight is logged and the request still reaches the app.
    def answer(request)
      context = { "ip" => request.remote_address }
      path = Http::Url.parse(request.url)&.pathname || "/"
      link_path = core.link_path
      link = request.method == "GET" && path.match?(%r{\A#{Regexp.escape(link_path)}/[^/]+/?\z})
      # The discovery documents OAuth clients read at the site's root are answered too, as under the base path.
      own = @app.nil? || mine?(path) || link || Routes.oauth_document?(path)
      if own || ready?
        linked = core.link_domain_response(request, context)
        return linked unless linked.nil?
      end
      if link
        linked = core.link_handler.call(request, context)
        # A slug with no link is the app's to answer, so its own 404 page shows.
        return linked unless @app && linked.status == 404

        own = mine?(path) || Routes.oauth_document?(path)
      end
      return routes.handle(request) if own

      nil
    rescue StandardError => e
      warn "Runlight: #{e.message}"
      return nil if @app && !own

      Http::Response.new(INTERNAL, status: 500, headers: {
                           "content-type" => "application/json; charset=utf-8",
                           "cache-control" => "no-store",
                           "x-content-type-options" => "nosniff",
                         })
    end

    private

    # Whether Runlight has made its tables. Until it has, an app's request starts init beside it, once at a
    # time, and again no sooner than a minute after one that failed.
    def ready?
      return true unless core.respond_to?(:ready?)
      return true if core.ready?

      @lock.synchronize do
        return false if @warming&.alive?
        return false if @warm_failed_at && monotonic - @warm_failed_at < 60

        @warming = Thread.new do
          core.init
        rescue StandardError => e
          @warm_failed_at = monotonic
          warn "Runlight: could not get ready #{e.message}"
        end
      end
      false
    end

    # AI agent fetches are recorded once Runlight is ready, and never hold up or break the page.
    def observe(request)
      core.observe(request) if ready?
    rescue StandardError => e
      warn "Runlight: #{e.message}"
    end

    def monotonic
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end

    def idle
      core.idle if core.respond_to?(:idle)
    rescue StandardError => e
      warn "Runlight: #{e.message}"
    end

    # Whether a path is under the routes' base path, which the dashboard, the API, and the tracker share.
    def mine?(path)
      base = Options.normalize(@route_options)["basePath"] || "/runlight"
      base = "/#{base.to_s.gsub(%r{\A/+|/+\z}, "")}"
      return true if base == "/"

      path == base || path.start_with?("#{base}/")
    end

    # A Rack body that runs a block once the server has sent it and closes it.
    class Body
      def initialize(body, after)
        @body = body
        @after = after
      end

      def each(&block)
        @body.each(&block)
      end

      def close
        @body.close if @body.respond_to?(:close)
      ensure
        @after.call
      end
    end
  end
end
