# runlight-sqlx

Runlight's tables in your own database, through sqlx and your own pool: `runlight_sqlx::sqlite(pool)`, `runlight_sqlx::postgres(pool)`, or `runlight_sqlx::mysql(pool)`, each behind the crate feature of the same name, or `runlight_sqlx::connect(url)` for a pool of its own. The tables and statements are the TypeScript library's, so a Rust service can share a database with a Node or PHP one.

Every value is a bound parameter, never part of a statement's text. On Postgres that means prepared statements, so the connection needs the same as sqlx itself needs: a direct connection, session pooling, or PgBouncer 1.21 or later with `max_prepared_statements` above 0. A pool made with `statement_cache_capacity(0)` works too: its statements run unnamed and none is left on the server.

Every table and index name starts with `rl_`. Two apps sharing one database can each keep a set of their own: `sqlite_with_prefix(pool, "wp_rl_")`, `postgres_with_prefix`, `mysql_with_prefix`, and `connect_with_prefix` put another prefix in its place.

MySQL 8's default sign-in over a connection without TLS needs sqlx's `mysql-rsa` feature, so turn it on in your own `Cargo.toml` or connect over TLS.

The [Rust guide](https://runlight.sh/docs/rust/) has the rest.
