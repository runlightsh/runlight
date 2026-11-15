using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Runlight.Accounts;
using Runlight.Http;
using Runlight.Store;
using Runlight.Tests.Routes;
using Runlight.Tests.Store;
using Xunit;
using AccountsStore = Runlight.Accounts.Accounts;

namespace Runlight.Tests;

/// <summary>
/// What a review of this port found, each with the case that would have caught it: a runtime with globalization
/// turned off, link domains read from several threads, account changes made at once on SQLite, sign-in counts
/// nobody comes back for, a port on a forwarded address, and a lookup that never answers.
/// </summary>
public sealed class ReviewFixesTests : IAsyncLifetime
{
    private const long Start = 1_760_000_000_000;

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public async ValueTask DisposeAsync() => await Databases.CleanupAsync();

    // ---- globalization turned off

    /// <summary>The variable that tells <see cref="With_globalization_turned_off_runlight_still_starts_and_sorts"/> it is the child.</summary>
    private const string Child = "RUNLIGHT_INVARIANT_CHILD";

    /// <summary>
    /// The runtime reads the switch once, at start, so the case runs in a process of its own: this test again,
    /// with DOTNET_SYSTEM_GLOBALIZATION_INVARIANT set, as the Alpine and chiseled images set it.
    /// </summary>
    [Fact]
    public async Task With_globalization_turned_off_runlight_still_starts_and_sorts()
    {
        string? marker = Environment.GetEnvironmentVariable(Child);
        if (!string.IsNullOrEmpty(marker))
        {
            // The child: there is no English here, which is what used to stop the Runlight class from loading at all.
            Assert.Throws<CultureNotFoundException>(() => CultureInfo.GetCultureInfo("en"));
            var rl = new Runlight(new RunlightOptions { Store = await Databases.FreshAsync("sqlite"), ManagedSites = true });
            await rl.AddSiteAsync(new JsObject { ["name"] = "beta", ["hostnames"] = Make.L("beta.example") });
            await rl.AddSiteAsync(new JsObject { ["name"] = "alpha", ["hostnames"] = Make.L("alpha.example") });
            Assert.Equal(["alpha", "beta"], rl.Sites().Select(s => s.Str("name")));
            Assert.Contains(12L, Runlight.RetentionMonths);
            Assert.True((await rl.CheckAsync()).Bool("ok"));
            Assert.NotEmpty(Assistant.Providers);
            await File.WriteAllTextAsync(marker, "ok");
            return;
        }

        string file = Path.Combine(Path.GetTempPath(), "runlight-invariant-" + Guid.NewGuid().ToString("N"));
        string name = typeof(ReviewFixesTests).FullName + "." + nameof(With_globalization_turned_off_runlight_still_starts_and_sorts);
        // The test program names one test in either of two ways, by how it was started; the other way is refused.
        string[][] ways = [["-method", name], ["--filter-method", name, "--results-directory", file + "-results"]];
        string said = "";
        try
        {
            foreach (string[] way in ways)
            {
                string exe = Environment.ProcessPath!;
                var start = new ProcessStartInfo(exe) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
                if (Path.GetFileNameWithoutExtension(exe) == "dotnet")
                {
                    start.ArgumentList.Add(typeof(ReviewFixesTests).Assembly.Location);
                }
                foreach (string argument in way)
                {
                    start.ArgumentList.Add(argument);
                }
                start.Environment["DOTNET_SYSTEM_GLOBALIZATION_INVARIANT"] = "true";
                start.Environment[Child] = file;
                // The suite's own culture, when it runs under one, is not there to be had in the child.
                start.Environment.Remove("RUNLIGHT_CULTURE");
                using var child = Process.Start(start)!;
                var output = child.StandardOutput.ReadToEndAsync();
                var errors = child.StandardError.ReadToEndAsync();
                using var limit = new CancellationTokenSource(TimeSpan.FromMinutes(3));
                await child.WaitForExitAsync(limit.Token);
                said += string.Join(' ', way) + ": exit " + child.ExitCode + "\n" + await output + "\n" + await errors + "\n";
                if (child.ExitCode == 0 && File.Exists(file))
                {
                    return;
                }
            }
            Assert.Fail("the run with globalization off failed:\n" + said);
        }
        finally
        {
            File.Delete(file);
            if (Directory.Exists(file + "-results"))
            {
                Directory.Delete(file + "-results", true);
            }
        }
    }

    // ---- link domains

    [Fact]
    public async Task A_failed_read_of_the_link_domains_is_no_link_domain_for_a_moment_and_then_asked_again()
    {
        bool down = true;
        int asked = 0;
        var watched = new WatchedDb((await Databases.FreshAsync("sqlite")).Db)
        {
            Before = (sql, _) =>
            {
                if (sql.Contains("rl_link_domains", StringComparison.Ordinal) && !sql.StartsWith("CREATE", StringComparison.Ordinal))
                {
                    asked++;
                    if (down)
                    {
                        throw new InvalidOperationException("the database is down");
                    }
                }
                return Task.CompletedTask;
            },
        };
        var rl = await Make.RunlightAsync(Make.Site(hostnames: ["example.com"]), store: new SqlStore(watched));
        var request = Make.At("https://go.example.net/launch");

        // A request is not on a link domain while the database cannot say, and it is asked again only after a moment.
        Assert.Null(await rl.LinkDomainResponseAsync(request));
        Assert.Null(await rl.LinkDomainResponseAsync(request));
        Assert.Equal(1, asked);

        // A change made here forgets the failure with the domains, and so does the moment passing.
        down = false;
        rl.ForgetLinkDomains();
        Assert.Null(await rl.LinkDomainResponseAsync(request));
        Assert.Equal(2, asked);

        // Read from many threads while it is forgotten again and again, nobody ever sees half of it.
        await rl.Store.AddLinkDomainAsync("go.example.net", "default", Start);
        rl.ForgetLinkDomains();
        using var stop = new CancellationTokenSource();
        var forgetting = Task.Run(() =>
        {
            while (!stop.IsCancellationRequested)
            {
                rl.ForgetLinkDomains();
            }
        });
        var readers = Enumerable.Range(0, 8).Select(_ => Task.Run(async () =>
        {
            for (int i = 0; i < 300; i++)
            {
                Assert.Equal(404, (await rl.LinkDomainResponseAsync(request))!.Status);
            }
        })).ToList();
        await Task.WhenAll(readers);
        await stop.CancelAsync();
        await forgetting;
    }

    // ---- accounts

    private static Web WebOn(SqlStore store, string basePath = "/runlight") => new(new WebOptions
    {
        Store = store,
        Secret = "a-secret-that-stays",
        Base = basePath,
        Now = () => Start,
        FirstAccount = FirstAccount.Open,
        Forgot = "https://runlight.sh/docs",
        SiteExists = (_, _) => Task.FromResult(true),
        MailSettings = _ => Task.FromResult<JsObject?>(null),
        SendMail = (_, _) => Task.CompletedTask,
        ClientIp = (_, ip) => ip ?? "",
        Later = _ => { },
    });

    [Fact]
    public async Task A_sign_in_link_opened_twice_at_once_lets_one_in_on_sqlite_too()
    {
        var store = await Databases.FreshAsync("sqlite");
        await store.MigrateAsync();
        var accounts = new AccountsStore(store, "a-secret-that-stays");
        var user = await accounts.SetPasswordAsync("jon@example.com", "a long password", Start);
        for (int i = 0; i < 40; i++)
        {
            // Each link runs out later than the last, so an earlier one's use does not withdraw it.
            long now = Start + i;
            string link = accounts.LinkFor(user, now);
            using var together = new Barrier(2);
            var both = await Task.WhenAll(Enumerable.Range(0, 2).Select(_ => Task.Run(async () =>
            {
                together.SignalAndWait(TimeSpan.FromSeconds(10));
                return await accounts.FromLinkAsync(link, now);
            })));
            Assert.Single(both, u => u != null);
        }
    }

    [Fact]
    public async Task An_account_kept_to_one_site_makes_no_token()
    {
        var store = await Databases.FreshAsync("sqlite");
        await store.MigrateAsync();
        var web = WebOn(store);
        await web.Accounts.SetPasswordAsync("jon@example.com", "a long password", Start);
        var everywhere = await web.Accounts.SetPasswordAsync("mo@example.com", "a long password", Start, "member");
        var kept = await web.Accounts.SetPasswordAsync("zed@example.com", "a long password", Start, "member", site: "default");
        var token = new JsObject { ["id"] = new string('b', 24) };
        Assert.True(await web.TokenMadeAsync(token, everywhere.Str("id")!));
        Assert.False(await web.TokenMadeAsync(token, kept.Str("id")!));
    }

    [Fact]
    public async Task An_account_kept_to_one_site_still_reads_it_when_the_base_path_has_oauth_in_it()
    {
        var store = await Databases.FreshAsync("sqlite");
        var rl = await Make.RunlightAsync(Make.Site(hostnames: ["example.com"]), now: () => Start, secret: "a-secret-that-stays", store: store);
        var web = WebOn(store, "/oauth/stats");
        var routes = rl.Routes(new RoutesOptions { BasePath = "/oauth/stats", Token = "tok", AccountsWeb = web });
        await web.Accounts.SetPasswordAsync("jon@example.com", "a long password", Start);
        var viewer = await web.Accounts.SetPasswordAsync("zed@example.com", "a long password", Start, "viewer", site: "default");
        var signedIn = Make.H(("cookie", AccountsStore.SessionCookie + "=" + Js.EncodeURIComponent(web.Accounts.SessionFor(viewer, Start))));

        // Only the path under the base says whether this is the OAuth consent, which such an account never gives.
        var sites = await routes.HandleAsync(Make.Req("/oauth/stats/api/sites", headers: signedIn));
        Assert.Equal(200, sites.Status);
        Assert.Equal(Make.L("default"), Make.Column(Make.Obj(sites).Get("sites"), "id"));
        var consent = await routes.HandleAsync(Make.Req("/oauth/stats/oauth/authorize?response_type=code&client_id=x&redirect_uri=https%3A%2F%2Fapp.example%2Fcb", headers: signedIn));
        Assert.NotEqual(200, consent.Status);
    }

    // ---- sign-in counts

    private static async Task<List<string>> CountsAsync(SqlStore store) =>
        [.. (await store.SettingsStartingWithAsync("throttle:")).Select(r => r.Str("key")!)];

    [Fact]
    public async Task A_sign_in_count_taken_back_to_nothing_is_deleted()
    {
        var store = await Databases.FreshAsync("sqlite");
        var perIp = new Throttle(store, "ip", 30);
        Assert.True(await perIp.TakeAsync("203.0.113.7", Start));
        Assert.True(await perIp.TakeAsync("203.0.113.7", Start));
        await perIp.ForgiveAsync("203.0.113.7", Start);
        Assert.Single(await CountsAsync(store));
        await perIp.ForgiveAsync("203.0.113.7", Start);
        Assert.Empty(await CountsAsync(store));
        // Forgiving what is not there changes nothing.
        await perIp.ForgiveAsync("203.0.113.7", Start);
        Assert.Empty(await CountsAsync(store));
    }

    [Fact]
    public async Task A_sign_in_count_goes_when_its_window_ends_with_no_scheduled_check_and_nobody_signing_in_again()
    {
        var store = await Databases.FreshAsync("sqlite");
        var perIp = new Throttle(store, "ip", 30, windowMs: 200);
        await perIp.FailAsync("203.0.113.7", Start);
        Assert.Single(await CountsAsync(store));
        // Nothing reads the count again and no check runs: the throttle's own timer sweeps it.
        for (int i = 0; i < 400 && (await CountsAsync(store)).Count > 0; i++)
        {
            await Task.Delay(25);
        }
        Assert.Empty(await CountsAsync(store));
    }

    [Fact]
    public async Task Counts_an_earlier_process_left_behind_go_when_runlight_starts_and_at_a_throttles_first_try()
    {
        var store = await Databases.FreshAsync("sqlite");
        await store.MigrateAsync();
        await store.SetSettingAsync("throttle:ip:left-behind", "{\"count\":1,\"until\":" + Js.Str(Start - 1) + "}");
        await store.SetSettingAsync("throttle-key:2020-01-01", "an-old-key");
        var rl = await Make.RunlightAsync(Make.Site(hostnames: ["example.com"]), now: () => Start, store: store);
        await rl.InitAsync();
        Assert.Empty(await CountsAsync(store));
        Assert.Empty(await store.SettingsStartingWithAsync("throttle-key:2020"));

        await store.SetSettingAsync("throttle:ip:left-behind", "{\"count\":1,\"until\":" + Js.Str(Start - 1) + "}");
        Assert.True(await new Throttle(store, "code", 5).TakeAsync("someone", Start));
        Assert.DoesNotContain("throttle:ip:left-behind", await CountsAsync(store));
    }

    // ---- a forwarded address with a port

    [Theory]
    [InlineData("x-forwarded-for", "203.0.113.5:49152", "203.0.113.5")]
    [InlineData("x-forwarded-for", "198.51.100.1, 203.0.113.5:49152", "203.0.113.5")]
    [InlineData("x-forwarded-for", "[2001:db8::1]:443", "2001:db8::1")]
    [InlineData("x-forwarded-for", "[2001:db8::1]", "2001:db8::1")]
    [InlineData("x-forwarded-for", "2001:db8::1", "2001:db8::1")]
    [InlineData("x-forwarded-for", "203.0.113.5", "203.0.113.5")]
    [InlineData("x-real-ip", "203.0.113.5:8080", "203.0.113.5")]
    [InlineData("cf-connecting-ip", "[2001:db8::2]:1", "2001:db8::2")]
    [InlineData("x-forwarded-for", "unknown", "unknown")]
    [InlineData("x-forwarded-for", "[2001:db8::1]junk", "[2001:db8::1]junk")]
    [InlineData("x-forwarded-for", "[2001:db8::1", "[2001:db8::1")]
    public async Task A_forwarded_address_loses_the_port_a_proxy_wrote_after_it(string header, string value, string address)
    {
        var rl = await Make.RunlightAsync(Make.Site(hostnames: ["example.com"]));
        Assert.Equal(address, rl.ClientIp(Make.Req("/", headers: Make.H((header, value))), "10.0.0.1"));
        // The connection's own address is used as it is.
        Assert.Equal("8.8.8.8", rl.ClientIp(Make.Req("/", headers: Make.H((header, value))), "8.8.8.8"));
    }

    // ---- a lookup that never answers

    /// <summary>A fetcher whose resolver never answers until it is told to stop.</summary>
    private sealed class NeverResolves : IFetcher
    {
        public int Fetched { get; private set; }

        public async Task<IReadOnlyList<string>> LookupAsync(string name, CancellationToken cancellationToken)
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
            return [];
        }

        public Task<Response> FetchAsync(string url, FetchInit? init = null, CancellationToken cancellationToken = default)
        {
            Fetched++;
            return Task.FromResult(new Response("ok"));
        }
    }

    [Fact]
    public async Task A_lookup_keeps_to_the_time_its_fetch_has_and_stops_when_the_caller_does()
    {
        var fetcher = new NeverResolves();
        var clock = Stopwatch.StartNew();
        var late = await Assert.ThrowsAsync<FetchException>(() => Safefetch.PublicFetchAsync("https://slow.example/", new PublicFetchInit { TimeoutMs = 300 }, fetcher));
        Assert.True(late.TimedOut);
        var service = await Assert.ThrowsAsync<FetchException>(() => Safefetch.ServiceFetchAsync("https://slow.example/", new FetchInit { TimeoutMs = 300 }, fetcher));
        Assert.True(service.TimedOut);
        Assert.True(clock.ElapsedMilliseconds < 10_000);

        using var gone = new CancellationTokenSource(200);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Safefetch.PublicFetchAsync("https://slow.example/", new PublicFetchInit { TimeoutMs = 60_000 }, fetcher, gone.Token));
        using var goneToo = new CancellationTokenSource(200);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Safefetch.ServiceFetchAsync("https://slow.example/", new FetchInit { TimeoutMs = 60_000 }, fetcher, cancellationToken: goneToo.Token));
        Assert.Equal(0, fetcher.Fetched);

        // The checks with no fetch behind them stop with their caller too.
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Safefetch.ResolvesPrivatelyAsync("slow.example", cancellationToken: cancelled.Token));
    }
}
