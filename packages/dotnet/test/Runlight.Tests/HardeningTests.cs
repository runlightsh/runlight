using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Runlight.Accounts;
using Runlight.Http;
using Runlight.Server;
using Xunit;
using AccountsStore = Runlight.Accounts.Accounts;

namespace Runlight.Tests;

/// <summary>
/// The 0.1.3 fixes that need no routes of their own to show: limits held for questions sent at once, a
/// setting written once by whoever asks first, one-time codes accepted once, and the server's secret made once.
/// </summary>
public sealed class HardeningTests : IAsyncLifetime
{
    private const long Now = 1_791_288_000_000;
    private const string Secret = "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk";

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public async ValueTask DisposeAsync() => await Databases.CleanupAsync();

    [Theory]
    [MemberData(nameof(Databases.KindData), MemberType = typeof(Databases))]
    public async Task Questions_sent_at_once_count_once_each(string kind)
    {
        var store = await Databases.FreshAsync(kind);
        await store.MigrateAsync();
        await store.SetSettingAsync("assistant-viewer-daily", "1");
        // Ten handlers on one store, as ten processes would be, each asked once by the same viewer.
        var handlers = Enumerable.Range(0, 10).Select(_ => new Runlight(new RunlightOptions { Store = store, Now = () => Now }).Routes(new RoutesOptions { Token = "secret" })).ToList();
        async Task<bool> Asked(global::Runlight.Routes routes, string who)
        {
            object turn = await routes.AskTurnAsync(who, false);
            if (turn is Action done)
            {
                done();
                return true;
            }
            Assert.Equal(429, ((Response)turn).Status);
            return false;
        }
        var turns = await Task.WhenAll(handlers.Select(h => Task.Run(() => Asked(h, "ann@example.com"))));
        Assert.Equal(1, turns.Count(t => t));
        Assert.Equal("1", await store.SettingAsync("assistant-asked:2026-10-06:ann@example.com"));

        // The same on one handler, and two viewers at once each get their own.
        await store.SetSettingAsync("assistant-viewer-daily", "2");
        var one = handlers[0];
        var both = await Task.WhenAll(Enumerable.Range(0, 5).Select(i => Task.Run(() => Asked(one, i % 2 == 0 ? "bo@example.com" : "cy@example.com"))));
        Assert.Equal(4, both.Count(t => t));
        Assert.Equal("2", await store.SettingAsync("assistant-asked:2026-10-06:bo@example.com"));
        Assert.Equal("2", await store.SettingAsync("assistant-asked:2026-10-06:cy@example.com"));

        // An owner is not counted, and a limit of none refuses at once without writing a row.
        Assert.IsType<Action>(await one.AskTurnAsync("owner", true));
        await store.SetSettingAsync("assistant-viewer-daily", "0");
        Assert.IsType<Response>(await one.AskTurnAsync("dee@example.com", false));
        Assert.Null(await store.SettingAsync("assistant-asked:2026-10-06:dee@example.com"));
    }

    [Fact]
    public async Task A_viewers_first_question_of_a_new_day_clears_the_days_before()
    {
        var store = await Databases.FreshAsync("sqlite");
        await store.MigrateAsync();
        await store.SetSettingAsync("assistant-asked:2026-10-05", "{\"ann@example.com\":3}");
        await store.SetSettingAsync("assistant-asked:2026-10-05:ann@example.com", "3");
        var routes = new Runlight(new RunlightOptions { Store = store, Now = () => Now }).Routes(new RoutesOptions { Token = "secret" });
        ((Action)await routes.AskTurnAsync("ann@example.com", false))();
        Assert.Equal(["assistant-asked:2026-10-06:ann@example.com"], (await store.SettingsStartingWithAsync("assistant-asked:")).Select(r => r.Str("key")));
    }

    [Theory]
    [MemberData(nameof(Databases.KindData), MemberType = typeof(Databases))]
    public async Task A_setting_added_or_swapped_changes_once(string kind)
    {
        var store = await Databases.FreshAsync(kind);
        await store.MigrateAsync();
        var added = await Task.WhenAll(Enumerable.Range(0, 8).Select(i => Task.Run(() => store.AddSettingAsync("k", "v" + i))));
        Assert.Equal(1, added.Count(a => a));
        string winner = (await store.SettingAsync("k"))!;
        Assert.False(await store.AddSettingAsync("k", "other"));
        Assert.Equal(winner, await store.SettingAsync("k"));

        Assert.False(await store.SwapSettingAsync("k", "not it", "x"));
        var swapped = await Task.WhenAll(Enumerable.Range(0, 8).Select(i => Task.Run(() => store.SwapSettingAsync("k", winner, "next" + i))));
        Assert.Equal(1, swapped.Count(a => a));
        Assert.StartsWith("next", await store.SettingAsync("k"), StringComparison.Ordinal);
        Assert.False(await store.SwapSettingAsync("missing", "a", "b"));
    }

    [Theory]
    [MemberData(nameof(Databases.KindData), MemberType = typeof(Databases))]
    public async Task A_key_made_on_first_use_is_the_same_for_every_request_that_asks_at_once(string kind)
    {
        var store = await Databases.FreshAsync(kind);
        await store.MigrateAsync();
        var made = new List<string>();
        var keys = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() => store.SettingOrAddAsync("pick-key", () =>
        {
            string key = Hash.RandomId(32);
            lock (made)
            {
                made.Add(key);
            }
            return key;
        }))));
        Assert.Single(keys.Distinct());
        Assert.Contains(keys[0], made);
        Assert.Equal(keys[0], await store.SettingAsync("pick-key"));

        var agents = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() => OAuth.AgentsKeyAsync(store, "blog"))));
        Assert.Single(agents.Distinct());
        Assert.NotEqual(agents[0], await OAuth.AgentsKeyAsync(store, "blog", true)); // a new one replaces it
    }

    [Theory]
    [MemberData(nameof(Databases.KindData), MemberType = typeof(Databases))]
    public async Task A_code_is_accepted_once_even_by_two_accounts_at_once(string kind)
    {
        var store = await Databases.FreshAsync(kind);
        await store.MigrateAsync();
        var first = new AccountsStore(store, Secret);
        var second = new AccountsStore(store, Secret);
        var user = await first.SetPasswordAsync("jon@example.com", "a long password", Now);
        string id = user.Str("id")!;
        string secret = await first.StartTwoFactorAsync(id);
        long step = Now / 30_000;
        var recovery = (await first.ConfirmTwoFactorAsync(id, Crypto.Totp(secret, step), Now))!;

        for (long next = step + 1; next <= step + 3; next++)
        {
            string code = Crypto.Totp(secret, next);
            long at = Now + ((next - step) * 30_000);
            var results = await Task.WhenAll(first.CheckSecondFactorAsync(id, code, at), second.CheckSecondFactorAsync(id, code, at), first.CheckSecondFactorAsync(id, code, at), second.CheckSecondFactorAsync(id, code, at));
            Assert.Equal(1, results.Count(r => r));
        }

        // A recovery code is used once whichever of them takes it, and the others are kept.
        var codes = await Task.WhenAll(first.CheckSecondFactorAsync(id, recovery[0], Now), second.CheckSecondFactorAsync(id, recovery[0], Now), first.CheckSecondFactorAsync(id, recovery[0], Now));
        Assert.Equal(1, codes.Count(r => r));
        Assert.Equal(9, (await first.ByIdAsync(id))!.Long("recoveryLeft"));
        Assert.True(await second.CheckSecondFactorAsync(id, recovery[1], Now));
        Assert.Equal(8, (await first.ByIdAsync(id))!.Long("recoveryLeft"));
    }

    [Fact]
    public async Task The_server_secret_is_made_once_when_servers_start_at_once()
    {
        string dir = Path.Combine(Path.GetTempPath(), "runlight-secret-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var secrets = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() => Config.SecretIn(dir))));
            Assert.Single(secrets.Distinct());
            Assert.Matches("^[0-9a-f]{64}\\z", secrets[0]);
            Assert.Equal(secrets[0] + "\n", await File.ReadAllTextAsync(dir + "/secret"));
            Assert.Equal(["secret"], Directory.GetFileSystemEntries(dir).Select(Path.GetFileName));
            if (!OperatingSystem.IsWindows())
            {
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(dir + "/secret"));
            }

            // One written by hand is kept, and one too short to be whole is never used.
            string mine = new('a', 40);
            await File.WriteAllTextAsync(dir + "/secret", mine);
            Assert.Equal(mine, Config.SecretIn(dir));
            await File.WriteAllTextAsync(dir + "/secret", "short");
            var refused = Assert.Throws<InvalidOperationException>(() => Config.SecretIn(dir));
            Assert.Contains("holds no whole secret", refused.Message, StringComparison.Ordinal);
            await File.WriteAllTextAsync(dir + "/secret", "");
            Assert.Throws<InvalidOperationException>(() => Config.SecretIn(dir));
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    [Fact]
    public async Task A_refused_site_change_changes_nothing_retention_and_timezone_included()
    {
        long now = Now;
        var store = await Databases.FreshAsync("sqlite");
        var rl = new Runlight(new RunlightOptions { Store = store, ManagedSites = true, Now = () => now });
        await rl.InitAsync();
        await rl.AddSiteAsync(new JsObject { ["hostnames"] = "blog.example.com" });
        await rl.AddSiteAsync(new JsObject { ["hostnames"] = "shop.example.com" });
        await rl.CollectAsync(Core.Harness.Hit("https://stats.example.com/runlight/e", new JsObject { ["k"] = "pageview", ["u"] = "https://blog.example.com/" }));
        now = Now + (400L * 86_400_000);
        string? zone = await store.SettingAsync("rollup-zone:blog.example.com");
        async Task<double> Visits() => (await store.StatsAsync(new JsObject { ["site"] = "blog.example.com", ["from"] = 0L, ["to"] = now + 86_400_000, ["filters"] = new List<object?>() })).Num("visits");
        Assert.Equal(1, await Visits());

        foreach (string hostnames in new[] { "not a domain", "shop.example.com" })
        {
            var patch = new JsObject { ["retentionMonths"] = 6.0, ["timezone"] = "Europe/Paris", ["name"] = "Renamed", ["hostnames"] = hostnames };
            await Assert.ThrowsAsync<SettingsError>(() => rl.UpdateSiteAsync("blog.example.com", patch));
            await rl.IdleAsync();
            Assert.Null(await rl.RetentionAsync("blog.example.com"));
            Assert.Equal(zone, await store.SettingAsync("rollup-zone:blog.example.com"));
            Assert.Equal("blog.example.com", rl.Site("blog.example.com")!.Str("name"));
            Assert.Equal("UTC", rl.Site("blog.example.com")!.Str("timezone"));
            Assert.Equal(1, await Visits());
        }

        // A bad retention is refused before the name or timezone is saved, too.
        await Assert.ThrowsAsync<SettingsError>(() => rl.UpdateSiteAsync("blog.example.com", new JsObject { ["retentionMonths"] = 7.0, ["name"] = "Renamed" }));
        Assert.Equal("blog.example.com", rl.Site("blog.example.com")!.Str("name"));

        await rl.UpdateSiteAsync("blog.example.com", new JsObject { ["retentionMonths"] = 6.0, ["hostnames"] = "blog.example.com" });
        await rl.IdleAsync();
        Assert.Equal(6, await rl.RetentionAsync("blog.example.com"));
        Assert.Equal(0, await Visits()); // a change that passes prunes once saved
    }
}
