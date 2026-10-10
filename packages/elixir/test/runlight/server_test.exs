defmodule Runlight.ServerTest do
  # An instance started as an app starts one, with the scheduled check on an interval.
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog

  alias Runlight.Test.Stores

  test "a check that fails leaves the instance and its table as they were, and a stopped instance is forgotten" do
    {store, cleanup} = Stores.store(:sqlite)
    on_exit(cleanup)
    stopped = :counters.new(1, [])
    # A clock that exits once stopped, so the check fails with an exit rather than an exception.
    now = fn -> if :counters.get(stopped, 1) == 1, do: exit(:clock_stopped), else: 1_791_288_000_000 end

    start_supervised!(
      {Runlight,
       name: Runlight.ServerTest.RL,
       store: store,
       site: [name: "example.com", hostnames: ["example.com"], timezone: "UTC"],
       now: now,
       check_every: 20}
    )

    rl = Runlight.instance(Runlight.ServerTest.RL)
    server = Process.whereis(Runlight.ServerTest.RL.Server)

    log =
      capture_log(fn ->
        :counters.put(stopped, 1, 1)
        Process.sleep(200)
        :counters.put(stopped, 1, 0)
        Process.sleep(50)
      end)

    assert log =~ "the scheduled check failed"
    assert Process.whereis(Runlight.ServerTest.RL.Server) == server
    assert Runlight.instance(Runlight.ServerTest.RL).table == rl.table
    assert :ets.info(rl.table, :owner) == server

    stop_supervised!(Runlight.ServerTest.RL)
    assert_raise ArgumentError, fn -> Runlight.instance(Runlight.ServerTest.RL) end
  end
end
