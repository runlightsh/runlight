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

  // Drupal's form runs too, with stand-ins for the form base class, its state, and the saved config.
  const drupal = new URL("../../../plugins/drupal/src/Form/SettingsForm.php", import.meta.url).pathname;
  const submit = `
    namespace Drupal\\Core\\Form {
      interface FormStateInterface { public function getValue($key); }
      class Config {
        public array $values = ["address" => "https://stats.example.com/runlight", "observe_key" => "rlo_saved", "dashboard_key" => "rl_saved"];
        public function get($key) { return $this->values[$key] ?? null; }
        public function set($key, $value) { $this->values[$key] = $value; return $this; }
        public function save() { return $this; }
      }
      abstract class ConfigFormBase {
        public static ?Config $saved = null;
        protected function config($name) { return self::$saved; }
        public function submitForm(array &$form, FormStateInterface $form_state): void {}
      }
    }
    namespace {
      require ${JSON.stringify(drupal)};
      class State implements Drupal\\Core\\Form\\FormStateInterface {
        public function __construct(private array $values) {}
        public function getValue($key) { return $this->values[$key] ?? ""; }
      }
      $keys = [];
      foreach ([["https://stats.example.com/runlight/", "", ""], ["https://evil.example/runlight", "", ""], ["https://other.example/runlight", "rlo_new", "rl_new"]] as [$address, $key, $dashboard]) {
        Drupal\\Core\\Form\\ConfigFormBase::$saved = new Drupal\\Core\\Form\\Config();
        $form = [];
        (new Drupal\\runlight\\Form\\SettingsForm())->submitForm($form, new State(["address" => $address, "observe_key" => $key, "dashboard_key" => $dashboard]));
        $keys[] = [Drupal\\Core\\Form\\ConfigFormBase::$saved->values["observe_key"], Drupal\\Core\\Form\\ConfigFormBase::$saved->values["dashboard_key"]];
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
