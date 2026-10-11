# frozen_string_literal: true

require "test_helper"
require_relative "support/smtp_server"

# Ports mail.test.ts, and replays the outbound fixture: every service sends the TypeScript SDK's exact requests.
class MailTest < Minitest::Test
  Mail = Runlight::Mail
  MESSAGE = { "to" => "jon@example.com", "from" => "reports@example.com", "fromName" => "Runlight", "subject" => "Hello", "html" => "<p>Hi</p>",
              "text" => "Hi", "headers" => { "List-Unsubscribe" => "<https://x/u>" } }.freeze

  def fixture
    Fixtures.load("outbound")
  end

  def capture(status = 200)
    FakeFetcher.new { Runlight::Http::Response.new(status == 200 ? "{}" : "nope", status: status) }
  end

  # A UUID stand-in that counts from 1, as the fixture script's does.
  def uuids
    n = 0
    -> { format("00000000-0000-4000-8000-%012d", n += 1) }
  end

  def error_of(error)
    { "message" => error.message, "code" => error.code, "params" => error.params }
  end

  def assert_throws_matching(pattern)
    yield
  rescue Mail::MailError => e
    assert_match pattern, e.message
  else
    flunk "Expected an error matching #{pattern.inspect}"
  end

  def test_sealed_keys_open_only_with_the_same_secret
    sealed = Mail::Secret.seal('{"apiKey":"re_123"}', "server secret")
    assert sealed.start_with?("v1:") && !sealed.include?("re_123")
    assert_equal '{"apiKey":"re_123"}', Mail::Secret.unseal(sealed, "server secret")
    assert_nil Mail::Secret.unseal(sealed, "another secret")
    assert_equal "x", Mail::Secret.unseal(Mail::Secret.seal("x", nil), nil), "with no secret the value is kept as typed"
    assert_nil Mail::Secret.unseal("v1:AAAA:AAAA", "server secret"), "damaged"
    assert_nil Mail::Secret.unseal("v2:a:b", "server secret")
    assert_nil Mail::Secret.unseal(sealed, nil)
  end

  def test_keys_sealed_by_type_script_open_here
    fixture["sealed"].each do |c|
      opened = Mail::Secret.unseal(c["sealed"], c["secret"])
      c["value"].nil? ? assert_nil(opened) : assert_equal(c["value"], opened)
      assert_nil Mail::Secret.unseal(c["sealed"], "#{c["secret"]}!")
      # A value of nil is a sealed form TypeScript cannot open (an IV under 12 bytes), so there is nothing to seal again.
      next if c["value"].nil?

      assert_equal c["value"], Mail::Secret.unseal(Mail::Secret.seal(c["value"], c["secret"]), c["secret"])
    end
  end

  def test_sig_v4_matches_aws_published_example
    # https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html (the IAM ListUsers example)
    headers = Mail::Ses.sign_v4({
      "method" => "GET",
      "url" => "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
      "body" => "",
      "region" => "us-east-1",
      "service" => "iam",
      "accessKeyId" => "AKIDEXAMPLE",
      "secretAccessKey" => "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      "now" => Time.utc(2015, 8, 30, 12, 36, 0).to_i * 1000,
      "headers" => { "content-type" => "application/x-www-form-urlencoded; charset=utf-8" },
    })
    assert_equal "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, " \
                 "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7", headers["authorization"]
  end

  def test_sig_v4_matches_type_script
    fixture["signatures"].each do |c|
      assert_equal c["headers"], Mail::Ses.sign_v4(c["input"]), c["input"]["url"]
      assert_equal c["headers"].keys, Mail::Ses.sign_v4(c["input"]).keys
    end
  end

  def test_each_service_gets_the_request_it_documents
    calls = capture
    Mail::Transports.deliver({ "service" => "resend", "apiKey" => "re_1" }, MESSAGE, calls)
    assert_equal "https://api.resend.com/emails", calls.requests[0]["url"]
    assert_equal "Bearer re_1", calls.requests[0]["headers"]["authorization"]
    assert_equal ["jon@example.com"], Runlight::Json.decode(calls.requests[0]["body"])["to"]
    assert_equal "Runlight <reports@example.com>", Runlight::Json.decode(calls.requests[0]["body"])["from"]

    calls = capture
    Mail::Transports.deliver({ "service" => "postmark", "serverToken" => "pm" }, MESSAGE, calls)
    assert_equal "pm", calls.requests[0]["headers"]["x-postmark-server-token"]
    assert_equal "outbound", Runlight::Json.decode(calls.requests[0]["body"])["MessageStream"]

    calls = capture
    Mail::Transports.deliver({ "service" => "mailgun", "apiKey" => "key", "domain" => "mg.example.com", "region" => "eu" }, MESSAGE, calls)
    assert_equal "https://api.eu.mailgun.net/v3/mg.example.com/messages", calls.requests[0]["url"]
    assert_equal "Basic #{["api:key"].pack("m0")}", calls.requests[0]["headers"]["authorization"]
    assert_equal "<https://x/u>", Runlight::Http::SearchParams.new(calls.requests[0]["body"]).get("h:List-Unsubscribe")

    calls = capture
    Mail::Transports.deliver({ "service" => "ses", "region" => "eu-west-1", "accessKeyId" => "AKID", "secretAccessKey" => "secret" }, MESSAGE, calls)
    assert_equal "https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails", calls.requests[0]["url"]
    assert_match %r{\AAWS4-HMAC-SHA256 Credential=AKID/\d{8}/eu-west-1/ses/aws4_request}, calls.requests[0]["headers"]["authorization"]

    calls = capture
    Mail::Transports.deliver({ "service" => "webhook", "url" => "https://hooks.example.com/mail", "secret" => "s" }, MESSAGE, calls)
    assert_match(/\Asha256=[a-f0-9]{64}\z/, calls.requests[0]["headers"]["x-runlight-signature"])

    refused = capture(401)
    assert_throws_matching(/api.sendgrid.com answered 401/) { Mail::Transports.deliver({ "service" => "sendgrid", "apiKey" => "bad" }, MESSAGE, refused) }
    assert_throws_matching(/must use https/) { Mail::Transports.deliver({ "service" => "webhook", "url" => "http://example.com/x" }, MESSAGE, refused) }
    assert_throws_matching(/Enter the api key/) { Mail::Transports.deliver({ "service" => "resend" }, MESSAGE, refused) }
  end

  def test_every_service_sends_the_type_script_requests_exactly
    now = fixture["now"]
    fixture["mail"].each_with_index do |c, i|
      answer = c["answer"]
      fetcher = FakeFetcher.new do
        raise Runlight::Http::FetchError, "fetch failed" if answer == "unreachable"

        Runlight::Http::Response.new(answer["body"], status: answer["status"])
      end
      error = nil
      begin
        Mail::Transports.deliver(c["config"], c["message"], fetcher, now)
      rescue Mail::MailError => e
        error = error_of(e)
      end
      label = "case #{i}: #{Runlight::Json.encode(c["config"])}"
      assert_equal c["requests"], fetcher.requests, label
      assert_equal Runlight::Json.encode(c["requests"]), Runlight::Json.encode(fetcher.requests), label
      if c["error"].nil?
        assert_nil error, label
      else
        assert_equal c["error"], error, label
      end
    end
  end

  def test_service_messages_match_type_script
    fixture["replies"].each do |c|
      assert_equal c["message"], Mail::Transports.service_message(c["reply"]), c["reply"]
    end
  end

  def test_mime_matches_type_script
    fixture["mimes"].each do |c|
      assert_equal c["mime"], Mail::Smtp.mime(c["message"], c["from"], c["now"], uuids)
    end
    raw = Mail::Smtp.mime(MESSAGE.merge("subject" => "Café report"), "Runlight <reports@example.com>")
    assert_match(/Subject: =\?UTF-8\?B\?/, raw)
    assert_match(/boundary="rl-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"/, raw)
  end

  def test_smtp_sends_the_type_script_conversation
    server = SmtpServer.new
    fixture["smtp"].each do |c|
      error = nil
      begin
        Mail::Smtp.deliver(c["config"].merge("service" => "smtp", "host" => "127.0.0.1", "port" => server.port.to_s), c["message"], c["from"], 60_000, fixture["now"], uuids)
      rescue Mail::MailError => e
        error = error_of(e)
      end
      if c["error"].nil?
        assert_nil error
      else
        assert_equal c["error"], error
      end
      assert_equal c["received"], server.conversation&.fetch("received", nil)
    end
  ensure
    server&.stop
  end

  def test_smtp_start_tls_refused_is_an_error_and_a_plain_relay_takes_the_message
    server = SmtpServer.new
    config = { "service" => "smtp", "host" => "127.0.0.1", "port" => server.port.to_s }
    assert_throws_matching(/does not offer STARTTLS/) { Mail::Smtp.deliver(config.merge("security" => "starttls"), MESSAGE, "reports@example.com") }
    server.conversation
    Mail::Smtp.deliver(config.merge("security" => "none", "username" => "jon", "password" => "pw"), MESSAGE.merge("text" => ".starts with a dot"), "Runlight <reports@example.com>")
    received = server.conversation["received"]
    seen = []
    in_data = false
    data = +""
    received.split("\r\n", -1).each do |line|
      if in_data
        if line == "."
          in_data = false
        else
          data << "#{line}\n"
        end
        next
      end
      seen << line.split(" ", -1)[0] unless line.empty?
      in_data = line == "DATA"
    end
    assert_equal %w[EHLO AUTH MAIL RCPT DATA QUIT], seen
    assert_match(/Subject: Hello/, data)
    assert_match %r{List-Unsubscribe: <https://x/u>}, data
    assert_match %r{multipart/alternative}, data
  ensure
    server&.stop
  end

  def test_smtp_through_transports_sends_too
    server = SmtpServer.new
    Mail::Transports.deliver({ "service" => "smtp", "host" => "127.0.0.1", "port" => server.port.to_s, "security" => "none" }, MESSAGE)
    assert_includes server.conversation["received"], "From: Runlight <reports@example.com>\r\n"
  ensure
    server&.stop
  end

  def test_smtp_reply_just_before_the_server_closes_is_the_error_not_the_close
    server = SmtpServer.new("refuse")
    error = assert_raises(Mail::MailError) do
      Mail::Smtp.deliver({ "service" => "smtp", "host" => "127.0.0.1", "port" => server.port.to_s, "security" => "none" }, MESSAGE, "reports@example.com")
    end
    assert_equal "SMTP greeting: 535 no", error.message
  ensure
    server&.stop
  end

  def test_smtp_never_a_link_local_or_metadata_address_and_something_that_is_not_a_mail_server_is_not_quoted
    ["169.254.169.254", "[fd00:ec2::254]"].each do |host|
      error = assert_raises(Mail::MailError, host) do
        Mail::Smtp.deliver({ "service" => "smtp", "host" => host, "port" => "25", "security" => "none" }, MESSAGE, "reports@example.com")
      end
      assert_equal "address_refused", error.code
    end
    rl = Runlight::Core.new({ "store" => Runlight::Stores.sqlite(":memory:"), "secret" => "s" * 64 })
    error = assert_raises(Mail::MailError) do
      rl.save_mail_settings({ "service" => "smtp", "host" => "metadata.google.internal", "port" => "587", "security" => "starttls", "from" => "a@example.com" })
    end
    assert_equal "address_refused", error.code
    server = TCPServer.new("127.0.0.1", 0)
    port = server.addr[1]
    answering = Thread.new do
      client = server.accept
      client.write("HTTP/1.1 400 Bad Request\r\nsecret: internal\r\n\r\n")
      client.close
    end
    error = assert_raises(Mail::MailError) do
      Mail::Smtp.deliver({ "service" => "smtp", "host" => "127.0.0.1", "port" => port.to_s, "security" => "none" }, MESSAGE, "reports@example.com")
    end
    assert_match(/did not answer as a mail server does/, error.message)
    refute_match(/internal|HTTP/, error.message)
  ensure
    answering&.join
    server&.close
  end

  def test_smtp_character_split_across_two_reads_comes_through_whole
    ours, theirs = UNIXSocket.pair
    session = Mail::SmtpSession.new("127.0.0.1", 25, Mail::Smtp.monotonic + 5_000_000_000, "late")
    session.instance_variable_set(:@socket, ours)
    bytes = "250 caf\u00e9 ok\r\n".b
    split = bytes.index("\xC3".b) + 1
    theirs.write(bytes.byteslice(0, split))
    writer = Thread.new do
      sleep 0.1
      theirs.write(bytes.byteslice(split, bytes.bytesize))
    end
    assert_equal({ "code" => 250, "text" => "caf\u00e9 ok" }, session.next_reply(2000))
    writer.join
  ensure
    ours&.close
    theirs&.close
  end

  def test_smtp_server_that_trickles_is_cut_off_at_the_deadline
    server = SmtpServer.new("trickle")
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    begin
      Mail::Smtp.deliver({ "service" => "smtp", "host" => "127.0.0.1", "port" => server.port.to_s, "security" => "none" }, MESSAGE, "reports@example.com", 600)
      flunk "the send should give up"
    rescue Mail::MailError => e
      assert_equal "mail_slow", e.code, e.message
      assert_equal({ "host" => "127.0.0.1:#{server.port}" }, e.params)
      assert_equal "SMTP: 127.0.0.1:#{server.port} took longer than 1 s", e.message
    end
    assert_operator Process.clock_gettime(Process::CLOCK_MONOTONIC) - started, :<, 2, "the send gives up at its deadline"
    assert server.conversation(2)&.fetch("closed", false), "the connection is closed"
  ensure
    server&.stop
  end

  def test_smtp_that_cannot_connect_says_so
    # A port that was free a moment ago.
    probe = TCPServer.new("127.0.0.1", 0)
    port = probe.addr[1]
    probe.close
    begin
      Mail::Smtp.deliver({ "service" => "smtp", "host" => "127.0.0.1", "port" => port.to_s, "security" => "none" }, MESSAGE, "reports@example.com")
      flunk "the send should fail"
    rescue Mail::MailError => e
      assert_equal "mail_unreachable", e.code
      assert_equal "127.0.0.1:#{port}", e.params["host"]
      assert e.message.start_with?("SMTP: could not connect to 127.0.0.1:#{port}: "), e.message
    end
  end

  def test_errors_carry_codes_and_params
    error = Mail::MailError.new("Something")
    assert_equal "mail_failed", error.code
    assert_equal({ "detail" => "Something" }, error.params)
    assert_equal "ses", Mail::Transports::SERVICES[0]["id"]
  end

  def test_the_apps_own_mailer_sends_until_a_service_saved_in_the_dashboard_takes_its_place
    now = Time.utc(2026, 10, 5, 12).to_i * 1000
    sent = []
    fail_with = ""
    calls = capture
    rl = Runlight::Core.new(
      store: Runlight::Stores.sqlite(":memory:"),
      site: { name: "Example", hostnames: ["example.com"] },
      now: -> { now },
      fetcher: calls,
      mail: {
        from: "site@example.com",
        from_name: "Example",
        via: "WordPress (WP Mail SMTP)",
        send: lambda do |m|
          raise fail_with unless fail_with == ""

          sent << m
        end,
      }
    )
    routes = rl.routes({ "token" => "t" })
    call = lambda do |method, path, body = nil|
      routes.handle(Runlight::Http::Request.new("https://stats.example.com/runlight#{path}", method: method,
                                                headers: { "authorization" => "Bearer t", "content-type" => "application/json" },
                                                body: body.nil? ? "" : Runlight::Json.encode(body)))
    end
    get = ->(path) { Runlight::Json.decode(call.call("GET", path).text) }

    app = get.call("/api/mail")
    assert_equal(
      { "source" => "app", "service" => "", "from" => "site@example.com", "fromName" => "Example", "fields" => {}, "saved" => [],
        "app" => { "via" => "WordPress (WP Mail SMTP)", "from" => "site@example.com", "fromName" => "Example", "replaced" => false } },
      app.slice("source", "service", "from", "fromName", "fields", "saved", "app")
    )
    assert_equal "app", app.keys.last

    assert_equal 200, call.call("POST", "/api/mail/test", { "to" => "jon@example.com" }).status
    assert_equal 1, sent.length
    assert_equal ["jon@example.com", "site@example.com", "Example"], sent[0].values_at("to", "from", "fromName")
    assert_match(/WordPress \(WP Mail SMTP\)/, sent[0]["text"], "the test names the app's mailer")

    # Reports go through it too, with the unsubscribe headers.
    assert_equal 201, call.call("POST", "/api/reports", { "email" => "jon@example.com", "frequency" => "weekly" }).status
    now += 7 * 86_400_000
    assert_equal({ "sent" => 1, "failed" => 0 }, rl.send_reports)
    assert_match(%r{\A<https://stats\.example\.com/runlight/unsubscribe/[a-f0-9]{32}>\z}, sent[1]["headers"]["List-Unsubscribe"])
    assert_equal "List-Unsubscribe=One-Click", sent[1]["headers"]["List-Unsubscribe-Post"]

    # A failure comes back as a mail error naming the mailer.
    fail_with = "SMTP connect() failed"
    failed = call.call("POST", "/api/mail/test", { "to" => "jon@example.com" })
    assert_equal 400, failed.status
    assert_equal({ "error" => "WordPress (WP Mail SMTP) could not send it: SMTP connect() failed", "code" => "mail_app_failed",
                   "params" => { "via" => "WordPress (WP Mail SMTP)", "detail" => "SMTP connect() failed" } }, Runlight::Json.decode(failed.text))
    fail_with = ""

    # A service saved in the dashboard takes its place.
    assert_equal 200, call.call("PUT", "/api/mail", { "service" => "resend", "apiKey" => "re_live_key", "from" => "reports@example.com" }).status
    replaced = get.call("/api/mail")
    assert_equal ["dashboard", "resend", "reports@example.com",
                  { "via" => "WordPress (WP Mail SMTP)", "from" => "site@example.com", "fromName" => "Example", "replaced" => true }],
                 replaced.values_at("source", "service", "from", "app")
    assert_equal 200, call.call("POST", "/api/mail/test", { "to" => "jon@example.com" }).status
    assert_equal 1, calls.requests.length, "through the saved service"
    assert_equal 2, sent.length, "and not the app's mailer"

    # Removing it goes back to the app's mailer.
    assert_equal 200, call.call("DELETE", "/api/mail").status
    assert_equal "app", get.call("/api/mail")["source"]
    assert_equal 200, call.call("POST", "/api/mail/test", { "to" => "jon@example.com" }).status
    assert_equal 3, sent.length
  end

  def test_the_apps_mailer_needs_a_from_address_and_without_one_the_answer_has_no_app
    error = assert_raises(ArgumentError) do
      Runlight::Core.new(store: Runlight::Stores.sqlite(":memory:"), mail: { from: "", via: "Drupal", send: ->(_m) {} })
    end
    assert_match(/from address/, error.message)
    rl = Runlight::Core.new(store: Runlight::Stores.sqlite(":memory:"))
    assert_nil rl.app_mailer
    response = rl.routes({ "token" => "t" }).handle(Runlight::Http::Request.new("https://stats.example.com/runlight/api/mail",
                                                                                 headers: { "authorization" => "Bearer t" }))
    answer = Runlight::Json.decode(response.text)
    assert_nil answer["source"]
    refute answer.key?("app"), "an install without an app mailer answers as before"
  end

  def test_mail_services_names_the_services_settings_offers_and_one_saved_that_is_not_offered_counts_as_none
    error = assert_raises(ArgumentError) { Runlight::Core.new(store: Runlight::Stores.sqlite(":memory:"), mail_services: %w[resend pigeon]) }
    assert_equal "Runlight: mail_services names \"pigeon\", which is not a mail service", error.message
    assert_equal Runlight::Mail::Transports::SERVICES, Runlight::Core.new(store: Runlight::Stores.sqlite(":memory:")).mail_services
    assert_equal [], Runlight::Core.new(store: Runlight::Stores.sqlite(":memory:"), mail_services: []).mail_services, "an empty list offers none"

    sent = []
    store = Runlight::Stores.sqlite(":memory:")
    everything = Runlight::Core.new(store: store, secret: "s")
    everything.save_mail_settings({ "service" => "smtp", "host" => "smtp.example.com", "port" => "587", "security" => "starttls", "from" => "r@example.com" })
    rl = Runlight::Core.new(store: store, secret: "s", mail_services: %w[webhook resend],
                            mail: { from: "site@example.com", via: "Drupal", send: ->(m) { sent << m } })
    # In the usual order, whatever order they were named in.
    assert_equal %w[resend webhook], rl.mail_services.map { |s| s["id"] }
    # SMTP was saved before it stopped being offered: it counts as none, and the app's mailer sends.
    assert_equal "app", rl.mail_settings["source"]
    assert_equal "dashboard", everything.mail_settings["source"]
    rl.send_mail({ "to" => "me@example.com", "subject" => "Hi", "html" => "<p>Hi</p>", "text" => "Hi" })
    assert_equal 1, sent.length

    refused = assert_raises(Runlight::Mail::MailError) do
      rl.save_mail_settings({ "service" => "smtp", "host" => "smtp.example.com", "port" => "587", "from" => "r@example.com" })
    end
    assert_equal ["SMTP is not offered here. Pick another mail service", "mail_service", { "service" => "smtp" }],
                 [refused.message, refused.code, refused.params]
    unknown = assert_raises(Runlight::Mail::MailError) { rl.save_mail_settings({ "service" => "pigeon", "from" => "r@example.com" }) }
    assert_equal ["Pick a mail service", "mail_service", {}], [unknown.message, unknown.code, unknown.params]

    answer = Runlight::Json.decode(rl.routes({ "token" => "t" }).handle(
      Runlight::Http::Request.new("https://stats.example.com/runlight/api/mail", headers: { "authorization" => "Bearer t" }),
    ).text)
    assert_equal %w[resend webhook], answer["services"].map { |s| s["id"] }
  end
end
