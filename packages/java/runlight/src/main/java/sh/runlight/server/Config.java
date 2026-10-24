package sh.runlight.server;

import java.io.IOException;
import java.io.Reader;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Locale;
import java.util.Objects;
import java.util.Properties;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import sh.runlight.Env;
import sh.runlight.Geo;
import sh.runlight.Hash;
import sh.runlight.Js;
import sh.runlight.accounts.Web;
import sh.runlight.store.SqlStore;
import sh.runlight.store.Stores;

/**
 * The standalone server's settings, as {@code runlight serve} and the other commands read them:
 * environment variables first, then a runlight.properties in the project folder (the working
 * folder, unless the command is told another) that sets the same names, one {@code NAME=value} a
 * line.
 *
 * <pre>
 *   PORT                  where to listen (3000)
 *   HOST                  which address to listen on (0.0.0.0)
 *   DATA_DIR              the SQLite file, the secret, the setup link, and location data (./runlight-data)
 *   DATABASE_URL          a postgres://, mysql://, or mariadb:// URL, to use that database instead of SQLite
 *   RUNLIGHT_SECRET       signs sessions and encrypts saved keys (made and kept in DATA_DIR if unset)
 *   RUNLIGHT_TOKEN        also accepted as a bearer token on the API, and makes the first account
 *   RUNLIGHT_URL          the dashboard's public address, which can never become a link domain
 *   TRUST_PROXY           unset believes forwarded addresses only from a private network; "false" never,
 *                         "true" from anywhere, or the one header a CDN sets, such as cf-connecting-ip
 *   RUNLIGHT_GEO          city (the default), country, off, or the path to an MMDB file
 *   CRON_SECRET           lets a scheduler run the check over HTTP, at POST /api/check
 *   RUNLIGHT_OBSERVE_KEY  one key for every site's AI agent reports
 * </pre>
 *
 * <p>Relative paths are read from the project folder. This is the port of PHP's Server/Config.php,
 * whose config.php becomes runlight.properties.
 */
public final class Config implements AutoCloseable {
  /** The settings file read from the project folder when no other is named. */
  public static final String FILE = "runlight.properties";

  private static final Pattern URL = Pattern.compile("^https?://[^/?#]+/?\\z");
  private static final Pattern SETUP_LINK = Pattern.compile("/setup\\?code=([A-Za-z0-9_-]+)");
  private static final Pattern POSTGRES =
      Pattern.compile("^postgres(ql)?://", Pattern.CASE_INSENSITIVE);
  private static final Pattern MYSQL = Pattern.compile("^mysql://", Pattern.CASE_INSENSITIVE);
  private static final Pattern MARIADB = Pattern.compile("^mariadb://", Pattern.CASE_INSENSITIVE);

  /** The project folder, which holds runlight.properties. */
  public final Path root;

  private final Properties file = new Properties();
  private String secret;
  private SqlStore store;

  /**
   * Settings from the environment and a properties file.
   *
   * @param root the project folder, which holds runlight.properties
   * @param named a properties file elsewhere, or null; RUNLIGHT_CONFIG names one too
   */
  public Config(Path root, String named) {
    this.root = root.toAbsolutePath().normalize();
    String given = named != null ? named : Env.get("RUNLIGHT_CONFIG");
    Path path = given != null ? path(given) : this.root.resolve(FILE);
    if (Files.isRegularFile(path)) {
      try (Reader reader = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
        file.load(reader);
      } catch (IOException | IllegalArgumentException e) {
        throw new IllegalStateException(
            "Runlight: could not read "
                + path
                + ". Write one setting a line, such as RUNLIGHT_URL=https://stats.example.com",
            e);
      }
    } else if (given != null) {
      throw new IllegalStateException("Runlight: there is no config file at " + path);
    }
  }

  /** Settings from the environment and the project folder's runlight.properties. */
  public Config(Path root) {
    this(root, null);
  }

  /** A setting: the environment's, else the file's, trimmed, with nothing for an empty one. */
  public String get(String name) {
    String value = Env.get(name);
    if (value != null) {
      return value;
    }
    String given = file.getProperty(name);
    if (given == null) {
      return null;
    }
    given = Js.trim(given);
    return given.isEmpty() ? null : given;
  }

  /** A path from a setting, read from the project folder when it is relative. */
  private Path path(String value) {
    return root.resolve(value).normalize();
  }

  /** The data folder, made on first use and readable only by this user. */
  public Path dataDir() {
    Path dir = dataPath();
    if (!Files.isDirectory(dir)) {
      try {
        createPrivately(dir);
      } catch (IOException e) {
        if (!Files.isDirectory(dir)) {
          throw new IllegalStateException(
              "Runlight: could not make the data folder "
                  + dir
                  + ". Make it, writable by this user, or set DATA_DIR.",
              e);
        }
      }
    }
    return dir;
  }

  /**
   * Makes a folder only this user can open, made so from the start. Folders above it that are
   * missing are made as usual.
   */
  private static void createPrivately(Path dir) throws IOException {
    Path parent = dir.toAbsolutePath().getParent();
    if (parent != null) {
      Files.createDirectories(parent);
    }
    try {
      Files.createDirectory(
          dir, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
    } catch (UnsupportedOperationException e) {
      // A file system without POSIX permissions keeps its own.
      Files.createDirectory(dir);
    }
  }

  private Path dataPath() {
    String dir = get("DATA_DIR");
    return path(dir != null ? dir : "runlight-data");
  }

  /** Where the data lives, for messages. */
  public String where() {
    String url = get("DATABASE_URL");
    url = url == null ? "" : url;
    if (POSTGRES.matcher(url).find()) {
      return "Postgres";
    }
    if (MYSQL.matcher(url).find()) {
      return "MySQL";
    }
    if (MARIADB.matcher(url).find()) {
      return "MariaDB";
    }
    return !url.isEmpty() ? url : dataPath().resolve("runlight.db").toString();
  }

  /** The store DATABASE_URL names, or SQLite in the data folder. Made once. */
  public synchronized SqlStore store() {
    if (store == null) {
      String url = get("DATABASE_URL");
      store =
          url != null
              ? Stores.url(url)
              : Stores.sqlite(dataDir().resolve("runlight.db").toString());
    }
    return store;
  }

  /** Closes the store, when one was opened. */
  @Override
  public synchronized void close() {
    if (store != null) {
      store.close();
      store = null;
    }
  }

  /**
   * RUNLIGHT_SECRET, or one made on first use and kept beside the data, readable only by this user.
   */
  public synchronized String secret() {
    if (secret != null) {
      return secret;
    }
    String given = get("RUNLIGHT_SECRET");
    if (given != null) {
      return secret = given;
    }
    Path path = dataDir().resolve("secret");
    String found = readWhole(path);
    if (found != null) {
      return secret = found;
    }
    String made = Hash.randomId(32);
    // Made once, written whole to a file of its own and then linked into place, which refuses to
    // replace a file already there, so a server starting at the same moment never reads half a
    // secret: whoever links first wins, and everyone else reads theirs.
    Path temp =
        dataDir().resolve(".secret-" + ProcessHandle.current().pid() + "-" + Hash.randomId(6));
    try {
      if (!create(temp, made + "\n")) {
        throw new IllegalStateException("Runlight: could not write " + temp);
      }
      try {
        Files.createLink(path, temp);
        return secret = made;
      } catch (FileAlreadyExistsException e) {
        return secret = Objects.requireNonNullElseGet(readWhole(path), () -> refuse(path));
      } catch (IOException | UnsupportedOperationException e) {
        // A file system with no hard links still creates the file only if it is not there; a reader
        // that catches it before its contents land reads it again.
        if (create(path, made + "\n")) {
          return secret = made;
        }
        return secret = Objects.requireNonNullElseGet(readWhole(path), () -> refuse(path));
      }
    } finally {
      try {
        Files.deleteIfExists(temp);
      } catch (IOException e) {
        // Gone already, or left for the next start to ignore.
      }
    }
  }

  /** Shorter than any secret this file has been given, so one caught half written is not used. */
  private static final int SHORTEST = 32;

  /**
   * The secret in a file, waiting up to two seconds for one too short to be whole; null when there
   * is no file.
   */
  private static String readWhole(Path path) {
    for (int tries = 0; ; tries++) {
      String text;
      try {
        if (!Files.isRegularFile(path)) {
          return null;
        }
        text = Js.trim(Files.readString(path));
      } catch (IOException e) {
        if (!Files.exists(path)) {
          return null;
        }
        throw new UncheckedIOException(e);
      }
      if (text.length() >= SHORTEST) {
        return text;
      }
      if (tries >= 20) {
        refuse(path);
      }
      pause(100);
    }
  }

  private static String refuse(Path path) {
    throw new IllegalStateException(
        "Runlight: "
            + path
            + " holds no whole secret. Delete it to have a new one made, which signs everyone out,"
            + " or set RUNLIGHT_SECRET.");
  }

  /**
   * Writes a new file readable only by this user; false when it is already there. The file is made
   * with those permissions, so it is never readable by others, even for a moment.
   */
  private static boolean create(Path path, String text) {
    Set<OpenOption> options = Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
    try (SeekableByteChannel channel = open(path, options)) {
      ByteBuffer bytes = ByteBuffer.wrap(text.getBytes(StandardCharsets.UTF_8));
      while (bytes.hasRemaining()) {
        channel.write(bytes);
      }
    } catch (FileAlreadyExistsException e) {
      return false;
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
    return true;
  }

  private static SeekableByteChannel open(Path path, Set<OpenOption> options) throws IOException {
    try {
      return Files.newByteChannel(
          path,
          options,
          PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
    } catch (UnsupportedOperationException e) {
      // A file system without POSIX permissions keeps its own.
      return Files.newByteChannel(path, options);
    }
  }

  private static void pause() {
    pause(50);
  }

  private static void pause(long millis) {
    try {
      Thread.sleep(millis);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }
  }

  /** The dashboard's public address, such as https://stats.example.com, or null. */
  public String url() {
    String url = get("RUNLIGHT_URL");
    if (url != null && !URL.matcher(url).find()) {
      throw new IllegalStateException(
          "Runlight: set RUNLIGHT_URL to the dashboard's address only, such as https://stats.example.com");
    }
    return url;
  }

  /**
   * TRUST_PROXY: false with nothing in front, true for a CDN that connects from public addresses,
   * or the one header the proxy sets, such as cf-connecting-ip behind Cloudflare. Null when unset,
   * so the library's default applies: forwarding headers count only from a private address.
   * Anything else is a mistake, said so rather than guessed at, since "0" or "off" read as on would
   * let any client choose its address.
   */
  public Object trustProxy() {
    String given = get("TRUST_PROXY");
    String value = given == null ? "" : Js.trim(given).toLowerCase(Locale.ROOT);
    if (value.isEmpty()) {
      return null;
    }
    if (Set.of("true", "1", "yes", "on").contains(value)) {
      return true;
    }
    if (Set.of("false", "0", "no", "off").contains(value)) {
      return false;
    }
    if (value.equals("x-forwarded-for")
        || value.equals("x-real-ip")
        || value.equals("cf-connecting-ip")) {
      return value;
    }
    throw new IllegalStateException(
        "Set TRUST_PROXY to true, false, or the header your proxy sets (x-forwarded-for,"
            + " x-real-ip, or cf-connecting-ip), not \""
            + given
            + "\"");
  }

  /** DB-IP's monthly download, for RUNLIGHT_GEO city (the default) or country, or null. */
  public DbIp dbIp() {
    String mode = get("RUNLIGHT_GEO");
    mode = mode == null ? "city" : mode.toLowerCase(Locale.ROOT);
    return mode.equals("city") || mode.equals("country")
        ? new DbIp(dataPath().resolve("geo"), mode)
        : null;
  }

  /**
   * Where locations come from: DB-IP's newest download (nothing until the first one is there), an
   * MMDB file of the owner's, opened at the first lookup, or null when RUNLIGHT_GEO is off.
   */
  public Geo.Lookup geo() {
    return geo(dbIp());
  }

  private Geo.Lookup geo(DbIp dbIp) {
    if (dbIp != null) {
      return dbIp::locate;
    }
    String setting = get("RUNLIGHT_GEO");
    if (setting != null && setting.toLowerCase(Locale.ROOT).equals("off")) {
      return null;
    }
    Path path = path(setting);
    Geo.Lookup[] lookup = {null};
    return ip -> {
      synchronized (lookup) {
        if (lookup[0] == null) {
          lookup[0] = Geo.fileLookup(path);
        }
      }
      return lookup[0].lookup(ip);
    };
  }

  /** The file that holds the setup link while there is no account. */
  public Path setupFile() {
    return dataDir().resolve("setup.txt");
  }

  /**
   * The one-time code that unlocks /setup, made the first time it is asked for and written to
   * setup.txt in the data folder with the link that carries it. With RUNLIGHT_TOKEN set there is
   * none: setup asks for the token.
   */
  public String setupCode() {
    if (get("RUNLIGHT_TOKEN") != null) {
      return null;
    }
    Path path = setupFile();
    String found = codeIn(path);
    if (found != null) {
      return found;
    }
    String code = Web.setupCode();
    String url = url();
    String link =
        (url != null ? url.replaceAll("/+\\z", "") : "https://your-runlight-address")
            + "/setup?code="
            + code;
    if (!create(
        path,
        "Open this link to create the first Runlight account. It works only while Runlight has no account.\n"
            + link
            + "\n")) {
      // Someone else wrote it first.
      pause();
      found = codeIn(path);
      if (found != null) {
        return found;
      }
      throw new IllegalStateException(
          "Runlight: could not write "
              + path
              + ". Make the data folder writable, or set RUNLIGHT_TOKEN.");
    }
    return code;
  }

  private static String codeIn(Path path) {
    try {
      if (!Files.isRegularFile(path)) {
        return null;
      }
      Matcher m = SETUP_LINK.matcher(Files.readString(path));
      return m.find() ? m.group(1) : null;
    } catch (IOException e) {
      return null;
    }
  }

  /**
   * The standalone server's options these settings describe, for a caller to change (such as now or
   * fetcher, for tests) before making one.
   *
   * @param setup whether to make the setup code when there is none, as the web pages need
   */
  public Standalone.Options options(boolean setup) {
    DbIp dbIp = dbIp();
    Geo.Lookup geo = geo(dbIp);
    String code = setup ? setupCode() : null;
    Standalone.Options options =
        new Standalone.Options()
            .store(store())
            .secret(secret())
            .token(get("RUNLIGHT_TOKEN"))
            .url(url())
            .trustProxy(trustProxy())
            .geoCredit(dbIp != null)
            .cronSecret(get("CRON_SECRET"))
            .observeKey(get("RUNLIGHT_OBSERVE_KEY"))
            .geo(geo);
    if (code != null) {
      options.setupCode(code);
      options.setupWhere(
          "in the file setup.txt in Runlight's data folder (<code>runlight setup</code> prints it too)");
    }
    return options;
  }

  /**
   * The standalone server these settings describe.
   *
   * @param setup whether to make the setup code when there is none, as the web pages need
   */
  public Standalone standalone(boolean setup) {
    return new Standalone(options(setup));
  }

  /** The standalone server, its setup code made when there is none. */
  public Standalone standalone() {
    return standalone(true);
  }
}
