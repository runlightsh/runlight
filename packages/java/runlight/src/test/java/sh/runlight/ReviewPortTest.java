package sh.runlight;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import sh.runlight.importers.CsvVisits;
import sh.runlight.importers.Write;

/**
 * Behaviour brought over from the TypeScript review that needs no database: text as it is stored,
 * the user agent's cap, the icon scan's bound, email length, and what an import keeps in a column.
 */
class ReviewPortTest {
  private static final String EMOJI = "😀";

  @Test
  void storedTextLosesNulsAndLoneSurrogatesAndIsCutByCharacter() {
    assertEquals("ab", Payload.tidy("a\u0000b"));
    assertEquals("a�b", Payload.tidy("a\ud83db"));
    assertEquals("�a", Payload.tidy("\ude00a"));
    assertEquals(EMOJI, Payload.tidy(EMOJI));
    assertEquals("x".repeat(499) + EMOJI, Payload.cleanText("x".repeat(499) + EMOJI + "y", 500));
    Map<String, Object> hit =
        Payload.parsePayload(
            Json.stringify(
                Json.object(
                    "k",
                    "event",
                    "u",
                    "https://example.com/?utm_source=a%00b",
                    "n",
                    " Sign\u0000up ",
                    "t",
                    "a\u0000b\ud83d",
                    "p",
                    Json.object(
                        "\u0000", "dropped", " k\u0000ey ", "x".repeat(499) + EMOJI + "y"))));
    assertEquals("Signup", hit.get("name"));
    assertEquals("ab�", hit.get("title"));
    assertEquals(Json.object("key", "x".repeat(499) + EMOJI), hit.get("props"));
    Map<String, Object> page = Sources.parsePage((sh.runlight.http.Url) hit.get("url"));
    assertEquals("ab", Js.map(page.get("utm")).get("source"));
  }

  @Test
  void aUserAgentIsReadNoFurtherThan512Characters() {
    String chrome =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
    String padded = chrome + " ".repeat(Ua.MAX_UA - chrome.length());
    assertFalse(Ua.isBot(padded + " Googlebot/2.1"), "a bot token past the cap is not seen");
    assertNull(Ua.aiAgent(padded + " GPTBot/1.2"));
    assertTrue(Ua.isBot(chrome + " Googlebot/2.1"));
    assertEquals(
        "Chrome",
        Ua.parseClient(padded + " Edg/129.0", Map.of("brands", "x".repeat(5000)), null)
            .get("browser"));
    for (String version : List.of("18", "18.1.1", "18.")) {
      Map<String, Object> safari =
          Ua.parseClient("Mozilla/5.0 (Macintosh) Version/" + version + " Safari/605.1.15");
      assertEquals("Safari", safari.get("browser"), version);
      assertEquals("18", safari.get("browserVersion"), version);
    }
    // Linear on a run of digits and dots with no Safari after it.
    long started = System.nanoTime();
    Ua.parseClient("Version/" + "1.".repeat(250) + "x");
    assertTrue(System.nanoTime() - started < 2_000_000_000L);
  }

  @Test
  void theIconScanReadsTagsOfAtMostAFewThousandCharacters() {
    String base = "https://example.com";
    assertEquals(
        List.of("https://example.com/a.png"),
        Icon.iconLinks("<link rel=\"icon\" href=\"/a.png\">", base));
    assertEquals(
        List.of("https://example.com/b.png"),
        Icon.iconLinks(
            "<link rel=\"icon\" href=\"/skipped.png\" <link rel=\"icon\" href=\"/b.png\">", base),
        "a tag never runs on into the next");
    assertEquals(
        List.of(),
        Icon.iconLinks("<link rel=\"icon\" href=\"/a.png\" " + "x".repeat(4001) + ">", base));
    long started = System.nanoTime();
    assertEquals(List.of(), Icon.iconLinks("<link ".repeat(200_000), base));
    assertTrue(System.nanoTime() - started < 5_000_000_000L);
  }

  @Test
  void anEmailAddressOver320CharactersIsRefusedBeforeThePatternReadsIt() {
    assertTrue(Runlight.isEmail("jon@example.com"));
    String longest = "a".repeat(320 - "@example.com".length()) + "@example.com";
    assertTrue(Runlight.isEmail(longest));
    assertFalse(Runlight.isEmail("a" + longest));
    assertFalse(Runlight.isEmail(null));
  }

  @Test
  void anImportKeepsNoAddressOrUserAgentInAnyColumn() {
    assertEquals("Chrome", Write.browser("chrome"));
    assertEquals("Ladybird", Write.browser(" ladybird "));
    assertEquals("", Write.browser("Mozilla/5.0 (X11) Chrome/129"));
    assertEquals("", Write.browser("203.0.113.7"));
    assertEquals("", Write.browser("9front"));
    assertEquals("Haiku", Write.system("Haiku"));
    assertEquals("", Write.system("2001:db8::1"));
    assertEquals("", Write.system("a".repeat(41)));
    assertEquals("Berlin", Write.placeName("Berlin"));
    assertEquals("", Write.placeName("seen from 203.0.113.7"));
    assertEquals("", Write.placeName("fe80::1"));
    assertEquals("", Write.placeName("AppleWebKit"));
    assertEquals("", Write.placeName("Chrome/129"));
    assertEquals("1440x900", Write.screenSize(" 1440x900 "));
    assertEquals("", Write.screenSize("1440x900x2"));
    assertEquals("pt-BR", Write.languageTag(" pt-BR "));
    assertEquals("", Write.languageTag("Mozilla/5.0"));
    assertEquals("", Write.languageTag("e"));
  }

  @Test
  void aCsvRowBefore2000HasNoTime() {
    assertEquals(
        946_684_800_000.0, CsvVisits.rowTime(Map.of("time", "2000-01-01T00:00:00Z"), "runlight"));
    assertTrue(Double.isNaN(CsvVisits.rowTime(Map.of("time", "1999-12-31T23:59:59Z"), "runlight")));
    // A date written as a bare number would be read as a Unix time in 1970.
    assertTrue(Double.isNaN(CsvVisits.rowTime(Map.of("time", "20240501"), "runlight")));
    assertEquals(
        1_714_566_896_000.0, CsvVisits.rowTime(Map.of("created_at", "1714566896"), "umami"));
  }
}
