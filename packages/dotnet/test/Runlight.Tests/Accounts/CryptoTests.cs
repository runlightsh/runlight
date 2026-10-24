using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Runlight.Accounts;
using Xunit;
using static Runlight.Tests.Fixtures;

namespace Runlight.Tests.Accounts;

/// <summary>Accounts' cryptography against tests/fixtures/crypto.json, written by the TypeScript SDK and Node's own crypto.</summary>
public sealed class CryptoTests
{
    private static List<JsObject> Cases(string name) => Load("crypto").Arr(name)!.Cast<JsObject>().ToList();

    private static string Hex(byte[] bytes) => Convert.ToHexStringLower(bytes);

    [Fact]
    public void Scrypt_gives_nodes_bytes()
    {
        var failures = new List<string>();
        foreach (var c in Cases("scrypt"))
        {
            byte[] key = Scrypt.Derive(Js.Utf8(c.Str("password")!), Crypto.FromBase64url(c.Str("salt")!), (int)c.Num("N"), (int)c.Num("r"), (int)c.Num("p"), (int)c.Num("length"));
            if (Hex(key) != c.Str("key"))
            {
                failures.Add(Label(c));
            }
        }
        NoFailures(failures);
    }

    [Fact]
    public void Scrypt_test_vectors_from_rfc_7914()
    {
        Assert.Equal(
            "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906",
            Hex(Scrypt.Derive([], [], 16, 1, 1, 64)));
        Assert.Equal(
            "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640",
            Hex(Scrypt.Derive(Js.Utf8("password"), Js.Utf8("NaCl"), 1024, 8, 16, 64)));
    }

    [Fact]
    public void Scrypt_refuses_a_bad_cost()
    {
        Assert.Throws<ArgumentException>(() => Scrypt.Derive(Js.Utf8("x"), Js.Utf8("y"), 1000, 8, 1, 32));
    }

    [Fact]
    public void Passwords_hashed_by_typescript_check_here()
    {
        var cases = Cases("hashes");
        for (int i = 0; i < cases.Count; i++)
        {
            Assert.True(Crypto.CheckPassword(cases[i].Str("password")!, cases[i].Str("hash")!), cases[i].Str("hash"));
            if (i == 0)
            {
                Assert.False(Crypto.CheckPassword(cases[i].Str("password") + "!", cases[i].Str("hash")!));
            }
        }
    }

    [Fact]
    public void New_hashes_use_scrypt_and_check()
    {
        string hash = Crypto.HashPassword("a long password");
        Assert.Matches(new Regex("^scrypt\\$32768\\$8\\$3\\$[A-Za-z0-9_-]{22}\\$[A-Za-z0-9_-]{43}\\z"), hash);
        Assert.True(Crypto.CheckPassword("a long password", hash));
        Assert.False(Crypto.CheckPassword("a long passwore", hash));
        Assert.NotEqual(hash, Crypto.HashPassword("a long password"));
        // The same bytes any language's scrypt gives for that cost, so every port can check them.
        string[] parts = hash.Split('$');
        byte[] again = Scrypt.Derive(Js.Utf8("a long password"), Crypto.FromBase64url(parts[4]), 32768, 8, 3, 32);
        Assert.Equal(parts[5], Crypto.Base64url(again));
    }

    [Fact]
    public void A_scrypt_cost_out_of_bounds_is_refused_not_run()
    {
        string[] parts = Crypto.HashPassword("a long password").Split('$');
        foreach (string cost in new[] { "2097152$8$1", "30000$8$1", "1$8$1", "16384$33$1", "16384$8$17", "16384$0$1", "x$8$1", "1048576$1$1", "65536$1$1" })
        {
            Assert.False(Crypto.CheckPassword("a long password", "scrypt$" + cost + "$" + parts[4] + "$" + parts[5]), cost);
        }
    }

    [Fact]
    public void A_hash_made_at_the_old_cost_still_checks_and_is_weaker_than_now()
    {
        byte[] salt = Crypto.RandomBytes(16);
        string old = "scrypt$" + Crypto.Base64url(salt) + "$" + Crypto.Base64url(Scrypt.Derive(Js.Utf8("a long password"), salt, 16384, 8, 1, 32));
        Assert.True(Crypto.CheckPassword("a long password", old));
        Assert.False(Crypto.CheckPassword("a wrong password", old));
        Assert.True(Crypto.WeakerThanNow(old));
        Assert.True(Crypto.WeakerThanNow("scrypt$16384$8$1$" + Crypto.Base64url(salt) + "$" + Crypto.Base64url(Scrypt.Derive(Js.Utf8("a long password"), salt, 16384, 8, 1, 32))));
        Assert.True(Crypto.WeakerThanNow("pbkdf2$100000$AAAA$BBBB"));
        Assert.False(Crypto.WeakerThanNow(Crypto.HashPassword("a long password")));
        Assert.False(Crypto.WeakerThanNow("scrypt$65536$8$3$AAAA$BBBB"));
        Assert.False(Crypto.WeakerThanNow("nonsense"));
    }

    [Fact]
    public async Task Many_passwords_checked_at_once_take_turns_and_all_answer_right()
    {
        string hash = await Crypto.HashPasswordAsync("a long password");
        var checks = await Task.WhenAll(Enumerable.Range(0, 24).Select(i => Crypto.CheckPasswordAsync(i % 2 == 0 ? "a long password" : "wrong", hash)));
        Assert.Equal(Enumerable.Range(0, 24).Select(i => i % 2 == 0), checks);
        // A pooled table that was wiped gives the same key the next time.
        Assert.True(Crypto.CheckPassword("a long password", hash));
    }

    [Fact]
    public void Check_password_answers_as_typescript_does()
    {
        var failures = new List<string>();
        foreach (var c in Cases("checks"))
        {
            string label = c.Str("password") + " against " + c.Str("stored");
            if (c.Has("throws"))
            {
                try
                {
                    Crypto.CheckPassword(c.Str("password")!, c.Str("stored")!);
                    failures.Add(label + " should throw");
                }
                catch (ArgumentException)
                {
                }
                continue;
            }
            if (Crypto.CheckPassword(c.Str("password")!, c.Str("stored")!) != c.Bool("value"))
            {
                failures.Add(label);
            }
        }
        NoFailures(failures);
    }

    [Fact]
    public void Sealed_text_opens_both_ways()
    {
        foreach (var c in Cases("sealedByTs"))
        {
            Assert.Equal(c.Str("text"), Crypto.UnsealText(c.Str("sealed")!, c.Str("secret")!));
            Assert.Equal(c.Str("text"), Crypto.UnsealText(Crypto.SealText(c.Str("text")!, c.Str("secret")!), c.Str("secret")!));
        }
        foreach (var c in Cases("sealedWithIv"))
        {
            Assert.Equal(c.Str("sealed"), Crypto.SealText(c.Str("text")!, c.Str("secret")!, Crypto.FromBase64url(c.Str("iv")!)));
        }
    }

    [Fact]
    public void Unseal_answers_as_typescript_does()
    {
        var failures = new List<string>();
        foreach (var c in Cases("unseal"))
        {
            string? got = Crypto.UnsealText(c.Str("sealed")!, c.Str("secret")!);
            if (got != c.Str("result"))
            {
                failures.Add(Label(c) + " gave " + Label(got));
            }
        }
        NoFailures(failures);
    }

    [Fact]
    public void Base64_and_base32()
    {
        foreach (var c in Cases("base64"))
        {
            if (c.Has("throws"))
            {
                Assert.Throws<ArgumentException>(() => Crypto.FromBase64url(c.Str("text")!));
                continue;
            }
            Assert.Equal(c.Str("value"), Hex(Crypto.FromBase64url(c.Str("text")!)));
        }
        foreach (var c in Cases("encode"))
        {
            byte[] bytes = Convert.FromHexString(c.Str("hex")!);
            Assert.Equal(c.Str("base64url"), Crypto.Base64url(bytes));
            Assert.Equal(c.Str("base32"), Crypto.Base32(bytes));
            Assert.Equal(c.Str("hex"), Hex(Crypto.FromBase64url(c.Str("base64url")!)));
            Assert.Equal(c.Str("hex"), Hex(Crypto.Unbase32(c.Str("base32")!)));
        }
    }

    [Fact]
    public void Totp_codes()
    {
        var failures = new List<string>();
        foreach (var c in Cases("totp"))
        {
            string label = c.Str("secret") + " at " + Js.String(c.Get("step"));
            long step = (long)c.Num("step");
            if (c.Has("throws"))
            {
                try
                {
                    Crypto.Totp(c.Str("secret")!, step);
                    failures.Add(label + " should throw");
                }
                catch (ArgumentException)
                {
                }
                continue;
            }
            if (Crypto.Totp(c.Str("secret")!, step) != c.Str("value"))
            {
                failures.Add(label);
            }
        }
        NoFailures(failures);
    }

    [Fact]
    public void Rfc_6238_vector()
    {
        // RFC 6238's SHA-1 secret "12345678901234567890" at 59 seconds: 94287082, of which authenticator apps show the last six.
        Assert.Equal("287082", Crypto.Totp(Crypto.Base32(Js.Utf8("12345678901234567890")), 1));
        Assert.Equal("005924", Crypto.Totp(Crypto.Base32(Js.Utf8("12345678901234567890")), 1234567890 / 30));
    }

    [Fact]
    public void Match_step_allows_one_step_either_side_and_never_an_old_one()
    {
        const string secret = "JBSWY3DPEHPK3PXP";
        const long now = 1_759_900_000_000;
        long step = now / Crypto.StepMs;
        Assert.Equal(step, Crypto.MatchStep(secret, Crypto.Totp(secret, step), now, 0));
        Assert.Equal(step - 1, Crypto.MatchStep(secret, Crypto.Totp(secret, step - 1), now, 0));
        Assert.Equal(step + 1, Crypto.MatchStep(secret, Crypto.Totp(secret, step + 1), now, 0));
        Assert.Null(Crypto.MatchStep(secret, Crypto.Totp(secret, step + 2), now, 0));
        Assert.Null(Crypto.MatchStep(secret, Crypto.Totp(secret, step), now, step));
    }

    [Fact]
    public void Otpauth_signatures_recovery_and_same_text()
    {
        foreach (var c in Cases("uris"))
        {
            Assert.Equal(c.Str("uri"), Crypto.OtpauthUri(c.Str("secret")!, c.Str("email")!, c.Str("host")!));
        }
        foreach (var c in Cases("signatures"))
        {
            Assert.Equal(c.Str("signature"), Crypto.Signature(c.Str("secret")!, c.Str("body")!, c.Str("hash")!));
        }
        foreach (var c in Cases("recovery"))
        {
            Assert.Equal(c.Str("hash"), Crypto.RecoveryHash(c.Str("code")!));
        }
        foreach (var c in Cases("same"))
        {
            Assert.Equal(c.Bool("same"), Crypto.SameText(c.Str("a")!, c.Str("b")!));
        }
        var codes = Crypto.RecoveryCodes();
        Assert.Equal(10, codes.Count);
        foreach (string code in codes)
        {
            Assert.Matches(new Regex("^[a-z2-7]{4}-[a-z2-7]{4}\\z"), code);
        }
    }
}
