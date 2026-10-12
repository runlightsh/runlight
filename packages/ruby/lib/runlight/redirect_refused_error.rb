# frozen_string_literal: true

module Runlight
  # Refused before anything was sent there, because a service's redirect led to another origin.
  class RedirectRefusedError < RuntimeError
    attr_reader :host, :to

    def initialize(host, to)
      @host = host
      @to = to
      super("#{host} redirected to #{to}. Runlight sends a service's key and request only to the address it was set up with, so set it up with that address instead")
    end
  end
end
