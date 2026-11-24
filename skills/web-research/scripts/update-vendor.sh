#!/bin/bash
set -euo pipefail

UPSTREAM="https://github.com/Johell1NS/browser-search"
TAG="${1:-v1.2.0}"

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$SKILL_DIR/scripts"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

log() { echo "==> $*"; }
log "fetch upstream $UPSTREAM @ $TAG → $WORK"
git clone --quiet --depth 1 --branch "$TAG" "$UPSTREAM.git" "$WORK"

copy() {
  local src="$1" dst="$2"
  mkdir -p "$VENDOR_DIR/$(dirname "$dst")"
  cp "$WORK/$src" "$VENDOR_DIR/$dst"
  echo "  $src → $dst"
}

log "vendoring files…"
copy scripts/cloak/cloak-fetch.mjs        cloak/cloak-fetch.mjs
copy scripts/cloak/cloak-script.mjs       cloak/cloak-script.mjs
copy scripts/cloak/challenges.mjs         cloak/challenges.mjs
copy scripts/cloak/lib/rate-limiter.mjs   cloak/lib/rate-limiter.mjs
copy scripts/cloak/lib/sandbox.mjs        cloak/lib/sandbox.mjs
copy scripts/cloak/scripts/screenshot.mjs cloak/scripts/screenshot.mjs
copy scripts/camofox/Readability.js       camofox/Readability.js

cat > "$VENDOR_DIR/VENDORED.md" <<EOF
# Vendored from $UPSTREAM

- **Version:** $TAG
- **License:** MIT (see upstream LICENSE)
- **Updated:** $(date -u +%Y-%m-%d)

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
EOF

log "syntax-check…"
for f in "$VENDOR_DIR"/cloak/*.mjs "$VENDOR_DIR"/cloak/lib/*.mjs; do
  node --check "$f" && echo "  ok: $(basename "$f")"
done

log "done. Review the diff and commit:"
echo "  git -C \"$SKILL_DIR\" diff --stat scripts/cloak scripts/camofox VENDORED.md"
echo "  (check that engines/local.ts (cloakFetch) still matches cloak-fetch CLI/contract!)"
