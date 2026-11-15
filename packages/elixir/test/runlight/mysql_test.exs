defmodule Runlight.MysqlTest do
  @moduledoc "The SDK's mysql.test.ts: what only MySQL and MariaDB need, run when RUNLIGHT_TEST_MYSQL or RUNLIGHT_TEST_MARIADB is set."
  use ExUnit.Case, async: false

  alias Runlight.Store
  alias Runlight.Test.Stores

  for {kind, _} <- Stores.kinds(), kind in [:mysql, :mariadb] do
    @kind kind
    test "#{kind}: a server set to NO_BACKSLASH_ESCAPES cannot turn a value into SQL" do
      url = Keyword.fetch!(Stores.kinds(), @kind)
      # An app's own repo whose every connection starts with the mode on, as a server configured that way would.
      mode_on = "SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',NO_BACKSLASH_ESCAPES')"
      {store, cleanup} = Stores.store(@kind, url, after_connect: {MyXQL, :query!, [mode_on, []]})
      on_exit(cleanup)
      Store.migrate(store)

      value = "a\\' , 'x') -- \\\\ end"
      Store.set_setting(store, "odd", value)
      assert Store.setting(store, "odd") == value
      assert Store.setting(store, "x") == nil, "nothing else was written"
      assert [row] = Runlight.Db.all(store.db, ~s(SELECT 'a\\b' AS t, ? AS v), [value])
      assert {row["t"], row["v"]} == {"a\\b", value}
      [row] = Runlight.Db.all(store.db, "SELECT @@SESSION.sql_mode AS mode", [])
      refute row["mode"] =~ "NO_BACKSLASH_ESCAPES"
    end

    test "#{kind}: prepared statements are kept open, and never more than a fixed number on a connection" do
      url = Keyword.fetch!(Stores.kinds(), @kind)
      {store, cleanup} = Stores.store(@kind, url)
      on_exit(cleanup)
      Store.migrate(store)

      # One connection for all of it, as a checkout holds one.
      Runlight.Db.exclusive(store.db, fn db ->
        # Six hundred statements that differ in their text, as those with a varying number of placeholders do.
        for i <- 1..600 do
          assert [row] = Runlight.Db.all(db, "SELECT ? AS v#{i}", ["a\\' -- #{i}"])
          assert row["v#{i}"] == "a\\' -- #{i}"
        end

        # And one sent again and again is prepared once.
        for i <- 1..50, do: assert([_] = Runlight.Db.all(db, "SELECT ? AS again", [i]))

        [version] = Runlight.Db.all(db, "SELECT VERSION() AS v", [])

        # MySQL says how many statements a connection holds open; MariaDB has no such table.
        unless version["v"] =~ "MariaDB" do
          [open] =
            Runlight.Db.all(
              db,
              "SELECT COUNT(*) AS n FROM performance_schema.prepared_statements_instances WHERE OWNER_THREAD_ID = PS_CURRENT_THREAD_ID()",
              []
            )

          assert open["n"] > 0, "statements are kept open"
          assert open["n"] <= 256, "#{open["n"]} statements were left open on one connection"
        end
      end)
    end
  end
end
