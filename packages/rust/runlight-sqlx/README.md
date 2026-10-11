# runlight-sqlx

Runlight's tables in your own database, through sqlx and your own pool: `runlight_sqlx::sqlite(pool)`, `runlight_sqlx::postgres(pool)`, or `runlight_sqlx::mysql(pool)`, each behind the crate feature of the same name, or `runlight_sqlx::connect(url)` for a pool of its own. The tables and statements are the TypeScript library's, so a Rust service can share a database with a Node or PHP one.

Every table and index name starts with `rl_`. Two apps sharing one database can each keep a set of their own: `sqlite_with_prefix(pool, "wp_rl_")`, `postgres_with_prefix`, `mysql_with_prefix`, and `connect_with_prefix` put another prefix in its place.

MySQL 8's default sign-in over a connection without TLS needs sqlx's `mysql-rsa` feature, so turn it on in your own `Cargo.toml` or connect over TLS.

The [Rust guide](https://runlight.sh/docs/rust/) has the rest.
