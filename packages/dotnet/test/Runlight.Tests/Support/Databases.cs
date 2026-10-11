using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;
using MySqlConnector;
using Npgsql;
using Runlight.Db;
using Runlight.Store;


namespace Runlight.Tests;

/// <summary>
/// The databases the store tests run on: SQLite always; Postgres when RUNLIGHT_TEST_PG holds a
/// connection string or URL (each test gets a schema of its own inside it), and MySQL 8.0.20 and
/// MariaDB 11.4 when RUNLIGHT_TEST_MYSQL is set. MySQL has one database for the port's tests, so
/// each test there drops Runlight's tables first, and the tests run one at a time. Any value
/// without "://" means the local servers: Postgres at 127.0.0.1:5432, database
/// runlight_test_dotnet; MySQL at 127.0.0.1:33084 and MariaDB at 127.0.0.1:33114, root with password
/// runlight, database runlight_test_dotnet.
/// </summary>
public static class Databases
{
    public const string LocalPg = "postgres://joncphillips@127.0.0.1:5432/runlight_test_dotnet";

    public static readonly Dictionary<string, string> LocalMysql = new(StringComparer.Ordinal)
    {
        ["mysql"] = "mysql://root:runlight@127.0.0.1:33084/runlight_test_dotnet",
        ["mariadb"] = "mysql://root:runlight@127.0.0.1:33114/runlight_test_dotnet",
    };

    private static readonly List<Func<Task>> Cleanups = [];

    /// <summary>The kinds at hand, for a theory's data.</summary>
    public static IEnumerable<string> Kinds()
    {
        yield return "sqlite";
        if (PgUrl() != null)
        {
            yield return "postgres";
        }
        foreach (string name in MysqlUrls().Keys)
        {
            yield return name;
        }
    }

    public static Xunit.TheoryData<string> KindData() => [.. Kinds()];

    /// <summary>The table prefix the "+prefix" kinds use in place of rl_, as WordPress would give one.</summary>
    public const string TestPrefix = "wp_rl_";

    /// <summary>
    /// The kinds at hand for the store suites and the conformance scenarios: each also once more with its
    /// tables under <see cref="TestPrefix"/>, as "sqlite+prefix", "postgres+prefix", and so on.
    /// </summary>
    public static IEnumerable<string> StoreKinds()
    {
        var kinds = Kinds().ToList();
        return kinds.Concat(kinds.Select(k => k + "+prefix"));
    }

    public static Xunit.TheoryData<string> StoreKindData() => [.. StoreKinds()];

    /// <summary>A kind without "+prefix", and the prefix it asks for (null for rl_).</summary>
    public static (string Kind, string? Prefix) Unprefixed(string kind) =>
        kind.EndsWith("+prefix", StringComparison.Ordinal) ? (kind[..^"+prefix".Length], TestPrefix) : (kind, null);

    public static Xunit.TheoryData<string> ServerData()
    {
        var kinds = Kinds().Where(k => k != "sqlite").ToList();
        return kinds.Count > 0 ? [.. kinds] : ["none"];
    }

    public static string? PgUrl()
    {
        string? url = Environment.GetEnvironmentVariable("RUNLIGHT_TEST_PG");
        if (string.IsNullOrEmpty(url))
        {
            return null;
        }
        return url.Contains("://", StringComparison.Ordinal) ? url : LocalPg;
    }

    public static Dictionary<string, string> MysqlUrls()
    {
        string? value = Environment.GetEnvironmentVariable("RUNLIGHT_TEST_MYSQL");
        if (string.IsNullOrEmpty(value))
        {
            return [];
        }
        var urls = value.Split([' ', ',', '\n', '\t'], StringSplitOptions.RemoveEmptyEntries).Where(u => u.Contains("://", StringComparison.Ordinal)).ToList();
        if (urls.Count == 0)
        {
            return new Dictionary<string, string>(LocalMysql, StringComparer.Ordinal);
        }
        var output = new Dictionary<string, string>(StringComparer.Ordinal);
        for (int i = 0; i < urls.Count; i++)
        {
            output[i == 0 ? "mysql" : "mysql" + i] = urls[i];
        }
        return output;
    }

    /// <summary>A Postgres connection string from a postgres:// URL.</summary>
    public static string PgConnectionString(string url, string? schema = null)
    {
        var uri = new Uri(url);
        var b = new NpgsqlConnectionStringBuilder
        {
            Host = uri.Host,
            Port = uri.Port > 0 ? uri.Port : 5432,
            Database = Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/')),
            Pooling = true,
        };
        string[] user = uri.UserInfo.Split(':', 2);
        if (user[0].Length > 0)
        {
            b.Username = Uri.UnescapeDataString(user[0]);
        }
        if (user.Length > 1)
        {
            b.Password = Uri.UnescapeDataString(user[1]);
        }
        if (schema != null)
        {
            b.SearchPath = schema;
        }
        return b.ConnectionString;
    }

    /// <summary>A MySQL connection string from a mysql:// URL.</summary>
    public static string MysqlConnectionString(string url)
    {
        var uri = new Uri(url.Replace("mariadb://", "mysql://", StringComparison.OrdinalIgnoreCase));
        var b = new MySqlConnectionStringBuilder
        {
            Server = uri.Host,
            Port = (uint)(uri.Port > 0 ? uri.Port : 3306),
            Database = Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/')),
            CharacterSet = "utf8mb4",
            AllowUserVariables = true,
        };
        string[] user = uri.UserInfo.Split(':', 2);
        b.UserID = Uri.UnescapeDataString(user[0]);
        if (user.Length > 1)
        {
            b.Password = Uri.UnescapeDataString(user[1]);
        }
        return b.ConnectionString;
    }

    /// <summary>Runlight's tables, under rl_ and under the test prefix.</summary>
    private static readonly string[] Tables = [.. Sql.Tables.Select(t => Sql.Prefix + t), .. Sql.Tables.Select(t => TestPrefix + t)];

    /// <summary>
    /// A fresh, empty store of a kind, dropped by <see cref="CleanupAsync"/>. <paramref name="statementTimeout"/>
    /// is the store's on Postgres and MySQL (the PHP tests' stores have 120000, as stores/postgres.ts and
    /// stores/mysql.ts default to; 0 here, since only the tests that look at it need it).
    /// </summary>
    public static async Task<SqlStore> FreshAsync(string kind, int statementTimeout = 0)
    {
        var (plain, prefix) = Unprefixed(kind);
        if (plain == "sqlite")
        {
            var source = SqliteFactory.Instance.CreateDataSource("Data Source=:memory:");
            var store = new SqlStore(new AdoDb(source, "sqlite", owned: true), prefix ?? Sql.Prefix);
            Cleanups.Add(() => store.CloseAsync().AsTask());
            return store;
        }
        if (plain == "postgres")
        {
            return PgStore(await PgSchemaAsync(), statementTimeout, prefix ?? Sql.Prefix);
        }
        await DropMysqlTablesAsync(plain);
        return MysqlStore(plain, statementTimeout, prefix ?? Sql.Prefix);
    }

    /// <summary>A schema of its own in the Postgres test database, dropped by <see cref="CleanupAsync"/>.</summary>
    public static async Task<string> PgSchemaAsync()
    {
        string name = "rl_test_" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(5));
        var admin = NpgsqlDataSource.Create(PgConnectionString(PgUrl()!));
        await using (var cmd = admin.CreateCommand("CREATE SCHEMA " + name))
        {
            await cmd.ExecuteNonQueryAsync();
        }
        Cleanups.Add(async () =>
        {
            await using (var drop = admin.CreateCommand("DROP SCHEMA " + name + " CASCADE"))
            {
                await drop.ExecuteNonQueryAsync();
            }
            await admin.DisposeAsync();
        });
        return name;
    }

    /// <summary>A store on a Postgres schema (one from <see cref="PgSchemaAsync"/>), closed by <see cref="CleanupAsync"/>.</summary>
    public static SqlStore PgStore(string schema, int statementTimeout = 0, string prefix = Sql.Prefix)
    {
        var store = new SqlStore(new AdoDb(NpgsqlDataSource.Create(PgConnectionString(PgUrl()!, schema)), "postgres", owned: true, statementTimeout: statementTimeout), prefix);
        Cleanups.Add(() => store.CloseAsync().AsTask());
        return store;
    }

    /// <summary>A store on the MySQL test database as it is, closed by <see cref="CleanupAsync"/>.</summary>
    public static SqlStore MysqlStore(string kind, int statementTimeout = 0, string prefix = Sql.Prefix)
    {
        var store = new SqlStore(new AdoDb(new MySqlDataSource(MysqlConnectionString(MysqlUrls()[kind])), "mysql", owned: true, statementTimeout: statementTimeout), prefix);
        Cleanups.Add(() => store.CloseAsync().AsTask());
        return store;
    }

    /// <summary>
    /// Runlight's tables dropped from the MySQL test database, under either prefix. MySQL has one database for the port's
    /// tests, so a test that needs a second empty database (as the PHP tests make one) empties this
    /// one instead.
    /// </summary>
    public static async Task DropMysqlTablesAsync(string kind)
    {
        await using var source = new MySqlDataSource(MysqlConnectionString(MysqlUrls()[kind]));
        await using var conn = await source.OpenConnectionAsync();
        foreach (string table in Tables)
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = "DROP TABLE IF EXISTS " + table;
            await cmd.ExecuteNonQueryAsync();
        }
    }

    /// <summary>Something for <see cref="CleanupAsync"/> to do, such as closing a store a test opened itself.</summary>
    public static void OnCleanup(Func<Task> fn) => Cleanups.Add(fn);

    /// <summary>Drops what the tests made, newest first, so each store closes before its database goes.</summary>
    public static async Task CleanupAsync()
    {
        while (Cleanups.Count > 0)
        {
            var fn = Cleanups[^1];
            Cleanups.RemoveAt(Cleanups.Count - 1);
            try
            {
                await fn();
            }
            catch (Exception e)
            {
                await Console.Error.WriteLineAsync("cleanup: " + e.Message);
            }
        }
    }
}
