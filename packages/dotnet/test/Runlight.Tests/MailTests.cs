using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading.Tasks;
using Runlight.Http;
using Runlight.Mail;
using Xunit;
using static Runlight.Tests.Fixtures;

namespace Runlight.Tests;

/// <summary>Ports MailTest.php (mail.test.ts), and replays fixtures/outbound.json: every service sends the TypeScript SDK's exact requests.</summary>
public sealed class MailTests
{
    private static JsObject Message() => new()
    {
        ["to"] = "jon@example.com",
        ["from"] = "reports@example.com",
        ["fromName"] = "Runlight",
        ["subject"] = "Hello",
        ["html"] = "<p>Hi</p>",
        ["text"] = "Hi",
        ["headers"] = new JsObject { ["List-Unsubscribe"] = "<https://x/u>" },
    };

    private static JsObject Message(string key, object? value) => Message().Set(key, value);

    public static JsObject Fixture => Load("outbound");

    private static FakeFetcher Capture(int status = 200) => new((_, _) => new Response(status == 200 ? "{}" : "nope", status));

    /// <summary>The requests a fake fetcher saw, as the fixtures record them.</summary>
    public static List<object?> Sent(FakeFetcher fetcher) =>
        [.. fetcher.Requests.Select(r => (object?)new JsObject { ["method"] = r.Method, ["url"] = r.Url, ["headers"] = r.Headers, ["body"] = r.Body ?? "" })];

    /// <summary>A UUID stand-in that counts from 1, as the fixture script's does.</summary>
    private static Func<string> Uuids()
    {
        int n = 0;
        return () => "00000000-0000-4000-8000-" + (++n).ToString("D12", System.Globalization.CultureInfo.InvariantCulture);
    }

    private static JsObject? ErrorOf(MailError? e) => e == null ? null : new JsObject { ["message"] = e.Message, ["code"] = e.Code, ["params"] = e.Params };

    private static async Task ThrowsMatching(string pattern, Func<Task> run)
    {
        var error = await Assert.ThrowsAsync<MailError>(run);
        Assert.Matches(pattern, error.Message);
    }

    [Fact]
    public void Sealed_keys_open_only_with_the_same_secret()
    {
        string sealedValue = Secret.Seal("{\"apiKey\":\"re_123\"}", "server secret");
        Assert.True(sealedValue.StartsWith("v1:", StringComparison.Ordinal) && !sealedValue.Contains("re_123", StringComparison.Ordinal));
        Assert.Equal("{\"apiKey\":\"re_123\"}", Secret.Unseal(sealedValue, "server secret"));
        Assert.Null(Secret.Unseal(sealedValue, "another secret"));
        Assert.Equal("x", Secret.Unseal(Secret.Seal("x", null), null));
        Assert.Null(Secret.Unseal("v1:AAAA:AAAA", "server secret"));
        Assert.Null(Secret.Unseal("v2:a:b", "server secret"));
        Assert.Null(Secret.Unseal(sealedValue, null));
    }

    [Fact]
    public void Keys_sealed_by_TypeScript_open_here()
    {
        foreach (JsObject c in Fixture.Arr("sealed")!)
        {
            string? value = c.Str("value");
            string secret = c.Str("secret")!;
            Assert.Equal(value, Secret.Unseal(c.Str("sealed")!, secret));
            Assert.Null(Secret.Unseal(c.Str("sealed")!, secret + "!"));
            // A value of null is a sealed form TypeScript cannot open (an IV under 12 bytes), so there is nothing to seal again.
            if (value != null)
            {
                Assert.Equal(value, Secret.Unseal(Secret.Seal(value, secret), secret));
            }
        }
    }

    [Fact]
    public void SigV4_matches_AWS_published_example()
    {
        // https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html (the IAM ListUsers example)
        var headers = Ses.SignV4(
            "GET",
            "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
            "",
            "us-east-1",
            "iam",
            "AKIDEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            DateTimeOffset.Parse("2015-08-30T12:36:00Z", System.Globalization.CultureInfo.InvariantCulture).ToUnixTimeMilliseconds(),
            new JsObject { ["content-type"] = "application/x-www-form-urlencoded; charset=utf-8" });
        Assert.Equal(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
            headers.Str("authorization"));
    }

    [Fact]
    public void SigV4_matches_TypeScript()
    {
        foreach (JsObject c in Fixture.Arr("signatures")!)
        {
            var i = c.Obj("input")!;
            var got = Ses.SignV4(i.Str("method")!, i.Str("url")!, i.Str("body")!, i.Str("region")!, i.Str("service")!, i.Str("accessKeyId")!, i.Str("secretAccessKey")!, i.Long("now"), i.Obj("headers")!);
            Assert.Equal(J(c.Get("headers")), J(got));
        }
    }

    [Fact]
    public async Task Each_service_gets_the_request_it_documents()
    {
        var calls = Capture();
        await Transports.SendAsync(new JsObject { ["service"] = "resend", ["apiKey"] = "re_1" }, Message(), calls);
        Assert.Equal("https://api.resend.com/emails", calls.Requests[0].Url);
        Assert.Equal("Bearer re_1", calls.Requests[0].Headers.Str("authorization"));
        var sent = (JsObject)Json.Parse(calls.Requests[0].Body!)!;
        Assert.Equal("[\"jon@example.com\"]", J(sent.Get("to")));
        Assert.Equal("Runlight <reports@example.com>", sent.Str("from"));

        calls = Capture();
        await Transports.SendAsync(new JsObject { ["service"] = "postmark", ["serverToken"] = "pm" }, Message(), calls);
        Assert.Equal("pm", calls.Requests[0].Headers.Str("x-postmark-server-token"));
        Assert.Equal("outbound", ((JsObject)Json.Parse(calls.Requests[0].Body!)!).Str("MessageStream"));

        calls = Capture();
        await Transports.SendAsync(new JsObject { ["service"] = "mailgun", ["apiKey"] = "key", ["domain"] = "mg.example.com", ["region"] = "eu" }, Message(), calls);
        Assert.Equal("https://api.eu.mailgun.net/v3/mg.example.com/messages", calls.Requests[0].Url);
        Assert.Equal("Basic " + Convert.ToBase64String("api:key"u8.ToArray()), calls.Requests[0].Headers.Str("authorization"));
        Assert.Equal("<https://x/u>", new SearchParams(calls.Requests[0].Body!).Get("h:List-Unsubscribe"));

        calls = Capture();
        await Transports.SendAsync(new JsObject { ["service"] = "ses", ["region"] = "eu-west-1", ["accessKeyId"] = "AKID", ["secretAccessKey"] = "secret" }, Message(), calls);
        Assert.Equal("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails", calls.Requests[0].Url);
        Assert.Matches("^AWS4-HMAC-SHA256 Credential=AKID/[0-9]{8}/eu-west-1/ses/aws4_request", calls.Requests[0].Headers.Str("authorization"));

        calls = Capture();
        await Transports.SendAsync(new JsObject { ["service"] = "webhook", ["url"] = "https://hooks.example.com/mail", ["secret"] = "s" }, Message(), calls);
        Assert.Matches("^sha256=[a-f0-9]{64}$", calls.Requests[0].Headers.Str("x-runlight-signature"));

        var refused = Capture(401);
        await ThrowsMatching("api.sendgrid.com answered 401", () => Transports.SendAsync(new JsObject { ["service"] = "sendgrid", ["apiKey"] = "bad" }, Message(), refused));
        await ThrowsMatching("must use https", () => Transports.SendAsync(new JsObject { ["service"] = "webhook", ["url"] = "http://example.com/x" }, Message(), refused));
        await ThrowsMatching("Enter the api key", () => Transports.SendAsync(new JsObject { ["service"] = "resend" }, Message(), refused));
    }

    [Fact]
    public async Task Every_service_sends_the_TypeScript_requests_exactly()
    {
        long now = Fixture.Long("now");
        int i = 0;
        foreach (JsObject c in Fixture.Arr("mail")!)
        {
            object? answer = c.Get("answer");
            var fetcher = new FakeFetcher((_, _) =>
            {
                if (answer is "unreachable")
                {
                    throw new FetchException("fetch failed");
                }
                var a = (JsObject)answer!;
                return new Response(a.Str("body")!, (int)a.Long("status"));
            });
            MailError? error = null;
            try
            {
                await Transports.SendAsync(c.Obj("config")!, c.Obj("message")!, fetcher, now);
            }
            catch (MailError e)
            {
                error = e;
            }
            string label = "case " + i++ + ": " + J(c.Get("config"));
            Assert.True(J(c.Get("requests")) == J(Sent(fetcher)), label + "\n" + J(c.Get("requests")) + "\n" + J(Sent(fetcher)));
            Assert.True(J(c.Get("error")) == J(ErrorOf(error)), label + "\n" + J(c.Get("error")) + "\n" + J(ErrorOf(error)));
        }
    }

    [Fact]
    public void Service_messages_match_TypeScript()
    {
        foreach (JsObject c in Fixture.Arr("replies")!)
        {
            Assert.Equal(c.Str("message"), Js.WellFormed(Transports.ServiceMessage(c.Str("reply")!)));
        }
    }

    [Fact]
    public void Mime_matches_TypeScript()
    {
        foreach (JsObject c in Fixture.Arr("mimes")!)
        {
            Assert.Equal(c.Str("mime"), Smtp.Mime(c.Obj("message")!, c.Str("from")!, c.Long("now"), Uuids()));
        }
        string raw = Smtp.Mime(Message("subject", "Café report"), "Runlight <reports@example.com>");
        Assert.Matches("Subject: =\\?UTF-8\\?B\\?", raw);
        Assert.Matches("boundary=\"rl-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\"", raw);
    }

    [Fact]
    public async Task Smtp_sends_the_TypeScript_conversation()
    {
        await using var server = new SmtpServer();
        foreach (JsObject c in Fixture.Arr("smtp")!)
        {
            var config = c.Obj("config")!.Clone();
            config["service"] = "smtp";
            config["host"] = "127.0.0.1";
            config["port"] = Js.Str(server.Port);
            MailError? error = null;
            try
            {
                await Smtp.SendAsync(config, c.Obj("message")!, c.Str("from")!, 60_000, Fixture.Long("now"), Uuids());
            }
            catch (MailError e)
            {
                error = e;
            }
            Assert.Equal(J(c.Get("error")), J(ErrorOf(error)));
            Assert.Equal(c.Str("received"), (await server.ConversationAsync())?.Str("received"));
        }
    }

    [Fact]
    public async Task Smtp_STARTTLS_refused_is_an_error_and_a_plain_relay_takes_the_message()
    {
        await using var server = new SmtpServer();
        var config = new JsObject { ["service"] = "smtp", ["host"] = "127.0.0.1", ["port"] = Js.Str(server.Port) };
        await ThrowsMatching("does not offer STARTTLS", () => Smtp.SendAsync(config.Clone().Set("security", "starttls"), Message(), "reports@example.com"));
        await server.ConversationAsync();
        await Smtp.SendAsync(config.Clone().Set("security", "none").Set("username", "jon").Set("password", "pw"), Message("text", ".starts with a dot"), "Runlight <reports@example.com>");
        string received = (await server.ConversationAsync())!.Str("received")!;
        var seen = new List<string>();
        bool inData = false;
        string data = "";
        foreach (string line in received.Split("\r\n"))
        {
            if (inData)
            {
                if (line == ".")
                {
                    inData = false;
                }
                else
                {
                    data += line + "\n";
                }
                continue;
            }
            if (line.Length > 0)
            {
                seen.Add(line.Split(' ')[0]);
            }
            inData = line == "DATA";
        }
        Assert.Equal(["EHLO", "AUTH", "MAIL", "RCPT", "DATA", "QUIT"], seen);
        Assert.Matches("Subject: Hello", data);
        Assert.Matches("List-Unsubscribe: <https://x/u>", data);
        Assert.Matches("multipart/alternative", data);
    }

    [Fact]
    public async Task Smtp_through_Transports_sends_too()
    {
        await using var server = new SmtpServer();
        await Transports.SendAsync(new JsObject { ["service"] = "smtp", ["host"] = "127.0.0.1", ["port"] = Js.Str(server.Port), ["security"] = "none" }, Message());
        Assert.Contains("From: Runlight <reports@example.com>\r\n", (await server.ConversationAsync())!.Str("received"), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Smtp_server_that_trickles_is_cut_off_at_the_deadline()
    {
        await using var server = new SmtpServer("trickle");
        var started = Stopwatch.StartNew();
        var error = await Assert.ThrowsAsync<MailError>(() => Smtp.SendAsync(new JsObject { ["service"] = "smtp", ["host"] = "127.0.0.1", ["port"] = Js.Str(server.Port), ["security"] = "none" }, Message(), "reports@example.com", 600));
        Assert.Equal("mail_slow", error.Code);
        Assert.Equal(J(new JsObject { ["host"] = "127.0.0.1:" + server.Port }), J(error.Params));
        Assert.Equal("SMTP: 127.0.0.1:" + server.Port + " took longer than 1 s", error.Message);
        Assert.True(started.Elapsed.TotalSeconds < 2, "the send gives up at its deadline");
        Assert.True((await server.ConversationAsync(2))?.Bool("closed"), "the connection is closed");
    }

    [Fact]
    public async Task Smtp_reply_just_before_the_server_closes_is_the_error_not_the_close()
    {
        await using var server = new SmtpServer("refuse");
        await ThrowsMatching("^SMTP greeting: 535 no$", () => Smtp.SendAsync(new JsObject { ["service"] = "smtp", ["host"] = "127.0.0.1", ["port"] = Js.Str(server.Port), ["security"] = "none" }, Message(), "reports@example.com"));
    }

    [Fact]
    public async Task Smtp_never_a_link_local_or_metadata_address_and_something_that_is_not_a_mail_server_is_not_quoted()
    {
        foreach (string host in new[] { "169.254.169.254", "[fd00:ec2::254]" })
        {
            var error = await Assert.ThrowsAsync<MailError>(() => Smtp.SendAsync(new JsObject { ["service"] = "smtp", ["host"] = host, ["port"] = "25", ["security"] = "none" }, Message(), "reports@example.com"));
            Assert.Equal("address_refused", error.Code);
        }
        var rl = new Runlight(new RunlightOptions { Store = await Databases.FreshAsync("sqlite"), Secret = new string('s', 64) });
        var saved = await Assert.ThrowsAsync<MailError>(() => rl.SaveMailSettingsAsync(new JsObject { ["service"] = "smtp", ["host"] = "metadata.google.internal", ["port"] = "587", ["security"] = "starttls", ["from"] = "a@example.com" }));
        Assert.Equal("address_refused", saved.Code);

        var (listener, port) = SmtpServer.Listen();
        using var _ = listener;
        var serving = Task.Run(async () =>
        {
            using var client = await listener.AcceptTcpClientAsync();
            await client.GetStream().WriteAsync(Js.Utf8("HTTP/1.1 400 Bad Request\r\nsecret: internal\r\n\r\n"));
        });
        try
        {
            var error = await Assert.ThrowsAsync<MailError>(() => Smtp.SendAsync(new JsObject { ["service"] = "smtp", ["host"] = "127.0.0.1", ["port"] = Js.Str(port), ["security"] = "none" }, Message(), "reports@example.com"));
            Assert.Matches("did not answer as a mail server does", error.Message);
            Assert.DoesNotMatch("internal|HTTP", error.Message);
        }
        finally
        {
            await serving;
            listener.Stop();
        }
    }

    [Fact]
    public async Task Smtp_that_cannot_connect_says_so()
    {
        // A port that was free a moment ago.
        var (probe, port) = SmtpServer.Listen();
        probe.Stop();
        probe.Dispose();
        var error = await Assert.ThrowsAsync<MailError>(() => Smtp.SendAsync(new JsObject { ["service"] = "smtp", ["host"] = "127.0.0.1", ["port"] = Js.Str(port), ["security"] = "none" }, Message(), "reports@example.com"));
        Assert.Equal("mail_unreachable", error.Code);
        Assert.Equal("127.0.0.1:" + port, error.Params.Str("host"));
        Assert.StartsWith("SMTP: could not connect to 127.0.0.1:" + port + ": ", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Errors_carry_codes_and_params()
    {
        var error = new MailError("Something");
        Assert.Equal("mail_failed", error.Code);
        Assert.Equal("{\"detail\":\"Something\"}", J(error.Params));
        Assert.Equal("ses", Transports.Services[0].Str("id"));
    }

    [Fact]
    public async Task The_apps_own_mailer_sends_until_a_service_saved_in_the_dashboard_takes_its_place()
    {
        long now = DateTimeOffset.Parse("2026-10-05T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture).ToUnixTimeMilliseconds();
        var sent = new List<JsObject>();
        string fail = "";
        var calls = Capture();
        var rl = new Runlight(new RunlightOptions
        {
            Store = await Databases.FreshAsync("sqlite"),
            Site = new SiteOptions { Name = "Example", Hostnames = ["example.com"] },
            Now = () => now,
            Fetcher = calls,
            Mail = new AppMailer
            {
                From = "site@example.com",
                FromName = "Example",
                Via = "WordPress (WP Mail SMTP)",
                Send = (m, _) =>
                {
                    if (fail.Length > 0)
                    {
                        throw new InvalidOperationException(fail);
                    }
                    sent.Add(m);
                    return Task.CompletedTask;
                },
            },
        });
        var routes = rl.Routes(new RoutesOptions { Token = "t" });
        async Task<(int Status, JsObject Body)> Call(string method, string path, object? body = null)
        {
            var headers = new Headers();
            headers.Set("authorization", "Bearer t");
            headers.Set("content-type", "application/json");
            var answer = await routes.HandleAsync(new Request("https://stats.example.com/runlight" + path, method, headers, body == null ? "" : Json.Stringify(body)));
            return (answer.Status, (JsObject)Json.Parse(answer.Text())!);
        }

        var app = (await Call("GET", "/api/mail")).Body;
        Assert.Equal(
            "{\"source\":\"app\",\"service\":\"\",\"from\":\"site@example.com\",\"fromName\":\"Example\",\"fields\":{},\"saved\":[],\"app\":{\"via\":\"WordPress (WP Mail SMTP)\",\"from\":\"site@example.com\",\"fromName\":\"Example\",\"replaced\":false}}",
            J(new JsObject { ["source"] = app.Get("source"), ["service"] = app.Get("service"), ["from"] = app.Get("from"), ["fromName"] = app.Get("fromName"), ["fields"] = app.Get("fields"), ["saved"] = app.Get("saved"), ["app"] = app.Get("app") }));
        Assert.Equal("app", app.Keys[^1]); // after the keys an install without one answers with

        Assert.Equal(200, (await Call("POST", "/api/mail/test", new JsObject { ["to"] = "jon@example.com" })).Status);
        Assert.Single(sent);
        Assert.Equal("[\"jon@example.com\",\"site@example.com\",\"Example\"]", J(new List<object?> { sent[0].Get("to"), sent[0].Get("from"), sent[0].Get("fromName") }));
        Assert.Contains("WordPress (WP Mail SMTP)", sent[0].Str("text"), StringComparison.Ordinal); // the test names the app's mailer

        // Reports go through it too, with the unsubscribe headers.
        Assert.Equal(201, (await Call("POST", "/api/reports", new JsObject { ["email"] = "jon@example.com", ["frequency"] = "weekly" })).Status);
        now += 7 * 86_400_000L;
        Assert.Equal("{\"sent\":1,\"failed\":0}", J(await rl.SendReportsAsync()));
        Assert.Matches("^<https://stats\\.example\\.com/runlight/unsubscribe/[a-f0-9]{32}>$", sent[1].Obj("headers")!.Str("List-Unsubscribe")!);
        Assert.Equal("List-Unsubscribe=One-Click", sent[1].Obj("headers")!.Str("List-Unsubscribe-Post"));

        // A failure comes back as a mail error naming the mailer.
        fail = "SMTP connect() failed";
        var failed = await Call("POST", "/api/mail/test", new JsObject { ["to"] = "jon@example.com" });
        Assert.Equal(400, failed.Status);
        Assert.Equal("{\"error\":\"WordPress (WP Mail SMTP) could not send it: SMTP connect() failed\",\"code\":\"mail_app_failed\",\"params\":{\"via\":\"WordPress (WP Mail SMTP)\",\"detail\":\"SMTP connect() failed\"}}", J(failed.Body));
        fail = "";

        // A service saved in the dashboard takes its place.
        Assert.Equal(200, (await Call("PUT", "/api/mail", new JsObject { ["service"] = "resend", ["apiKey"] = "re_live_key", ["from"] = "reports@example.com" })).Status);
        var replaced = (await Call("GET", "/api/mail")).Body;
        Assert.Equal(
            "[\"dashboard\",\"resend\",\"reports@example.com\",{\"via\":\"WordPress (WP Mail SMTP)\",\"from\":\"site@example.com\",\"fromName\":\"Example\",\"replaced\":true}]",
            J(new List<object?> { replaced.Get("source"), replaced.Get("service"), replaced.Get("from"), replaced.Get("app") }));
        calls.Requests.Clear();
        Assert.Equal(200, (await Call("POST", "/api/mail/test", new JsObject { ["to"] = "jon@example.com" })).Status);
        Assert.Single(calls.Requests); // through the saved service
        Assert.Equal(2, sent.Count); // and not the app's mailer

        // Removing it goes back to the app's mailer.
        Assert.Equal(200, (await Call("DELETE", "/api/mail")).Status);
        Assert.Equal("app", (await Call("GET", "/api/mail")).Body.Str("source"));
        Assert.Equal(200, (await Call("POST", "/api/mail/test", new JsObject { ["to"] = "jon@example.com" })).Status);
        Assert.Equal(3, sent.Count);
    }

    [Fact]
    public async Task The_apps_mailer_needs_a_from_address_and_without_one_the_answer_has_no_app()
    {
        var store = await Databases.FreshAsync("sqlite");
        var error = Assert.Throws<ArgumentException>(() => new Runlight(new RunlightOptions { Store = store, Mail = new AppMailer { From = "", Via = "Drupal", Send = (_, _) => Task.CompletedTask } }));
        Assert.Contains("from address", error.Message, StringComparison.Ordinal);
        var rl = new Runlight(new RunlightOptions { Store = store });
        var headers = new Headers();
        headers.Set("authorization", "Bearer t");
        var answer = (JsObject)Json.Parse((await rl.Routes(new RoutesOptions { Token = "t" }).HandleAsync(new Request("https://stats.example.com/runlight/api/mail", "GET", headers))).Text())!;
        Assert.Null(answer.Get("source"));
        Assert.False(answer.Has("app")); // an install without an app mailer answers as before
    }
}
