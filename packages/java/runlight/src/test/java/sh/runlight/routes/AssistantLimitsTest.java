package sh.runlight.routes;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import sh.runlight.Env;
import sh.runlight.Json;
import sh.runlight.RecordingFetcher;
import sh.runlight.Routes;
import sh.runlight.Runlight;
import sh.runlight.http.FetchError;
import sh.runlight.store.SqlStore;
import sh.runlight.store.Stores;

/** assistant.test.ts, ported: questions sent at once count once each against a daily number. */
class AssistantLimitsTest {
  private static final long NOW = Make.utc(2026, 10, 12, 12);

  @BeforeEach
  void setUp() {
    Make.clearEnv();
  }

  @AfterEach
  void tearDown() {
    Env.reset();
  }

  /** A Runlight on the shared store, as another process on one database would be. */
  private static Runlight made(SqlStore store) {
    return Make.runlight(
        new Runlight.Options()
            .store(store)
            .now(() -> NOW)
            .site(Make.site("a", "a.example.com"))
            // The model is never reached; a question that gets past the limits fails fast instead.
            .fetcher(
                new RecordingFetcher(
                    (url, init) -> {
                      throw new FetchError("down");
                    })));
  }

  private static Routes routes(Runlight rl) {
    return rl.routes(
        new Routes.Options()
            .authorize(r -> r.headers().get("x-who") != null ? "read" : false)
            .accountOf(r -> r.headers().get("x-who")));
  }

  private static int ask(Routes routes, String who) {
    return routes
        .handle(
            Make.req(
                "/runlight/api/assistant/chat",
                "POST",
                Map.of("x-who", who, "content-type", "application/json"),
                Json.stringify(
                    Json.object(
                        "site",
                        "a",
                        "messages",
                        List.of(Json.object("role", "user", "content", "hi"))))))
        .status();
  }

  /** How many of the questions, all started together, were not turned away. */
  private static int passed(List<Routes> handlers, List<String> who) throws Exception {
    ExecutorService pool = Executors.newFixedThreadPool(who.size());
    try {
      CountDownLatch go = new CountDownLatch(1);
      List<Future<Integer>> answers = new ArrayList<>();
      for (int i = 0; i < who.size(); i++) {
        Routes routes = handlers.get(i % handlers.size());
        String viewer = who.get(i);
        answers.add(
            pool.submit(
                () -> {
                  go.await();
                  return ask(routes, viewer);
                }));
      }
      go.countDown();
      int passed = 0;
      for (Future<Integer> answer : answers) {
        if (answer.get() != 429) {
          passed++;
        }
      }
      return passed;
    } finally {
      pool.shutdown();
    }
  }

  @Test
  void questionsSentAtOnceCountOnceEachAgainstAViewersDailyNumber() throws Exception {
    SqlStore store = Stores.sqlite(":memory:");
    Runlight first = made(store);
    first.init();
    first.saveAssistantSettings(
        Json.object(
            "provider", "custom", "model", "m", "baseUrl", "http://127.0.0.1:9/v1", "key", "k"));
    first.store.setSetting("assistant-viewer-daily", "1");
    String day = "assistant-asked:2026-10-12:";

    // One process: the second and later questions see the first before anything is awaited.
    Routes one = routes(first);
    assertEquals(1, passed(List.of(one), java.util.Collections.nCopies(10, "viewer-1")));
    assertEquals("1", first.store.setting(day + "viewer-1"));

    // Ten processes on one database, each with its own counts in memory: the database lets one in.
    List<Routes> handlers = new ArrayList<>();
    for (int i = 0; i < 10; i++) {
      handlers.add(routes(made(store)));
    }
    assertEquals(1, passed(handlers, java.util.Collections.nCopies(10, "viewer-2")));
    assertEquals("1", first.store.setting(day + "viewer-2"));

    // Two viewers at once each have their own row, and neither write loses the other's.
    assertEquals(2, passed(handlers.subList(0, 2), List.of("viewer-3", "viewer-4")));
    assertEquals("1", first.store.setting(day + "viewer-3"));
    assertEquals("1", first.store.setting(day + "viewer-4"));

    // A viewer's first question of a day clears the days before.
    first.store.setSetting("assistant-asked:2026-10-11:viewer-1", "1");
    first.store.setSetting("assistant-asked:2026-10-11", "{\"viewer-1\":1}");
    assertEquals(1, passed(handlers.subList(0, 1), List.of("viewer-5")));
    assertEquals(null, first.store.setting("assistant-asked:2026-10-11:viewer-1"));
    assertEquals(null, first.store.setting("assistant-asked:2026-10-11"));
  }
}
