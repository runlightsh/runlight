package sh.runlight.conformance;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import sh.runlight.Fixtures;
import sh.runlight.Js;
import sh.runlight.Json;

/**
 * The normalizer against cases run through normalize() in http-conformance.ts
 * (tests/fixtures/conformance-normalize.json), so the player masks answers as the TypeScript does.
 */
class NormalizerTest {
  @Test
  void normalizesAsTheTypeScriptDoes() {
    List<Object> cases =
        Js.list(
            Json.parse(
                Fixtures.read(
                    Fixtures.repo()
                        .resolve("packages/php/tests/fixtures/conformance-normalize.json"))));
    assertFalse(cases.isEmpty());
    List<String> failures = new ArrayList<>();
    for (int i = 0; i < cases.size(); i++) {
      Map<String, Object> c = Js.map(cases.get(i));
      String expected = Normalizer.canonical(c.get("output"));
      String actual = Normalizer.canonical(Normalizer.normalize(c.get("input")));
      if (!expected.equals(actual)) {
        failures.add("case " + (i + 1) + ": " + Fixtures.label(c.get("input")) + " gave " + actual);
      }
    }
    assertTrue(failures.isEmpty(), String.join("\n", failures));
  }

  @Test
  void cookieShape() {
    assertEquals(
        "rl_session=<value>; Path=/; HttpOnly",
        Normalizer.cookieShape("rl_session=abc123; Path=/; HttpOnly"));
    assertEquals(
        "rl_session=; Path=/; Max-Age=0", Normalizer.cookieShape("rl_session=; Path=/; Max-Age=0"));
    assertEquals("a=<value>", Normalizer.cookieShape("a=b=c"));
    assertEquals("no value here", Normalizer.cookieShape("no value here"));
    assertEquals("=x; Path=/", Normalizer.cookieShape("=x; Path=/"));
  }
}
