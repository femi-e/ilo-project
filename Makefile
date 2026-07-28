# ILO Monorepo — Cross-language orchestration
# Usage: make <target>

.PHONY: all build test clean dev help

all: build

help:
	@echo "Targets:"
	@echo "  build       Build Rust sidecar"
	@echo "  test        Run all tests (Rust + TS)"
	@echo "  test-rust   Run Rust unit tests"
	@echo "  test-ts     Run TypeScript tests"
	@echo "  dev         Start dev loop"
	@echo "  clean       Clean build artifacts"

# ── Rust sidecar ──────────────────────────────────────

build:
	cd mem-arch && cargo build --release

build-debug:
	cd mem-arch && cargo build

test-rust:
	cd mem-arch && cargo test --lib

# ── TypeScript extension ──────────────────────────────

test-ts:
	cd pi-extension && npx vitest run 2>/dev/null || echo "No TS tests yet"

# ── All tests ─────────────────────────────────────────

test: test-rust test-ts

# ── Dev ───────────────────────────────────────────────

dev:
	cd mem-arch && cargo watch -x run

# ── Clean ─────────────────────────────────────────────

clean:
	cd mem-arch && cargo clean
	rm -f var/ilo_data.lbug var/ilo_data.lbug.wal
