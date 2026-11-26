# frozen_string_literal: true

module Runlight
  module Brand
    module_function

    # The Runlight mark for the dashboard's tab: an R in a rounded lamp housing, one corner lit. A data: URL.
    def runlight_icon
      Version.build["icon"].to_s
    end

    # The mark as a 96 pixel PNG, base64, the same drawing as the website's header and the Mac app's icon. Each
    # install serves it at <base>/logo.png, without signing in, for its emails.
    def logo_png
      Version.build["logoPng"].to_s
    end

    # The email logo's bytes, decoded from base64 the first time they are asked for.
    def logo_bytes
      @logo_bytes ||= logo_png.unpack1("m0").freeze
    end

    # The mark for emails: the PNG at the sending install's own /logo.png, shown at 48 pixels. Opening an email
    # fetches it from that install and from nowhere else; a client that blocks images shows the word Runlight.
    # `home` is the install's address with its base path, such as https://example.com/runlight.
    def email_logo(home)
      src = "#{home.to_s.sub(%r{/+\z}, "")}/logo.png".gsub("&", "&amp;").gsub('"', "&quot;").gsub("<", "&lt;").gsub(">", "&gt;")
      "<img src=\"#{src}\" width=\"48\" height=\"48\" alt=\"Runlight\" style=\"display:block;width:48px;height:48px;margin:0 0 24px;" \
        "border:0;outline:none;text-decoration:none;font:700 16px/48px -apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#6b7280\">"
    end
  end
end
