# Contributing to Runlight

Bug reports and pull requests are welcome. For anything larger than a fix, open an issue first so we can agree on the approach.

## The repository

| Folder | What is in it |
| --- | --- |
| `packages/sdk` | The library, published as `@runlight/sdk`. |
| `packages/server` | The standalone server, published as `runlight.sh`. |
| `packages/dashboard` | The dashboard, built into the library. |
| `packages/tracker` | The browser script, built into the library. |
| `packages/php`, `packages/python`, `packages/ruby`, `packages/go`, `packages/java`, `packages/dotnet`, `packages/elixir`, `packages/rust` | Runlight in each of those languages. |
| `conformance` | The recorded answers every implementation is tested against. |
| `plugins` | The WordPress, Drupal, and Craft plugins. |

The TypeScript library is the reference. A change in behaviour lands there first, then `npm run conformance` rewrites `conformance/http.json`, and the other languages follow until their conformance tests pass again.

## Working on it

Use Node 24 (see `.nvmrc`), then:

```bash
npm install
npm run check
```

`npm run check` typechecks, runs the tests against SQLite, and runs the PHP package's tests. Set `RUNLIGHT_TEST_PG` to a Postgres connection string, and `RUNLIGHT_TEST_MYSQL` to a MySQL or MariaDB one, to run the tests against those as well; each test makes and drops its own schema. Each other language runs its own tests in its folder, as its CI workflow under `.github/workflows` shows.

A few rules hold everywhere:

- Never store an IP address, a full user agent, or any identifier that lasts longer than a day.
- No em or en dashes anywhere in the repository, including commit messages. `scripts/check-dashes.mjs` checks.
- Keep commit messages to one short line.

## Releasing

The library, the server, every other language's package, and the WordPress plugin share one version. The Drupal and Craft plugins take theirs from the release tag. Write the release's notes under `## Unreleased` in `CHANGELOG.md` (and in the Craft plugin's `CHANGELOG.md` and the WordPress readme's `= Unreleased =` section when they changed), then release from a clean `main`.

```bash
npm run release -- X.Y.Z --dry-run   # show every change and command, write nothing
npm run release -- X.Y.Z             # bump, check, commit "Release X.Y.Z", tag vX.Y.Z
```

The script bumps every file listed in `VERSIONED` at the top of `scripts/release.mjs`, dates the changelogs' Unreleased sections, and lists any other tracked file that still names the old version. It refreshes `package-lock.json` and each language's copy of the built assets, runs `npm run check` and the build, builds the WordPress zip, and installs the packed npm packages in a scratch project to load every entry point and run `runlight.sh --version`. Set `RUNLIGHT_TEST_PG` and `RUNLIGHT_TEST_MYSQL` first so the check covers both databases. A new folder under `packages/` or `plugins/` needs a row in the script's tables, or the script refuses to run.

It fetches `main` first and refuses unless your `main` is exactly origin's and the tag is not on origin yet. It never pushes or publishes. It prints what to run next, which is `git push --atomic origin main vX.Y.Z` (the commit and the tag go up together, or neither does) and then `npm publish` for `@runlight/sdk` and `runlight.sh`, in that order, once CI has passed. The tag starts the workflows below, and each one waits for CI to pass on the tagged commit (`ci-passed.yml`) and does nothing until its switch is set.

| Workflow | What it does | Switch |
| --- | --- | --- |
| `docker.yml` | Builds the server's image for amd64 and arm64 and pushes it to `ghcr.io/runlightsh/runlight` | `DOCKER_ENABLED` variable |
| `release.yml` | Makes the GitHub release from the changelog and attaches the WordPress zip as `runlight-X.Y.Z.zip` and `runlight.zip` | `RELEASE_ENABLED` variable |
| `php-split.yml` | Pushes `packages/php` and the tag to `runlightsh/runlight-php` for Packagist | `PHP_SPLIT_DEPLOY_KEY` secret |
| `php-plugins-split.yml` | Pushes the Drupal module to drupal.org and the Craft plugin to `runlightsh/runlight-craft` | `DRUPAL_SPLIT_ENABLED` and `CRAFT_SPLIT_ENABLED` variables |
| `pypi.yml` | Builds `packages/python` and publishes it to PyPI as `runlight` with trusted publishing | `PYPI_ENABLED` variable |
| `hex.yml` | Publishes `packages/elixir` to Hex as `runlight`, with its docs on HexDocs | `HEX_ENABLED` variable and `HEX_API_KEY` secret |
| `maven.yml` | Builds, signs, and publishes `sh.runlight:runlight`, `runlight-servlet`, and `runlight-spring-boot-starter` to Maven Central through the Central Publisher Portal | `MAVEN_ENABLED` variable, with the Portal token and the GPG key as secrets |
| `nuget.yml` | Packs `Runlight`, `Runlight.AspNetCore`, and `Runlight.Server` and publishes them to nuget.org in that order with trusted publishing | `NUGET_ENABLED` variable |
| `crates.yml` | Publishes the `runlight` crate and then `runlight-sqlx` to crates.io with trusted publishing | `CRATES_ENABLED` variable |

The PyPI, NuGet, crates.io, Hex, and Maven workflows publish from a GitHub environment of the same name, so a required reviewer there makes each publish wait for a click. Each workflow's header says what to set up first. To run one of these workflows again by hand, choose Run workflow in the Actions tab and pick the release tag, not a branch, under Use workflow from; a run from a branch fails before it does anything. crates.io trusts a workflow only for a crate that already exists, so the first Rust release is published by hand with `cargo publish --workspace` in `packages/rust`.

Two languages ship from the commands the script prints. The Ruby gem is built and pushed by hand with `gem build runlight.gemspec` and `gem push runlight-X.Y.Z.gem` in `packages/ruby`. Go modules are versioned by tags, so the release commit also gets `packages/go/vX.Y.Z` and a tag of the same form for each of the `chi`, `echo`, and `cmd/runlight` modules. Once those are pushed, `go list -m` against `proxy.golang.org` makes the Go proxy fetch them, and `runlight.sh` answers the go command's lookups for `runlight.sh/go`.

After the Drupal split, make the release on drupal.org from the pushed tag.
