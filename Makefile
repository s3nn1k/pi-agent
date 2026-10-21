SHELL := /bin/sh
.PHONY: init lint test

PRETTIER := npx --no-install prettier
TSC := npx --no-install tsc

# Install dev tooling (formatter/typecheck). Types for extensions resolve via the
# @earendil-works/pi-coding-agent devDep — no manual symlink needed.
init:
	npm install

# Format everything in place (Prettier — same as nvim/conform) + typecheck; exits non-zero on errors.
lint:
	$(PRETTIER) --write .
	$(TSC) -p tsconfig.json

test:
	node --test $$(find extensions -name '*.test.ts' | tr '\n' ' ')
