# frozen_string_literal: true

module Runlight
  # Refused before anything was fetched, because the address is link-local or a cloud's metadata service.
  class MetadataAddressError < RuntimeError
    attr_reader :host

    def initialize(host)
      @host = host
      super("#{host} is a link-local or cloud metadata address, which Runlight never connects to")
    end
  end
end
