// Command runlight starts the standalone server. Settings come from the environment:
//
//	PORT              where to listen (3000)
//	HOST              which address to listen on (0.0.0.0)
//	DATA_DIR          where the SQLite file and the secret live (./runlight-data)
//	DATABASE_URL      a postgres://, mysql://, or mariadb:// URL, to use that database instead of SQLite
//	                  (a MySQL URL's ?tls= or ?ssl-mode= sets its TLS; a host other than this machine is offered it)
//	RUNLIGHT_SECRET   signs sessions and encrypts saved keys (made and kept in DATA_DIR if unset)
//	RUNLIGHT_TOKEN    also accepted as a bearer token on the API
//	RUNLIGHT_URL      the dashboard's public address, which can never become a link domain
//	TRUST_PROXY       unset believes forwarded addresses only from a private network; "false" never,
//	                  "true" from anywhere, or the one header a CDN sets, such as cf-connecting-ip
//	RUNLIGHT_GEO      city (the default), country, off, or the path to an MMDB file
package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
	// The zone database is built in, so reports keep their timezones on a host or image without one.
	_ "time/tzdata"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"

	runlight "runlight.sh/go"
	"runlight.sh/go/server"
)

func env(name string) string { return strings.TrimSpace(os.Getenv(name)) }

const help = `Runlight %s, privacy friendly web analytics for any number of sites.

Usage:
  runlight                      Start the server
  runlight password <email>     Make an account, or give one a new password
  runlight agents --log <file>  Count AI agents from a web server's access log
  runlight --version            Print the version

Settings are environment variables. PORT (3000) and HOST (0.0.0.0) set where it
listens. DATA_DIR (./runlight-data) holds the SQLite file and the secret, and
DATABASE_URL switches to Postgres, MySQL, or MariaDB. RUNLIGHT_SECRET signs
sessions and encrypts saved keys, RUNLIGHT_TOKEN also works as a bearer token
on the API. Forwarded addresses count only from a proxy on this computer or a
private network; TRUST_PROXY=false ignores them, and behind a CDN that connects
from public addresses, TRUST_PROXY names its header, such as cf-connecting-ip.
RUNLIGHT_URL is the dashboard's public address, such as
https://stats.example.com, which short links can never take over.
RUNLIGHT_GEO picks where locations come from when no platform header gives
them. It is city by default, which downloads DB-IP's free city database into
DATA_DIR and refreshes it each month. Set it to country for a smaller file, to
off, or to the path of your own MMDB file.

Docs: https://runlight.sh/docs/go/
`

const agentsHelp = `Count AI agents on a site that has only the script tag, from its web server's log.

Usage:
  runlight agents --log /var/log/nginx/access.log --to https://stats.example.com --key rlo_...

  --log <file>    The access log, in nginx or Apache's combined format, or Caddy's JSON
  --to <url>      Your Runlight, as its dashboard address (or RUNLIGHT_URL)
  --key <key>     The site's agents key from Settings, Install (or RUNLIGHT_OBSERVE_KEY)
  --site <url>    The site's address, such as https://example.com, when the log has no host in it
  --follow        Keep running and send fetches as they happen
  --state <file>  Remember where it stopped, so the next run, or a restarted --follow, starts there.
                  Only one run at a time can use it.

Docs: https://runlight.sh/docs/server/#ai-agents-from-a-log
`

var (
	postgresURL  = regexp.MustCompile(`^postgres(ql)?://`)
	mysqlURL     = regexp.MustCompile(`^(mysql|mariadb)://`)
	dashboardURL = regexp.MustCompile(`^https?://[^/?#]+/?$`)
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "Runlight: %s\n", err)
		os.Exit(1)
	}
}

// openStore is SQLite in the data folder, or the database DATABASE_URL names.
func openStore(dataDir string) (*runlight.Store, runlight.Db, error) {
	address := env("DATABASE_URL")
	switch {
	case postgresURL.MatchString(address):
		u, err := url.Parse(address)
		if err != nil {
			return nil, nil, err
		}
		// Any one query stops after two minutes, as the SDK's Postgres store does.
		q := u.Query()
		if !q.Has("statement_timeout") {
			q.Set("statement_timeout", "120000")
		}
		u.RawQuery = q.Encode()
		db, err := sql.Open("pgx", u.String())
		if err != nil {
			return nil, nil, err
		}
		d := runlight.Postgres(db).Owned(0)
		return runlight.NewStore(d), d, nil
	case mysqlURL.MatchString(address):
		dsn, err := mysqlDSN(address)
		if err != nil {
			return nil, nil, err
		}
		db, err := sql.Open("mysql", dsn)
		if err != nil {
			return nil, nil, err
		}
		d := runlight.MySQL(db).Owned(120_000)
		return runlight.NewStore(d), d, nil
	}
	db, err := sql.Open("sqlite", filepath.Join(dataDir, "runlight.db"))
	if err != nil {
		return nil, nil, err
	}
	d := runlight.SQLite(db).Owned(0)
	return runlight.NewStore(d), d, nil
}

// mysqlDSN is a mysql:// or mariadb:// URL as go-sql-driver/mysql's DSN. The URL's ?tls= (true, false, skip-verify,
// or preferred) or ?ssl-mode= (as MySQL's own clients name them) carries over; with neither, a host that is not
// this machine is asked for TLS where it has it, so a password does not cross a network in the clear when it need not.
func mysqlDSN(raw string) (string, error) {
	u, err := url.Parse(strings.Replace(raw, "mariadb://", "mysql://", 1))
	if err != nil {
		return "", err
	}
	pass, _ := u.User.Password()
	host := u.Host
	if u.Port() == "" {
		host = net.JoinHostPort(u.Hostname(), "3306")
	}
	tls, err := mysqlTLS(u)
	if err != nil {
		return "", err
	}
	dsn := fmt.Sprintf("%s:%s@tcp(%s)/%s?charset=utf8mb4&loc=UTC", u.User.Username(), pass, host, strings.TrimPrefix(u.Path, "/"))
	if tls != "" {
		dsn += "&tls=" + tls
	}
	return dsn, nil
}

// mysqlTLS is the driver's tls setting for a URL: "" for the driver's own (no TLS).
func mysqlTLS(u *url.URL) (string, error) {
	query := u.Query()
	if given := query.Get("tls"); given != "" {
		switch strings.ToLower(given) {
		case "true", "false", "skip-verify", "preferred":
			return strings.ToLower(given), nil
		}
		return "", fmt.Errorf("Runlight: tls=%s is not one MySQL's driver knows (true, false, skip-verify, or preferred)", given)
	}
	for _, name := range []string{"ssl-mode", "sslmode", "ssl_mode"} {
		if given := query.Get(name); given != "" {
			switch strings.ToUpper(given) {
			case "DISABLED", "DISABLE":
				return "false", nil
			case "PREFERRED", "PREFER":
				return "preferred", nil
			case "REQUIRED", "REQUIRE":
				return "skip-verify", nil
			case "VERIFY_CA", "VERIFY_IDENTITY", "VERIFY-CA", "VERIFY-FULL":
				return "true", nil
			}
			return "", fmt.Errorf("Runlight: %s=%s is not a mode MySQL knows (DISABLED, PREFERRED, REQUIRED, VERIFY_CA, or VERIFY_IDENTITY)", name, given)
		}
	}
	if isLoopback(u.Hostname()) {
		return "", nil
	}
	return "preferred", nil
}

// isLoopback is whether a host is this machine: localhost, or a loopback address.
func isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// secretFor is RUNLIGHT_SECRET, or one made on first run and kept beside the data, readable only by this user.
func secretFor(dataDir string) (string, error) {
	if given := env("RUNLIGHT_SECRET"); given != "" {
		return given, nil
	}
	return secretIn(dataDir)
}

func flag(args []string, name string) string {
	for i, a := range args {
		if a == "--"+name && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func has(args []string, names ...string) bool {
	for _, a := range args {
		for _, n := range names {
			if a == n {
				return true
			}
		}
	}
	return false
}

func agents(args []string) error {
	if has(args, "--help", "-h") {
		fmt.Print(agentsHelp)
		return nil
	}
	log, to, key := flag(args, "log"), flag(args, "to"), flag(args, "key")
	if to == "" {
		to = env("RUNLIGHT_URL")
	}
	if key == "" {
		key = env("RUNLIGHT_OBSERVE_KEY")
	}
	if log == "" || to == "" || key == "" {
		fmt.Fprint(os.Stderr, agentsHelp)
		os.Exit(1)
	}
	options := server.AgentsOptions{To: to, Key: key, Site: flag(args, "site"), Follow: has(args, "--follow")}
	var err error
	if options.Log, err = filepath.Abs(log); err != nil {
		return err
	}
	if state := flag(args, "state"); state != "" {
		if options.State, err = filepath.Abs(state); err != nil {
			return err
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	_, err = server.RunAgents(ctx, options)
	return err
}

func run(args []string) error {
	command := ""
	if len(args) > 0 {
		command = args[0]
		args = args[1:]
	}
	switch command {
	case "--help", "-h", "help":
		fmt.Printf(help, runlight.Version)
		return nil
	case "--version", "-v":
		fmt.Println(runlight.Version)
		return nil
	case "agents":
		return agents(args)
	}

	dataDir, err := filepath.Abs(firstOf(env("DATA_DIR"), "./runlight-data"))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return err
	}
	store, db, err := openStore(dataDir)
	if err != nil {
		return err
	}
	defer db.(interface{ Close() error }).Close()

	logLine := func(line string) { fmt.Println(line) }
	geoSetting := firstOf(env("RUNLIGHT_GEO"), "city")
	var geo *server.Geo
	var lookup runlight.GeoLookup
	switch geoSetting {
	case "city", "country":
		if geo, err = server.NewGeo(filepath.Join(dataDir, "geo"), geoSetting, logLine, nil); err != nil {
			return err
		}
		lookup = geo.Lookup
	case "off":
	default:
		path, err := filepath.Abs(geoSetting)
		if err != nil {
			return err
		}
		if lookup, err = runlight.FileLookup(path); err != nil {
			return err
		}
	}
	address := env("RUNLIGHT_URL")
	if address != "" && !dashboardURL.MatchString(address) {
		return errors.New("Set RUNLIGHT_URL to the dashboard's address only, such as https://stats.example.com")
	}
	secret, err := secretFor(dataDir)
	if err != nil {
		return err
	}
	options := server.Options{Store: store, Secret: secret, Token: env("RUNLIGHT_TOKEN"), URL: address, Geo: lookup, GeoCredit: geo != nil,
		Logf: func(format string, args ...any) { fmt.Fprintf(os.Stderr, format+"\n", args...) }}
	if err := trustProxyFrom(env("TRUST_PROXY"), &options); err != nil {
		return err
	}
	srv, err := server.New(options)
	if err != nil {
		return err
	}
	ctx := context.Background()

	if command == "password" {
		if len(args) == 0 || args[0] == "" {
			return errors.New("Name the account: runlight password you@example.com")
		}
		email := args[0]
		if err := srv.Runlight.Init(ctx); err != nil {
			return err
		}
		b := make([]byte, 12)
		_, _ = rand.Read(b)
		password := base64.RawURLEncoding.EncodeToString(b)
		existing, err := srv.Accounts.ByEmail(ctx, email)
		if err != nil {
			return err
		}
		user, err := srv.Accounts.SetPassword(ctx, email, password, time.Now().UnixMilli(), "")
		if err != nil {
			return err
		}
		// Someone at the server is who they say, so a lost authenticator is no longer in the way.
		if user.TwoFactor {
			if err := srv.Accounts.DisableTwoFactor(ctx, user.ID); err != nil {
				return err
			}
		}
		what := "Account made, as an admin,"
		if existing != nil {
			what = "New password"
		} else if user.Role == "owner" {
			what = "Account made, as the owner,"
		}
		fmt.Printf("%s for %s: %s\n", what, strings.ToLower(strings.TrimSpace(email)), password)
		if user.TwoFactor {
			fmt.Println("Two-factor sign-in is now off for this account; turn it on again under Account.")
		}
		fmt.Println("Sign in, and change it by running this again whenever you like.")
		return nil
	}
	if command != "" && command != "start" {
		return fmt.Errorf("Unknown command %q. Run runlight --help.", command)
	}

	if err := srv.Runlight.Init(ctx); err != nil {
		return err
	}
	// A site's reports fall back to UTC when its zone cannot be loaded, so say so rather than count days quietly wrong.
	for _, site := range srv.Runlight.Sites() {
		if site.Timezone != "" && !runlight.IsTimezone(site.Timezone) {
			options.Logf("Runlight: could not load the timezone %q for site %s, so its reports use UTC", site.Timezone, site.ID)
		}
	}
	port, err := strconv.Atoi(firstOf(env("PORT"), "3000"))
	if err != nil {
		return errors.New("Set PORT to a number")
	}
	host := firstOf(env("HOST"), "0.0.0.0")
	listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return err
	}
	// A body is 10 MB at most, which a slow line sends within two minutes. Nothing streams: the longest
	// answer is a report or an export from a connected install, which may take two minutes to
	// arrive before it is passed on, so writes get five.
	http := &http.Server{Handler: srv, ReadHeaderTimeout: 30 * time.Second, ReadTimeout: 2 * time.Minute, WriteTimeout: 5 * time.Minute, IdleTimeout: 2 * time.Minute}
	shown := host
	if host == "0.0.0.0" || host == "::" {
		shown = "localhost"
	}
	fmt.Printf("Runlight %s is listening on http://%s\n", runlight.Version, net.JoinHostPort(shown, strconv.Itoa(port)))
	database := env("DATABASE_URL")
	where := filepath.Join(dataDir, "runlight.db")
	switch {
	case postgresURL.MatchString(database):
		where = "Postgres"
	case strings.HasPrefix(database, "mysql://"):
		where = "MySQL"
	case strings.HasPrefix(database, "mariadb://"):
		where = "MariaDB"
	}
	fmt.Println("Data: " + where)
	if count, err := srv.Accounts.Count(ctx); err == nil && count == 0 {
		fmt.Printf("\nNo account yet. Open this link to create the first one:\n  http://%s/setup?code=%s\n\n", net.JoinHostPort(shown, strconv.Itoa(port)), srv.SetupCode)
	}

	// The scheduled check (salts, email reports, retention, and rollups) and this month's location data: now, then every five minutes.
	stop, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			if err := srv.Check(stop); err != nil && stop.Err() == nil {
				fmt.Fprintf(os.Stderr, "Runlight: the scheduled check failed: %v\n", err)
			}
			if geo != nil {
				if err := geo.Refresh(stop, time.Now().UnixMilli()); err != nil {
					fmt.Fprintf(os.Stderr, "Runlight: could not refresh location data: %v\n", err)
				}
			}
			select {
			case <-stop.Done():
				return
			case <-ticker.C:
			}
		}
	}()

	done := make(chan error, 1)
	go func() { done <- http.Serve(listener) }()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	select {
	case err := <-done:
		return err
	case <-signals:
	}
	cancel()
	shutdown, release := context.WithTimeout(ctx, 5*time.Second)
	defer release()
	_ = http.Shutdown(shutdown)
	srv.Runlight.Idle()
	return nil
}

// trustProxyFrom reads TRUST_PROXY: "false" with nothing in front, "true" for a CDN that connects from public
// addresses, or the one header your proxy sets, such as cf-connecting-ip behind Cloudflare. Unset stays unset,
// so the library's default applies: forwarding headers count only from a private address. Anything else is a
// mistake, said so rather than guessed at, since "0" or "off" read as on would let any client choose its address.
func trustProxyFrom(given string, options *server.Options) error {
	switch value := strings.ToLower(strings.TrimSpace(given)); value {
	case "":
	case "true", "1", "yes", "on":
		options.TrustProxy = true
	case "false", "0", "no", "off":
		options.IgnoreProxy = true
	case "x-forwarded-for", "x-real-ip", "cf-connecting-ip":
		options.ProxyHeader = value
	default:
		return fmt.Errorf("Set TRUST_PROXY to true, false, or the header your proxy sets (x-forwarded-for, x-real-ip, or cf-connecting-ip), not %q", given)
	}
	return nil
}

func firstOf(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
