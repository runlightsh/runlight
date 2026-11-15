# frozen_string_literal: true

module Runlight
  # A map whose entries go when their key is collected, and whose values are held firmly until then: on Ruby
  # 3.3 and later, ObjectSpace::WeakKeyMap itself. Ruby 3.2 has no WeakKeyMap, and its ObjectSpace::WeakMap
  # holds values weakly too, so a value nothing else holds (a rate count, a request's context) could be
  # collected while its key is in use. There, the value is kept on the key, in an instance variable this map
  # alone uses, and goes with the key. Only [], []=, and key? are offered, which is all Runlight uses.
  WeakKeys =
    if defined?(ObjectSpace::WeakKeyMap)
      ObjectSpace::WeakKeyMap
    else
      Class.new do
        def initialize
          @name = :"@__runlight_weak_keys_#{object_id}"
        end

        def [](key)
          key.instance_variable_defined?(@name) ? key.instance_variable_get(@name) : nil
        end

        def []=(key, value)
          key.instance_variable_set(@name, value)
        end

        def key?(key)
          key.instance_variable_defined?(@name)
        end
      end
    end
end
