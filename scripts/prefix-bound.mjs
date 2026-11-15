/**
 * The widest address prefix scripts/agent-ranges.mts takes from a list an AI
 * company publishes. A list is copied into every install, where a request
 * from inside it counts as that company's agent, so one over-wide entry (a
 * mistake upstream, or a list someone tampered with) would count ordinary
 * visitors as an agent everywhere. The widest entries published today are an
 * IPv4 /16 and an IPv6 /56; these bounds leave room above that and stop
 * anything that claims a real share of the internet.
 */
export const WIDEST = { ipv4: 10, ipv6: 24 };

/**
 * The entries of `prefixes` that may not be written, each with why: one that
 * is not an address with an optional /length, or one wider than WIDEST. An
 * address with no length is a single host.
 */
export function refusedPrefixes(prefixes) {
  const refused = [];
  for (const prefix of prefixes) {
    if (typeof prefix !== "string") {
      refused.push(`${JSON.stringify(prefix)} is not text`);
      continue;
    }
    const match = /^([0-9a-fA-F:.]+)(?:\/(\d{1,3}))?$/.exec(prefix);
    if (!match) {
      refused.push(`${prefix} is not an address prefix`);
      continue;
    }
    const v6 = match[1].includes(":");
    const bits = v6 ? 128 : 32;
    const length = match[2] === undefined ? bits : Number(match[2]);
    const widest = v6 ? WIDEST.ipv6 : WIDEST.ipv4;
    if (length > bits) refused.push(`${prefix} has a length past /${bits}`);
    else if (length < widest) refused.push(`${prefix} is wider than /${widest}, the widest ${v6 ? "IPv6" : "IPv4"} prefix taken`);
  }
  return refused;
}
