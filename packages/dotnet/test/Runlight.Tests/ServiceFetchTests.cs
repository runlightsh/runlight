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

        // Followed as fetch follows them: a 303 goes on as a GET with no body, a 307 keeps both, and the key
        // goes no further than the origin it was meant for.
        server.Clear();
        Assert.Equal("ok", (await Safefetch.ServiceFetchAsync(server.Base + "/see-other", Ask(), fetcher)).Text());
        Assert.Equal(("GET", "/landed", "", "Bearer key", ""), Shape(server.Requests[1]));
        server.Clear();
        await Safefetch.ServiceFetchAsync(server.Base + "/keep", Ask(), fetcher);
        Assert.Equal(("POST", "/landed", "{}", "Bearer key", "application/json"), Shape(server.Requests[1]));
        server.Clear();
        await Safefetch.ServiceFetchAsync(server.Base + "/elsewhere", Ask(), fetcher);
        Assert.Equal(("POST", "/landed", "{}", "", "application/json"), Shape(server.Requests[1]));

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
}
