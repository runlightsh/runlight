using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Threading.Tasks;
using Runlight.Http;
using Runlight.Mail;
using Xunit;

namespace Runlight.Tests;

/// <summary>
/// Ports the service fetch test in safefetch.test.ts: a service someone set up is followed through its
/// redirects only while each stays off link-local and metadata addresses. And a pinned request connects
/// only to the addresses it was pinned to, never through a proxy.
/// </summary>
public sealed class ServiceFetchTests
{
    private static LocalHttp Server() => new(seen => seen.Target switch
    {
        "/metadata" => new(302, new() { ["location"] = "http://169.254.169.254/latest/meta-data/" }),
        "/metadata-v6" => new(307, new() { ["location"] = "http://[fd00:ec2::254]/" }),
        "/see-other" => new(303, new() { ["location"] = "/landed" }),
        "/keep" => new(307, new() { ["location"] = "/landed" }),
        "/elsewhere" => new(307, new() { ["location"] = "http://localhost:" + seen.Header("host").Split(':')[^1] + "/landed" }),
        "/loop" => new(302, new() { ["location"] = "/loop" }),
        _ => new(200, null, "ok"),
    });

    private static FetchInit Ask() => new()
    {
        Method = "POST",
        Headers = new Headers { ["authorization"] = "Bearer key", ["content-type"] = "application/json" },
        BodyText = "{}",
    };

    private static (string Method, string Target, string Body, string Authorization, string Type) Shape(LocalHttp.Seen seen) =>
        (seen.Method, seen.Target, seen.Body, seen.Header("authorization"), seen.Header("content-type"));

    [Fact]
    public async Task A_services_redirects_are_followed_only_while_each_one_stays_off_link_local_and_metadata_addresses()
    {
        await using var server = Server();
        using var fetcher = new HttpClientFetcher();
        // A service on this computer is fine; a redirect to a metadata address is refused before it is asked.
        var error = await Assert.ThrowsAsync<MetadataAddressError>(() => Safefetch.ServiceFetchAsync(server.Base + "/metadata", Ask(), fetcher));
        Assert.Equal("169.254.169.254", error.Host);
        Assert.Equal("169.254.169.254 is a link-local or cloud metadata address, which Runlight never connects to", error.Message);
        error = await Assert.ThrowsAsync<MetadataAddressError>(() => Safefetch.ServiceFetchAsync(server.Base + "/metadata-v6", Ask(), fetcher));
        Assert.Equal("fd00:ec2::254", error.Host);
        await Assert.ThrowsAsync<MetadataAddressError>(() => Safefetch.ServiceFetchAsync("http://169.254.169.254/v1/models", new FetchInit(), fetcher));

        // Followed as fetch follows them while the origin stays the same: a 303 goes on as a GET with no body,
        // and a 307 keeps both.
        server.Clear();
        Assert.Equal("ok", (await Safefetch.ServiceFetchAsync(server.Base + "/see-other", Ask(), fetcher)).Text());
        Assert.Equal(("GET", "/landed", "", "Bearer key", ""), Shape(server.Requests[1]));
        server.Clear();
        await Safefetch.ServiceFetchAsync(server.Base + "/keep", Ask(), fetcher);
        Assert.Equal(("POST", "/landed", "{}", "Bearer key", "application/json"), Shape(server.Requests[1]));
        // A redirect to another origin is refused before anything is sent there, key and body alike.
        server.Clear();
        var elsewhere = await Assert.ThrowsAsync<RedirectRefusedError>(() => Safefetch.ServiceFetchAsync(server.Base + "/elsewhere", Ask(), fetcher));
        Assert.Equal("http://localhost:" + server.Port, elsewhere.To);
        Assert.Single(server.Requests);

        // Past the last redirect, the redirect comes back as it is.
        server.Clear();
        Assert.Equal(302, (await Safefetch.ServiceFetchAsync(server.Base + "/loop", new FetchInit(), fetcher, redirects: 2)).Status);
        Assert.Equal(3, server.Requests.Count);

        // The AI assistant and a mail webhook refuse such a redirect with the address it led to.
        var refused = await Assert.ThrowsAsync<AssistantError>(() => Assistant.ListModelsAsync(new JsObject { ["provider"] = "custom", ["baseUrl"] = server.Base + "/metadata#", ["key"] = "" }, fetcher));
        Assert.Equal("address_refused", refused.Code);
        Assert.Equal("{\"host\":\"169.254.169.254\"}", Json.Stringify(refused.Params));
        var message = new JsObject { ["to"] = "me@example.com", ["from"] = "reports@example.com", ["subject"] = "Hi", ["html"] = "<p>Hi</p>", ["text"] = "Hi" };
        var mail = await Assert.ThrowsAsync<MailError>(() => Transports.SendAsync(new JsObject { ["service"] = "webhook", ["url"] = "http://localhost:" + server.Port + "/metadata" }, message, fetcher));
        Assert.Equal("address_refused", mail.Code);
        Assert.Equal("169.254.169.254 is a link-local or cloud metadata address, which Runlight never connects to", mail.Message);
        Assert.Equal("{\"host\":\"169.254.169.254\"}", Json.Stringify(mail.Params));
    }

    /// <summary>A proxy for every address, as HTTPS_PROXY or a system proxy would be.</summary>
    private sealed class EveryAddress(Uri proxy) : IWebProxy
    {
        public ICredentials? Credentials { get; set; }

        public Uri GetProxy(Uri destination) => proxy;

        public bool IsBypassed(Uri host) => false;
    }

    [Fact]
    public async Task A_pinned_request_connects_to_its_checked_address_and_never_through_a_proxy()
    {
        await using var target = new LocalHttp(seen => seen.Target == "/away"
            ? new(302, new() { ["location"] = "http://elsewhere.test:" + seen.Header("host").Split(':')[^1] + "/" })
            : new(200, null, "direct"));
        await using var proxy = new LocalHttp(_ => new(200, null, "proxied"));
        using var fetcher = new HttpClientFetcher(new EveryAddress(new Uri(proxy.Base)));
        string url = "http://pinned.test:" + target.Port + "/";

        // Not pinned: the proxy takes it, as it would any other request.
        Assert.Equal("proxied", (await fetcher.FetchAsync(url)).Text());
        Assert.Single(proxy.Requests);

        // Pinned: straight to the checked address, the proxy never asked.
        var pins = new List<string> { "pinned.test:" + target.Port + ":127.0.0.1" };
        Assert.Equal("direct", (await fetcher.FetchAsync(url, new FetchInit { Resolve = pins, Redirect = "manual" })).Text());
        Assert.Single(proxy.Requests);

        // A redirect to a host the pins do not name is refused, never looked up or sent to the proxy.
        await Assert.ThrowsAsync<FetchException>(() => fetcher.FetchAsync(url + "away", new FetchInit { Resolve = pins }));
        Assert.Single(proxy.Requests);
        Assert.Equal(["/", "/away"], target.Requests.Select(r => r.Target));
    }

    private static FetchInit Keyed(params string[] names)
    {
        var headers = new Headers { ["content-type"] = "application/json" };
        foreach (string name in names)
        {
            headers.Set(name, "secret");
        }
        return new FetchInit { Method = "POST", Headers = headers, BodyText = "{\"private\":\"conversation\"}" };
    }

    private static FakeFetcher Redirecting(int status, string to) =>
        new((_, _) => new Response("", status, new Headers { ["location"] = to }));

    [Fact]
    public async Task A_redirect_to_another_origin_is_refused_with_no_second_request()
    {
        string[] keys = ["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key", "x-postmark-server-token"];
        foreach (var (status, to, shown) in new[]
        {
            (307, "http://198.51.100.7/collect", "http://198.51.100.7"),
            (308, "http://api.example.com/v1", "http://api.example.com"),
            (302, "https://other.example.net:8443/", "https://other.example.net:8443"),
            (307, "ftp://files.example.net/", "ftp:"),
        })
        {
            var fetcher = Redirecting(status, to);
            var error = await Assert.ThrowsAsync<RedirectRefusedError>(() => Safefetch.ServiceFetchAsync("https://api.example.com/v1/messages", Keyed(keys), fetcher));
            Assert.Equal("api.example.com", error.Host);
            Assert.Equal(shown, error.To);
            Assert.Equal("api.example.com redirected to " + shown + ". Runlight sends a service's key and request only to the address it was set up with, so set it up with that address instead", error.Message);
            Assert.Single(fetcher.Requests);
        }

        // A redirect to a metadata address is still the address refusal.
        var metadata = Redirecting(307, "http://169.254.169.254/latest");
        await Assert.ThrowsAsync<MetadataAddressError>(() => Safefetch.ServiceFetchAsync("https://api.example.com/v1/messages", Keyed(keys), metadata));
        Assert.Single(metadata.Requests);

        // On the same origin it is followed, with a 307 keeping the body.
        int calls = 0;
        var same = new FakeFetcher((url, _) => ++calls == 1 ? new Response("", 307, new Headers { ["location"] = "/v2/messages" }) : new Response("done"));
        Assert.Equal("done", (await Safefetch.ServiceFetchAsync("https://api.example.com/v1/messages", Keyed(keys), same)).Text());
        Assert.Equal("https://api.example.com/v2/messages", same.Requests[1].Url);
        Assert.Equal("{\"private\":\"conversation\"}", same.Requests[1].Body);
        Assert.Equal("secret", same.Requests[1].Headers.Str("x-api-key"));
    }

    [Fact]
    public async Task Each_provider_refuses_a_redirect_with_its_own_key_header_held_back()
    {
        var anthropic = Redirecting(307, "http://198.51.100.7/");
        var settings = new JsObject { ["provider"] = "anthropic", ["model"] = "m", ["baseUrl"] = "", ["key"] = "k" };
        var chat = await Assert.ThrowsAsync<AssistantError>(() => Assistant.ChatAsync(settings, [new() { ["role"] = "user", ["content"] = "Hi?" }], new JsObject { ["site"] = new JsObject { ["id"] = "default", ["name"] = "Blog", ["timezone"] = "UTC" }, ["today"] = "2026-10-08", ["view"] = "today", ["language"] = "en" }, McpTests.ReadApi([]), anthropic));
        Assert.Equal("redirect_refused", chat.Code);
        Assert.Equal("{\"host\":\"api.anthropic.com\",\"to\":\"http://198.51.100.7\"}", Json.Stringify(chat.Params));
        Assert.Single(anthropic.Requests);

        var listing = Redirecting(307, "http://198.51.100.7/");
        var listed = await Assert.ThrowsAsync<AssistantError>(() => Assistant.ListModelsAsync(settings, listing));
        Assert.Equal("redirect_refused", listed.Code);
        Assert.Single(listing.Requests);

        var message = new JsObject { ["to"] = "me@example.com", ["from"] = "reports@example.com", ["subject"] = "Hi", ["html"] = "<p>Hi</p>", ["text"] = "Hi" };
        foreach (var config in new[]
        {
            new JsObject { ["service"] = "brevo", ["apiKey"] = "key" },
            new JsObject { ["service"] = "postmark", ["serverToken"] = "token" },
            new JsObject { ["service"] = "resend", ["apiKey"] = "key" },
            new JsObject { ["service"] = "webhook", ["url"] = "https://hooks.example.net/mail" },
        })
        {
            var fetcher = Redirecting(307, "http://198.51.100.7/collect");
            var mail = await Assert.ThrowsAsync<MailError>(() => Transports.SendAsync(config, message, fetcher));
            Assert.Equal("redirect_refused", mail.Code);
            Assert.Equal("http://198.51.100.7", mail.Params.Str("to"));
            Assert.Single(fetcher.Requests);
        }
    }

    [Fact]
    public async Task A_service_is_fetched_from_the_address_its_name_was_checked_at()
    {
        // A name is looked up once and the request pinned to what it gave, a private address included.
        var fetcher = new FakeFetcher((_, _) => new Response("ok")) { Dns = _ => ["127.0.0.1", "::1"] };
        await Safefetch.ServiceFetchAsync("https://models.local.test/v1/models", new FetchInit(), fetcher);
        Assert.Equal(["models.local.test:443:127.0.0.1,[::1]"], fetcher.Requests[0].Init.Resolve);
        await Safefetch.ServiceFetchAsync("http://models.local.test:11434/v1/models", new FetchInit(), fetcher);
        Assert.Equal(["models.local.test:11434:127.0.0.1,[::1]"], fetcher.Requests[1].Init.Resolve);

        // Any link-local or metadata address among them refuses the name, and nothing is sent.
        var metadata = new FakeFetcher((_, _) => new Response("ok")) { Dns = _ => ["93.184.215.14", "169.254.169.254"] };
        var refused = await Assert.ThrowsAsync<MetadataAddressError>(() => Safefetch.ServiceFetchAsync("https://rebind.example.com/", new FetchInit(), metadata));
        Assert.Equal("rebind.example.com", refused.Host);
        Assert.Empty(metadata.Requests);
        var v6 = new FakeFetcher((_, _) => new Response("ok")) { Dns = _ => ["fd00:ec2::254"] };
        await Assert.ThrowsAsync<MetadataAddressError>(() => Safefetch.ServiceFetchAsync("https://rebind6.example.com/", new FetchInit(), v6));
        Assert.Empty(v6.Requests);

        // A name that does not resolve fails closed.
        var gone = new FakeFetcher((_, _) => new Response("ok")) { Dns = _ => [] };
        var missing = await Assert.ThrowsAsync<FetchException>(() => Safefetch.ServiceFetchAsync("https://nowhere.example.com/", new FetchInit(), gone));
        Assert.Equal("Could not look up nowhere.example.com", missing.Message);
        Assert.Empty(gone.Requests);

        // A literal address needs no lookup, and is not pinned.
        var literal = new FakeFetcher((_, _) => new Response("ok")) { Dns = _ => throw new InvalidOperationException("looked up") };
        await Safefetch.ServiceFetchAsync("http://127.0.0.1:11434/v1/models", new FetchInit(), literal);
        Assert.Empty(literal.Requests[0].Init.Resolve);
    }
}
