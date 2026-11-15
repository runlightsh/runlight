package sh.runlight;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

/**
 * A body of nothing but brackets can no longer run a thread's stack out. Reading one used a call
 * for each level, and so did writing it back; at the 5,000 levels allowed, both overflowed a stack
 * of 512 KiB and writing one of 1 MiB, with an error the handlers for a bad body do not catch.
 */
class JsonDepthTest {
  private static String nested(int depth, boolean objects) {
    return (objects ? "{\"a\":" : "[").repeat(depth)
        + (objects ? "1" : "")
        + (objects ? "}" : "]").repeat(depth);
  }

  /** Runs on a thread with a stack this small, and hands back what it gave or threw. */
  private static Object onSmallStack(java.util.function.Supplier<Object> work)
      throws InterruptedException {
    return onStack(256 * 1024L, work);
  }

  private static Object onStack(long bytes, java.util.function.Supplier<Object> work)
      throws InterruptedException {
    AtomicReference<Object> result = new AtomicReference<>();
    Thread small =
        new Thread(
            null,
            () -> {
              try {
                result.set(work.get());
              } catch (Throwable error) {
                result.set(error);
              }
            },
            "small-stack",
            bytes);
    small.start();
    small.join();
    return result.get();
  }

  @Test
  void nestingPastTheLimitIsRefusedAsBadJsonHoweverDeepItGoes() throws InterruptedException {
    for (boolean objects : new boolean[] {false, true}) {
      String deep = nested(Json.MAX_DEPTH + 1, objects);
      assertThrows(Json.JsonException.class, () -> Json.parse(deep));
      assertFalse(Json.tryParse(deep).ok());
      // A megabyte of brackets is read without a call for each, so it is refused, not a crash.
      String deeper = nested(500_000, objects);
      assertEquals(false, onSmallStack(() -> Json.tryParse(deeper).ok()));
      assertEquals(false, onSmallStack(() -> Json.tryParseShallow(deeper + "]").ok()));
    }
  }

  @Test
  void theDeepestNestingAllowedIsReadAndWrittenBackWithStackToSpare() throws InterruptedException {
    for (boolean objects : new boolean[] {false, true}) {
      String text = nested(Json.MAX_DEPTH, objects);
      String pretty = Json.stringify(Json.parse(text), 2);
      // Again and again, so it holds before and after the JIT has compiled the walk, and on half
      // the small stack as well.
      for (int round = 0; round < 300; round++) {
        long stack = round % 2 == 0 ? 256 * 1024L : 128 * 1024L;
        assertEquals(text, onStack(stack, () -> Json.stringify(Json.parse(text))));
        assertEquals(pretty, onStack(stack, () -> Json.stringify(Json.parse(text), 2)));
        assertTrue(onStack(stack, () -> Js.string(Json.parse(text))) instanceof String);
      }
    }
  }

  @Test
  void writingAValueBackTakesNoCallForEachLevel() throws InterruptedException {
    // Built here, far deeper than anything read could be, and written on a small stack.
    Object list = 1L;
    Object map = 1L;
    for (int i = 0; i < 50_000; i++) {
      list = Json.array(list);
      map = Json.object("a", map);
    }
    Object lists = list;
    Object maps = map;
    assertEquals(
        nested(50_000, false).replace("[]", "[1]"), onSmallStack(() -> Json.stringify(lists)));
    assertEquals(nested(50_000, true), onSmallStack(() -> Json.stringify(maps)));
    assertEquals("1", onSmallStack(() -> Js.string(lists)));
    assertEquals(
        "{\n  \"a\": [\n    1,\n    {},\n    []\n  ]\n}",
        Json.stringify(
            Json.object("a", Json.array(1L, Json.object("gone", Json.UNDEFINED), Json.array())),
            2));
    assertEquals(
        "1,,2,3,,4",
        Js.string(Json.array(1L, null, Json.array(2L, Json.array(3L, Json.array())), 4L)));
  }

  @Test
  void aTrackerHitKeepsItsTopHoweverDeepAFieldNobodyReadsNests() throws InterruptedException {
    String hit =
        "{\"k\":\"pageview\",\"u\":\"https://example.com/\",\"x\":" + nested(3900, false) + "}";
    Object read = onSmallStack(() -> Payload.parsePayload(hit));
    assertEquals("pageview", Js.map(read).get("kind"));
    Json.Parsed shallow =
        Json.tryParseShallow("{\"a\":1,\"x\":" + nested(1500, true) + ",\"b\":[2]}");
    assertTrue(shallow.ok());
    assertEquals(1L, Js.map(shallow.value()).get("a"));
    assertEquals(Json.array(2L), Js.map(shallow.value()).get("b"));
    // What is nested past the limit is still checked to be JSON.
    assertFalse(
        Json.tryParseShallow("{\"x\":" + nested(1500, false).replace("]]", "],]") + "}").ok());
    assertNull(
        Payload.parsePayload("{\"k\":\"pageview\",\"u\":\"https://example.com/\",\"x\":[[}"));
  }
}
