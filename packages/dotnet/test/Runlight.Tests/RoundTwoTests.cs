using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Runlight.Accounts;
using Runlight.Http;
using Runlight.Importers;
using Runlight.Server;
using Runlight.Store;
using Runlight.Tests.Core;
using Runlight.Tests.Routes;
using Xunit;
using Response = Runlight.Http.Response;

namespace Runlight.Tests;

/// <summary>
/// The behaviour the TypeScript reference gained in its review, where the shared fixtures and the conformance
/// scenarios do not already replay it: limits on clicks and AI fetches, text as it is stored, salts, the code
/// lockout, what an import keeps, and the standalone server's own rules.
/// </summary>
public sealed class RoundTwoTests : IAsyncLifetime
{
    private const string GptBot = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public async ValueTask DisposeAsync() => await Databases.CleanupAsync();

    private static SiteOptions Example => Make.Site(hostnames: ["example.com"]);

    // ---- ingestion

    [Fact]
    public async Task A_click_past_the_trackers_limit_still_redirects_and_is_not_counted()
    {
        var t = await Harness.CreateAsync("sqlite", Example, rateLimit: 2);
        await t.Rl.InitAsync();
        await t.Rl.Links.CreateAsync("default", new JsObject { ["url"] = "https://example.com/launch", ["slug"] = "launch" });
        Request Click(string ip) => new("https://example.com/go/launch", "GET", new Headers { ["user-agent"] = Harness.ChromeMac, ["x-forwarded-for"] = ip });
        for (int i = 0; i < 4; i++)
        {
            Assert.Equal(302, (await t.Rl.RedirectAsync(Click("203.0.113.1"), "launch", ""))!.Status);
        }
        Assert.Equal(2, await t.CountAsync("SELECT COUNT(*) AS n FROM rl_events WHERE kind = 'click'"));
        // The same counter as hits: this address has used its minute up.
        await t.SendAsync(new JsObject { ["k"] = "pageview", ["u"] = "https://example.com/", ["i"] = "pv1" });
        Assert.Equal(0, await t.CountAsync("SELECT COUNT(*) AS n FROM rl_events WHERE kind = 'pageview'"));
        // Another address has its own, and one with no address at all is not limited.
        Assert.Equal(302, (await t.Rl.RedirectAsync(Click("203.0.113.2"), "launch", ""))!.Status);
        Assert.Equal(3, await t.CountAsync("SELECT COUNT(*) AS n FROM rl_events WHERE kind = 'click'"));
    }

    [Fact]
    public async Task Live_ai_fetches_are_limited_at_ten_times_the_trackers_limit_and_reported_ones_never()
    {
        var t = await Harness.CreateAsync("sqlite", Example, rateLimit: 1);
        Request Page() => new("https://example.com/post", "GET", new Headers { ["user-agent"] = GptBot, ["x-forwarded-for"] = "203.0.113.1" });
        int live = 0;
        for (int i = 0; i < 12; i++)
        {
            live += await t.Rl.ObserveAsync(Page()) ? 1 : 0;
        }
        Assert.Equal(10, live);
        // A report names the agent's address, even as "", and is never limited.
        Assert.True(await t.Rl.ObserveAsync(Page(), agentIp: ""));
        Assert.True(await t.Rl.ObserveAsync(Page(), agentIp: "203.0.113.1"));

        var off = await Harness.CreateAsync("sqlite", Example, rateLimit: null);
        for (int i = 0; i < 12; i++)
        {
            Assert.True(await off.Rl.ObserveAsync(Page()));
        }
    }

    [Fact]
    public async Task An_ai_fetch_keeps_the_forwarded_host_only_from_a_trusted_proxy_and_takes_a_user_agent_as_text()
    {
        var t = await Harness.CreateAsync("sqlite", sites: [Make.Site("a", hostnames: ["a.example"]), Make.Site("b", hostnames: ["b.example"])]);
        var headers = new Headers { ["user-agent"] = GptBot, ["host"] = "a.example", ["x-forwarded-host"] = "www.b.example:8443, proxy.internal" };
        // From a private address the proxy's host counts: first value, no port, no www.
        Assert.True(await t.Rl.ObserveAsync(new Request("https://a.example/post", "GET", headers), ip: "10.0.0.1"));
        // From a public one it does not.
        Assert.True(await t.Rl.ObserveAsync(new Request("https://a.example/post", "GET", headers), ip: "8.8.8.8"));
        var rows = await t.Store.Db.AllAsync("SELECT site, hostname FROM rl_events WHERE kind = 'fetch' ORDER BY id");
        Assert.Equal(["b", "a"], rows.Select(r => r.Str("site")));
        Assert.Equal(["b.example", "a.example"], rows.Select(r => r.Str("hostname")));

        // The user agent as an argument stands in for the header, whatever a logged one holds.
        Assert.True(await t.Rl.ObserveAsync(new Request("https://a.example/logged", "GET"), userAgent: "GPTBot/1.2\n日本", agentIp: ""));
        Assert.False(await t.Rl.ObserveAsync(new Request("https://a.example/logged", "GET", new Headers { ["user-agent"] = GptBot }), userAgent: Harness.ChromeMac, agentIp: ""));
    }

    [Fact]
    public async Task Collect_never_raises_to_its_caller()
    {
        var watched = new Store.WatchedDb((await Databases.FreshAsync("sqlite")).Db) { Before = (_, _) => throw new InvalidOperationException("the database is down") };
        var t = Harness.Create(new SqlStore(watched), Example);
        await t.SendAsync(new JsObject { ["k"] = "pageview", ["u"] = "https://example.com/", ["i"] = "pv1" });
    }

    [Fact]
    public async Task A_newer_days_salt_is_never_deleted()
    {
        var store = await Databases.FreshAsync("sqlite");
        await store.MigrateAsync();
        foreach (string day in new[] { "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07" })
        {
            await store.SaltAsync(day, "salt-" + day);
        }
        // A process whose clock is a moment behind keeps yesterday and today as it sees them.
        await store.DropSaltsExceptAsync(["2026-10-05", "2026-10-06"]);
        Assert.Equal(["2026-10-05", "2026-10-06", "2026-10-07"], (await store.Db.AllAsync("SELECT day FROM rl_salts ORDER BY day")).Select(r => r.Str("day")));
    }

    [Fact]
    public void Text_is_stored_without_nul_with_whole_characters_and_cut_by_code_point()
    {
        Assert.Equal("ab", Payload.Tidy("a\0b"));
        Assert.Equal("a�b", Payload.Tidy("a\ud83db"));
        Assert.Equal("a�b", Payload.Tidy("a\ude00b"));
        Assert.Equal("a😀b", Payload.Tidy("a😀b"));
        string long500 = new string('x', 499) + "😀y";
        Assert.Equal(new string('x', 499) + "😀", Payload.CleanText(long500, 500));

        var hit = Payload.ParsePayload(Json.Stringify(new JsObject
        {
            ["k"] = "event",
            ["u"] = "https://example.com/?utm_source=a%00b",
            ["n"] = " Sign\0up ",
            ["t"] = "a\0b",
            ["l"] = "en\0",
            ["s"] = "de\0fault",
            ["p"] = new JsObject { [" \0 "] = "dropped", ["k\0ey"] = long500, ["lone"] = "x\ud83dy" },
        }))!;
        Assert.Equal("Signup", hit.Name);
        Assert.Equal("ab", hit.Title);
        Assert.Equal("en", hit.Language);
        Assert.Equal("default", hit.Site);
        Assert.Equal(["key", "lone"], hit.Props!.Keys);
        Assert.Equal(new string('x', 499) + "😀", hit.Props.Str("key"));
        Assert.Equal("x�y", hit.Props.Str("lone"));
        Assert.Equal("ab", Sources.ParsePage(hit.Url).Obj("utm")!.Str("source"));

        var place = Geo.Locate(new Headers(), "203.0.113.1", _ => new JsObject { ["country"] = "CA", ["region"] = "Que\0bec", ["city"] = "Mon\0treal" });
        Assert.Equal("CA-Quebec", place.Str("region"));
        Assert.Equal("Montreal", place.Str("city"));
    }

    [Fact]
    public void A_user_agent_is_read_no_further_than_512_characters()
    {
        string filler = Harness.ChromeMac + " " + new string('x', 512);
        Assert.Null(Ua.AiAgent(filler + " GPTBot/1.2"));
        Assert.NotNull(Ua.AiAgent("GPTBot/1.2 " + filler));
        Assert.False(Ua.IsBot(filler + " bot crawler spider"));
        Assert.Equal("Chrome", Ua.ParseClient(filler + " Firefox/1").Str("browser"));
        Assert.Equal("Chrome", Ua.ParseClient(Harness.ChromeMac, new JsObject { ["brands"] = new string(' ', 512) + "\"Brave\"" }).Str("browser"));

        const string Safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) ";
        foreach (string version in new[] { "Version/18 Safari/605.1.15", "Version/18.1.1 Safari/605.1.15", "Version/18.0 Mobile/15E148 Safari/604.1" })
        {
            var client = Ua.ParseClient(Safari + version);
            Assert.Equal("Safari", client.Str("browser"));
            Assert.Equal("18", client.Str("browserVersion"));
        }
    }

    [Fact]
    public void An_address_over_320_characters_is_no_email_address()
    {
        Assert.True(Runlight.IsEmail("jon@example.com"));
        Assert.True(Runlight.IsEmail(new string('a', 308) + "@example.com"));
        Assert.False(Runlight.IsEmail(new string('a', 309) + "@example.com"));
    }

    [Fact]
    public void The_icon_scan_reads_bounded_link_tags_only()
    {
        Assert.Equal(["https://example.com/a.png"], Icon.IconLinks("<LINK rel=icon href=/a.png><linkage rel=icon href=/b.png><link>", "https://example.com"));
        Assert.Empty(Icon.IconLinks("<link rel=icon " + new string('x', 4000) + " href=/a.png>", "https://example.com"));
        Assert.Empty(Icon.IconLinks("<link rel=icon <b> href=/a.png>", "https://example.com"));
        // A page of unclosed tags is read once, not once for every tag.
        var clock = System.Diagnostics.Stopwatch.StartNew();
        Assert.Empty(Icon.IconLinks(string.Concat(Enumerable.Repeat("<link ", 30_000)), "https://example.com"));
        Assert.True(clock.ElapsedMilliseconds < 5000);
    }

    [Fact]
    public async Task A_downloaded_range_list_is_used_only_while_it_is_newer_than_the_one_that_shipped()
    {
        var gpt = Ua.AiAgent(GptBot)!;
        string url = AgentCheck.BundledUrls.First(u => u.Contains("gptbot", StringComparison.Ordinal));
        long shipped = (long)Importers.Http.ParseDate(AgentCheck.BundledFetchedAt);
        var lists = new JsObject { [url] = Make.L("203.0.113.0/24") };
        async Task<string> CheckedAsync(JsObject saved)
        {
            var t = await Harness.CreateAsync("sqlite", Example);
            await t.Rl.InitAsync();
            await t.Store.SetSettingAsync("agent-ranges", Json.Stringify(saved));
            await t.Rl.CheckAsync();
            await t.Rl.ObserveAsync(new Request("https://example.com/post", "GET", new Headers { ["user-agent"] = GptBot }), agentIp: "203.0.113.7");
            return (await t.Store.Db.AllAsync("SELECT title FROM rl_events WHERE kind = 'fetch'"))[0].Str("title")!;
        }
        _ = gpt;
        // Downloaded after this version shipped: the stored list stands in for the bundled one.
        Assert.Equal("verified", await CheckedAsync(new JsObject { ["at"] = shipped + 1, ["lists"] = lists, ["fetched"] = new JsObject { [url] = shipped + 1 } }));
        // Downloaded before: the bundled list is the newer of the two.
        Assert.Equal("mismatch", await CheckedAsync(new JsObject { ["at"] = shipped + 1, ["lists"] = lists, ["fetched"] = new JsObject { [url] = shipped - 1 } }));
        // A copy from before each list's time was kept goes by its one time for all of them.
        Assert.Equal("verified", await CheckedAsync(new JsObject { ["at"] = shipped, ["lists"] = lists }));
        Assert.Equal("mismatch", await CheckedAsync(new JsObject { ["at"] = shipped - 1, ["lists"] = lists }));
    }

    // ---- accounts

    [Fact]
    public async Task Wrong_codes_lock_an_account_for_longer_each_time_and_a_lock_always_ends()
    {
        const long Min = 60_000;
        var store = await Databases.FreshAsync("sqlite");
        var tries = new Lockout(store, "code", 5);
        long now = 1_760_000_000_000;
        async Task<int> UntilLockedAsync()
        {
            int taken = 0;
            while (taken < 10 && await tries.TakeAsync("user", now))
            {
                taken++;
            }
            return taken;
        }
        Assert.Equal(5, await UntilLockedAsync());
        // Fifteen minutes from the fifth try, then thirty, an hour, and so on, up to a day.
        foreach (long minutes in new long[] { 15, 30, 60, 120, 240, 480, 960, 1440, 1440 })
        {
            now += minutes * Min - 1;
            Assert.False(await tries.TakeAsync("user", now));
            now += 1;
            Assert.Equal(5, await UntilLockedAsync());
        }
        // Another key, such as the account's own browser, counts apart, and a right code clears a key.
        Assert.True(await tries.TakeAsync("user\ndevice", now));
        await tries.ClearAsync("user");
        Assert.Equal(5, await UntilLockedAsync());

        // Before the fifth try, the count starts over fifteen minutes after the first.
        var other = new Lockout(store, "other", 5);
        for (int i = 0; i < 4; i++)
        {
            Assert.True(await other.TakeAsync("user", now));
        }
        now += 15 * Min;
        for (int i = 0; i < 4; i++)
        {
            Assert.True(await other.TakeAsync("user", now));
        }
        // A week with no lock and no try, and the key is forgotten, by the next try or by the sweep.
        Assert.NotEmpty(await store.SettingsStartingWithAsync("lockout:"));
        await Lockout.SweepAsync(store, now + 8 * 1440 * Min + 15 * Min);
        Assert.Empty(await store.SettingsStartingWithAsync("lockout:"));
    }

    // ---- store and importers

    [Fact]
    public async Task A_link_imported_once_and_deleted_since_still_exists_to_an_import()
    {
        var t = await Harness.CreateAsync("sqlite", Example);
        await t.Rl.InitAsync();
        var foreign = new JsObject { ["sourceId"] = "abc", ["slug"] = "launch", ["domain"] = "", ["name"] = "Launch", ["url"] = "https://example.com/launch", ["createdAt"] = t.Now };
        var history = new JsObject { ["clicks"] = Make.L(new JsObject { ["ts"] = t.Now - 1000 }) };
        Assert.Equal("created", (await Write.WriteLinkAsync(t.Rl, "default", "dub", foreign, history)).Str("status"));
        string id = Write.ImportedLinkId("dub", "abc");
        await t.Rl.Links.RemoveAsync(id);
        Assert.Null(await t.Store.LinkByIdAsync(id));
        Assert.True(await t.Store.LinkExistsAsync(id));
        Assert.False(await t.Store.LinkExistsAsync(new string('0', 24)));
        // Skipped, with its clicks left as they were.
        Assert.Equal("skipped", (await Write.WriteLinkAsync(t.Rl, "default", "dub", foreign, history)).Str("status"));
        Assert.Equal(1, await t.CountAsync("SELECT COUNT(*) AS n FROM rl_events WHERE link = ?", id));
    }

    [Fact]
    public async Task An_imported_link_brings_at_most_a_hundred_thousand_clicks()
    {
        var t = await Harness.CreateAsync("sqlite", Example);
        await t.Rl.InitAsync();
        var foreign = new JsObject { ["sourceId"] = "many", ["slug"] = "many", ["domain"] = "", ["name"] = "Many", ["url"] = "https://example.com/many", ["createdAt"] = t.Now };
        var daily = Enumerable.Range(1, 12).Select(d => (object?)new JsObject { ["day"] = "2026-09-" + d.ToString("00", System.Globalization.CultureInfo.InvariantCulture), ["clicks"] = 50_000.0 }).ToList();
        var written = await Write.WriteLinkAsync(t.Rl, "default", "dub", foreign, new JsObject { ["daily"] = daily });
        Assert.Equal((long)Write.MaxLinkClicks, Js.ToLong(written.Num("clicks")));
        Assert.Equal(Write.MaxLinkClicks, await t.CountAsync("SELECT COUNT(*) AS n FROM rl_events WHERE kind = 'click'"));
    }

    [Fact]
    public void An_import_keeps_names_and_never_an_address_or_a_user_agent()
    {
        Assert.Equal("Chrome", Write.Browser("chrome"));
        Assert.Equal("Arc", Write.Browser(" arc "));
        Assert.Equal("", Write.Browser(Harness.ChromeMac));
        Assert.Equal("", Write.Browser("203.0.113.7"));
        Assert.Equal("", Write.Browser("9front"));
        Assert.Equal("macOS", Write.System("Mac OS X"));
        Assert.Equal("Haiku", Write.System("Haiku"));
        Assert.Equal("", Write.System("fe80::1"));
        Assert.Equal("Montreal", Write.PlaceName("Montreal"));
        Assert.Equal("", Write.PlaceName("at 203.0.113.7"));
        Assert.Equal("", Write.PlaceName("2001:DB8::1"));
        Assert.Equal("", Write.PlaceName("Mozilla/5.0"));
        Assert.Equal("", Write.PlaceName("curl/8"));
        Assert.Equal("1.2.3.4.5", Write.PlaceName("1.2.3.4.5"));
        Assert.Equal("1440x900", Write.ScreenSize(" 1440x900 "));
        Assert.Equal("", Write.ScreenSize("1440 x 900"));
        Assert.Equal("pt-BR", Write.LanguageTag("pt-BR"));
        Assert.Equal("", Write.LanguageTag("English (US)"));

        // A row from before 2000 has no time, so a date written as a bare number is skipped.
        Assert.True(double.IsNaN(CsvVisits.RowTime(new JsObject { ["time"] = "20240501" }, "runlight")));
        Assert.True(double.IsNaN(CsvVisits.RowTime(new JsObject { ["time"] = "1999-12-31T23:59:59Z" }, "runlight")));
        Assert.Equal(946_684_800_000.0, CsvVisits.RowTime(new JsObject { ["time"] = "2000-01-01T00:00:00Z" }, "runlight"));
    }

    public static TheoryData<string> Kinds() => Databases.KindData();

    [Theory]
    [MemberData(nameof(Kinds))]
    public async Task Props_the_database_cannot_read_as_json_count_as_none_and_fail_no_report(string kind)
    {
        var t = await Harness.CreateAsync(kind, Example);
        await t.SendAsync(new JsObject { ["k"] = "pageview", ["u"] = "https://example.com/", ["i"] = "pv1" });
        foreach (string plan in new[] { "pro", "free", "team" })
        {
            await t.SendAsync(new JsObject { ["k"] = "event", ["u"] = "https://example.com/", ["i"] = "pv1", ["n"] = "Signup", ["p"] = new JsObject { ["plan"] = plan } });
        }
        // As JSON.stringify wrote them before text was cleaned on the way in: an escaped NUL, and half a surrogate pair.
        await t.Store.Db.RunAsync("UPDATE rl_events SET props = ? WHERE kind = 'event' AND props LIKE ?", ["{\"plan\":\"a\\u0000b\"}", "%free%"]);
        await t.Store.Db.RunAsync("UPDATE rl_events SET props = ? WHERE kind = 'event' AND props LIKE ?", ["{\"plan\":\"x\\ud83dy\"}", "%team%"]);
        var query = t.Query("2026-10-06", "2026-10-06");

        var keys = await t.Store.EventPropKeysAsync(query, "Signup");
        Assert.Equal("plan", Assert.Single(keys).Str("key"));
        var values = await t.Store.EventPropValuesAsync(query, "Signup", "plan", 10);
        Assert.Contains(values, v => v.Str("value") == "pro");
        if (kind == "postgres")
        {
            // Postgres reads neither row, so each counts as an event with no props.
            Assert.Equal(1.0, keys[0].Num("events"));
            Assert.Equal("pro", Assert.Single(values).Str("value"));
        }
    }

    [Fact]
    public async Task Connecting_an_install_takes_only_a_site_with_an_id_and_a_name_as_text()
    {
        JsObject? there = null;
        var fetcher = new FakeFetcher((url, _) => url.EndsWith("/api/token", StringComparison.Ordinal)
            ? Response.JsonOf(new JsObject { ["scope"] = "read", ["site"] = "" })
            : Response.JsonOf(new JsObject { ["sites"] = Make.L(there) }));
        var rl = await Make.RunlightAsync(managedSites: true, fetcher: fetcher);
        var input = new JsObject { ["remote"] = new JsObject { ["url"] = "https://app.example/runlight", ["token"] = "rl_token" } };
        foreach (var bad in new[]
        {
            new JsObject { ["id"] = 7.0, ["name"] = "Seven" },
            new JsObject { ["id"] = "", ["name"] = "Empty" },
            new JsObject { ["id"] = new string('x', 65), ["name"] = "Long" },
            new JsObject { ["id"] = "ok", ["name"] = 7.0 },
        })
        {
            there = bad;
            var refused = await Assert.ThrowsAsync<SettingsError>(() => rl.AddSiteAsync(input));
            Assert.Equal("connect_not_runlight", refused.Code);
        }
        Assert.Empty(rl.Sites());
        Assert.Empty(await rl.Store.SettingsStartingWithAsync("remote:"));

        // Empty hostnames are ignored, the id starts at a letter or digit, and the name is trimmed to 80.
        there = new JsObject { ["id"] = "blog", ["name"] = "  " + new string('n', 90) + "  ", ["hostnames"] = Make.L("", "-.blog.example") };
        var site = await rl.AddSiteAsync(input);
        Assert.Equal("blog.example", site.Str("id"));
        Assert.Equal(new string('n', 80), site.Str("name"));
        Assert.Equal(Make.L("-.blog.example"), rl.Remote("blog.example")!.Arr("hostnames"));
    }

    // ---- the standalone server

    private static Standalone Server(SqlStore store, string? token = null, string? url = null, long now = 1_791_374_400_000) => new(new StandaloneOptions
    {
        Store = store,
        Secret = new string('s', 64),
        Token = token,
        Url = url,
        Now = () => now,
    });

    [Fact]
    public async Task The_servers_own_paths_are_kept_back_from_new_links()
    {
        var server = Server(await Databases.FreshAsync("sqlite"));
        var rl = server.Runlight;
        var site = await rl.AddSiteAsync(new JsObject { ["hostnames"] = Make.L("example.com") });
        string id = site.Str("id")!;
        foreach (string slug in new[] { "login", "logout", "setup", "invite", "healthz", "api", "mcp", "e", "embed", "pick-return" })
        {
            var refused = await Assert.ThrowsAsync<LinkError>(() => rl.Links.CreateAsync(id, new JsObject { ["url"] = "https://example.com/", ["slug"] = slug }));
            Assert.Equal("link_reserved", refused.Code);
        }
        // One made before keeps its slug, and can still be changed.
        long now = rl.Now();
        await rl.Store.InsertLinkAsync(new JsObject { ["id"] = new string('a', 24), ["site"] = id, ["domain"] = "", ["slug"] = "login", ["name"] = "Old", ["url"] = "https://example.com/old", ["createdAt"] = now, ["updatedAt"] = now });
        Assert.Equal("login", (await rl.Links.UpdateAsync(new string('a', 24), new JsObject { ["slug"] = "login", ["name"] = "Still here" })).Str("slug"));
        // A library on its own keeps nothing back.
        var plain = await Make.RunlightAsync(Example);
        Assert.Equal("login", (await plain.Links.CreateAsync("default", new JsObject { ["url"] = "https://example.com/", ["slug"] = "login" })).Str("slug"));
    }

    [Fact]
    public async Task Wrong_guesses_at_a_short_token_are_throttled_per_address_and_a_long_token_counts_nothing()
    {
        Request Api(string bearer, string ip) => new("https://stats.example.com/api/sites", "GET", new Headers { ["authorization"] = "Bearer " + bearer, ["host"] = "stats.example.com" }, (byte[]?)null, ip);
        var weak = Server(await Databases.FreshAsync("sqlite"), token: "short-token");
        Assert.Equal(200, (await weak.HandleAsync(Api("short-token", "8.8.8.8"), "8.8.8.8")).Status);
        for (int i = 0; i < 10; i++)
        {
            Assert.Equal(401, (await weak.HandleAsync(Api("guess-" + i, "8.8.8.8"), "8.8.8.8")).Status);
        }
        // That address is now refused even with the right token; another address is not.
        Assert.Equal(401, (await weak.HandleAsync(Api("short-token", "8.8.8.8"), "8.8.8.8")).Status);
        Assert.Equal(200, (await weak.HandleAsync(Api("short-token", "8.8.4.4"), "8.8.4.4")).Status);
        // A token made in Settings is never a guess at this one.
        for (int i = 0; i < 12; i++)
        {
            Assert.Equal(401, (await weak.HandleAsync(Api("rl_" + new string('0', 40), "8.8.4.4"), "8.8.4.4")).Status);
        }
        Assert.Equal(200, (await weak.HandleAsync(Api("short-token", "8.8.4.4"), "8.8.4.4")).Status);

        string longToken = new string('t', 40);
        var strong = Server(await Databases.FreshAsync("sqlite"), token: longToken);
        for (int i = 0; i < 12; i++)
        {
            Assert.Equal(401, (await strong.HandleAsync(Api("guess-" + i, "8.8.8.8"), "8.8.8.8")).Status);
        }
        Assert.Equal(200, (await strong.HandleAsync(Api(longToken, "8.8.8.8"), "8.8.8.8")).Status);
        Assert.Empty(await strong.Runlight.Store.SettingsStartingWithAsync("throttle:bearer:"));
    }

    [Fact]
    public void A_short_secret_or_token_is_warned_about()
    {
        Assert.Null(Config.ShortWarning("RUNLIGHT_SECRET", null));
        Assert.Null(Config.ShortWarning("RUNLIGHT_TOKEN", new string('x', 32)));
        Assert.Equal(
            "Runlight: WARNING: RUNLIGHT_TOKEN is only 5 characters long. Anyone who guesses it has the whole API, as the owner. Set it to 32 or more random characters, such as the output of: openssl rand -hex 32",
            Config.ShortWarning("RUNLIGHT_TOKEN", "short"));
        Assert.StartsWith("Runlight: WARNING: RUNLIGHT_SECRET is only 5 characters long. It signs every session", Config.ShortWarning("RUNLIGHT_SECRET", "short"), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Location_downloads_that_keep_failing_wait_longer_each_time()
    {
        string dir = Path.Combine(Path.GetTempPath(), "runlight-geo-" + Guid.NewGuid().ToString("N"));
        try
        {
            int asked = 0;
            var geo = new DbIp(dir, "country", (_, _) =>
            {
                asked++;
                return Task.FromResult(new DbIpAnswer(404, new MemoryStream()));
            }, _ => { });
            const long Min = 60_000;
            long now = 1_791_374_400_000;
            await geo.RefreshAsync(now);
            int perTry = asked;
            Assert.True(perTry > 0);
            // Five minutes, then ten, then twenty: nothing is asked in between.
            await geo.RefreshAsync(now + 5 * Min - 1);
            Assert.Equal(perTry, asked);
            await geo.RefreshAsync(now + 5 * Min);
            Assert.Equal(2 * perTry, asked);
            await geo.RefreshAsync(now + 15 * Min - 1);
            Assert.Equal(2 * perTry, asked);
            await geo.RefreshAsync(now + 15 * Min);
            Assert.Equal(3 * perTry, asked);
            await geo.RefreshAsync(now + 35 * Min - 1);
            Assert.Equal(3 * perTry, asked);
        }
        finally
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, true);
            }
        }
    }
}
