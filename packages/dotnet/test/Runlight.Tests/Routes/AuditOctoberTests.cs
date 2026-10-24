using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using Runlight.Accounts;
using Runlight.Db;
using Runlight.Http;
using Runlight.Store;
using Runlight.Tests.Core;
using Runlight.Tests.Store;
using Xunit;
using static Runlight.Tests.Routes.Make;

namespace Runlight.Tests.Routes;

/// <summary>The audit of 2026-10-23, as audit.test.ts tests it: tokens and members, signing out, cross-site forms, salts, retried hits, funnels, and link events.</summary>
public sealed class AuditOctoberTests : RoutesTestCase
{
    private static readonly Headers Bearer = H(("authorization", "Bearer secret"));

    private static Request AccountReq(string path, string method = "GET", Headers? headers = null, string? body = null) =>
        new("https://example.com/runlight" + path, method, headers ?? new Headers(), body ?? "");

    private static Request FormPost(string path, (string Name, string Value)[] fields, params (string Name, string Value)[] headers)
    {
        var parameters = new SearchParams();
        foreach (var (name, value) in fields)
        {
            parameters.Append(name, value);
        }
        var h = H(("content-type", "application/x-www-form-urlencoded"));
        foreach (var (name, value) in headers)
        {
            h.Set(name, value);
        }
        return AccountReq(path, "POST", h, parameters.ToString());
    }

    private static string CookieOf(Response response) => (response.Headers.Get("set-cookie") ?? "").Split(';')[0];

    /// <summary>An install with accounts: its owner, and a member who joined by invite.</summary>
    private sealed class WithMember
    {
        public required global::Runlight.Routes Routes { get; init; }

        public required string Owner { get; init; }

        public required string Member { get; init; }

        public Task<Response> HandleAsync(Request request) => Routes.HandleAsync(request);

        public Task<Response> JsonAsync(string cookie, string method, string path, object? body = null) =>
            Routes.HandleAsync(AccountReq(path, method, H(("cookie", cookie), ("content-type", "application/json")), body == null ? null : global::Runlight.Json.Stringify(body)));

        public static async Task<WithMember> CreateAsync()
        {
            var rl = new Runlight(new RunlightOptions { Store = await Databases.FreshAsync("sqlite"), Secret = new string('k', 64) });
            var routes = rl.Routes(new RoutesOptions { Token = "app-token", Accounts = true });
            string owner = CookieOf(await routes.HandleAsync(FormPost("/setup", [("code", "app-token"), ("email", "jon@example.com"), ("password", "a long password"), ("again", "a long password")])));
            var sent = Obj(await routes.HandleAsync(AccountReq("/api/people", "POST", H(("cookie", owner), ("content-type", "application/json")), global::Runlight.Json.Stringify(new JsObject { ["allSites"] = true, ["email"] = "mo@example.com", ["role"] = "member" }))));
            var invite = new Url(sent.Str("link")!);
            string member = CookieOf(await routes.HandleAsync(FormPost("/invite", [("code", invite.SearchParams.Get("code") ?? ""), ("password", "a long password"), ("again", "a long password")])));
            return new WithMember { Routes = routes, Owner = owner, Member = member };
        }
    }

    private static readonly (string, string)[] MoSignsIn = [("email", "mo@example.com"), ("password", "a long password"), ("next", "/runlight/")];

    [Fact]
    public async Task A_member_sees_and_revokes_only_the_tokens_they_made_and_cannot_replace_a_sites_agents_key()
    {
        var t = await WithMember.CreateAsync();
        async Task<string> Make(string cookie, string name) => Obj(await t.JsonAsync(cookie, "POST", "/api/tokens", new JsObject { ["name"] = name })).Obj("token")!.Str("id")!;
        string owners = await Make(t.Owner, "Owner's");
        string mine = await Make(t.Member, "Member's");
        async Task<string[]> Listed(string cookie) =>
            [.. Obj(await t.JsonAsync(cookie, "GET", "/api/tokens")).Arr("tokens")!.Cast<JsObject>().Select(o => o.Str("id")!).Order(StringComparer.Ordinal)];
        string[] both = [.. new[] { owners, mine }.Order(StringComparer.Ordinal)];
        Assert.Equal([mine], await Listed(t.Member));
        Assert.Equal(both, await Listed(t.Owner)); // the owner sees every token
        Assert.Equal(404, (await t.JsonAsync(t.Member, "DELETE", "/api/tokens/" + owners)).Status); // the owner's token is not the member's to revoke
        Assert.Equal(both, await Listed(t.Owner));
        Assert.Equal(200, (await t.JsonAsync(t.Member, "DELETE", "/api/tokens/" + mine)).Status);
        Assert.Equal(403, (await t.JsonAsync(t.Member, "POST", "/api/observe-key/new?site=default", new JsObject())).Status);
        Assert.Equal(200, (await t.JsonAsync(t.Owner, "POST", "/api/observe-key/new?site=default", new JsObject())).Status);
    }

    [Fact]
    public async Task Signing_out_ends_this_browsers_session_signing_out_everywhere_ends_them_all_and_only_from_the_dashboards_own_pages()
    {
        var t = await WithMember.CreateAsync();
        string other = CookieOf(await t.HandleAsync(FormPost("/login", MoSignsIn)));
        var crossSite = await t.HandleAsync(AccountReq("/logout", "GET", H(("cookie", t.Member), ("sec-fetch-site", "cross-site"))));
        Assert.Equal(403, crossSite.Status); // another site cannot sign anyone out
        var signedOut = await t.HandleAsync(AccountReq("/logout", "GET", H(("cookie", t.Member), ("sec-fetch-site", "same-origin"))));
        Assert.Equal(303, signedOut.Status);
        Assert.Contains("max-age=0", signedOut.Headers.Get("set-cookie") ?? "", StringComparison.OrdinalIgnoreCase); // this browser's cookie goes
        Assert.Equal(200, (await t.JsonAsync(other, "GET", "/api/account")).Status); // the other browser stays signed in

        string third = CookieOf(await t.HandleAsync(FormPost("/login", MoSignsIn)));
        var ended = await t.JsonAsync(other, "POST", "/api/account/sign-out-everywhere", new JsObject());
        Assert.Equal(200, ended.Status);
        Assert.Contains("max-age=0", ended.Headers.Get("set-cookie") ?? "", StringComparison.OrdinalIgnoreCase);
        Assert.Equal(401, (await t.JsonAsync(other, "GET", "/api/account")).Status); // the browser that asked is signed out
        Assert.Equal(401, (await t.JsonAsync(third, "GET", "/api/account")).Status); // and so is every other
        Assert.Equal(401, (await t.JsonAsync(t.Member, "GET", "/api/account")).Status); // and a cookie copied before
        string back = CookieOf(await t.HandleAsync(FormPost("/login", MoSignsIn)));
        Assert.Equal(200, (await t.JsonAsync(back, "GET", "/api/account")).Status); // signing in again works
    }

    [Fact]
    public async Task The_sign_in_forms_take_a_post_only_from_their_own_pages()
    {
        var t = await WithMember.CreateAsync();
        foreach (string site in new[] { "cross-site", "same-site" })
        {
            var refused = await t.HandleAsync(FormPost("/login", MoSignsIn, ("sec-fetch-site", site)));
            Assert.Equal(403, refused.Status);
            Assert.Null(refused.Headers.Get("set-cookie")); // no session is planted
        }
        var own = await t.HandleAsync(FormPost("/login", MoSignsIn, ("sec-fetch-site", "same-origin")));
        Assert.Equal(303, own.Status);
    }

    [Fact]
    public async Task A_new_password_can_take_back_the_tokens_the_account_made()
    {
        var t = await WithMember.CreateAsync();
        await t.JsonAsync(t.Member, "POST", "/api/tokens", new JsObject { ["name"] = "Kept" });
        string fresh = CookieOf(await t.JsonAsync(t.Member, "POST", "/api/account/password", new JsObject { ["current"] = "a long password", ["next"] = "another long password" }));
        var kept = await t.JsonAsync(fresh, "GET", "/api/tokens");
        Assert.Equal(200, kept.Status);
        Assert.Single(Obj(kept).Arr("tokens")!); // kept unless asked
        string latest = CookieOf(await t.JsonAsync(fresh, "POST", "/api/account/password", new JsObject { ["current"] = "another long password", ["next"] = "a third long password", ["revokeTokens"] = true }));
        Assert.Empty(Obj(await t.JsonAsync(latest, "GET", "/api/tokens")).Arr("tokens")!);
    }

    [Fact]
    public async Task A_flood_of_made_up_names_cannot_reset_the_count_of_one_close_to_its_limit()
    {
        // The counts live in the database here, so the flood is written straight in: a fresh throttle reads them all
        // back on its first new count, as one past the ceiling would.
        var store = await Databases.FreshAsync("sqlite");
        await store.MigrateAsync();
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var throttle = new Throttle(store, "flood", 3);
        Assert.True(await throttle.TakeAsync("target", now));
        Assert.True(await throttle.TakeAsync("target", now));
        string entry = global::Runlight.Json.Stringify(new JsObject { ["count"] = 1L, ["until"] = now + 15 * 60_000 });
        await DbExtensions.TransactionAsync(store.Db, async db =>
        {
            for (int i = 0; i < 10_050; i++)
            {
                await db.RunAsync("INSERT INTO rl_settings (\"key\", value) VALUES (?, ?)", ["throttle:flood:made-up-" + i, entry]);
            }
        });
        Assert.True(await new Throttle(store, "flood", 3).TakeAsync("one-more", now));
        Assert.Equal(9_000, (await store.SettingsStartingWithAsync("throttle:flood:")).Count);
        Assert.True(await throttle.TakeAsync("target", now));
        Assert.False(await throttle.TakeAsync("target", now)); // the target's earlier tries still count
    }

    [Fact]
    public async Task Yesterdays_salt_leaves_memory_when_it_leaves_the_store_on_the_first_hit_after_midnight()
    {
        var t = await Harness.CreateAsync("sqlite", new SiteOptions { Hostnames = ["example.com"], Timezone = "UTC" });
        await t.SendAsync(new JsObject { ["k"] = "pageview", ["u"] = "https://example.com/" });
        t.Advance(13 * Harness.HOUR);
        await t.SendAsync(new JsObject { ["k"] = "pageview", ["u"] = "https://example.com/" }, ip: "203.0.113.9");
        var salts = (ConcurrentDictionary<string, (string Day, string Today, string? Yesterday)>)typeof(Runlight).GetField("_salts", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(t.Rl)!;
        var cached = salts["UTC"];
        Assert.Equal("2026-10-07", cached.Day);
        Assert.Null(cached.Yesterday); // no visit was left open, so yesterday's salt is gone from here too
    }

    [Fact]
    public async Task A_hit_tried_again_after_the_store_was_busy_counts_once()
    {
        var watched = new WatchedDb((await Databases.FreshAsync("sqlite")).Db);
        var t = Harness.Create(new SqlStore(watched), new SiteOptions { Hostnames = ["example.com"], Timezone = "UTC" });
        await t.Rl.InitAsync();
        int fail = 2;
        watched.Before = (sql, _) =>
        {
            if (sql.StartsWith("INSERT INTO rl_events", StringComparison.Ordinal) && fail-- > 0)
            {
                throw new InvalidOperationException("SQLITE_BUSY: database is locked");
            }
            return Task.CompletedTask;
        };
        await t.SendAsync(new JsObject { ["k"] = "pageview", ["u"] = "https://example.com/", ["i"] = "p1" });
        fail = 1;
        await t.SendAsync(new JsObject { ["k"] = "engagement", ["u"] = "https://example.com/", ["i"] = "p1", ["e"] = 5000L });
        watched.Before = null;
        var visit = (await t.Store.Db.AllAsync("SELECT pageviews, engaged_ms FROM rl_sessions")).Single();
        Assert.Equal(1, Sql.Num(visit.Get("pageviews")));
        Assert.Equal(5000, Sql.Num(visit.Get("engaged_ms")));
        Assert.Single(await t.Store.Db.AllAsync("SELECT id FROM rl_events WHERE kind = 'pageview'"));
    }

    [Fact]
    public async Task A_funnel_over_more_visits_than_the_cap_counts_the_newest_and_says_so()
    {
        var t = await Harness.CreateAsync("sqlite", new SiteOptions { Hostnames = ["example.com"], Timezone = "UTC" });
        var routes = t.Rl.Routes(new RoutesOptions { Token = "secret" });
        t.Store.FunnelVisits = 2;
        foreach (string ip in new[] { "203.0.113.1", "203.0.113.2", "203.0.113.3" })
        {
            await t.SendAsync(new JsObject { ["k"] = "pageview", ["u"] = "https://example.com/pricing" }, ip: ip);
            t.Advance(Harness.MIN);
        }
        var steps = new System.Collections.Generic.List<object?> { new JsObject { ["kind"] = "page", ["match"] = "/pricing" }, new JsObject { ["kind"] = "page", ["match"] = "/thanks" } };
        Assert.Equal(201, (await routes.HandleAsync(Owner("/runlight/api/funnels?site=default", "POST", new JsObject { ["name"] = "F", ["steps"] = steps }))).Status);
        async Task<JsObject> Funnel() => (JsObject)Obj(await routes.HandleAsync(Req("/runlight/api/funnels?period=today", "GET", Bearer))).Arr("funnels")![0]!;
        var funnel = await Funnel();
        Assert.Equal(2, funnel.Num("sampled"));
        Assert.Equal(2, ((JsObject)funnel.Arr("steps")![0]!).Num("visits"));
        t.Store.FunnelVisits = 10;
        Assert.False((await Funnel()).Has("sampled"));
    }

    [Fact]
    public async Task An_automatic_link_event_keeps_its_link_without_the_query_string_or_fragment()
    {
        var t = await Harness.CreateAsync("sqlite", new SiteOptions { Hostnames = ["example.com"], Timezone = "UTC" });
        await t.SendAsync(new JsObject { ["k"] = "event", ["u"] = "https://example.com/", ["n"] = "Outbound link", ["p"] = new JsObject { ["url"] = "https://other.example/reset?token=abc&email=a@b.example#top" } });
        await t.SendAsync(new JsObject { ["k"] = "event", ["u"] = "https://example.com/", ["n"] = "File download", ["p"] = new JsObject { ["url"] = "https://example.com/a.pdf?sig=x" } });
        await t.SendAsync(new JsObject { ["k"] = "event", ["u"] = "https://example.com/", ["n"] = "Signup", ["p"] = new JsObject { ["url"] = "https://example.com/?plan=pro" } });
        var rows = await t.Store.Db.AllAsync("SELECT name, props FROM rl_events ORDER BY name");
        Assert.Equal(
            ["File download https://example.com/a.pdf", "Outbound link https://other.example/reset", "Signup https://example.com/?plan=pro"],
            rows.Select(r => Sql.S(r.Get("name")) + " " + ((JsObject)global::Runlight.Json.Parse(Sql.S(r.Get("props")))!).Str("url")));
    }
}
