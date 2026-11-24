// URL validation — anti-SSRF protection
// Blocks internal IPs, link-local, metadata endpoints, and *.localhost.
//
// ⚠️ FORKED from upstream Johell1NS/browser-search (MIT). Intentionally diverged;
// NOT refreshed by update-vendor.sh (removed from its manifest — see VENDORED.md).
// Local hardening over upstream:
//   - dns.lookup (getaddrinfo) so /etc/hosts + mDNS agree with the browser
//     (upstream dns.resolve* / c-ares skipped /etc/hosts → *.localhost slipped through)
//   - fails CLOSED on resolution error (upstream fail-open)
//   - blocks IPv4-mapped IPv6 (dotted ::ffff:a.b.c.d and hex ::ffff:a9fe:a9fe)
// If you ever sync from upstream, re-apply these three changes (or upstream them).

import { lookup } from "node:dns";
import { promisify } from "node:util";

const lookupAsync = promisify(lookup);

// RFC 1918 + special ranges
const BLOCKED_RANGES = [
  // Loopback
  { cidr: "127.0.0.0", prefixLen: 8 },
  // Link-local
  { cidr: "169.254.0.0", prefixLen: 16 },
  // RFC 1918 private
  { cidr: "10.0.0.0", prefixLen: 8 },
  { cidr: "172.16.0.0", prefixLen: 12 },
  { cidr: "192.168.0.0", prefixLen: 16 },
  // Additional reserved
  { cidr: "0.0.0.0", prefixLen: 8 },
  { cidr: "100.64.0.0", prefixLen: 10 }, // CGNAT
  { cidr: "192.0.0.0", prefixLen: 24 }, // IETF Protocol Assignments
  { cidr: "192.0.2.0", prefixLen: 24 }, // TEST-NET-1
  { cidr: "198.51.100.0", prefixLen: 24 }, // TEST-NET-2
  { cidr: "203.0.113.0", prefixLen: 24 }, // TEST-NET-3
  { cidr: "224.0.0.0", prefixLen: 4 }, // Multicast
  { cidr: "240.0.0.0", prefixLen: 4 }, // Reserved
];

// Known cloud metadata endpoints (hostname check, in addition to IP check)
const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.google.internal.",
  "instance-data.pai.googleapis.com",
  "instance-data.pai.googleapis.com.",
]);

// IPv6 blocked patterns
const BLOCKED_IPV6_PATTERNS = [
  /^::1$/, // loopback
  /^fe80:/i, // link-local
  /^fc/i,
  /^fd/i, // unique local
  /^ff/i, // multicast
];

function ipToNumber(ip) {
  const parts = ip.split(".").map(Number);
  return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
}

function isInBlockedRange(ip) {
  const ipNum = ipToNumber(ip);
  for (const { cidr, prefixLen } of BLOCKED_RANGES) {
    const networkNum = ipToNumber(cidr);
    const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
    if ((ipNum & mask) === (networkNum & mask)) return true;
  }
  return false;
}

// IPv4-mapped IPv6 — the browser connects to the embedded v4, so extract the
// octets and check them against the blocked v4 ranges. Node canonicalizes these
// to HEX form (::ffff:a9fe:a9fe); also accept the dotted form (::ffff:169.254.169.254).
const V4_MAPPED_DOTTED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;
const V4_MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
function ipv4FromMappedV6(ip) {
  let m = ip.match(V4_MAPPED_DOTTED);
  if (m) return m[1];
  m = ip.match(V4_MAPPED_HEX);
  if (m) {
    const a = parseInt(m[1], 16),
      b = parseInt(m[2], 16);
    return `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
  }
  return null;
}
function isBlockedIPv6(ip) {
  const v4 = ipv4FromMappedV6(ip);
  if (v4) return isInBlockedRange(v4);
  for (const pattern of BLOCKED_IPV6_PATTERNS) {
    if (pattern.test(ip)) return true;
  }
  return false;
}

/**
 * Validate a URL for SSRF safety.
 * @param {string} url - URL to validate
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
export function validateUrl(url) {
  // Parse URL
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: "Invalid URL format" };
  }

  // Scheme check
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { valid: false, reason: `Blocked scheme: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block empty hostname
  if (!hostname) {
    return { valid: false, reason: "Missing hostname" };
  }

  // Block known metadata hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return {
      valid: false,
      reason: "Blocked hostname: cloud metadata endpoint",
    };
  }

  // Block localhost (+ any *.localhost — browsers resolve these to loopback)
  if (
    hostname === "localhost" ||
    hostname === "localhost." ||
    hostname.endsWith(".localhost")
  ) {
    return { valid: false, reason: "Blocked hostname: localhost" };
  }

  // Block IP literals in URL (IPv4)
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    if (isInBlockedRange(hostname)) {
      return { valid: false, reason: `Blocked IP: ${hostname}` };
    }
    // Allow public IPs but warn — most SSRF targets are private
    return { valid: true };
  }

  // Block IPv6 literals
  if (/^\[.*\]$/.test(hostname) || hostname.includes(":")) {
    const ipv6 = hostname.replace(/^\[|\]$/g, "");
    if (isBlockedIPv6(ipv6)) {
      return { valid: false, reason: `Blocked IPv6: ${ipv6}` };
    }
    return { valid: true };
  }

  // Block common internal TLDs
  if (
    hostname.endsWith(".internal") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".lan")
  ) {
    return { valid: false, reason: `Blocked TLD: ${hostname}` };
  }

  return { valid: true };
}

/**
 * Async DNS resolution check — resolves the hostname (getaddrinfo) and verifies
 * the IP is not private/blocked. Best-effort pre-check, NOT a complete
 * DNS-rebinding defense: the browser re-resolves independently, so a low-TTL
 * public→private flip can still slip through (full protection needs IP pinning
 * or a blocking resolver). Fails CLOSED on resolution error.
 * @param {string} url - URL to check
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
export async function validateUrlWithDns(url) {
  const syncResult = validateUrl(url);
  if (!syncResult.valid) return syncResult;

  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();

  // Skip DNS for IP literals (v4 dotted or v6 with ':') — validateUrl already checked them.
  if (
    /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    hostname.includes(":")
  ) {
    return syncResult;
  }

  // Resolve via getaddrinfo (all families) so /etc/hosts + mDNS agree with the
  // browser. Fail CLOSED on resolution error: an unresolvable host would fail
  // in the browser too, and the old dns.resolve*/fail-open let *.localhost through.
  let addresses;
  try {
    addresses = await lookupAsync(hostname, { all: true });
  } catch {
    return { valid: false, reason: `Unresolvable hostname: ${hostname}` };
  }
  if (!addresses || addresses.length === 0) {
    return { valid: false, reason: `Unresolvable hostname: ${hostname}` };
  }

  for (const { address } of addresses) {
    if (address.includes(":")) {
      if (isBlockedIPv6(address))
        return {
          valid: false,
          reason: `DNS resolved to blocked IPv6: ${address}`,
        };
    } else if (isInBlockedRange(address)) {
      return { valid: false, reason: `DNS resolved to blocked IP: ${address}` };
    }
  }

  return { valid: true };
}
