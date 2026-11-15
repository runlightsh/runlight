# frozen_string_literal: true

require "stringio"

module Runlight
  module Http
    # An answer, shaped like the Fetch API's Response. The body is text, or a
    # Proc that writes its parts to the writer it is given (anything with <<),
    # for answers too long to hold at once.
    class Response
      attr_reader :status, :headers

      def initialize(body = "", status: 200, headers: {})
        @body = body.is_a?(Proc) ? body : body.to_s
        @status = status
        @headers = headers.is_a?(Headers) ? headers : Headers.new(headers)
      end

      def self.json(data, status: 200, headers: {})
        new(Json.encode(data), status: status, headers: { "content-type" => "application/json" }.merge(headers))
      end

      def self.redirect(location, status: 302)
        new("", status: status, headers: { "location" => location })
      end

      def ok?
        @status >= 200 && @status < 300
      end

      # The whole body as text; a streamed body is run and captured.
      def text
        return @body if @body.is_a?(String)

        out = StringIO.new(+"")
        @body.call(out)
        @body = out.string
      end

      # The body as JSON. Raises Runlight::Json::ParseError when it is not.
      def json
        Json.decode(text)
      end

      def streamed?
        !@body.is_a?(String)
      end

      # Calls the block with each part of the body, as a Rack body's each does.
      def each_chunk(&block)
        return block.call(@body) if @body.is_a?(String)

        @body.call(Writer.new(block))
      end

      # [status, headers, body] for Rack. Header names are lowercase, as Rack 3 asks. Several Set-Cookie values
      # are an Array under Rack 3, which takes no line break in a value, and one per line under Rack 2 (or
      # with no rack gem loaded, where servers split on the line break), which takes no Array.
      def to_rack
        headers = {}
        @headers.all.each do |name, values|
          headers[name] = if name != "set-cookie" then values.join(", ")
                          elsif values.length > 1 && Response.rack3? then values.dup
                          else values.join("\n")
                          end
        end
        [@status, headers, RackBody.new(self)]
      end

      # Whether the rack gem loaded is 3 or later. Its version is in a file of its own, which an app that
      # loaded only parts of rack may not have read yet.
      def self.rack3?
        return false unless defined?(::Rack)

        unless ::Rack.respond_to?(:release)
          begin
            require "rack/version"
          rescue LoadError
            return false
          end
        end
        ::Rack.respond_to?(:release) && ::Rack.release.to_i >= 3
      end

      # What a streamed body writes to: each part goes straight to the block.
      class Writer
        def initialize(block)
          @block = block
        end

        def <<(chunk)
          @block.call(chunk.to_s)
          self
        end

        def write(chunk)
          @block.call(chunk.to_s)
          chunk.to_s.bytesize
        end
      end

      # A Rack body that writes a Response's parts.
      class RackBody
        def initialize(response)
          @response = response
        end

        def each(&block)
          @response.each_chunk(&block)
        end
      end
    end
  end
end
