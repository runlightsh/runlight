package sh.runlight.server;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.zip.CRC32;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;
import sh.runlight.Geo;
import sh.runlight.Js;
import sh.runlight.Mmdb;

/**
 * Location for servers with no platform headers (Cloudflare, Vercel, and Netlify send their own,
 * and those always win), from DB-IP's free databases (CC BY 4.0, https://db-ip.com). This is the
 * port of the Geo class in packages/server/src/geo.ts: {@link #refresh(long)} downloads each
 * month's release (the server does it every five minutes, {@code runlight cron} each time it runs),
 * and lookups answer from the newest file on disk, opened again once a newer one arrives.
 *
 * <p>A download is used only once it is checked: its SHA-1 against the one DB-IP publishes on its
 * download page, and the file itself as a DB-IP database of the kind asked for, no older than the
 * one in use. That catches a damaged or swapped file, and a download server serving something else.
 * It is not a signature: DB-IP publishes none, so whoever can change DB-IP's own page can change
 * both. A checksum that does not match always refuses the download. Only when none can be read at
 * all (the page is down, or no longer reads as it did) is a download accepted on the other checks
 * alone, with a warning, so a change to that page does not stop location data everywhere.
 */
public final class DbIp {
  /** What one GET answered: its status, the length it declared (-1 for none), and its body. */
  public record Answer(int status, long length, InputStream body) {}

  /** One GET that goes nowhere but where it was sent: no redirect is followed. */
  @FunctionalInterface
  public interface Get {
    Answer get(String url, long timeoutMs) throws IOException;
  }

  /** The release DB-IP's page offers, and the SHA-1 it gives for the unpacked file. */
  public record Published(String release, String sha1) {}

  /** A download or a file that is not fit to use, with why; status is what a GET answered, or 0. */
  public static final class Refused extends RuntimeException {
    private static final long serialVersionUID = 1L;
    private final int status;

    Refused(String message) {
      this(message, 0);
    }

    Refused(String message, int status) {
      super(message);
      this.status = status;
    }

    public int status() {
      return status;
    }
  }

  private static final long DAY = 86_400_000L;

  /**
   * A release is built at the start of its month and stands in until the next appears, so one is
   * two months old at most.
   */
  private static final long OLDEST_BUILD = 100 * DAY;

  /** Addresses any location database knows: Google's and Cloudflare's resolvers, v4 and v6. */
  private static final List<String> KNOWN = List.of("8.8.8.8", "1.1.1.1", "2001:4860:4860::8888");

  /**
   * The most a database may unpack to, several times the city file's size, so a bad download cannot
   * fill the disk.
   */
  static final long MOST_BYTES = 512L * 1024 * 1024;

  /** The most the download itself may weigh, and the least a database unpacks to. */
  static final long MOST_PACKED_BYTES = 256L * 1024 * 1024;

  static final long FEWEST_BYTES = 1024 * 1024;

  /** The most of DB-IP's download page that is read; it is about 25 KB. */
  static final int MOST_PAGE_BYTES = 1024 * 1024;

  private static final byte[] MARKER = {
    (byte) 0xAB, (byte) 0xCD, (byte) 0xEF, 'M', 'a', 'x', 'M', 'i', 'n', 'd', '.', 'c', 'o', 'm'
  };

  private static final Pattern COUNTRY = Pattern.compile("^[A-Z]{2}\\z");
  private static final Pattern OTHER_LINK = Pattern.compile("download\\.db-ip\\.com/free/dbip-");
  private static final Pattern SHA1SUM =
      Pattern.compile("SHA1SUM[\\s\\S]{0,200}?\\b([0-9a-f]{40})\\b", Pattern.CASE_INSENSITIVE);

  private static final DateTimeFormatter MONTH =
      DateTimeFormatter.ofPattern("uuuu-MM", Locale.ROOT);

  private final Path dir;
  private final String mode;
  private final Get get;
  private final Consumer<String> log;
  private final Object opening = new Object();
  private volatile Path loaded;
  private volatile Path seen;
  private volatile long scanned = Long.MIN_VALUE;
  private volatile Geo.Lookup reader;

  /**
   * DB-IP's data in a folder.
   *
   * @param mode "city" or "country"
   * @param get answers one GET without following a redirect; Java's HttpClient by default
   * @param log what it has to say; standard error by default
   */
  public DbIp(Path dir, String mode, Get get, Consumer<String> log) {
    this.dir = dir;
    this.mode = mode;
    this.get = get != null ? get : DbIp::httpGet;
    this.log = log != null ? log : line -> System.err.println(line);
  }

  public DbIp(Path dir, String mode) {
    this(dir, mode, null, null);
  }

  /** "2026-10", the month DB-IP names each release after. */
  public static String month(long ms) {
    return MONTH.format(Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC));
  }

  private Path file(String release) {
    return dir.resolve("dbip-" + mode + "-lite-" + release + ".mmdb");
  }

  private String prefix() {
    return "dbip-" + mode + "-lite-";
  }

  private List<Path> releases() {
    if (!Files.isDirectory(dir)) {
      return List.of();
    }
    try (Stream<Path> files = Files.list(dir)) {
      return files.filter(f -> f.getFileName().toString().startsWith(prefix())).sorted().toList();
    } catch (IOException e) {
      return List.of();
    }
  }

  /** The newest release on disk, or null before the first download. */
  public Path newest() {
    Path found = null;
    for (Path file : releases()) {
      if (file.getFileName().toString().endsWith(".mmdb")) {
        found = file;
      }
    }
    return found;
  }

  /**
   * A lookup answering from the newest release on disk, or null when there is none yet. Lookups
   * that fail answer nothing, as they do before the first download in TypeScript.
   */
  public Geo.Lookup lookup() {
    return newest() == null ? null : this::locate;
  }

  /**
   * An address's location from the newest release on disk, opened at the first lookup and again
   * when a newer release arrives; null before the first download, or when the file cannot be read.
   */
  public Map<String, Object> locate(String ip) throws Exception {
    // The folder is read again at most once a minute, or at once after a refresh here.
    long tick = System.nanoTime();
    Path newest = seen;
    if (scanned == Long.MIN_VALUE || tick - scanned > 60_000_000_000L || newest == null) {
      newest = newest();
      seen = newest;
      scanned = tick;
    }
    if (newest == null) {
      return null;
    }
    Geo.Lookup current = reader;
    if (!newest.equals(loaded) || current == null) {
      synchronized (opening) {
        if (!newest.equals(loaded) || reader == null) {
          try {
            reader = Geo.lookupFrom(Mmdb.open(newest)::get);
          } catch (RuntimeException e) {
            return null;
          }
          loaded = newest;
        }
        current = reader;
      }
    }
    return current.lookup(ip);
  }

  /** The release answering lookups: the newest on disk, as "2026-10", or "" before the first. */
  public String release() {
    Path newest = newest();
    if (newest == null) {
      return "";
    }
    String name = newest.getFileName().toString();
    return name.substring(prefix().length(), name.length() - ".mmdb".length());
  }

  /**
   * Fetches this month's release when it is missing. Safe to call often: once this month's file is
   * there it reads only the folder, and while the month's file is not published yet, or a download
   * keeps failing, each try waits twice as long as the last, from five minutes up to six hours, so
   * neither DB-IP nor the disk is asked for the whole file every few minutes.
   */
  public void refresh(long now) {
    scanned = Long.MIN_VALUE;
    String current = month(now);
    if (Files.isRegularFile(file(current))) {
      wait = 0;
      return;
    }
    if (now < retryAt) {
      return;
    }
    try {
      fetchRelease(now, current);
    } finally {
      scanned = Long.MIN_VALUE;
      if (Files.isRegularFile(file(current))) {
        wait = 0;
      } else {
        wait = Math.min(wait == 0 ? FIRST_WAIT : wait * 2, LONGEST_WAIT);
        retryAt = now + wait;
      }
    }
  }

  /** How long after a first failed try the next one waits, and the longest any waits. */
  static final long FIRST_WAIT = 5 * 60_000L;

  static final long LONGEST_WAIT = 6 * 3_600_000L;

  /** After a try that left this month's file missing: how long the next waits, and when. */
  private volatile long wait;

  private volatile long retryAt;

  /** One GET that must answer 200, or a Refused that carries what it answered. */
  private Answer ask(String url, long timeoutMs) throws IOException {
    Answer answer = get.get(url, timeoutMs);
    if (answer.status() != 200 || answer.body() == null) {
      if (answer.body() != null) {
        answer.body().close();
      }
      throw new Refused("it answered " + answer.status(), answer.status());
    }
    return answer;
  }

  /** The release DB-IP's download page offers for this kind of database, and its SHA-1. */
  private Published published() {
    String url = "https://db-ip.com/db/download/ip-to-" + mode + "-lite";
    String page;
    try {
      Answer answer = ask(url, 30_000);
      try (InputStream body = answer.body()) {
        ByteArrayOutputStream kept = new ByteArrayOutputStream();
        byte[] chunk = new byte[16 * 1024];
        for (int n = body.read(chunk); n >= 0; n = body.read(chunk)) {
          if (kept.size() + n > MOST_PAGE_BYTES) {
            throw new Refused("it is more than " + MOST_PAGE_BYTES / 1024 + " KB");
          }
          kept.write(chunk, 0, n);
        }
        page = kept.toString(StandardCharsets.UTF_8);
      }
    } catch (IOException | RuntimeException error) {
      throw new Refused("could not read DB-IP's checksums at " + url + ": " + reason(error));
    }
    Published found = publishedChecksum(page, mode);
    if (found == null) {
      throw new Refused("found no checksum for the " + mode + " database at " + url);
    }
    return found;
  }

  private void fetchRelease(long now, String current) {
    try {
      Files.createDirectories(dir);
    } catch (IOException e) {
      log.accept("Runlight: could not make the folder for location data, " + dir);
      return;
    }
    // A new month's file appears a day or so after the month starts; until then, last month's is
    // current.
    ZonedDateTime at = Instant.ofEpochMilli(now).atZone(ZoneOffset.UTC);
    String previous = MONTH.format(at.withDayOfMonth(15).minusMonths(1).toLocalDate());
    List<String> tries = List.of(current, previous);
    // The page says which release there is and what it must hash to, so only that file is asked
    // for. When the page cannot be read, the newest release there is goes unchecked against it,
    // and the log says so.
    Published published = null;
    String unchecked = "";
    try {
      published = published();
    } catch (Refused error) {
      unchecked = error.getMessage();
    }
    if (published != null && !tries.contains(published.release())) {
      log.accept(
          "Runlight: location data was not updated: DB-IP offers the "
              + published.release()
              + " release, which is neither this month's nor last month's");
      return;
    }
    for (String name : published != null ? List.of(published.release()) : tries) {
      if (Files.isRegularFile(file(name))) {
        return;
      }
      String url = "https://download.db-ip.com/free/" + prefix() + name + ".mmdb.gz";
      Path partial = Path.of(file(name) + ".partial." + ProcessHandle.current().pid());
      try {
        save(url, partial, published != null ? published.sha1() : null, now);
        Files.move(
            partial,
            file(name),
            StandardCopyOption.ATOMIC_MOVE,
            StandardCopyOption.REPLACE_EXISTING);
        // Older releases go once the new one is in place.
        try (Stream<Path> files = Files.list(dir)) {
          for (Path old : files.toList()) {
            if (old.getFileName().toString().startsWith(prefix()) && !old.equals(file(name))) {
              Files.deleteIfExists(old);
            }
          }
        }
        if (published == null) {
          log.accept(
              "Runlight: warning: location data from DB-IP ("
                  + name
                  + ") could not be checked against DB-IP's published checksum ("
                  + unchecked
                  + "). It was accepted as a DB-IP database of the right kind, without that"
                  + " check.");
        }
        log.accept("Runlight: location data from DB-IP (" + name + ") is ready.");
        return;
      } catch (IOException | RuntimeException error) {
        try {
          Files.deleteIfExists(partial);
        } catch (IOException ignored) {
          // Left for the next release that is accepted to clear away.
        }
        // Without the page to say which release there is, this month's not being out yet is no
        // failure.
        if (published == null && error instanceof Refused refused && refused.status() == 404) {
          continue;
        }
        // Whatever went wrong, the database in use stays in use.
        log.accept("Runlight: location data was not updated from " + url + ": " + reason(error));
      }
    }
    if (published == null) {
      log.accept(
          "Runlight: location data was not updated: "
              + unchecked
              + ", and no release could be downloaded without them");
    }
  }

  private static String reason(Exception error) {
    return error.getMessage() != null ? error.getMessage() : error.toString();
  }

  /** When the database in use was built, in milliseconds, or 0 when there is none. */
  private long builtInUse() {
    Path newest = newest();
    if (newest == null) {
      return 0;
    }
    try {
      return (long) (Js.toNumber(Mmdb.open(newest).metadata().get("build_epoch")) * 1000);
    } catch (RuntimeException e) {
      return 0;
    }
  }

  /**
   * Downloads one release to {@code partial}, unpacked, and throws unless it is fit to use: the
   * published SHA-1's (when there is one to hold it to), and a DB-IP database of this kind no older
   * than the one in use.
   */
  private void save(String url, Path partial, String sha1, long now) throws IOException {
    Answer answer = ask(url, 10 * 60_000L);
    String got;
    try (InputStream body = answer.body()) {
      if (answer.length() > MOST_PACKED_BYTES) {
        throw new Refused("the download is more than " + MOST_PACKED_BYTES / 1024 / 1024 + " MB");
      }
      try (OutputStream out = Files.newOutputStream(partial)) {
        got = gunzip(new Capped(body, MOST_PACKED_BYTES), out);
      }
    }
    if (sha1 != null && !got.equals(sha1)) {
      throw new Refused("its SHA-1 is " + got + ", and DB-IP publishes " + sha1);
    }
    checkDatabase(Files.readAllBytes(partial), mode, now, builtInUse());
  }

  /** A stream that fails once more than a number of bytes have been read from it. */
  private static final class Capped extends FilterInputStream {
    private final long most;
    private long seen;

    Capped(InputStream in, long most) {
      super(in);
      this.most = most;
    }

    private int count(int n) {
      if (n > 0) {
        seen += n;
        if (seen > most) {
          throw new Refused("the location data is more than " + most / 1024 / 1024 + " MB");
        }
      }
      return n;
    }

    @Override
    public int read() throws IOException {
      int b = super.read();
      count(b < 0 ? 0 : 1);
      return b;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
      return count(super.read(buffer, offset, length));
    }
  }

  private static int unsigned(InputStream in) throws IOException {
    int b = in.read();
    if (b < 0) {
      throw new EOFException("unexpected end of file");
    }
    return b;
  }

  /**
   * Unpacks one gzip stream, whole and nothing more, and gives the SHA-1 of what it unpacked to.
   * Java's own gzip reader passes over bytes that follow the stream, so this reads the format
   * itself: a stream cut short, a wrong checksum, and anything after its end are all refused. Fails
   * past MOST_BYTES unpacked.
   */
  static String gunzip(InputStream in, OutputStream out) throws IOException {
    if (unsigned(in) != 0x1f || unsigned(in) != 0x8b) {
      throw new Refused("it is not a gzip file: incorrect header check");
    }
    if (unsigned(in) != 8) {
      throw new Refused("it is not a gzip file: unknown compression method");
    }
    int flags = unsigned(in);
    for (int i = 0; i < 6; i++) {
      unsigned(in);
    }
    if ((flags & 4) != 0) {
      int extra = unsigned(in) | (unsigned(in) << 8);
      for (int i = 0; i < extra; i++) {
        unsigned(in);
      }
    }
    // A file name, then a comment, each ending with a zero byte.
    for (int flag : new int[] {8, 16}) {
      if ((flags & flag) != 0) {
        while (unsigned(in) != 0) {
          // Read past.
        }
      }
    }
    if ((flags & 2) != 0) {
      unsigned(in);
      unsigned(in);
    }
    MessageDigest hash;
    try {
      hash = MessageDigest.getInstance("SHA-1");
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
    CRC32 crc = new CRC32();
    Inflater inflater = new Inflater(true);
    long written = 0;
    // How much of the last piece read was given to the inflater.
    int filled = 0;
    byte[] packed = new byte[64 * 1024];
    byte[] plain = new byte[64 * 1024];
    try {
      while (!inflater.finished()) {
        if (inflater.needsInput()) {
          int n = in.read(packed);
          if (n < 0) {
            throw new EOFException("unexpected end of file");
          }
          filled = n;
          inflater.setInput(packed, 0, n);
        }
        int n;
        try {
          n = inflater.inflate(plain);
        } catch (DataFormatException e) {
          throw new Refused("it is not a gzip file: " + e.getMessage());
        }
        if (n > 0) {
          written += n;
          if (written > MOST_BYTES) {
            throw new Refused("the location data is more than " + MOST_BYTES / 1024 / 1024 + " MB");
          }
          hash.update(plain, 0, n);
          crc.update(plain, 0, n);
          out.write(plain, 0, n);
        } else if (inflater.needsDictionary()) {
          throw new Refused("it is not a gzip file: it needs a dictionary");
        }
      }
      // The eight bytes after the data: its CRC-32 and its length, then nothing at all.
      int left = inflater.getRemaining();
      byte[] rest = new byte[8];
      int have = Math.min(left, 8);
      // What the inflater did not use is the end of the last piece read.
      System.arraycopy(packed, filled - left, rest, 0, have);
      for (int i = have; i < 8; i++) {
        rest[i] = (byte) unsigned(in);
      }
      long sum = le32(rest, 0);
      long size = le32(rest, 4);
      if (sum != crc.getValue() || size != (written & 0xFFFFFFFFL)) {
        throw new Refused("it is not a whole gzip file: incorrect data check");
      }
      if (left > 8 || in.read() >= 0) {
        throw new Refused("there is more after the end of the gzip file");
      }
    } finally {
      inflater.end();
    }
    return HexFormat.of().formatHex(hash.digest());
  }

  private static long le32(byte[] bytes, int at) {
    return (bytes[at] & 0xFFL)
        | (bytes[at + 1] & 0xFFL) << 8
        | (bytes[at + 2] & 0xFFL) << 16
        | (bytes[at + 3] & 0xFFL) << 24;
  }

  /**
   * The release and SHA-1 on DB-IP's download page for the MMDB file of one kind: the last SHA1SUM
   * before the link to that file, and after the link to any other. Null when the page does not read
   * that way.
   */
  public static Published publishedChecksum(String page, String mode) {
    Matcher link =
        Pattern.compile(
                "download\\.db-ip\\.com/free/dbip-"
                    + Pattern.quote(mode)
                    + "-lite-(\\d{4}-\\d{2})\\.mmdb\\.gz")
            .matcher(page);
    if (!link.find()) {
      return null;
    }
    String before = page.substring(0, link.start());
    int card = 0;
    Matcher others = OTHER_LINK.matcher(before);
    while (others.find()) {
      card = others.start();
    }
    String sha1 = null;
    Matcher sums = SHA1SUM.matcher(before.substring(card));
    while (sums.find()) {
      sha1 = sums.group(1).toLowerCase(Locale.ROOT);
    }
    return sha1 == null ? null : new Published(link.group(1), sha1);
  }

  private static int lastIndexOf(byte[] bytes, byte[] marker) {
    for (int i = bytes.length - marker.length; i >= 0; i--) {
      int k = 0;
      while (k < marker.length && bytes[i + k] == marker[k]) {
        k++;
      }
      if (k == marker.length) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Throws a {@link Refused} unless {@code bytes} is a DB-IP database of the kind asked for that a
   * lookup can be made in: of a believable size, its search tree inside the file, built lately and
   * not before the one in use ({@code inUse}, a time in milliseconds, or 0 for none), and answering
   * for addresses everyone knows.
   */
  public static void checkDatabase(byte[] bytes, String mode, long now, long inUse) {
    if (bytes.length < FEWEST_BYTES) {
      throw new Refused(
          "it unpacks to " + bytes.length + " bytes, too few for a location database");
    }
    int marker = lastIndexOf(bytes, MARKER);
    if (marker < 0) {
      throw new Refused("it is not an MMDB file");
    }
    Mmdb reader;
    try {
      reader = new Mmdb(bytes);
    } catch (RuntimeException error) {
      throw new Refused("it does not open as an MMDB file: " + error.getMessage());
    }
    Map<String, Object> meta = reader.metadata();
    double major = Js.toNumber(meta.get("binary_format_major_version"));
    if (major != 2) {
      throw new Refused("its format is version " + Js.string(Js.num(major)) + ", not 2");
    }
    String type = Js.strOr(meta.get("database_type"), "");
    if (!type.toLowerCase(Locale.ROOT).equals("dbip-" + mode + "-lite")) {
      throw new Refused("it is a \"" + type + "\" database, not DB-IP's " + mode + " one");
    }
    double version = Js.toNumber(meta.get("ip_version"));
    if (version != 6) {
      throw new Refused("it covers IP version " + Js.string(Js.num(version)) + ", not 6");
    }
    double recordSize = Js.toNumber(meta.get("record_size"));
    if (recordSize != 24 && recordSize != 28 && recordSize != 32) {
      throw new Refused("its records are " + Js.string(Js.num(recordSize)) + " bits");
    }
    double nodes = Js.toNumber(meta.get("node_count"));
    if (!(nodes > 0) || nodes * recordSize / 4 + 16 > marker) {
      throw new Refused("its search tree does not fit in the file");
    }
    double built = Js.toNumber(meta.get("build_epoch")) * 1000;
    if (!(built <= now + 2 * DAY) || built < now - OLDEST_BUILD) {
      throw new Refused(
          "it was built on "
              + (Double.isNaN(built)
                  ? "no date"
                  : Instant.ofEpochMilli((long) built).toString().substring(0, 10)));
    }
    if (built < inUse) {
      throw new Refused("it is older than the database in use");
    }
    for (String ip : KNOWN) {
      Object code = null;
      try {
        if (reader.get(ip) instanceof Map<?, ?> found
            && found.get("country") instanceof Map<?, ?> country) {
          code = country.get("iso_code");
        }
      } catch (RuntimeException e) {
        // No record that can be read is no country.
      }
      if (!(code instanceof String text) || !COUNTRY.matcher(text).find()) {
        throw new Refused("it has no country for " + ip);
      }
    }
  }

  private static final ScheduledThreadPoolExecutor TIMER = timer();

  private static ScheduledThreadPoolExecutor timer() {
    ScheduledThreadPoolExecutor made =
        new ScheduledThreadPoolExecutor(
            1,
            work -> {
              Thread thread = new Thread(work, "runlight-geo-deadline");
              thread.setDaemon(true);
              return thread;
            });
    made.setRemoveOnCancelPolicy(true);
    return made;
  }

  private static final HttpClient CLIENT =
      HttpClient.newBuilder()
          .followRedirects(HttpClient.Redirect.NEVER)
          .connectTimeout(Duration.ofSeconds(15))
          .build();

  /**
   * One GET with Java's HttpClient: https only, no redirect followed, and the whole of it, body
   * included, held to the timeout. The body is read as it arrives, since a city database is too big
   * to hold in memory.
   */
  private static Answer httpGet(String url, long timeoutMs) throws IOException {
    if (!url.startsWith("https://")) {
      throw new IOException("only https is fetched");
    }
    HttpResponse<InputStream> answer;
    try {
      answer =
          CLIENT.send(
              HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofMillis(timeoutMs)).build(),
              HttpResponse.BodyHandlers.ofInputStream());
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IOException("interrupted", e);
    }
    InputStream body = answer.body();
    // The request's own timeout ends once the headers are in; the body is cut off at the deadline.
    ScheduledFuture<?> watch =
        TIMER.schedule(
            () -> {
              try {
                body.close();
              } catch (IOException e) {
                // Already gone.
              }
            },
            timeoutMs,
            TimeUnit.MILLISECONDS);
    InputStream watched =
        new FilterInputStream(body) {
          @Override
          public void close() throws IOException {
            watch.cancel(false);
            super.close();
          }
        };
    return new Answer(
        answer.statusCode(),
        answer.headers().firstValueAsLong("content-length").orElse(-1),
        watched);
  }
}
