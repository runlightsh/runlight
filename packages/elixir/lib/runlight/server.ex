defmodule Runlight.Server do
  @moduledoc false
  # Internal. The process an instance started under a supervision tree lives
  # in: it owns the instance's state table, makes the tables in the database
  # on start (so a bad store fails the app's boot rather than its first
  # request), and keeps the instance where Runlight.instance/1 finds it.
  # With `check_every:` (milliseconds) it also runs the scheduled check on an
  # interval, as a platform's cron would call POST /api/check.
  #
  # The table lives as long as this process does, so the process does nothing
  # that can fail: each check runs in a task under a task supervisor of its
  # own, one at a time, and a check that fails or is killed leaves the table
  # as it was.

  use GenServer

  require Logger

  def start_link(opts) do
    name = Keyword.get(opts, :name, Runlight)
    GenServer.start_link(__MODULE__, opts, name: server_name(name))
  end

  defp server_name(name), do: Module.concat(name, Server)

  @impl true
  def init(opts) do
    # So terminate/2 runs when the supervisor stops this process, and the instance is forgotten.
    Process.flag(:trap_exit, true)
    rl = Runlight.new(opts)
    :persistent_term.put({Runlight, rl.name}, rl)
    Runlight.init(rl)
    every = Keyword.get(opts, :check_every)
    {:ok, tasks} = Task.Supervisor.start_link()
    if every, do: schedule(every)
    {:ok, %{rl: rl, every: every, tasks: tasks, running: nil}}
  end

  @impl true
  # One check at a time: one that is still running when the next is due lets it pass.
  def handle_info(:check, %{running: nil} = state) do
    rl = state.rl
    task = Task.Supervisor.async_nolink(state.tasks, fn -> check(rl) end)
    schedule(state.every)
    {:noreply, %{state | running: task.ref}}
  end

  def handle_info(:check, state) do
    schedule(state.every)
    {:noreply, state}
  end

  def handle_info({ref, _result}, %{running: ref} = state) do
    Process.demonitor(ref, [:flush])
    {:noreply, %{state | running: nil}}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, %{running: ref} = state) do
    Logger.error("Runlight: the scheduled check stopped: #{inspect(reason, limit: 5, printable_limit: 200)}")
    {:noreply, %{state | running: nil}}
  end

  # The task supervisor stopping takes this process with it, as it would without exits trapped.
  def handle_info({:EXIT, pid, reason}, %{tasks: pid} = state), do: {:stop, reason, state}

  def handle_info(_message, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    key = {Runlight, state.rl.name}
    # Only this process's own instance is forgotten, not one a newer process under the same name put there.
    if :persistent_term.get(key, nil) == state.rl, do: :persistent_term.erase(key)
    :ok
  end

  defp check(rl) do
    Runlight.check(rl)
  rescue
    error -> Logger.error("Runlight: the scheduled check failed: #{Exception.message(error)}")
  catch
    kind, reason ->
      Logger.error(
        "Runlight: the scheduled check failed: #{inspect(kind)} #{inspect(reason, limit: 5, printable_limit: 200)}"
      )
  end

  defp schedule(every), do: Process.send_after(self(), :check, every)
end
