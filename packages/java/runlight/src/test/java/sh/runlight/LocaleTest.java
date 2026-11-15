package sh.runlight;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import sh.runlight.http.SearchParams;
import sh.runlight.http.Url;

/**
 * Dates, escapes, and numbers come out the same whatever the JVM's own locale is. Java writes a
 * formatted number in the default locale's digits, so on a server set to Arabic, Persian, or
 * Bengali a date became one nothing could read back, and every range and day after it was wrong.
 */
class LocaleTest {
  private Locale before;

  @BeforeEach
  void keep() {
    before = Locale.getDefault();
  }

  @AfterEach
  void putBack() {
    Locale.setDefault(before);
  }

  @Test
  void datesAreWrittenInAsciiDigitsUnderALocaleWithDigitsOfItsOwn() {
    long noon = Time.utc(2026, 10, 14, 12, 0, 0);
    for (String tag : List.of("ar-SA", "ar-EG", "fa-IR", "bn-BD", "th-TH-u-nu-thai")) {
      Locale.setDefault(Locale.forLanguageTag(tag));
      assertEquals("2026-11-14", Time.localDate(noon, "UTC"), tag);
      assertEquals("2026-11-14T12:00:00.000Z", Time.isoString(noon), tag);
      assertEquals("2026-11-13", Time.addDays("2026-11-14", -1), tag);
      assertEquals("2026-10-01", Time.addMonths("2026-11-14", -1), tag);
      assertEquals(noon - 12 * 3_600_000L, Time.startOf(Time.localDate(noon, "UTC"), "UTC"), tag);
      // A Saturday, at noon.
      assertEquals(List.of(5, 12), ints(Time.localWeekdayHour(noon, "UTC")), tag);
      Map<String, Object> range =
          Time.resolveRange(Json.object("period", "7d"), "Asia/Riyadh", noon, null);
      assertNotNull(range, tag);
      assertEquals("2026-11-08", range.get("fromDate"), tag);
      assertEquals("2026-11-14", range.get("toDate"), tag);
    }
  }

  @Test
  void escapesAreWrittenInAsciiDigitsToo() {
    Locale.setDefault(Locale.forLanguageTag("ar-SA"));
    assertEquals("\"\\u0001\"", Json.quote("\u0001"));
    assertEquals("a=%2F1", new SearchParams(Map.of("a", "/1")).toString());
    assertEquals("https://example.com/%7F", new Url("https://example.com/\u007f").href());
  }

  private static List<Integer> ints(int[] values) {
    return List.of(values[0], values[1]);
  }
}
