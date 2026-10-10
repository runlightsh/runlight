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
  end
end
