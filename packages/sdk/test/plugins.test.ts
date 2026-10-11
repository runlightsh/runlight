import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AI_AGENTS } from "../src/data/agents.js";

// The tests that run PHP skip where it is not installed, except in CI, which
// installs it (.github/workflows/ci.yml), so there they fail instead.
const PLUGINS = ["wordpress/includes/Agents.php", "drupal/src/Agents.php", "craft/src/Agents.php"];
const DRUPAL = new URL("../../../plugins/drupal/", import.meta.url).pathname;
const CRAFT = new URL("../../../plugins/craft/", import.meta.url).pathname;

test("each CMS plugin knows every AI agent the server records, and no others", () => {
  const expected = AI_AGENTS.map((a) => a.token).sort();
  for (const file of PLUGINS) {
    const source = readFileSync(new URL(`../../../plugins/${file}`, import.meta.url), "utf8");
    const list = /TOKENS\s*=\s*(?:array\(|\[)([\s\S]*?)(?:\)|\]);/.exec(source)?.[1] ?? "";
    const tokens = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
    assert.deepEqual(tokens, expected, `${file} is out of step with src/data/agents.ts`);
  }
});

test("a CMS plugin keeps its saved keys only while its Runlight address stays the same", (t) => {
  // WordPress's sanitize runs under PHP with stand-ins for the few WordPress functions it calls.
  const settings = new URL("../../../plugins/wordpress/includes/Settings.php", import.meta.url).pathname;
  const script = `
    namespace Runlight\\WordPress;
    define("ABSPATH", "/");
    $GLOBALS["saved"] = ["address" => "https://stats.example.com/runlight", "observe_key" => "rlo_saved", "dashboard_key" => "rl_saved"];
    function get_option($name, $default) { return $GLOBALS["saved"]; }
    function sanitize_text_field($v) { return trim($v); }
    function wp_unslash($v) { return $v; }
    function untrailingslashit($v) { return rtrim($v, "/"); }
    function esc_url_raw($v, $protocols) { return $v; }
    function is_multisite() { return $GLOBALS["multisite"] ?? false; }
    function current_user_can($capability) { return $GLOBALS["network_admin"] ?? false; }
    require ${JSON.stringify(settings)};
    $keys = [];
    foreach ([["https://stats.example.com/runlight", "", ""], ["https://evil.example/runlight", "", ""], ["https://other.example/runlight", "rlo_new", "rl_new"]] as [$address, $key, $dashboard]) {
      $saved = Settings::sanitize(["address" => $address, "observe_key" => $key, "dashboard_key" => $dashboard]);
      $keys[] = [$saved["observe_key"], $saved["dashboard_key"]];
    }
    // On a network, a site's admin cannot move the address; a network admin can.
    $GLOBALS["saved"] = ["address" => "https://stats.example.com/runlight", "observe_key" => "rlo_saved", "dashboard_key" => "rl_saved"];
    $GLOBALS["multisite"] = true;
    $moved = Settings::sanitize(["address" => "http://10.0.0.5/runlight", "observe_key" => "", "dashboard_key" => ""]);
    $keys[] = [$moved["address"], $moved["observe_key"]];
    $GLOBALS["network_admin"] = true;
    $moved = Settings::sanitize(["address" => "http://10.0.0.5/runlight", "observe_key" => "", "dashboard_key" => ""]);
    $keys[] = [$moved["address"], $moved["observe_key"]];
    echo json_encode($keys);
  `;
  let answer: string;
  try {
    answer = execFileSync("php", ["-r", script], { encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !process.env.CI) return t.skip("PHP is not installed");
    throw error;
  }
  assert.deepEqual(JSON.parse(answer), [
    ["rlo_saved", "rl_saved"],
    ["", ""],
    ["rlo_new", "rl_new"],
    ["https://stats.example.com/runlight", "rlo_saved"],
    ["http://10.0.0.5/runlight", ""],
  ]);

  // Drupal's form tidies the address and keeps the keys by the same rule.
  const submit = `
    namespace Drupal\\Core\\Form { abstract class ConfigFormBase {} interface FormStateInterface {} }
    namespace {
      require ${JSON.stringify(DRUPAL + "tests/drupal.php")};
      require ${JSON.stringify(DRUPAL + "src/Form/SettingsForm.php")};
      $saved = ["address" => "https://stats.example.com/runlight", "observe_key" => "rlo_saved", "dashboard_key" => "rl_saved"];
      $keys = [];
      foreach ([["https://stats.example.com/runlight/", "", ""], ["https://evil.example/runlight", "", ""], ["https://other.example/runlight/s.js", "rlo_new", "rl_new"]] as [$address, $key, $dashboard]) {
        $kept = Drupal\\runlight\\Setup::keys($saved, Drupal\\runlight\\Form\\SettingsForm::tidy($address), $key, $dashboard);
        $keys[] = [$kept["observe_key"], $kept["dashboard_key"]];
      }
      echo json_encode($keys);
    }
  `;
  assert.deepEqual(JSON.parse(execFileSync("php", ["-r", submit], { encoding: "utf8" })), [["rlo_saved", "rl_saved"], ["", ""], ["rlo_new", "rl_new"]]);
});

test("the WordPress plugin hands Runlight the request without the slashes WordPress adds", (t) => {
  // WordPress slashes $_SERVER as it boots (wp_magic_quotes); the stand-ins below do the same and undo it as it does.
  const includes = new URL("../../../plugins/wordpress/includes/", import.meta.url).pathname;
  const script = `
    namespace Runlight\\WordPress;
    define("ABSPATH", "/");
    function slash($v) { return is_array($v) ? array_map(__NAMESPACE__ . "\\\\slash", $v) : (is_string($v) ? addslashes($v) : $v); }
    function wp_unslash($v) { return is_array($v) ? array_map(__NAMESPACE__ . "\\\\wp_unslash", $v) : (is_string($v) ? stripslashes($v) : $v); }
    require ${JSON.stringify(includes + "Library.php")};
    require ${JSON.stringify(includes + "Local.php")};
    $_SERVER = slash(["REQUEST_METHOD" => "GET", "HTTP_HOST" => "example.com", "REQUEST_URI" => "/runlight/it's?q=\\"a\\"", "HTTP_USER_AGENT" => "Bot \\"quoted\\" O'Brien", "HTTP_COOKIE" => "a=\\"b\\"", "REMOTE_ADDR" => "203.0.113.9"]);
    $request = Local::request();
    echo json_encode([$request->url, $request->headers->get("user-agent"), $request->headers->get("cookie"), $request->remoteAddress]);
  `;
  let answer: string;
  try {
    answer = execFileSync("php", ["-r", script], { encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !process.env.CI) return t.skip("PHP is not installed");
    throw error;
  }
  assert.deepEqual(JSON.parse(answer), ['http://example.com/runlight/it\'s?q="a"', 'Bot "quoted" O\'Brien', 'a="b"', "203.0.113.9"]);
});

test("every CMS plugin's PHP parses", (t) => {
  const root = new URL("../../../plugins/", import.meta.url).pathname;
  const files = execFileSync("find", [root, "-name", "*.php", "-not", "-path", "*/vendor/*"], { encoding: "utf8" }).trim().split("\n");
  for (const file of files) {
    try {
      execFileSync("php", ["-l", file], { encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !process.env.CI) return t.skip("PHP is not installed");
      throw new Error(`${file} does not parse: ${(error as { stdout?: string }).stdout ?? error}`);
    }
  }
});

test("the Craft plugin's settings read environment variables, check the address, and drop keys when it moves", (t) => {
  // The settings model runs under PHP with stand-ins for Craft's Model, App::parseEnv, and Craft::t.
  const settings = new URL("../../../plugins/craft/src/models/Settings.php", import.meta.url).pathname;
  const script = `
    namespace craft\\base {
      class Model {
        private array $errors = [];
        public function addError($attribute, $message) { $this->errors[$attribute][] = $message; }
        public function getErrors($attribute) { return $this->errors[$attribute] ?? []; }
      }
    }
    namespace craft\\helpers {
      class App {
        public static function parseEnv($value) { return is_string($value) && str_starts_with($value, "$") ? (getenv(substr($value, 1)) ?: $value) : $value; }
      }
    }
    namespace {
      class Craft { public static function t($category, $message, $params = []) { return $message; } }
      require ${JSON.stringify(settings)};
      use Runlight\\Craft\\models\\Settings;
      putenv("RUNLIGHT_SITE=blog.example.com");
      $out = [];

      $keys = [];
      $before = ["address" => "https://stats.example.com/runlight", "observeKey" => "rlo_saved", "dashboardKey" => '$RUNLIGHT_DASHBOARD_KEY'];
      foreach ([["https://stats.example.com/runlight/", "rlo_saved", '$RUNLIGHT_DASHBOARD_KEY'], ["https://evil.example/runlight", "rlo_saved", '$RUNLIGHT_DASHBOARD_KEY'], ["https://other.example/runlight", "rlo_new", '$OTHER_KEY']] as [$address, $key, $dashboard]) {
        $s = new Settings();
        $s->address = $address; $s->observeKey = $key; $s->dashboardKey = $dashboard;
        $s->forgetKeysIfMoved($before);
        $keys[] = [$s->observeKey, $s->dashboardKey];
      }
      $out["keys"] = $keys;

      $s = new Settings();
      $s->site = '$RUNLIGHT_SITE';
      $out["site"] = $s->getSite();

      $valid = [];
      foreach (["https://stats.example.com", "http://localhost:3000/runlight", "javascript:alert(1)", "stats.example.com", ""] as $address) {
        $s = new Settings();
        $s->address = $address;
        $s->validateAddress("address");
        $valid[] = $s->getErrors("address") === [];
      }
      $out["address"] = $valid;

      $sites = [];
      foreach (["blog.example.com", '$RUNLIGHT_SITE', "no spaces"] as $site) {
        $s = new Settings();
        $s->site = $site;
        $s->validateSite("site");
        $sites[] = $s->getErrors("site") === [];
      }
      $out["site ok"] = $sites;
      echo json_encode($out);
    }
  `;
  let answer: string;
  try {
    answer = execFileSync("php", ["-r", script], { encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !process.env.CI) return t.skip("PHP is not installed");
    throw error;
  }
  assert.deepEqual(JSON.parse(answer), {
    keys: [["rlo_saved", "$RUNLIGHT_DASHBOARD_KEY"], ["", ""], ["rlo_new", "$OTHER_KEY"]],
    site: "blog.example.com",
    address: [true, true, false, false, true],
    "site ok": [true, true, false],
  });
});

const WORDPRESS = new URL("../../../plugins/wordpress/", import.meta.url).pathname;

/** Runs PHP with the WordPress stand-ins loaded, or skips the test where PHP is not installed. */
function wordpressPhp(t: { skip: (message: string) => void }, script: string, env: Record<string, string> = {}): string | null {
  try {
    return execFileSync("php", ["-r", `require ${JSON.stringify(WORDPRESS + "tests/wordpress.php")}; ${script}`], { encoding: "utf8", env: { ...process.env, ...env } });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !process.env.CI) {
      t.skip("PHP is not installed");
      return null;
    }
    throw error;
  }
}

test("the WordPress plugin counts a visitor by an address no visitor can choose", (t) => {
  const answer = wordpressPhp(t, `
    require ${JSON.stringify(WORDPRESS + "includes/Visitor.php")};
    $cases = [
      // Cloudflare, then the host's nginx, which appends Cloudflare's address: the visitor, not Cloudflare.
      ["REMOTE_ADDR" => "10.0.0.2", "HTTP_X_FORWARDED_FOR" => "203.0.113.7, 172.70.1.1", "HTTP_CF_CONNECTING_IP" => "203.0.113.7"],
      // Nothing in front: a header the visitor wrote counts for nothing.
      ["REMOTE_ADDR" => "203.0.113.9", "HTTP_X_FORWARDED_FOR" => "198.51.100.23"],
      // Cloudflare straight to WordPress.
      ["REMOTE_ADDR" => "172.70.1.1", "HTTP_CF_CONNECTING_IP" => "198.51.100.4"],
      // Cloudflare's header from anywhere else is a visitor's own.
      ["REMOTE_ADDR" => "203.0.113.9", "HTTP_CF_CONNECTING_IP" => "1.2.3.4"],
      // Two proxies on a private network, after a visitor who wrote a header of their own.
      ["REMOTE_ADDR" => "127.0.0.1", "HTTP_X_FORWARDED_FOR" => "8.8.8.8, 198.51.100.7, 10.1.2.3"],
      // IPv6 from Cloudflare.
      ["REMOTE_ADDR" => "2606:4700::1", "HTTP_CF_CONNECTING_IP" => "2001:db8::5"],
      // A proxy that names no one: the proxy's own address.
      ["REMOTE_ADDR" => "127.0.0.1"],
      // Ports and brackets as some proxies write them, and a host's shared range.
      ["REMOTE_ADDR" => "100.64.3.2", "HTTP_X_FORWARDED_FOR" => "[2001:db8::9]:443"],
      ["REMOTE_ADDR" => "::ffff:10.0.0.2", "HTTP_X_FORWARDED_FOR" => "198.51.100.8:5555"],
      // Not an address at all.
      ["REMOTE_ADDR" => "10.0.0.2", "HTTP_X_FORWARDED_FOR" => "unknown"],
      [],
    ];
    $out = array_map(static fn (array $server): string => Runlight\\WordPress\\Visitor::address($server), $cases);
    // A host that knows better says so with the filter; an answer that is no address is ignored.
    add_filter("runlight_client_ip", static fn ($ip, $server) => $server["HTTP_X_CLIENT"] ?? $ip, 10, 2);
    $out[] = Runlight\\WordPress\\Visitor::address(["REMOTE_ADDR" => "203.0.113.9", "HTTP_X_CLIENT" => "192.0.2.44"]);
    $out[] = Runlight\\WordPress\\Visitor::address(["REMOTE_ADDR" => "203.0.113.9", "HTTP_X_CLIENT" => "nonsense"]);
    echo json_encode($out);
  `);
  if (answer === null) return;
  assert.deepEqual(JSON.parse(answer), [
    "203.0.113.7",
    "203.0.113.9",
    "198.51.100.4",
    "203.0.113.9",
    "198.51.100.7",
    "2001:db8::5",
    "127.0.0.1",
    "2001:db8::9",
    "198.51.100.8",
    "10.0.0.2",
    "",
    "192.0.2.44",
    "203.0.113.9",
  ]);
});

test("without an object cache, the WordPress plugin's rate counts take two rows in wp_options, however many visitors and minutes", (t) => {
  const answer = wordpressPhp(t, `
    require ${JSON.stringify(WORDPRESS + "includes/Library.php")};
    Runlight\\WordPress\\Library::load();
    require ${JSON.stringify(WORDPRESS + "includes/Cache.php")};
    $now = 1_791_288_000_000;
    $GLOBALS["wp_test"]["now"] = intdiv($now, 1000);
    $limit = new Runlight\\RateLimit(120, function () use (&$now): int { return $now; }, null, true, new Runlight\\WordPress\\Cache());
    $rows = static fn (): array => array_values(array_filter(array_keys(wp_test_options()), static fn (string $k): bool => str_starts_with($k, "_transient")));
    $most = 0;
    // Three days, a visit a minute from a new address each time, and a burst of 700 addresses in one minute.
    for ($minute = 0; $minute < 3 * 1440; $minute += 7) {
      $now = 1_791_288_000_000 + $minute * 60_000;
      $GLOBALS["wp_test"]["now"] = intdiv($now, 1000);
      $limit->allow("198.51.100." . ($minute % 250));
      $most = max($most, count($rows()));
    }
    $allowed = 0;
    for ($i = 0; $i < 700; $i++) {
      $allowed += $limit->allow("10.9." . intdiv($i, 250) . "." . ($i % 250)) ? 1 : 0;
    }
    $counts = get_transient("runlight_rate");
    // One address, past its limit within the minute.
    $refused = 0;
    for ($i = 0; $i < 130; $i++) {
      $refused += $limit->allow("203.0.113.1") ? 0 : 1;
    }
    $most = max($most, count($rows()));
    // The hourly check clears what is over once its minute and day have passed.
    $GLOBALS["wp_test"]["now"] += 2 * 86400;
    Runlight\\WordPress\\Cache::sweep();
    echo json_encode(["most" => $most, "allowed" => $allowed, "kept" => count($counts["counts"]), "refused" => $refused, "after" => $rows()]);
  `);
  if (answer === null) return;
  assert.deepEqual(JSON.parse(answer), { most: 4, allowed: 700, kept: 500, refused: 10, after: [] });
});

test("the WordPress plugin keeps its tables under WordPress's prefix, and drops only its own by name", (t) => {
  const run = (tables: string[], kept = "") =>
    wordpressPhp(t, `
      class wpdb {
        public $prefix = "wpx_";
        public $options = "wpx_options";
        public array $tables;
        public array $dropped = [];
        public function __construct(array $tables) { $this->tables = $tables; }
        public function get_var($sql) { return "8.4.3"; }
        public function esc_like($text) { return addcslashes($text, "_%\\\\"); }
        public function prepare($sql, ...$args) { return str_replace("%s", "'" . $args[0] . "'", $sql); }
        public function get_col($sql) {
          preg_match("/LIKE '(.*)'/", $sql, $m);
          $start = stripslashes(substr($m[1], 0, -1));
          return array_values(array_filter($this->tables, static fn ($t) => str_starts_with($t, $start)));
        }
        public function query($sql) { if (preg_match("/^DROP TABLE IF EXISTS \\\`(.*)\\\`$/", $sql, $m)) { $this->dropped[] = $m[1]; } return 1; }
      }
      function esc_sql($v) { return $v; }
      $GLOBALS["wpdb"] = new wpdb(${JSON.stringify(tables)});
      require ${JSON.stringify(WORDPRESS + "includes/Library.php")};
      require ${JSON.stringify(WORDPRESS + "includes/Storage.php")};
      ${kept ? `update_option("runlight_storage", ["kind" => ${JSON.stringify(kept)}, "file" => "x.db"]);` : ""}
      $kind = ${kept ? "null" : "Runlight\\WordPress\\Storage::kind()"};
      Runlight\\WordPress\\Storage::remove();
      echo json_encode(["kind" => $kind, "prefix" => Runlight\\WordPress\\Storage::prefix(), "dropped" => $GLOBALS["wpdb"]->dropped]);
    `);
  const own = ["meta", "sites", "salts", "sessions", "events", "links", "link_domains", "shares", "goals", "settings", "reports", "tokens", "funnels", "rollup_days", "rollups"].map((n) => `wpx_rl_${n}`);
  const fresh = run(["wpx_options", "wpx_posts", "rl_events", "rl_meta"]);
  if (fresh === null) return;
  // A new database: MySQL, under wpx_rl_, whatever a standalone Runlight keeps beside it as rl_.
  assert.deepEqual(JSON.parse(fresh), { kind: "mysql", prefix: "wpx_rl_", dropped: [] });
  // Runlight's own tables, left by an earlier copy: used again.
  assert.equal(JSON.parse(run([...own, "wpx_options"])!).kind, "mysql");
  // Another WordPress whose prefix is wpx_rl_ shares the database: a SQLite file instead.
  assert.equal(JSON.parse(run(["wpx_options", "wpx_rl_options", "wpx_rl_posts", "wpx_rl_links"])!).kind, "sqlite");
  assert.equal(JSON.parse(run(["wpx_options", ...own, "wpx_rl_extra"])!).kind, "sqlite");
  // Uninstalling drops Runlight's tables by name and nothing else, and only where its record of the schema is.
  assert.deepEqual(JSON.parse(run([...own, "wpx_options", "wpx_rl_extra", "rl_events", "rl_meta"], "mysql")!).dropped, own.slice().sort((a, b) => own.indexOf(a) - own.indexOf(b)));
  assert.deepEqual(JSON.parse(run(["wpx_options", "wpx_rl_options", "wpx_rl_links"], "mysql")!).dropped, []);
});

test("the WordPress plugin's zip serves the dashboard, counts a visit, and runs its check from the package it bundles", async (t) => {
  const php = spawnSync("php", ["--version"]);
  if (php.error && !process.env.CI) return t.skip("PHP is not installed");
  const dir = mkdtempSync(path.join(tmpdir(), "runlight-wp-zip-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const built = execFileSync("php", [WORDPRESS + "build.php", dir], { encoding: "utf8" });
  const zip = /build: (\S+\.zip)/.exec(built)?.[1];
  assert.ok(zip, built);
  execFileSync("php", ["-r", `$z = new ZipArchive(); $z->open($argv[1]); $z->extractTo($argv[2]); $z->close();`, zip, dir]);
  const plugin = path.join(dir, "runlight");
  assert.ok(existsSync(path.join(plugin, "vendor/runlight/runlight/src/Runlight.php")));
  const env = {
    ...process.env,
    RUNLIGHT_WP_PLUGIN: plugin,
    RUNLIGHT_WP_STATE: path.join(dir, "options"),
    RUNLIGHT_WP_UPLOADS: path.join(dir, "uploads"),
    RUNLIGHT_WP_ADMIN: "1",
  };
  const option = (name: string, value: string) =>
    execFileSync("php", ["-r", `require ${JSON.stringify(WORDPRESS + "tests/wordpress.php")}; update_option(${JSON.stringify(name)}, ${value});`], { env });
  option("runlight_settings", `["mode" => "local"]`);
  option("permalink_structure", `"/%postname%/"`);

  const port = 47000 + (process.pid % 2000);
  const home = `http://127.0.0.1:${port}`;
  const server = spawn("php", ["-S", `127.0.0.1:${port}`, WORDPRESS + "tests/serve.php"], { cwd: dir, env: { ...env, RUNLIGHT_WP_HOME: home }, stdio: "ignore" });
  t.after(() => server.kill());
  for (let i = 0; ; i++) {
    try {
      await fetch(`${home}/`);
      break;
    } catch (error) {
      if (i > 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const script = await fetch(`${home}/runlight/s.js`);
  assert.equal(script.status, 200, await script.clone().text());
  assert.match(script.headers.get("content-type") ?? "", /javascript/);
  const page = await fetch(`${home}/runlight/`);
  const html = await page.text();
  assert.equal(page.status, 200, html);
  assert.match(html, /data-cms="WordPress"/);
  // The dashboard's script, styles, map, and a translation, each from the zip.
  const assets = [...html.matchAll(/(?:src|href|data-world)="(\/runlight\/assets\/[^"]+)"/g), ...html.matchAll(/(\/runlight\/assets\/locale\.de\.[^&]+)&/g)].map((m) => m[1]!);
  assert.equal(assets.length, 4, html);
  for (const asset of assets) assert.equal((await fetch(home + asset)).status, 200, asset);
  const hit = await fetch(`${home}/runlight/e`, {
    method: "POST",
    headers: { "content-type": "text/plain", "user-agent": "Mozilla/5.0 (Macintosh) Chrome/129.0.0.0 Safari/537.36", "x-forwarded-for": "198.51.100.20" },
    body: JSON.stringify({ k: "pageview", u: `${home}/hello` }),
  });
  assert.ok(hit.status < 300, `${hit.status} ${await hit.text()}`);
  const stats = await fetch(`${home}/runlight/api/stats?period=today`, { headers: { accept: "application/json" } });
  const body = await stats.text();
  assert.equal(stats.status, 200, body);
  assert.equal(JSON.parse(body).stats.visitors, 1);
  const check = await fetch(`${home}/__check`);
  assert.match(await check.text(), /^checked [1-9]/);
  const other = await fetch(`${home}/hello`);
  assert.equal(await other.text(), "WordPress");

  // With plain permalinks nothing rewrites /runlight to WordPress on Apache, so it answers through index.php.
  option("permalink_structure", `""`);
  assert.equal((await fetch(`${home}/index.php/runlight/s.js`)).status, 200);
  assert.equal(await (await fetch(`${home}/runlight/s.js`)).text(), "WordPress");
});

/** Runs PHP with the Drupal stand-ins loaded, or skips the test where PHP is not installed. */
function drupalPhp(t: { skip: (message: string) => void }, script: string): string | null {
  try {
    return execFileSync("php", ["-r", `namespace { require ${JSON.stringify(DRUPAL + "tests/drupal.php")}; } ${script}`], { encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !process.env.CI) {
      t.skip("PHP is not installed");
      return null;
    }
    throw error;
  }
}

test("the Drupal module keeps where Runlight runs in state, with settings.php over it and older config moved out", (t) => {
  const answer = drupalPhp(t, `
    namespace DrupalTest {
      $config = new ConfigFactory();
      // An earlier version saved the address and a key in exported config.
      $config->configs["runlight.settings"] = new Config(["mode" => "", "address" => "https://stats.example.com", "observe_key" => "rlo_old", "dashboard_key" => "", "outbound" => true]);
      $state = new State();
      $setup = new \\Drupal\\runlight\\Setup($config, $state, new Invalidator());
      $before = [$setup->mode(), $setup->get("observe_key"), $setup->isSetUp()];
      $setup->save(["dashboard_key" => "rl_new"]);
      $after = [$setup->all(), $config->configs["runlight.settings"]->saved, $GLOBALS["drupal_test"]["invalidated"]];
      // settings.php wins, even with an empty value.
      $config->configs["runlight.settings"]->overrides = ["dashboard_key" => "rl_env", "observe_key" => ""];
      $override = [$setup->get("dashboard_key"), $setup->get("observe_key"), $setup->get("address")];
      echo json_encode([$before, $after, $override]);
    }
  `);
  if (answer === null) return;
  const [before, after, override] = JSON.parse(answer);
  assert.deepEqual(before, ["remote", "rlo_old", true]);
  assert.deepEqual(after[0], { mode: "", address: "https://stats.example.com", site: "", observe_key: "rlo_old", dashboard_key: "rl_new" });
  // Nothing of the connection is left in exported config; the counting settings stay.
  assert.deepEqual(after[1], { mode: "", address: "", observe_key: "", dashboard_key: "", outbound: true });
  assert.deepEqual(after[2], ["config:runlight.settings"]);
  assert.deepEqual(override, ["rl_env", "", "https://stats.example.com"]);
});

test("the Drupal module keeps its tables under Drupal's prefix, beside anyone else's, and drops only its own by name", (t) => {
  const run = (tables: string[], options: { prefix?: string; owner?: string | null; kept?: string; type?: string; version?: string; privatePath?: boolean } = {}) =>
    drupalPhp(t, `
      namespace DrupalTest {
        $root = sys_get_temp_dir() . "/runlight-drupal-" . getmypid() . "-" . bin2hex(random_bytes(4));
        if (${options.privatePath ? "true" : "false"}) {
          $GLOBALS["drupal_test"]["settings"]["file_private_path"] = $root . "/private";
        }
        $config = new ConfigFactory();
        $config->configs["system.site"] = new Config(["uuid" => "site-1"]);
        $db = new Database(${JSON.stringify(tables)}, ${JSON.stringify(options.prefix ?? "")}, ${JSON.stringify(options.type ?? "mysql")}, ${JSON.stringify(options.version ?? "8.4.3")}, ${options.owner === undefined ? "null" : JSON.stringify(options.owner)});
        $state = new State();
        ${options.kept ? `$state->set("runlight.storage", ["kind" => ${JSON.stringify(options.kept)}, "file" => "x.db"]);` : ""}
        $logger = new Logger();
        $storage = new \\Drupal\\runlight\\Storage($state, $db, new FileSystem($root), $config, $logger);
        $kind = $storage->kind();
        $clash = $storage->clash();
        $prefix = $storage->prefix();
        $storage->remove();
        echo json_encode(["kind" => $kind, "clash" => $clash, "prefix" => $prefix, "dropped" => $db->dropped, "log" => $logger->lines]);
      }
    `);
  const own = ["meta", "sites", "salts", "sessions", "events", "links", "link_domains", "shares", "goals", "settings", "reports", "tokens", "funnels", "rollup_days", "rollups"].map((n) => `rl_${n}`);
  const fresh = run(["node", "users", "cache_default"], { prefix: "d_" });
  if (fresh === null) return;
  // A new database: Drupal's own, under Drupal's prefix.
  assert.deepEqual(JSON.parse(fresh), { kind: "mysql", clash: false, prefix: "d_rl_", dropped: [], log: [] });
  assert.equal(JSON.parse(run(["node"], { type: "pgsql" })!).kind, "postgres");
  // MySQL before 8.4 and MariaDB before 11.4 lack the collation, so SQLite in the private folder, or nothing without one.
  assert.equal(JSON.parse(run(["node"], { version: "8.0.36" })!).kind, "");
  assert.equal(JSON.parse(run(["node"], { version: "10.11.6-MariaDB", privatePath: true })!).kind, "sqlite");
  assert.equal(JSON.parse(run(["node"], { type: "sqlite", privatePath: true })!).kind, "sqlite");
  // This site's own tables, left by an earlier install: used again.
  assert.equal(JSON.parse(run([...own, "node"], { owner: "site-1" })!).kind, "mysql");
  // A standalone Runlight's tables, or another site's, under the same names: never shared.
  const standalone = JSON.parse(run([...own, "node"], { owner: null, privatePath: true })!);
  assert.deepEqual([standalone.kind, standalone.clash], ["sqlite", true]);
  assert.equal(JSON.parse(run([...own, "node"], { owner: "site-2" })!).kind, "");
  assert.equal(JSON.parse(run(["rl_events", "rl_meta", "rl_extra"], { owner: "site-1" })!).kind, "");
  // Uninstalling drops Runlight's tables by name and nothing else, and only this site's.
  const dropped = JSON.parse(run([...own, "node", "rl_extra_of_someone"], { owner: "site-1", kept: "mysql" })!);
  assert.deepEqual(dropped.dropped, []);
  assert.match(dropped.log[0], /left the tables starting rl_ in place/);
  assert.deepEqual(JSON.parse(run([...own, "node"], { owner: "site-1", kept: "mysql" })!).dropped, own);
  assert.deepEqual(JSON.parse(run([...own, "node"], { owner: "site-2", kept: "mysql" })!).dropped, []);
  assert.deepEqual(JSON.parse(run(["node", "rl_events"], { kept: "mysql" })!).dropped, []);
});

test("the Drupal module counts a visitor by the address Drupal works out, and takes changes only from its own pages", (t) => {
  const answer = drupalPhp(t, `
    namespace Symfony\\Component\\HttpFoundation {
      final class Bag {
        public function __construct(private array $values) {}
        public function get(string $key, mixed $default = null): mixed { return $this->values[strtolower($key)] ?? $default; }
        public function all(): array { return array_map(static fn ($v) => [$v], $this->values); }
      }
      /** Symfony's request, trusting X-Forwarded-For only from the proxies Drupal's reverse_proxy settings name. */
      class Request {
        public Bag $headers;
        public Bag $server;
        public static array $trusted = [];
        public function __construct(array $headers, string $remote) {
          $this->headers = new Bag(array_change_key_case($headers));
          $this->server = new Bag(["remote_addr" => $remote]);
        }
        public function getRealMethod(): string { return "POST"; }
        public function getContent(bool $stream = false): mixed { $s = fopen("php://memory", "r+"); fwrite($s, "{}"); rewind($s); return $s; }
        public function getRequestUri(): string { return "/runlight/e"; }
        public function getSchemeAndHttpHost(): string { return "https://www.example.com"; }
        public function getClientIp(): ?string {
          $remote = $this->server->get("REMOTE_ADDR");
          if (!in_array($remote, self::$trusted, true)) return $remote;
          $chain = array_map("trim", explode(",", (string) $this->headers->get("x-forwarded-for", "")));
          return $chain[count($chain) - 1] ?: $remote;
        }
      }
      class Response {}
    }
    namespace {
      use Symfony\\Component\\HttpFoundation\\Request;
      $runlight = new Runlight\\Runlight(["store" => Runlight\\Store\\Stores::sqlite(":memory:"), "site" => ["id" => "default", "hostnames" => []], "secret" => str_repeat("s", 32), "trustProxy" => false]);
      $address = static function (Request $request) use ($runlight): array {
        $ours = Drupal\\runlight\\Local::visitorRequest($request);
        return [$ours->remoteAddress, $runlight->clientIp($ours, ["ip" => $ours->remoteAddress])];
      };
      $headers = ["x-forwarded-for" => "198.51.100.23", "cf-connecting-ip" => "198.51.100.24", "content-type" => "application/json"];
      $out = [];
      // Nothing in front: a header the visitor wrote counts for nothing.
      $out[] = $address(new Request($headers, "203.0.113.9"));
      // A proxy Drupal is told about: the address it passes on.
      Request::$trusted = ["10.0.0.2"];
      $out[] = $address(new Request(["x-forwarded-for" => "203.0.113.7"], "10.0.0.2"));
      // Changes come only from the site's own pages.
      $same = static fn (string $method, array $headers): bool => Drupal\\runlight\\Local::sameSite(new Runlight\\Http\\Request("https://www.example.com/runlight/api/goals", $method, $headers));
      $out[] = [
        $same("POST", ["sec-fetch-site" => "same-origin"]),
        $same("POST", ["sec-fetch-site" => "cross-site"]),
        $same("POST", ["sec-fetch-site" => "same-site"]),
        $same("DELETE", ["origin" => "https://evil.example"]),
        $same("PATCH", ["origin" => "https://www.example.com"]),
        $same("POST", []),
        $same("GET", ["sec-fetch-site" => "cross-site"]),
      ];
      echo json_encode($out);
    }
  `);
  if (answer === null) return;
  assert.deepEqual(JSON.parse(answer), [
    ["203.0.113.9", "203.0.113.9"],
    ["203.0.113.7", "203.0.113.7"],
    [true, false, false, false, true, true, true],
  ]);
});

test("the Drupal module's Connect gets the site's keys from a Runlight over OAuth, and keeps them in state", (t) => {
  const answer = drupalPhp(t, `
    namespace DrupalTest {
      $rl = new \\Runlight\\Runlight([
        "store" => \\Runlight\\Store\\Stores::sqlite(":memory:"),
        "site" => ["id" => "blog", "name" => "Blog", "hostnames" => ["cms.example"]],
        "secret" => str_repeat("s", 32),
        "trustProxy" => false,
      ]);
      $routes = $rl->routes(["basePath" => "/runlight", "token" => null, "authorize" => static fn (): bool => true]);
      $client = new Client(static fn (\\Runlight\\Http\\Request $request): \\Runlight\\Http\\Response => $routes->handle($request));
      $config = new ConfigFactory();
      $state = new State();
      $setup = new \\Drupal\\runlight\\Setup($config, $state, new Invalidator());
      $keyValue = new KeyValue();
      $connect = new \\Drupal\\runlight\\Connect($client, $keyValue, $setup, new Account(7));
      $out = [];
      // A default port makes no difference to where its endpoints must be.
      $to = $connect->start("https://stats.example:443/runlight");
      $out[] = get_class($to);
      $authorize = parse_url($to->getTargetUrl());
      parse_str($authorize["query"], $asked);
      // The owner allows it on the consent page, and Runlight sends the admin back.
      $allowed = $routes->handle(new \\Runlight\\Http\\Request("https://stats.example/runlight/oauth/authorize", "POST", ["content-type" => "application/x-www-form-urlencoded"], http_build_query($asked + ["site" => "blog", "decision" => "allow"])));
      parse_str((string) parse_url((string) $allowed->headers->get("location"), PHP_URL_QUERY), $back);
      // The state proves the admin: another one's, or a second use, gets nowhere.
      $pending = $keyValue->collections["runlight.connect"]["7"];
      $out[] = (string) $connect->finish(["state" => "nope"] + $back)[1];
      $keyValue->collections["runlight.connect"]["7"] = $pending;
      [$ok, $message] = $connect->finish($back);
      $out[] = [$ok, (string) $message];
      $out[] = (string) $connect->finish($back)[1];
      $kept = $setup->all();
      $out[] = [$kept["mode"], $kept["address"], $kept["site"], str_starts_with($kept["observe_key"], ""), $kept["dashboard_key"] !== ""];
      // Nothing reached exported config.
      $out[] = array_filter($config->get("runlight.settings")->saved);
      // The keys work: the dashboard key opens the dashboard, and the agents key reports agents.
      $embed = $routes->handle(new \\Runlight\\Http\\Request("https://stats.example/runlight/api/embed", "POST", ["authorization" => "Bearer " . $kept["dashboard_key"], "content-type" => "application/json"], json_encode(["origin" => "https://cms.example"])));
      $observe = $routes->handle(new \\Runlight\\Http\\Request("https://stats.example/runlight/api/observe", "POST", ["authorization" => "Bearer " . $kept["observe_key"], "content-type" => "application/json"], json_encode(["url" => "https://cms.example/", "userAgent" => "ChatGPT-User/1.0"])));
      $out[] = [$embed->status, $observe->status];
      // A Runlight that cannot be reached says why.
      $client->fail = "cURL error 6: Could not resolve host: stats.example";
      $out[] = (string) $connect->start("https://stats.example/runlight");
      echo json_encode($out);
    }
  `);
  if (answer === null) return;
  const [kind, wrong, finished, again, kept, exported, keys, unreachable] = JSON.parse(answer);
  assert.equal(kind, "Drupal\\Core\\Routing\\TrustedRedirectResponse");
  assert.match(wrong, /took too long or was already used/);
  assert.deepEqual(finished, [true, "Connected. Runlight counts this site as blog."]);
  assert.match(again, /took too long or was already used/);
  assert.deepEqual(kept, ["remote", "https://stats.example:443/runlight", "blog", true, true]);
  assert.deepEqual(exported, []);
  assert.deepEqual(keys, [201, 204]);
  assert.match(unreachable, /Could not reach a Runlight at https:\/\/stats\.example\/runlight: cURL error 6/);
});

test("the Drupal module keeps rate counts in two cache items, however many visitors and minutes, and nothing in files", (t) => {
  const answer = drupalPhp(t, `
    namespace DrupalTest {
      $now = 1_791_288_000_000;
      $clock = new Clock(intdiv($now, 1000));
      $backend = new CacheBackend($clock);
      $limit = new \\Runlight\\RateLimit(120, function () use (&$now): int { return $now; }, "/nonexistent/never-written", true, new \\Drupal\\runlight\\Cache($backend, $clock));
      $most = 0;
      for ($minute = 0; $minute < 3 * 1440; $minute += 7) {
        $now = 1_791_288_000_000 + $minute * 60_000;
        $clock->now = intdiv($now, 1000);
        $limit->allow("198.51.100." . ($minute % 250));
        $most = max($most, count($backend->items));
      }
      $allowed = 0;
      for ($i = 0; $i < 700; $i++) {
        $allowed += $limit->allow("10.9." . intdiv($i, 250) . "." . ($i % 250)) ? 1 : 0;
      }
      $refused = 0;
      for ($i = 0; $i < 130; $i++) {
        $refused += $limit->allow("203.0.113.1") ? 0 : 1;
      }
      $tags = array_unique(array_merge(...array_column($backend->items, "tags")));
      // The hourly check clears what is over once its minute and day have passed.
      $clock->now += 2 * 86400;
      (new \\Drupal\\runlight\\Cache($backend, $clock))->sweep();
      echo json_encode(["most" => $most, "allowed" => $allowed, "refused" => $refused, "tags" => array_values($tags), "after" => array_keys($backend->items)]);
    }
  `);
  if (answer === null) return;
  assert.deepEqual(JSON.parse(answer), { most: 2, allowed: 700, refused: 10, tags: ["runlight"], after: [] });
});
