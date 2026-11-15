# frozen_string_literal: true

require_relative "test_helper"

class WeakKeysTest < Minitest::Test
  # A value nothing else holds outlives a garbage collection while its key is alive, on every Ruby the gem
  # supports. On Ruby 3.2, ObjectSpace::WeakMap would let it go, which once reset the OAuth registration limit.
  def test_a_value_held_by_nothing_else_stays_while_its_key_lives
    map = Runlight::WeakKeys.new
    keys = Array.new(50) { Object.new }
    keys.each_with_index { |key, i| map[key] = "value #{i}".dup }
    3.times { GC.start(full_mark: true, immediate_sweep: true) }
    keys.each_with_index { |key, i| assert_equal "value #{i}", map[key] }
    assert_nil map[Object.new]
    assert map.key?(keys.first)
    refute map.key?(Object.new)
  end

  def test_two_maps_keep_their_own_values_for_one_key
    first = Runlight::WeakKeys.new
    second = Runlight::WeakKeys.new
    key = Object.new
    first[key] = 1
    second[key] = 2
    assert_equal [1, 2], [first[key], second[key]]
  end
end
