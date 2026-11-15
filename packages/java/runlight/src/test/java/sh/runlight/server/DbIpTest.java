package sh.runlight.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.zip.GZIPOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import sh.runlight.Json;
import sh.runlight.Time;

/**
 * The DB-IP downloader, as packages/server/test/geo.test.ts tests it, with every request answered
 * here: a download is used only once its checksum and its structure are checked, a mismatch is
 * never a fallback, and only a page that gives no checksum at all lets one in unchecked, with a
 * warning.
 */
class DbIpTest {
  @TempDir Path root;

  private int folders;

  private static final String PAGE = "https://db-ip.com/db/download/ip-to-city-lite";
  private static final long OCTOBER = Time.utc(2026, 9, 3, 3, 0, 0);

  private static String file(String release) {
    return "https://download.db-ip.com/free/dbip-city-lite-" + release + ".mmdb.gz";
  }

  private static byte[] concat(byte[]... parts) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    for (byte[] part : parts) {
      out.writeBytes(part);
    }
    return out.toByteArray();
  }

  private static byte[] control(int type, int size) {
    if (type >= 8) {
      if (size >= 29) {
        throw new IllegalArgumentException("too long for this writer");
      }
      return new byte[] {(byte) size, (byte) (type - 7)};
    }
    if (size < 29) {
      return new byte[] {(byte) ((type << 5) | size)};
    }
    if (size < 285) {
      return new byte[] {(byte) ((type << 5) | 29), (byte) (size - 29)};
    }
    return new byte[] {
      (byte) ((type << 5) | 30), (byte) ((size - 285) >> 8), (byte) ((size - 285) & 255)
    };
  }

  /** MMDB's data format, enough of it to write a database: maps, strings, arrays, and integers. */
  private static byte[] encode(Object value) {
    if (value instanceof String text) {
      byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
      return concat(control(2, bytes.length), bytes);
    }
    if (value instanceof Number number) {
      long n = number.longValue();
      int bytes = n < 0x10000 ? 2 : n < 0x100000000L ? 4 : 8;
      byte[] out = new byte[bytes];
      for (int i = 0; i < bytes; i++) {
        out[bytes - 1 - i] = (byte) (n >> (8 * i));
      }
      return concat(control(bytes == 2 ? 5 : bytes == 4 ? 6 : 9, bytes), out);
    }
    if (value instanceof List<?> list) {
      List<byte[]> parts = new ArrayList<>();
      parts.add(control(11, list.size()));
      for (Object item : list) {
        parts.add(encode(item));
      }
      return concat(parts.toArray(new byte[0][]));
    }
    Map<?, ?> map = (Map<?, ?>) value;
    List<byte[]> parts = new ArrayList<>();
    parts.add(control(7, map.size()));
    for (Map.Entry<?, ?> entry : map.entrySet()) {
      parts.add(encode(entry.getKey()));
      parts.add(encode(entry.getValue()));
    }
    return concat(parts.toArray(new byte[0][]));
  }

  private static final Object US =
      Json.object(
          "country",
          Json.object("iso_code", "US", "names", Json.object("en", "United States")),
          "city",
          Json.object("names", Json.object("en", "Mountain View")));

  private static byte[] mmdb() {
    return mmdb(Map.of());
  }

  private static byte[] mmdb(Map<String, Object> meta) {
    return mmdb(meta, US, 1024 * 1024);
  }

  /**
   * A whole MMDB file of one megabyte or so, in which every address has the same record. {@code
   * meta} overrides the metadata, and {@code record} the record (null leaves every address without
   * one).
   */
  private static byte[] mmdb(Map<String, Object> meta, Object record, int pad) {
    // One node whose two records both point at the first thing in the data section, or at "no
    // data".
    byte pointer = (byte) (record == null ? 1 : 1 + 16);
    byte[] node = {0, 0, pointer, 0, 0, pointer};
    Map<String, Object> metadata = new LinkedHashMap<>();
    metadata.put("binary_format_major_version", 2);
    metadata.put("binary_format_minor_version", 0);
    metadata.put("build_epoch", Time.utc(2026, 9, 1, 2, 0, 0) / 1000);
    metadata.put("database_type", "DBIP-City-Lite");
    metadata.put("description", Json.object("en", "A test database"));
    metadata.put("ip_version", 6);
    metadata.put("languages", List.of("en"));
    metadata.put("node_count", 1);
    metadata.put("record_size", 24);
    metadata.putAll(meta);
    return concat(
        node,
        new byte[16],
        encode(record == null ? Map.of() : record),
        new byte[pad],
        new byte[] {
          (byte) 0xAB,
          (byte) 0xCD,
          (byte) 0xEF,
          'M',
          'a',
          'x',
          'M',
          'i',
          'n',
          'd',
          '.',
          'c',
          'o',
          'm'
        },
        encode(metadata));
  }

  private static String sha1(byte[] bytes) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-1").digest(bytes));
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  private static byte[] gzip(byte[] bytes) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    try (GZIPOutputStream zip = new GZIPOutputStream(out)) {
      zip.write(bytes);
    } catch (IOException e) {
      throw new IllegalStateException(e);
    }
    return out.toByteArray();
  }

  /** DB-IP's download page as it reads, with the CSV file's card before the MMDB file's. */
  private static String page(String mode, String release, String sum) {
    return "<div class=\"card\"><dl class=\"card-body\"><dt>Format</dt><dd>CSV</dd><dt>MD5SUM</dt>\n"
        + "<dd class=\"small\">93c945395f0bc2ceefea7dd55750417a</dd><dt>SHA1SUM</dt><dd"
        + " class=\"small\">e2061015c43ec91c94a12191a6a613279eb94c0c</dd></dl>\n"
        + "<a href='https://download.db-ip.com/free/dbip-"
        + mode
        + "-lite-"
        + release
        + ".csv.gz' class='btn'>Download CSV</a></div>\n"
        + "<div class=\"card\"><dl class=\"card-body\"><dt>Format</dt><dd>MMDB</dd><dt>MD5SUM</dt><dd"
        + " class=\"small\">5974b336a7409ec854f67eacd52c2061</dd>\n"
        + "<dt>SHA1SUM</dt>\n\t\t\t\t\t<dd class=\"small\">"
        + sum
        + "</dd></dl>\n"
        + "<a href='https://download.db-ip.com/free/dbip-"
        + mode
        + "-lite-"
        + release
        + ".mmdb.gz' class='btn'>Download MMDB</a></div>";
  }

  private static DbIp.Answer ok(byte[] body) {
    return new DbIp.Answer(200, body.length, new ByteArrayInputStream(body));
  }

  private static DbIp.Answer ok(String body) {
    return ok(body.getBytes(StandardCharsets.UTF_8));
  }

  private static DbIp.Answer status(int status) {
    return new DbIp.Answer(status, -1, new ByteArrayInputStream(new byte[0]));
  }

  /** A DbIp whose requests are answered from a map, by URL, with every URL and log line kept. */
  private final class World {
    final Path dir;
    final List<String> asked = new ArrayList<>();
    final List<String> lines = new ArrayList<>();
    final Map<String, Supplier<DbIp.Answer>> answers = new LinkedHashMap<>();
    final DbIp geo;

    World(Map<String, Supplier<DbIp.Answer>> given) {
      dir = root.resolve("geo" + folders++);
      answers.putAll(given);
      geo =
          new DbIp(
              dir,
              "city",
              (url, timeoutMs) -> {
                asked.add(url);
                Supplier<DbIp.Answer> answer = answers.get(url);
                return answer != null ? answer.get() : status(404);
              },
              lines::add);
    }

    List<String> files() {
      if (!Files.isDirectory(dir)) {
        return List.of();
      }
      try (Stream<Path> found = Files.list(dir)) {
        return found.map(f -> f.getFileName().toString()).sorted().toList();
      } catch (IOException e) {
        throw new IllegalStateException(e);
      }
    }

    String last() {
      return lines.get(lines.size() - 1);
    }

    String all() {
      return String.join("\n", lines);
    }
  }

  /** Answers for one release: the page with the file's own checksum, and the file, gzipped. */
  private static Map<String, Supplier<DbIp.Answer>> release(String name, byte[] file) {
    return release(name, file, sha1(file));
  }

  private static Map<String, Supplier<DbIp.Answer>> release(String name, byte[] file, String sum) {
    Map<String, Supplier<DbIp.Answer>> out = new LinkedHashMap<>();
    out.put(PAGE, () -> ok(page("city", name, sum)));
    out.put(file(name), () -> ok(gzip(file)));
    return out;
  }

  private static Map<String, Supplier<DbIp.Answer>> with(
      Map<String, Supplier<DbIp.Answer>> base, String url, Supplier<DbIp.Answer> answer) {
    Map<String, Supplier<DbIp.Answer>> out = new LinkedHashMap<>(base);
    out.put(url, answer);
    return out;
  }

  private static boolean matches(String pattern, String text) {
    return Pattern.compile(pattern, Pattern.DOTALL).matcher(text).find();
  }

  private static final Map<String, Object> MOUNTAIN_VIEW =
      Json.object("country", "US", "region", "", "city", "Mountain View");

  @Test
  void aDownloadWhoseChecksumMatchesDbIpsPageIsPutToUse() throws Exception {
    byte[] file = mmdb();
    World t = new World(release("2026-10", file));
    t.geo.refresh(OCTOBER);
    assertEquals(List.of(PAGE, file("2026-10")), t.asked);
    assertEquals("2026-10", t.geo.release());
    assertEquals(MOUNTAIN_VIEW, t.geo.locate("8.8.8.8"));
    assertEquals(List.of("dbip-city-lite-2026-10.mmdb"), t.files());
    assertEquals(
        sha1(file), sha1(Files.readAllBytes(t.dir.resolve("dbip-city-lite-2026-10.mmdb"))));
    assertEquals(List.of("Runlight: location data from DB-IP (2026-10) is ready."), t.lines);
  }

  @Test
  void earlyInAMonthThePageStillOffersLastMonthsReleaseAndThatIsTheOneFetched() {
    World t =
        new World(
            release("2026-09", mmdb(Map.of("build_epoch", Time.utc(2026, 8, 1, 0, 0, 0) / 1000))));
    t.geo.refresh(Time.utc(2026, 9, 1, 3, 0, 0));
    assertEquals(List.of(PAGE, file("2026-09")), t.asked);
    assertEquals("2026-09", t.geo.release());
    t.geo.refresh(Time.utc(2026, 9, 1, 4, 0, 0));
    assertEquals(
        List.of(PAGE),
        t.asked.subList(2, t.asked.size()),
        "later the page is read again, and the file on disk is not fetched twice");
  }

  @Test
  void aDownloadThatDoesNotMatchThePublishedChecksumIsNeverUsedAndTheOneInUseStays()
      throws Exception {
    byte[] good = mmdb(Map.of("build_epoch", Time.utc(2026, 8, 1, 0, 0, 0) / 1000));
    World t = new World(release("2026-09", good));
    t.geo.refresh(Time.utc(2026, 8, 20, 0, 0, 0));
    assertEquals("2026-09", t.geo.release());

    // October's file is not the one DB-IP's page describes.
    byte[] swapped = mmdb(Map.of(), Json.object("country", Json.object("iso_code", "ZZ")), 1 << 20);
    t.answers.putAll(release("2026-10", swapped, sha1(mmdb())));
    t.geo.refresh(OCTOBER);
    assertEquals("2026-09", t.geo.release(), "last month's is still in use");
    assertEquals(MOUNTAIN_VIEW, t.geo.locate("8.8.8.8"));
    assertEquals(
        List.of("dbip-city-lite-2026-09.mmdb"), t.files(), "nothing of the bad download is left");
    assertEquals(
        "Runlight: location data was not updated from "
            + file("2026-10")
            + ": its SHA-1 is "
            + sha1(swapped)
            + ", and DB-IP publishes "
            + sha1(mmdb()),
        t.last());

    // Bytes after the end of the gzip stream never reach a file: what is kept is what was checked.
    byte[] october = mmdb();
    t.answers.putAll(release("2026-10", october));
    t.answers.put(
        file("2026-10"), () -> ok(concat(gzip(october), "extra".getBytes(StandardCharsets.UTF_8))));
    t.geo.refresh(OCTOBER + 6 * 3_600_000L);
    assertEquals(List.of("dbip-city-lite-2026-09.mmdb"), t.files());
    assertTrue(t.last().contains("more after the end of the gzip file"), t.last());
  }

  @Test
  void whenNoChecksumCanBeReadAtAllTheNewestReleaseIsTakenOnItsStructureAloneWithAWarning() {
    byte[] file = mmdb();
    Map<String, Supplier<DbIp.Answer>> cases = new LinkedHashMap<>();
    Map<String, String> why = new LinkedHashMap<>();
    cases.put("the page is down", () -> status(503));
    why.put("the page is down", "could not read DB-IP's checksums.*answered 503");
    cases.put("the page redirects", () -> status(302));
    why.put("the page redirects", "answered 302");
    cases.put("the page has no checksum", () -> ok(page("city", "2026-10", "")));
    why.put("the page has no checksum", "found no checksum");
    cases.put("the page is for another database", () -> ok(page("country", "2026-10", sha1(file))));
    why.put("the page is for another database", "found no checksum");
    cases.put("the page never ends", () -> ok("x".repeat(2 * 1024 * 1024)));
    why.put("the page never ends", "more than 1024 KB");
    for (Map.Entry<String, Supplier<DbIp.Answer>> c : cases.entrySet()) {
      String what = c.getKey();
      World t = new World(with(release("2026-10", file), PAGE, c.getValue()));
      t.geo.refresh(OCTOBER);
      assertEquals(List.of(PAGE, file("2026-10")), t.asked, what);
      assertEquals("2026-10", t.geo.release(), what);
      assertEquals(List.of("dbip-city-lite-2026-10.mmdb"), t.files(), what);
      List<String> warnings =
          t.lines.stream()
              .filter(l -> l.contains("could not be checked against DB-IP's published checksum"))
              .toList();
      assertEquals(1, warnings.size(), what);
      assertTrue(
          warnings.get(0).startsWith("Runlight: warning: location data from DB-IP (2026-10)"),
          what);
      assertTrue(matches(why.get(what), warnings.get(0)), what + ": " + warnings.get(0));
    }

    // As before the page was read: this month's file, then last month's, and a month not out yet
    // is no failure.
    World early =
        new World(
            Map.of(
                file("2026-09"),
                () -> ok(gzip(mmdb(Map.of("build_epoch", Time.utc(2026, 8, 1, 0, 0, 0) / 1000))))));
    early.geo.refresh(Time.utc(2026, 9, 1, 3, 0, 0));
    assertEquals(List.of(PAGE, file("2026-10"), file("2026-09")), early.asked);
    assertEquals("2026-09", early.geo.release());
    assertEquals(
        List.of(
            "Runlight: warning: location data from DB-IP (2026-",
            "Runlight: location data from DB-IP (2026-09) is re"),
        early.lines.stream().map(l -> l.substring(0, 50)).toList());

    // The other checks still hold: what is not a DB-IP city database is not used, checksum or no
    // checksum.
    World wrong =
        new World(
            Map.of(
                file("2026-10"), () -> ok(gzip(mmdb(Map.of("database_type", "GeoLite2-City"))))));
    wrong.geo.refresh(OCTOBER);
    assertEquals("", wrong.geo.release());
    assertEquals(List.of(), wrong.files());
    assertTrue(
        matches(
            "not updated from .*2026-10\\.mmdb\\.gz: it is a \"GeoLite2-City\" database",
            wrong.all()),
        wrong.all());
    assertTrue(
        matches(
            "not updated: could not read DB-IP's checksums.*and no release could be downloaded"
                + " without them",
            wrong.last()),
        wrong.last());
    assertFalse(
        wrong.lines.stream().anyMatch(l -> l.contains("warning")),
        "the warning is for a download that was accepted");
  }

  @Test
  void aPageThatIsReadIsHeldTo() {
    byte[] file = mmdb();
    World old =
        new World(
            with(release("2026-10", file), PAGE, () -> ok(page("city", "2026-05", sha1(file)))));
    old.geo.refresh(OCTOBER);
    assertEquals(List.of(PAGE), old.asked);
    assertEquals("", old.geo.release());
    assertTrue(old.all().contains("offers the 2026-05 release"), old.all());

    // A good October file is on offer, but the page describes another: refused, with no try at
    // last month's.
    Map<String, Supplier<DbIp.Answer>> answers = new LinkedHashMap<>(release("2026-09", file));
    answers.putAll(release("2026-10", file, "0".repeat(40)));
    World mismatch = new World(answers);
    mismatch.geo.refresh(OCTOBER);
    assertEquals(List.of(PAGE, file("2026-10")), mismatch.asked);
    assertEquals("", mismatch.geo.release());
    assertEquals(List.of(), mismatch.files());
    assertTrue(
        matches("its SHA-1 is [0-9a-f]{40}, and DB-IP publishes 0{40}", mismatch.all()),
        mismatch.all());
    assertFalse(mismatch.lines.stream().anyMatch(l -> l.contains("warning")));
  }

  @Test
  void aDownloadThatRedirectsIsNotGzipOrIsTooLargeIsRefused() {
    byte[] file = mmdb();
    byte[] packed = gzip(file);
    Map<String, Supplier<DbIp.Answer>> cases = new LinkedHashMap<>();
    Map<String, String> said = new LinkedHashMap<>();
    cases.put("a redirect", () -> status(301));
    said.put("a redirect", "answered 301");
    cases.put("not gzip", () -> ok(file));
    said.put("not gzip", "(?i)header|gzip");
    cases.put("cut short", () -> ok(Arrays.copyOf(packed, 300)));
    said.put("cut short", "(?i)unexpected end");
    cases.put(
        "a length past the limit",
        () -> new DbIp.Answer(200, 300L * 1024 * 1024, new ByteArrayInputStream(packed)));
    said.put("a length past the limit", "more than 256 MB");
    for (Map.Entry<String, Supplier<DbIp.Answer>> c : cases.entrySet()) {
      String what = c.getKey();
      World t = new World(with(release("2026-10", file), file("2026-10"), c.getValue()));
      t.geo.refresh(OCTOBER);
      assertEquals("", t.geo.release(), what);
      assertTrue(matches(said.get(what), t.all()), what + ": " + t.all());
      assertEquals(List.of(), t.files(), what);
    }
  }

  private static String refused(byte[] file) {
    return refused(file, 0);
  }

  private static String refused(byte[] file, long inUse) {
    try {
      DbIp.checkDatabase(file, "city", OCTOBER, inUse);
      return "";
    } catch (DbIp.Refused error) {
      return error.getMessage();
    }
  }

  @Test
  void aFileWithTheRightChecksumIsStillReadAsADbIpDatabaseBeforeItIsUsed() {
    assertEquals("", refused(mmdb()));
    assertTrue(refused(mmdb(Map.of(), US, 1000)).contains("too few"));
    assertTrue(refused(new byte[2 * 1024 * 1024]).contains("not an MMDB file"));
    assertTrue(
        refused(mmdb(Map.of("database_type", "GeoLite2-City")))
            .contains("\"GeoLite2-City\" database"));
    assertTrue(
        refused(mmdb(Map.of("database_type", "DBIP-Country-Lite")))
            .contains("not DB-IP's city one"));
    assertTrue(refused(mmdb(Map.of("binary_format_major_version", 3))).contains("version 3"));
    assertTrue(refused(mmdb(Map.of("ip_version", 4))).contains("IP version 4"));
    assertTrue(matches("20 bits|does not open", refused(mmdb(Map.of("record_size", 20)))));
    assertTrue(
        matches(
            "search tree does not fit|does not open",
            refused(mmdb(Map.of("node_count", 900_000)))));
    assertTrue(
        refused(mmdb(Map.of("build_epoch", Time.utc(2026, 4, 1, 0, 0, 0) / 1000)))
            .contains("built on 2026-05-01"));
    assertTrue(
        refused(mmdb(Map.of("build_epoch", Time.utc(2026, 11, 1, 0, 0, 0) / 1000)))
            .contains("built on 2026-12-01"));
    assertTrue(
        refused(mmdb(), Time.utc(2026, 9, 2, 0, 0, 0)).contains("older than the database in use"));
    assertTrue(refused(mmdb(Map.of(), null, 1 << 20)).contains("no country for 8.8.8.8"));
    assertTrue(
        refused(
                mmdb(
                    Map.of(),
                    Json.object("city", Json.object("names", Json.object("en", "Nowhere"))),
                    1 << 20))
            .contains("no country for 8.8.8.8"));

    // And through a download: the page vouches for a file that is not a city database, so it is
    // not used.
    World t = new World(release("2026-10", mmdb(Map.of("database_type", "DBIP-Country-Lite"))));
    t.geo.refresh(OCTOBER);
    assertEquals("", t.geo.release());
    assertEquals(List.of(), t.files());
  }

  @Test
  void theChecksumReadFromDbIpsPageIsTheMmdbFilesNotTheCsvFiles() {
    String sum = "09eea8433fe3eed71984fd6aac9d8ab3d9ca51f0";
    assertEquals(
        new DbIp.Published("2026-11", sum),
        DbIp.publishedChecksum(page("country", "2026-11", sum.toUpperCase()), "country"));
    assertNull(DbIp.publishedChecksum(page("country", "2026-11", sum), "city"));
    assertNull(
        DbIp.publishedChecksum(page("city", "2026-11", "abc"), "city"),
        "the CSV file's checksum never stands in");
    assertNull(DbIp.publishedChecksum("<html></html>", "city"));
  }

  @Test
  void aFailedDownloadLeavesLookupsEmptyAndTheFolderCleanAndIsTriedAgainLater() throws Exception {
    World t = new World(Map.of());
    t.geo.refresh(Time.utc(2026, 9, 1, 3, 0, 0));
    assertEquals(
        List.of(PAGE, file("2026-10"), file("2026-09")),
        t.asked,
        "the checksum comes first; with none, this month's file and then last month's");
    assertNull(t.geo.locate("8.8.8.8"));
    assertNull(t.geo.lookup());
    assertEquals(List.of(), t.files());
    t.geo.refresh(Time.utc(2026, 9, 1, 4, 0, 0));
    assertEquals(6, t.asked.size(), "tried again on the next check");
    assertTrue(t.last().contains("not updated: could not read DB-IP's checksums"), t.last());
  }

  @Test
  void aFileThatKeepsBeingMissingIsAskedForLessAndLessOftenUpToEverySixHours() {
    World t = new World(Map.of());
    long start = Time.utc(2026, 9, 1, 3, 0, 0);
    // The server checks every five minutes; each try asks for the checksum, this month's file, and
    // last month's.
    List<Integer> tries = new ArrayList<>();
    for (int at = 0; at <= 24 * 60; at += 5) {
      int before = t.asked.size();
      t.geo.refresh(start + at * 60_000L);
      if (t.asked.size() > before) {
        tries.add(at);
      }
    }
    assertEquals(
        List.of(0, 5, 15, 35, 75, 155, 315, 635, 995, 1355),
        tries,
        "each wait is twice the last, and none is longer than six hours");
    assertEquals(tries.size() * 3, t.asked.size());
  }
}
