// Working out who is calling. Getting this wrong makes the per-IP limits useless in one of two ways:
//  - trust the X-Forwarded-For header blindly, and anyone can send a fresh fake address with every request;
//  - ignore it behind a proxy, and every visitor looks like the proxy and shares one limit.
// So the header is only used when we are told how many proxies sit in front of us, and then only the
// entry the nearest trusted proxy added, never the entries the caller wrote.

import { isIP } from "node:net";

function stripPort(raw: string): string {
  const s = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed) return bracketed[1]!;
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) return s.slice(0, s.lastIndexOf(":"));
  return s;
}

function expandIPv6(addr: string): string[] | null {
  const noZone = addr.split("%")[0]!;
  const parts = noZone.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (parts.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = parts.length === 1 ? head : [...head, ...Array<string>(missing).fill("0"), ...tail];
  return groups.map((g) => g.toLowerCase().padStart(4, "0"));
}

/** The key a caller is counted under: an IPv4 address as is, an IPv6 address as its /64. Garbage becomes "unknown". */
export function ipBucket(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  let ip = stripPort(raw).toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) ip = mapped[1]!;
  const kind = isIP(ip);
  if (kind === 4) return ip;
  if (kind === 6) {
    const groups = expandIPv6(ip);
    return groups ? `${groups.slice(0, 4).join(":")}::/64` : "unknown";
  }
  return "unknown";
}

/**
 * The caller's address.
 * trustedHops is how many proxies we run behind. With 0 the header is ignored completely.
 * With 1, the address that the proxy itself recorded (the last entry) is used, and anything the caller
 * put earlier in the header is ignored.
 */
export function clientIp(input: { xForwardedFor?: string | null; remoteAddress?: string | null; trustedHops: number }): string {
  if (input.trustedHops > 0 && input.xForwardedFor) {
    const entries = input.xForwardedFor.split(",").map((e) => e.trim()).filter(Boolean);
    const pick = entries[entries.length - input.trustedHops];
    if (pick) return pick;
  }
  return input.remoteAddress ?? "unknown";
}
