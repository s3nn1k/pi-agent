# Vendored from https://github.com/Johell1NS/browser-search

- **Version:** v1.2.0
- **License:** MIT (see upstream LICENSE)
- **Updated:** 2026-09-07

## Vendored (refreshed by this script: ./scripts/update-vendor.sh [tag])

- scripts/cloak/cloak-fetch.mjs
- scripts/cloak/cloak-script.mjs
- scripts/cloak/challenges.mjs
- scripts/cloak/lib/rate-limiter.mjs
- scripts/cloak/lib/sandbox.mjs
- scripts/cloak/scripts/screenshot.mjs
- scripts/camofox/Readability.js

## Forked — diverged, NOT refreshed (do not overwrite)

- scripts/cloak/lib/url-validation.mjs — hardened over upstream: dns.lookup (getaddrinfo,
  agrees with /etc/hosts), fail-closed on resolution error, IPv4-mapped-IPv6 detection
  (::ffff:a.b.c.d → hex ::ffff:a9fe:a9fe).

## Skill-authored — not from upstream

- scripts/cloak/scripts/selector-eval.mjs (env-injected URL/selector runner)
