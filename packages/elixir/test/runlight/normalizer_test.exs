defmodule Runlight.NormalizerTest do
  @moduledoc """
  The conformance player's normalizer against cases run through normalize()
  in http-conformance.ts (packages/php/tests/fixtures/conformance-normalize.json).
  """
  use ExUnit.Case, async: true

  alias Runlight.JS
  alias Runlight.Test.Conformance
  alias Runlight.Test.Fixtures

  test "normalizes as the TypeScript does" do
    for c <- Fixtures.php("conformance-normalize.json") do
      assert JS.stringify(Conformance.normalize(c["input"])) == JS.stringify(c["output"]), JS.stringify(c["input"])
    end
  end
end
