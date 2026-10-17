"""Accounts' cryptography against tests/fixtures/crypto.json, written by the TypeScript SDK and Node's own crypto."""

from __future__ import annotations

import hashlib
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from support import fixtures

from runlight.accounts import auth, crypto


def fixture():
    return fixtures.load("crypto")


def test_scrypt_gives_nodes_bytes():
    for case in fixture()["scrypt"]:
        key = crypto.scrypt(case["password"], crypto.from_base64url(case["salt"]), case["N"], case["r"], case["p"], case["length"])
        assert key.hex() == case["key"], fixtures.label([case["password"], case["N"], case["r"], case["p"], case["length"]])


def test_scrypt_test_vectors_from_rfc_7914():
    assert crypto.scrypt("", b"", 16, 1, 1, 64).hex() == (
        "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906"
    )
    assert crypto.scrypt("password", b"NaCl", 1024, 8, 16, 64).hex() == (
        "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640"
    )


def test_scrypt_refuses_a_bad_cost():
    with pytest.raises(ValueError):
        crypto.scrypt("x", b"y", 1000, 8, 1, 32)


def test_passwords_hashed_by_typescript_check_here():
    for i, case in enumerate(fixture()["hashes"]):
        assert crypto.check_password(case["password"], case["hash"]), case["hash"]
        if i == 0:
            assert not crypto.check_password(f"{case['password']}!", case["hash"])


def test_no_more_than_four_password_hashes_run_at_once(monkeypatch):
    running = [0]
    most = [0]
    lock = threading.Lock()
    real = crypto.hashlib.scrypt

    def counted(*args, **kwargs):
        with lock:
            running[0] += 1
            most[0] = max(most[0], running[0])
        try:
            time.sleep(0.02)
            return real(*args, **kwargs)
        finally:
            with lock:
                running[0] -= 1

    monkeypatch.setattr(crypto.hashlib, "scrypt", counted)
    hashed = crypto.hash_password("a long password")
    with ThreadPoolExecutor(20) as pool:
        assert all(pool.map(lambda _: crypto.check_password("a long password", hashed), range(20)))
    assert most[0] == crypto.PASSWORD_SLOTS == 4


def test_new_hashes_use_scrypt_and_check():
    hashed = crypto.hash_password("a long password")
    assert re.fullmatch(r"scrypt\$32768\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}", hashed)
    assert crypto.check_password("a long password", hashed)
    assert not crypto.check_password("a long passwore", hashed)
    assert hashed != crypto.hash_password("a long password"), "a new salt each time"


def test_a_hash_records_its_cost_and_a_cost_out_of_bounds_is_refused_not_run():
    hashed = crypto.hash_password("a long password")
    _, _, _, _, salt, key = hashed.split("$")
    # The same bytes any language's scrypt gives for that cost, so every port can check them.
    again = hashlib.scrypt(b"a long password", salt=crypto.from_base64url(salt), n=32768, r=8, p=3, maxmem=256 * 32768 * 8, dklen=32)
    assert crypto.base64url(again) == key
    for cost in ["2097152$8$1", "30000$8$1", "1$8$1", "16384$33$1", "16384$8$17", "16384$0$1", "x$8$1", "16384$8$1.5"]:
        assert crypto.check_password("a long password", f"scrypt${cost}${salt}${key}") is False, cost


def test_a_hash_from_before_costs_were_recorded_still_checks_at_the_old_cost():
    salt = b"0123456789abcdef"
    key = hashlib.scrypt(b"a long password", salt=salt, n=16384, r=8, p=1, maxmem=64 * 1024 * 1024, dklen=32)
    old = f"scrypt${crypto.base64url(salt)}${crypto.base64url(key)}"
    assert crypto.check_password("a long password", old)
    assert not crypto.check_password("another long one", old)
    assert crypto.weaker_than_now(old) is True
    assert crypto.weaker_than_now(crypto.hash_password("a long password")) is False
    assert crypto.weaker_than_now("pbkdf2$100000$AAAA$AAAA") is True
    assert crypto.weaker_than_now("nothing") is False
    assert crypto.weaker_than_now("scrypt$16384$8$1$AAAA$AAAA") is True
    assert crypto.weaker_than_now("scrypt$2097152$8$1$AAAA$AAAA") is False, "one out of bounds is not made again"


def test_check_password_answers_as_typescript_does():
    for case in fixture()["checks"]:
        label = f"{case['password']} against {case['stored']}"
        assert "throws" not in case, f"{label}: checkPassword never throws"
        assert crypto.check_password(case["password"], case["stored"]) is case["value"], label
    assert crypto.check_password("a long password", "scrypt$@@$" + "A" * 43) is False, "nor does a bad salt"
    assert crypto.check_password("a long password", "pbkdf2$1000$@@$" + "A" * 43) is False


def test_sealed_text_opens_both_ways():
    for case in fixture()["sealedByTs"]:
        assert crypto.unseal_text(case["sealed"], case["secret"]) == case["text"]
        assert crypto.unseal_text(crypto.seal_text(case["text"], case["secret"]), case["secret"]) == case["text"]
    for case in fixture()["sealedWithIv"]:
        assert crypto.seal_text(case["text"], case["secret"], crypto.from_base64url(case["iv"])) == case["sealed"]


def test_unseal_answers_as_typescript_does():
    for case in fixture()["unseal"]:
        assert crypto.unseal_text(case["sealed"], case["secret"]) == case["result"], case["sealed"]


def test_base64_and_base32():
    for case in fixture()["base64"]:
        if "throws" in case:
            with pytest.raises(ValueError):
                crypto.from_base64url(case["text"])
            continue
        assert crypto.from_base64url(case["text"]).hex() == case["value"], case["text"]
    for case in fixture()["encode"]:
        data = bytes.fromhex(case["hex"])
        assert crypto.base64url(data) == case["base64url"]
        assert auth.base32(data) == case["base32"]
        assert crypto.from_base64url(case["base64url"]).hex() == case["hex"]
        assert auth.unbase32(case["base32"]).hex() == case["hex"]


def test_totp_codes():
    for case in fixture()["totp"]:
        label = f"{case['secret']} at {case['step']}"
        if "throws" in case:
            with pytest.raises(ValueError):
                auth.totp(case["secret"], int(case["step"]))
            continue
        assert auth.totp(case["secret"], int(case["step"])) == case["value"], label


def test_rfc_6238_vector():
    # RFC 6238's SHA-1 secret "12345678901234567890" at 59 seconds: 94287082, of which authenticator apps show the
    # last six.
    assert auth.totp(auth.base32(b"12345678901234567890"), 1) == "287082"
    assert auth.totp(auth.base32(b"12345678901234567890"), 1234567890 // 30) == "005924"


def test_match_step_allows_one_step_either_side_and_never_an_old_one():
    secret = "JBSWY3DPEHPK3PXP"
    now = 1_759_900_000_000
    step = now // auth.STEP_MS
    assert auth.match_step(secret, auth.totp(secret, step), now, 0) == step
    assert auth.match_step(secret, auth.totp(secret, step - 1), now, 0) == step - 1
    assert auth.match_step(secret, auth.totp(secret, step + 1), now, 0) == step + 1
    assert auth.match_step(secret, auth.totp(secret, step + 2), now, 0) is None
    assert auth.match_step(secret, auth.totp(secret, step), now, step) is None, "a code used once is not taken again"


def test_otpauth_signatures_recovery_and_same_text():
    for case in fixture()["uris"]:
        assert auth.otpauth_uri(case["secret"], case["email"], case["host"]) == case["uri"]
    for case in fixture()["signatures"]:
        assert auth.signature(case["secret"], case["body"], case["hash"]) == case["signature"]
    for case in fixture()["recovery"]:
        assert auth.recovery_hash(case["code"]) == case["hash"], case["code"]
    for case in fixture()["same"]:
        assert crypto.same_text(case["a"], case["b"]) is case["same"]
    codes = auth.recovery_codes()
    assert len(codes) == 10
    for code in codes:
        assert re.fullmatch(r"[a-z2-7]{4}-[a-z2-7]{4}", code)
