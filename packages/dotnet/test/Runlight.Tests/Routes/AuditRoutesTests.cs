using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Runlight.Http;
using Runlight.Tests.Core;
using Xunit;
using static Runlight.Tests.Routes.Make;

namespace Runlight.Tests.Routes;

/// <summary>What the audit of 2026-10-16 changed at the routes: hostname suggestions, whole-number paging, journeys' pages, test emails, agents keys, and one-site accounts.</summary>
public sealed class AuditRoutesTests : RoutesTestCase
{
    private const string Chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
    private static readonly Headers Owner = H(("authorization", "Bearer secret"));

    private static async Task HitAsync(global::Runlight.Routes routes, string url, string id, string ip)
    {
        var headers = H(("user-agent", Chrome), ("x-forwarded-for", ip), ("content-type", "text/plain;charset=UTF-8"));
        await routes.HandleAsync(new Request("https://example.com/runlight/e", "POST", headers, Json.Stringify(new JsObject { ["k"] = "pageview", ["u"] = url, ["i"] = id })));
    }

    private static async Task<JsObject> GetAsync(global::Runlight.Routes routes, string path) =>
        (JsObject)Json.Parse((await routes.HandleAsync(Req("/runlight" + path, "GET", Owner))).Text())!;

    [Theory]
    [MemberData(nameof(Databases.KindData), MemberType = typeof(Databases))]
    public async Task Hostname_suggestions_step_through_hostnames_in_the_order_they_are_sorted_in(string kind)
    {
        // A locale's own order puts blog-staging after blog, where byte order puts it before, so suggestions taken
        // one after another in byte order must compare in byte order too, or one is skipped (Postgres on Linux).
        long now = Time.Utc(2026, 9, 6, 12);
        var rl = await RunlightAsync(sites: [Site("a", hostnames: ["blog.example.com", "blog-staging.example.com", "shop.example.com"]), Site("other", hostnames: ["private.example.com"])], now: () => now, store: await Databases.FreshAsync(kind));
        var routes = rl.Routes(new RoutesOptions { Token = "secret" });
        await HitAsync(routes, "https://blog.example.com/", "a", "203.0.113.2");
        await HitAsync(routes, "https://blog-staging.example.com/pricing", "b", "203.0.113.3");
        await HitAsync(routes, "https://shop.example.com/", "c", "203.0.113.4");
        await HitAsync(routes, "https://private.example.com/", "d", "203.0.113.5");
        string path = "/api/breakdown?site=a&period=today&dimension=hostname&suggestions=1";
        Assert.Equal(["blog-staging.example.com", "blog.example.com", "shop.example.com"], (await GetAsync(routes, path)).Arr("rows")!.Cast<JsObject>().Select(r => r.Str("value")!));
        Assert.Equal(["blog-staging.example.com"], (await GetAsync(routes, path + "&limit=1")).Arr("rows")!.Cast<JsObject>().Select(r => r.Str("value")!));
        Assert.Equal(["blog-staging.example.com"], (await GetAsync(routes, path + "&filter=" + Js.EncodeURIComponent("page:is:/pricing"))).Arr("rows")!.Cast<JsObject>().Select(r => r.Str("value")!));
        Assert.Empty((await GetAsync(routes, path + "&filter=" + Js.EncodeURIComponent("page:is:/missing"))).Arr("rows")!);
        Assert.Equal(401, (await routes.HandleAsync(Req("/runlight" + path))).Status);
    }

    [Fact]
    public async Task Paging_takes_whole_numbers_only()
    {
        var rl = await RunlightAsync(site: Site(hostnames: ["example.com"]));
        var routes = rl.Routes(new RoutesOptions { Token = "secret" });
        foreach (string query in new[] { "limit=2.5", "page=1e20", "limit=-3&page=0", "limit=abc&page=2.5" })
        {
            Assert.Equal(200, (await routes.HandleAsync(Req("/runlight/api/breakdown?period=7d&dimension=page&" + query, "GET", Owner))).Status);
        }
    }

    [Fact]
    public async Task A_journeys_start_end_and_through_take_a_page_as_written_as_filters_do()
    {
        long now = Time.Utc(2026, 10, 6, 12);
        var rl = await RunlightAsync(site: Site(hostnames: ["example.com"]), now: () => now);
        var routes = rl.Routes(new RoutesOptions { Token = "secret" });
        await HitAsync(routes, "https://example.com/café", "a", "203.0.113.1");
        now += 30_000;
        await HitAsync(routes, "https://example.com/pricing", "b", "203.0.113.1");
        string cafe = Js.EncodeURIComponent("/café");
        foreach (string query in new[]
        {
            "start=" + cafe,
            "start=" + Js.EncodeURIComponent("/caf%C3%A9"),
            "end=" + Js.EncodeURIComponent("/pricing") + "&start=" + cafe,
            "through=" + Js.EncodeURIComponent("0:/café"),
        })
        {
            Assert.Equal(1, (await GetAsync(routes, "/api/journeys?period=today&" + query)).Num("visits"));
        }
    }

    [Fact]
    public async Task A_test_email_goes_at_most_once_a_minute_through_each_mail_service()
    {
        long now = Time.Utc(2026, 10, 7, 12);
        var sent = new List<string>();
        var fetcher = new Router(Router.R("hooks\\.example\\.net", (url, init) =>
        {
            sent.Add(url.Href);
            return new JsObject();
        }));
        var rl = await RunlightAsync(site: Site(hostnames: ["example.com"]), now: () => now, fetcher: fetcher, secret: new string('k', 64));
        var routes = rl.Routes(new RoutesOptions { Token = "secret", Origin = "https://stats.example.com" });
        async Task<(int Status, JsObject Body)> CallAsync(string method, string path, object body)
        {
            var answer = await routes.HandleAsync(Req("/runlight" + path, method, H(("authorization", "Bearer secret"), ("content-type", "application/json")), Json.Stringify(body)));
            return (answer.Status, (JsObject)Json.Parse(answer.Text())!);
        }
        Assert.Equal(200, (await CallAsync("PUT", "/api/mail", new JsObject { ["service"] = "webhook", ["url"] = "https://hooks.example.net/runlight", ["from"] = "reports@example.com" })).Status);
        Assert.Equal(200, (await CallAsync("POST", "/api/mail/test", new JsObject { ["to"] = "me@example.com" })).Status);
        // Another test through it straight away waits a minute, so the button cannot flood an inbox.
        var again = await CallAsync("POST", "/api/mail/test", new JsObject { ["to"] = "me@example.com" });
        Assert.Equal((429, "test_soon"), (again.Status, again.Body.Str("code")));
        Assert.Single(sent);
        now += 60_000;
        Assert.Equal(200, (await CallAsync("POST", "/api/mail/test", new JsObject { ["to"] = "me@example.com" })).Status);
        Assert.Equal(2, sent.Count);
    }

    [Theory]
    [MemberData(nameof(Databases.KindData), MemberType = typeof(Databases))]
    public async Task A_sites_agents_key_is_kept_sealed_and_one_kept_as_plain_text_before_still_works_and_is_sealed_when_read(string kind)
    {
        var rl = await RunlightAsync(site: Site(hostnames: ["example.com"]), secret: new string('s', 32), store: await Databases.FreshAsync(kind));
        await rl.InitAsync();
        var routes = rl.Routes(new RoutesOptions { Token = "owner" });
        string key = await OAuth.AgentsKeyAsync(rl.Store, rl.Secret, "default");
        string stored = (await rl.Store.SettingAsync("observe-key:default"))!;
        Assert.DoesNotContain(key, stored, StringComparison.Ordinal); // not in the database as it is
        Assert.Equal(key, OAuth.OpenAgentsKey(stored, rl.Secret));
        async Task<int> ObserveAsync(string bearer)
        {
            var headers = H(("authorization", "Bearer " + bearer), ("content-type", "application/json"));
            var body = Json.Stringify(new JsObject { ["url"] = "https://example.com/", ["userAgent"] = "Mozilla/5.0 (compatible; GPTBot/1.2)" });
            return (await routes.HandleAsync(Req("/runlight/api/observe", "POST", headers, body))).Status;
        }
        Assert.Equal(204, await ObserveAsync(key));
        // A key from before, kept as it was.
        await rl.Store.SetSettingAsync("observe-key:default", "rlo_legacykeylegacykey00");
        Assert.Equal(204, await ObserveAsync("rlo_legacykeylegacykey00"));
        Assert.Equal("rlo_legacykeylegacykey00", await OAuth.AgentsKeyAsync(rl.Store, rl.Secret, "default")); // shown as it was
        Assert.DoesNotContain("rlo_legacy", (await rl.Store.SettingAsync("observe-key:default"))!, StringComparison.Ordinal); // and sealed now
        Assert.Equal(204, await ObserveAsync("rlo_legacykeylegacykey00")); // still working
        Assert.Equal(401, await ObserveAsync("rlo_wrongkeywrongkeywron"));
    }

    [Fact]
    public async Task An_account_kept_to_one_site_sees_no_mail_fields_and_cannot_change_its_hostnames()
    {
        var rl = new Runlight(new RunlightOptions { Store = await Databases.FreshAsync("sqlite"), Secret = new string('k', 64), Sites = [Site("blog", hostnames: ["blog.example.com"]), Site("shop", hostnames: ["shop.example.com"])] });
        var routes = rl.Routes(new RoutesOptions { Token = "app-token", Accounts = true });
        Task<Response> Handler(Request r) => routes.HandleAsync(r);
        static Request Form(string path, params (string Name, string Value)[] fields)
        {
            var parameters = new SearchParams();
            foreach (var (name, value) in fields)
            {
                parameters.Append(name, value);
            }
            return new Request("https://example.com" + path, "POST", H(("content-type", "application/x-www-form-urlencoded")), parameters.ToString());
        }
        static string CookieOf(Response response) => (response.Headers.Get("set-cookie") ?? "").Split(';')[0];
        Task<Response> Json(string cookie, string method, string path, object? body = null) =>
            Handler(new Request("https://example.com/runlight" + path, method, H(("cookie", cookie), ("content-type", "application/json")), body == null ? "" : global::Runlight.Json.Stringify(body)));

        string owner = CookieOf(await Handler(Form("/runlight/setup", ("code", "app-token"), ("email", "jon@example.com"), ("password", "a long password"), ("again", "a long password"))));
        var sent = (JsObject)global::Runlight.Json.Parse((await Json(owner, "POST", "/api/people", new JsObject { ["site"] = "blog", ["email"] = "mo@example.com", ["role"] = "member" })).Text())!;
        var link = new Url(sent.Str("link")!);
        string member = CookieOf(await Handler(Form("/runlight/invite", ("code", link.SearchParams.Get("code") ?? ""), ("password", "another long one"), ("again", "another long one"))));

        // A webhook's address is often its own credential, so the account sees which service sends and nothing more.
        var mail = (JsObject)global::Runlight.Json.Parse((await Json(member, "GET", "/api/mail")).Text())!;
        Assert.Empty(mail.Obj("fields")!);
        Assert.Empty(mail.Arr("saved")!);
        // It may rename its site, never move it.
        Assert.Equal(200, (await Json(member, "PATCH", "/api/sites/blog", new JsObject { ["name"] = "My blog" })).Status);
        var moved = await Json(member, "PATCH", "/api/sites/blog", new JsObject { ["hostnames"] = "evil.example" });
        Assert.Equal(403, moved.Status);
        Assert.Equal("site_domains", ((JsObject)global::Runlight.Json.Parse(moved.Text())!).Str("code"));
    }
}
