using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;
using MySqlConnector;
using Npgsql;
using Runlight.Db;
using Runlight.Store;
using Xunit;
using static Runlight.Tests.Routes.Make;

namespace Runlight.Tests.Store;

/// <summary>
/// tables.test.ts: a second set of tables under another prefix in one database, the mode of a new SQLite
/// file, and how long a process waits for another one creating the tables.
/// </summary>
public sealed class TablesTests : IAsyncLifetime
{
    private readonly string _dir = Directory.CreateTempSubdirectory("runlight-tables-").FullName;

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public async ValueTask DisposeAsync()
    {
        await Databases.CleanupAsync();
        SqliteConnection.ClearAllPools();
        try
        {
            Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    /// <summary>Every table and index name in the database, as each dialect lists them.</summary>
    private static async Task<List<string>> NamesAsync(IDb db)
    {
        string sql = db.Dialect switch
        {
            "sqlite" => @"SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite\_%' ESCAPE '\'",
            "postgres" => "SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'i', 'S')",
            _ => "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() UNION SELECT index_name AS name FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name <> 'PRIMARY'",
        };
        return [.. (await db.AllAsync(sql)).Select(row => Js.String(row.Get("name"))).Order(StringComparer.Ordinal)];
    }

    /// <summary>A store with its tables under rl_, and a function that opens another under wp_rl_ in the same database.</summary>
    private async Task<(SqlStore Plain, Func<SqlStore> Other)> PairAsync(string kind)
    {
        if (kind == "sqlite")
        {
            string file = Path.Combine(_dir, "shared-" + Guid.NewGuid().ToString("N") + ".db");
            SqlStore Open(string prefix)
            {
                var store = Stores.Sqlite(SqliteFactory.Instance, file, prefix);
                Databases.OnCleanup(() => store.CloseAsync().AsTask());
                return store;
            }
            return (Open(Sql.Prefix), () => Open(Databases.TestPrefix));
        }
        if (kind == "postgres")
        {
            string schema = await Databases.PgSchemaAsync();
            return (Databases.PgStore(schema), () => Databases.PgStore(schema, 0, Databases.TestPrefix));
        }
        await Databases.DropMysqlTablesAsync(kind);
        return (Databases.MysqlStore(kind), () => Databases.MysqlStore(kind, 0, Databases.TestPrefix));
    }

    private static JsObject Site(string id) => new() { ["id"] = id, ["name"] = id, ["hostnames"] = new List<object?> { id + ".example" }, ["timezone"] = "UTC" };

    [Theory]
    [MemberData(nameof(Databases.KindData), MemberType = typeof(Databases))]
    public async Task A_prefix_keeps_a_second_set_of_tables_beside_the_first_in_one_database(string kind)
    {
        var (plain, open) = await PairAsync(kind);
        var other = open();
        await other.MigrateAsync();
        // A second process with the same prefix finds every table and index already there.
        await open().MigrateAsync();
        var made = await NamesAsync(plain.Db);
        Assert.NotEmpty(made);
        Assert.DoesNotContain(made, name => !name.StartsWith("wp_rl_", StringComparison.Ordinal));
        Assert.Equal(Sql.Tables.Select(t => "wp_rl_" + t), other.Tables());
        Assert.Equal("wp_rl_", other.Prefix);
        Assert.DoesNotContain(other.Tables().Take(15), t => !made.Contains(t));

        await plain.MigrateAsync();
        var plainNames = (await NamesAsync(plain.Db)).Where(name => name.StartsWith(Sql.Prefix, StringComparison.Ordinal)).ToList();
        Assert.Equal(15, plainNames.Count(name => Sql.Tables.Contains(name[Sql.Prefix.Length..])));
        await plain.UpsertSiteAsync(Site("first"), 1);
        await other.UpsertSiteAsync(Site("second"), 1);
        Assert.Equal(["first"], (await plain.SitesAsync()).Select(s => s.Str("id")));
        Assert.Equal(["second"], (await other.SitesAsync()).Select(s => s.Str("id")));
        Assert.Equal("second", await other.TransactionAsync(async tx => (await tx.SitesAsync())[0].Str("id")));
        await other.SetSettingAsync("k", "wp");
        Assert.Null(await plain.SettingAsync("k"));
        Assert.Equal("wp", await other.SettingAsync("k"));
    }

    [Fact]
    public void A_table_prefix_is_letters_digits_and_underscores_and_does_not_start_with_a_digit()
    {
        foreach (string prefix in new[] { "1rl_", "rl-", "rl_; DROP TABLE x", "", new string('a', 33) })
        {
            var error = Assert.Throws<ArgumentException>(() => Stores.Sqlite(SqliteFactory.Instance, ":memory:", prefix));
            Assert.StartsWith("Runlight: a table prefix is up to 32 letters, digits, and underscores, and does not start with a digit", error.Message, StringComparison.Ordinal);
        }
        foreach (string prefix in new[] { "rl_", "wp_rl_", "_x", new string('A', 32) })
        {
            Assert.Equal(prefix, Stores.Sqlite(SqliteFactory.Instance, ":memory:", prefix).Prefix);
        }
        Assert.Equal("wp_rl_", new SqlStore(Stores.Sqlite(SqliteFactory.Instance, ":memory:", "wp_rl_").Db).Prefix);
        Assert.Equal(["rl_meta", "rl_sites"], Stores.Sqlite(SqliteFactory.Instance, ":memory:").Tables().Take(2));
        // Only Runlight's names are rewritten: not a longer word, and not a value.
        var db = new PrefixedDb(new SqlStore(new AdoDb(SqliteFactory.Instance.CreateDataSource("Data Source=:memory:"), "sqlite")).Db, "wp_rl_");
        Assert.Equal("SELECT * FROM wp_rl_sites JOIN curl_x ON \"wp_rl_events\".x = 'rl_' WHERE table_name = 'wp_rl_users'", db.Sql("SELECT * FROM rl_sites JOIN curl_x ON \"rl_events\".x = 'rl_' WHERE table_name = 'rl_users'"));
    }

    [Fact]
    public async Task A_new_SQLite_file_is_for_its_owner_and_group_alone_and_so_are_the_files_SQLite_makes_beside_it()
    {
        if (OperatingSystem.IsWindows())
        {
            Assert.Skip("Windows has no such modes");
            return;
        }
        string folder = Path.Combine(_dir, "made", "here");
        string file = Path.Combine(folder, "mode.db");
        var store = Stores.Sqlite(SqliteFactory.Instance, file);
        await store.MigrateAsync();
        await store.SetSettingAsync("k", "v");
        const UnixFileMode Group = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.GroupWrite;
        Assert.Equal(Group, File.GetUnixFileMode(file));
        Assert.True(File.Exists(file + "-wal"));
        Assert.Equal(Group, File.GetUnixFileMode(file + "-wal"));
        // The folders it made for the file too.
        Assert.Equal(Group | UnixFileMode.UserExecute | UnixFileMode.GroupExecute, File.GetUnixFileMode(folder));
        Assert.Equal(Group | UnixFileMode.UserExecute | UnixFileMode.GroupExecute, File.GetUnixFileMode(Path.GetDirectoryName(folder)!));
        await store.CloseAsync();
    }

    /// <summary>A database whose lock for creating tables another process holds, until it is told to give up or go ahead.</summary>
    private sealed class HeldLock(IDb inner) : IDb
    {
        private TaskCompletionSource<bool> _turn = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public string Dialect => inner.Dialect;

        /// <summary>The other process finishes (true), or this one gives up waiting (false).</summary>
        public void Release(bool go) => _turn.TrySetResult(go);

        public Task<List<JsObject>> AllAsync(string sql, IReadOnlyList<object?>? args = null, CancellationToken cancellationToken = default) => inner.AllAsync(sql, args, cancellationToken);

        public Task RunAsync(string sql, IReadOnlyList<object?>? args = null, CancellationToken cancellationToken = default) => inner.RunAsync(sql, args, cancellationToken);

        public Task<long> AffectedAsync(string sql, IReadOnlyList<object?>? args = null, CancellationToken cancellationToken = default) => inner.AffectedAsync(sql, args, cancellationToken);

        public Task<T> TransactionAsync<T>(Func<IDb, Task<T>> fn, CancellationToken cancellationToken = default) => inner.TransactionAsync(fn, cancellationToken);

        public async Task<T> ExclusiveAsync<T>(Func<IDb, Task<T>> fn, CancellationToken cancellationToken = default)
        {
            var turn = _turn;
            if (!await turn.Task)
            {
                // The next one to wait waits again.
                Interlocked.CompareExchange(ref _turn, new(TaskCreationOptions.RunContinuationsAsynchronously), turn);
                throw new TablesBusyError();
            }
            return await inner.ExclusiveAsync(fn, cancellationToken);
        }

        public ValueTask DisposeAsync() => inner.DisposeAsync();
    }

    [Fact]
    public async Task A_tracker_hit_waits_a_moment_at_most_while_another_process_creates_the_tables_and_other_requests_hear_why_they_failed()
    {
        var db = new HeldLock((await Databases.FreshAsync("sqlite")).Db);
        var rl = new Runlight(new RunlightOptions { Store = new SqlStore(db), Site = new SiteOptions { Hostnames = ["example.com"] }, Now = () => StoreTestCase.NOW });
        Assert.Equal(10_000, Runlight.TrackerWaitMs);
        rl.TrackerWait = 1_000;
        var routes = rl.Routes(new RoutesOptions { Token = "secret" });
        var clock = Stopwatch.StartNew();
        var hit = await routes.HandleAsync(Req(
            "/runlight/e",
            "POST",
            H(("user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"), ("x-forwarded-for", "203.0.113.1")),
            "{\"k\":\"pageview\",\"u\":\"https://example.com/\",\"i\":\"a1\"}"));
        Assert.Equal(202, hit.Status);
        long waited = clock.ElapsedMilliseconds;
        Assert.True(waited is >= 900 and < 3_000, $"the hit waited {waited}ms");

        // The other process gives up the wait: the request that waited answers 503, saying why.
        var asked = routes.HandleAsync(Req("/runlight/api/stats?period=today", headers: H(("authorization", "Bearer secret"))));
        db.Release(false);
        var answer = await asked;
        Assert.Equal(503, answer.Status);
        Assert.Equal("30", answer.Headers.Get("retry-after"));
        Assert.Equal("{\"error\":\"Runlight is creating or upgrading its tables. Try again in a minute.\",\"code\":\"tables_busy\"}", answer.Text());

        // Once the tables are there, hits are counted again.
        var later = rl.InitAsync();
        db.Release(true);
        await later;
        var stats = (JsObject)Json.Parse((await routes.HandleAsync(Req("/runlight/api/stats?period=today&compare=off", headers: H(("authorization", "Bearer secret"))))).Text())!;
        Assert.Equal(0, Js.Number(stats.Obj("stats")!.Get("visitors")));
    }

    [Fact]
    public async Task Postgres_waiting_for_another_process_creating_the_tables_gives_up_after_the_lock_wait()
    {
        if (Databases.PgUrl() == null)
        {
            Assert.Skip("RUNLIGHT_TEST_PG is not set");
        }
        string schema = await Databases.PgSchemaAsync();
        await using var admin = NpgsqlDataSource.Create(Databases.PgConnectionString(Databases.PgUrl()!));
        await using var held = await admin.OpenConnectionAsync();
        // The lock every Runlight takes to create tables, held by another session. Asked for again and again,
        // as the stores do, since waiting on it could deadlock with an index another test is building concurrently.
        while (!await LockAsync(held))
        {
            await Task.Delay(50);
        }
        var db = new AdoDb(NpgsqlDataSource.Create(Databases.PgConnectionString(Databases.PgUrl()!, schema)), "postgres", owned: true) { LockWait = 1_000 };
        Databases.OnCleanup(() => db.DisposeAsync().AsTask());
        var clock = Stopwatch.StartNew();
        var error = await Assert.ThrowsAsync<TablesBusyError>(() => new SqlStore(db).MigrateAsync());
        Assert.Equal("Runlight: another process is creating or upgrading the tables, and had not finished after 1 seconds. Try again in a minute.", error.Message);
        Assert.True(clock.ElapsedMilliseconds < 5_000);
        await using (var unlock = held.CreateCommand())
        {
            unlock.CommandText = "SELECT pg_advisory_unlock(" + AdoDb.MigrationLock + ")";
            await unlock.ExecuteNonQueryAsync();
        }
        await new SqlStore(db).MigrateAsync();
    }

    private static async Task<bool> LockAsync(NpgsqlConnection connection)
    {
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT pg_try_advisory_lock(" + AdoDb.MigrationLock + ")";
        return (bool)(await cmd.ExecuteScalarAsync())!;
    }

    [Fact]
    public async Task Postgres_an_index_left_unusable_is_built_again_under_a_prefix_that_itself_starts_rl_()
    {
        if (Databases.PgUrl() == null)
        {
            Assert.Skip("RUNLIGHT_TEST_PG is not set");
        }
        string schema = await Databases.PgSchemaAsync();
        await Databases.PgStore(schema, 0, "rl_wp_").MigrateAsync();
        await using var admin = NpgsqlDataSource.Create(Databases.PgConnectionString(Databases.PgUrl()!));
        // As a concurrent build stopped part way leaves it.
        await using (var broken = admin.CreateCommand("UPDATE pg_index SET indisvalid = false WHERE indexrelid = '" + schema + ".rl_wp_events_site_ts'::regclass"))
        {
            Assert.Equal(1, await broken.ExecuteNonQueryAsync());
        }
        await Databases.PgStore(schema, 0, "rl_wp_").MigrateAsync(true);
        await using var valid = admin.CreateCommand("SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid = '" + schema + ".rl_wp_events_site_ts'::regclass");
        Assert.Equal(true, await valid.ExecuteScalarAsync());
    }

    public static TheoryData<string> MysqlKinds()
    {
        var kinds = Databases.MysqlUrls().Keys.ToList();
        return kinds.Count > 0 ? [.. kinds] : ["none"];
    }

    [Theory]
    [MemberData(nameof(MysqlKinds))]
    public async Task Mysql_waiting_for_another_process_creating_the_tables_gives_up_after_the_lock_wait(string kind)
    {
        if (kind == "none")
        {
            Assert.Skip("RUNLIGHT_TEST_MYSQL is not set");
        }
        await Databases.DropMysqlTablesAsync(kind);
        const string Name = "CONCAT('runlight:', LEFT(SHA2(COALESCE(DATABASE(), ''), 256), 48))";
        await using var other = new MySqlConnection(Databases.MysqlConnectionString(Databases.MysqlUrls()[kind]));
        await other.OpenAsync();
        var db = new AdoDb(new MySqlDataSource(Databases.MysqlConnectionString(Databases.MysqlUrls()[kind])), "mysql", owned: true) { LockWait = 1_000 };
        Databases.OnCleanup(() => db.DisposeAsync().AsTask());
        // The lock every Runlight takes to create tables in this database, held by another session.
        await using (var take = other.CreateCommand())
        {
            take.CommandText = "SELECT GET_LOCK(" + Name + ", 0)";
            await take.ExecuteNonQueryAsync();
        }
        var clock = Stopwatch.StartNew();
        await Assert.ThrowsAsync<TablesBusyError>(() => new SqlStore(db).MigrateAsync());
        Assert.True(clock.ElapsedMilliseconds < 5_000);
        await using (var release = other.CreateCommand())
        {
            release.CommandText = "DO RELEASE_LOCK(" + Name + ")";
            await release.ExecuteNonQueryAsync();
        }
        await new SqlStore(db).MigrateAsync();
    }
}
