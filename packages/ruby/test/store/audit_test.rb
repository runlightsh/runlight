# frozen_string_literal: true

require "test_helper"
require_relative "../support/store_test_case"

# The store's side of the audit of 2026-10-16, as rollups.test.ts and counting.test.ts test it.
class StoreAuditTest < StoreTestCase
  def build_all(store)
    Seed.build_days(store, "default", NOW - 7 * DAY, NOW - DAY)
  end

  def reads(store, goal_id)
    query = q(NOW - 7 * DAY, NOW + DAY)
    totals = store.goal_totals_all(query, store.goals("default"))[goal_id]
    { "goal" => [totals["conversions"], totals["visitors"]], "events" => store.breakdown(query, "event", 10, 0).map { |r| [r["value"], r["events"]] }.sort }
  end

  on_each "renaming_a_click_goal_keeps_its_conversions_on_built_days_even_onto_a_name_with_events_of_its_own" do |kind|
    store = store(kind)
    3.times do |i|
      t = NOW - ((3 - i) * DAY)
      rows = [["pageview", "/", t, "c#{i}"], ["event", "Buy click", t + 1000, nil]]
      # One visit also sends a plain event under the name the goal is renamed to.
      rows << ["event", "Purchase", t + 2000, nil] if i.zero?
      Seed.visit(store, "c#{i}", "v#{i}", t, {}, rows)
    end
    made = goal("c".rjust(24, "0"), "name" => "Buy click", "kind" => "click", "match" => "button.buy", "clickBy" => "selector")
    store.save_goal(made)
    build_all(store)
    assert_equal [3, 3], reads(store, made["id"])["goal"]
    ["Checkout click", "Purchase"].each do |name|
      before = store.goals("default")[0]
      store.save_goal(before.merge("name" => name), before)
      rolled = reads(store, made["id"])
      assert_equal [name == "Purchase" ? 4 : 3, 3], rolled["goal"], "renamed to #{name}"
      # Days built again where both names met, then every built day reads the same as the raw events.
      build_all(store)
      built = reads(store, made["id"])
      store.clear_rollups("default")
      assert_equal built, reads(store, made["id"]), "rollups agree with the raw events after renaming to #{name}"
      build_all(store)
    end
  end

  on_each "a_header_longer_than_its_column_is_cut_to_fit_so_the_days_rollup_still_builds" do |kind|
    store = store(kind)
    long = "Windows " * 400
    t = NOW - (2 * DAY)
    Seed.visit(store, "long1", "v1", t, { "os" => long, "hostname" => "h" * 300, "referrerPath" => "r" * 900, "browser" => "B" * 3000 },
               [["pageview", "/#{"a" * 1500}", t, "p1"], ["event", "E" * 400, t + 1000, nil, "/#{"b" * 1500}"]])
    row = store.db.all("SELECT os, hostname, referrer_path, browser, entry_path, exit_path FROM rl_sessions")[0]
    assert_operator row["os"].to_s.length, :<=, 100
    assert_operator row["os"].to_s.length, :>, 50
    assert_equal 255, row["hostname"].to_s.length
    assert_equal 500, row["referrer_path"].to_s.length
    assert_equal 100, row["browser"].to_s.length
    assert_equal 1000, row["entry_path"].to_s.length
    assert_equal 1000, row["exit_path"].to_s.length
    event = store.db.all("SELECT path, name FROM rl_events WHERE kind = 'event'")[0]
    assert_equal [1000, 255], [event["path"].to_s.length, event["name"].to_s.length]
    assert_operator Seed.build_days(store, "default", t, NOW), :>=, 1, "the day builds"
    assert_equal 1, store.stats(q(NOW - 7 * DAY, NOW + DAY))["visits"]
  end

  on_each "text_is_cut_by_characters_never_through_the_middle_of_one" do |kind|
    store = store(kind)
    Seed.visit(store, "e1", "v1", NOW, { "city" => "é" * 120, "language" => "😀" * 60 })
    row = store.db.all("SELECT city, language FROM rl_sessions")[0]
    assert_equal "é" * 100, row["city"].to_s
    assert_equal "😀" * 50, row["language"].to_s
  end

  on_each "two_visits_opened_for_one_visitor_at_once_by_two_processes_settle_on_one" do |kind|
    store = store(kind)
    Seed.visit(store, "bbbb", "v1", NOW)
    Seed.visit(store, "aaaa", "v1", NOW)
    # Each process asks after opening its own; both settle on the same one, and the other is gone.
    one = store.settle_open_session("default", ["v1"], NOW - 60_000, { "id" => "bbbb", "visitor" => "v1" })
    other = store.settle_open_session("default", ["v1"], NOW - 60_000, { "id" => "aaaa", "visitor" => "v1" })
    assert_equal %w[aaaa aaaa], [one["id"], other["id"]]
    assert_equal ["aaaa"], store.db.all("SELECT id FROM rl_sessions").map { |r| r["id"].to_s }
  end

  on_each "a_visit_already_counting_a_hit_is_the_one_both_settle_on" do |kind|
    store = store(kind)
    Seed.visit(store, "bbbb", "v1", NOW, {}, [["pageview", "/", NOW, "p1"]])
    Seed.visit(store, "aaaa", "v1", NOW)
    settled = store.settle_open_session("default", ["v1"], NOW - 60_000, { "id" => "aaaa", "visitor" => "v1" })
    assert_equal "bbbb", settled["id"]
    assert_equal ["bbbb"], store.db.all("SELECT id FROM rl_sessions").map { |r| r["id"].to_s }
  end

  on_each "salts_are_kept_by_day_and_a_visit_still_going_is_found" do |kind|
    store = store(kind)
    store.salt("2026-10-05", "old")
    store.salt("2026-10-06", "today")
    store.drop_salts_except(["2026-10-06"])
    assert_nil store.salt_if_exists("2026-10-05")
    assert_equal "today", store.salt_if_exists("2026-10-06")
    Seed.visit(store, "s1", "v1", NOW - HOUR, {}, [["pageview", "/", NOW - 10 * MIN, "p1"]])
    assert store.visit_open(["default"], NOW - DAY, NOW, NOW - 30 * MIN)
    refute store.visit_open(["default"], NOW - DAY, NOW, NOW), "ended before the time asked"
    refute store.visit_open(["default"], NOW, NOW + DAY, NOW - 30 * MIN), "began outside the stretch"
    refute store.visit_open(["elsewhere"], NOW - DAY, NOW, NOW - 30 * MIN)
    assert store.visit_open(["elsewhere", "default"], NOW - DAY, NOW, NOW - 30 * MIN)
    many = Array.new(250) { |i| "site#{i}" } + ["default"]
    assert store.visit_open(many, NOW - DAY, NOW, NOW - 30 * MIN), "however many sites are asked about"
  end

  # Two processes building one day at once add its rows once: there the day is marked first, so one waits on the
  # other and then fails.
  on_each "on_mysql_two_processes_building_one_day_at_once_add_its_rows_once", Databases.mysql_urls.keys do |kind|
    url = StoreDatabases.mysql_database(kind)
    one = StoreDatabases.closing(Runlight::Stores.mysql(url))
    other = StoreDatabases.closing(Runlight::Stores.mysql(url))
    one.migrate
    one.upsert_site({ "id" => "default", "name" => "Example", "hostnames" => ["example.com"], "timezone" => "UTC" }, NOW)
    5.times { |i| Seed.visit(one, "s#{i}", "v#{i}", NOW - DAY + (i * MIN), {}, [["pageview", "/", NOW - DAY + (i * MIN), "p#{i}"]]) }
    day = (NOW - DAY) / DAY * DAY
    name = Time.at(day / 1000).utc.strftime("%Y-%m-%d")
    5.times do |round|
      results = [one, other].map do |s|
        Thread.new do
          s.build_rollup_day("default", name, day, day + DAY)
          :built
        rescue StandardError
          :failed
        end
      end.map(&:value)
      assert_includes results, :built, "one of them builds it"
      total = one.db.all("SELECT COUNT(*) AS n, SUM(visits) AS visits FROM rl_rollups WHERE site = 'default' AND day = ? AND dim = ''", [name])[0]
      assert_equal [1, 5], [total["n"].to_i, total["visits"].to_i], "round #{round}"
    end
  end
end
