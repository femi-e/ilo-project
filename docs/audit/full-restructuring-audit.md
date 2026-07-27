# ILO Full Restructuring Audit

> Generated: 2026-07-27
> Covers: pi-extension (TypeScript), mem-arch (Rust sidecar), project structure
> Status: All issues documented, prioritized, ready for execution

---

## Table of Contents

1. [Issue #13 — Duplicate turn creation / uncoordinated entity storage](#issue-13--duplicate-turn-creation--uncoordinated-entity-storage)
2. [Issue #7 — Binary threshold scoring vs composite formula](#issue-7--binary-threshold-scoring-vs-composite-formula)
3. [Issue #8 — Learning signal uses overlap selection, not explicit labels](#issue-8--learning-signal-uses-overlap-selection-not-explicit-labels)
4. [Issue #12 — Hardcoded 4B model ID ("default")](#issue-12--hardcoded-4b-model-id-default)
5. [Issue #9 — No pinned/stable memory tier](#issue-9--no-pinnedstable-memory-tier)
6. [Rust Sidecar: Dead code (`handlers::status`)](#rust-sidecar-dead-code-handlersstatus)
7. [Rust Sidecar: Blocking `embed()` without async signal](#rust-sidecar-blocking-embed-without-async-signal)
8. [Rust Sidecar: Crate naming confusion (package=ilo, lib=mem_arch)](#rust-sidecar-crate-naming-confusion-packageilo-libmem_arch)
9. [Rust Sidecar: Large file `crud.rs` (783 lines)](#rust-sidecar-large-file-crudrs-783-lines)
10. [Rust Sidecar: `resolve_entity_store` thin wrapper duplication](#rust-sidecar-resolve_entity_store-thin-wrapper-duplication)
11. [Rust Sidecar: `extract.rs` is 680 lines of mostly dead code](#rust-sidecar-extractrs-is-680-lines-of-mostly-dead-code)
12. [Rust Sidecar: No CI/lint config (clippy, rustfmt, CI)](#rust-sidecar-no-cilint-config-clippy-rustfmt-ci)
13. [Rust Sidecar: No benches/ directory for performance benchmarks](#rust-sidecar-no-benches-directory-for-performance-benchmarks)
14. [Project Structure: Dual `var/` directories](#project-structure-dual-var-directories)
15. [Project Structure: Nested git repo (Qwen3.6 model config)](#project-structure-nested-git-repo-qwen36-model-config)
16. [Project Structure: Orphan root-level stale files](#project-structure-orphan-root-level-stale-files)
17. [Project Structure: Design docs scattered across 3+ locations](#project-structure-design-docs-scattered-across-3-locations)
18. [Project Structure: TOP-LEVEL — The pi-extension lives in a hidden `.pi/` directory](#project-structure-top-level--the-pi-extension-lives-in-a-hidden-pi-directory)
19. [Project Structure: Extension internal organization — `context.ts` is bloated](#project-structure-extension-internal-organization--contextts-is-bloated)
20. [Project Structure: Dead web tool files in extension (4 files)](#project-structure-dead-web-tool-files-in-extension-4-files)
21. [Project Structure: Only Rust tests, no TypeScript tests for extension](#project-structure-only-rust-tests-no-typescript-tests-for-extension)
22. [Project Structure: No Makefile for cross-language orchestration](#project-structure-no-makefile-for-cross-language-orchestration)

---

## Issue #13 — Duplicate turn creation / uncoordinated entity storage

**Priority:** 🔴 P0 — Data integrity
**Area:** `context.ts` + `turn.ts` + `ilo-client.ts`
**Fix complexity:** 3 files, ~2 hours

### Root cause

Two separate `ilo.remember()` calls per user interaction, creating two Turn nodes with uncoordinated data:

#### Call 1: `context.ts` (before_provider_request)

```typescript
await ilo.remember({
    query: latestQuery,
    response: result.analysis,       // ← WRONG: this is the 4B model's analysis, not the LLM response
    entities: result.extracted_entities.map(...),  // ← Has entities
    claims: result.extracted_claims.map(...),      // ← Has claims
    turnIndex: 0,                                  // ← Always 0 (never incremented!)
})
```

Rust `/remember` handler sees `is_phase2 = true` (because `response` is present), creates a `Turn(0)` node with entity links — but the "response" stored is the 4B analysis.

#### Call 2: `turn.ts` (turn_end)

```typescript
await ilo.remember({
    query: userText,
    response: responseText,       // ← CORRECT: the actual LLM response
    entities: [],                 // ← Empty! No entity links
    claims: [],                   // ← Empty! No claim links
    turnIndex: state.turnCount++, // ← 1, 2, 3... (correctly incremented)
})
```

Creates a `Turn(1)` node with the real response — but zero entity or claim links.

### Result in the graph

```
Turn(0) ──links to──▶ entity_a, entity_b    (has entities, wrong response)
Turn(1) ──links to──▶ (nothing)              (has correct response, no entities)
```

Entities exist in the graph (from call 1) but are orphaned from the real turn (call 2).

### The `all_entities` escape hatch

The Rust handler has an `all_entities: Option<Vec<String>>` field on `RememberReq` that specifically solves this — it lets you pass entity labels to link to an existing turn without re-creating entities. But **the TypeScript client never sends `all_entities`**.

From `handlers.rs`:

```rust
pub struct RememberReq {
    pub turn_id: Option<String>,
    pub turn_index: Option<u32>,
    pub query: String,
    pub response: Option<String>,
    pub entities: Option<Vec<EntityInput>>,
    pub claims: Option<Vec<ClaimInput>>,
    pub all_entities: Option<Vec<String>>,   // ← EXISTS but never sent!
    pub model: Option<String>,
    pub tokens_in: Option<u32>,
    pub tokens_out: Option<u32>,
    pub duration_ms: Option<u64>,
}
```

### Fix plan

1. **Add `allEntities` to the TS `remember` method** in `ilo-client.ts`
2. **`context.ts`**: Replace `ilo.remember()` with `ilo.createEntities()` to store entity nodes without creating a turn. Save extracted entity labels to `globalThis.__pendingEntityLabels`.
3. **`turn.ts`**: Call `ilo.remember()` with `allEntities: __pendingEntityLabels` to create the turn with entity links.

Or a simpler variant:

- `context.ts`: Store entity labels on `globalThis`, don't call `ilo.remember()` at all
- `turn.ts`: Call `ilo.remember()` with `entities` and `claims` populated from the saved labels

### Files to change

- `.pi/extensions/core/lib/ilo-client.ts` — Add `allEntities` param to `remember()`
- `.pi/extensions/core/events/context.ts` — Remove `ilo.remember()` call, save labels
- `.pi/extensions/core/events/turn.ts` — Pass saved labels to `ilo.remember()`

---

## Issue #7 — Binary threshold scoring vs composite formula

**Priority:** 🟡 P1 — Context quality
**Area:** `context.ts` + `context-rebuild-llm.ts`
**Fix complexity:** 1 file, ~30 lines

### Current behavior

```typescript
// 4B model scores each chunk 0.0-1.0 (separate API call)
const modelScores = await scoreChunksWith4BModel(chunkInfo, latestQuery);

// Binary threshold: score < 0.5 = eviction candidate, nothing else matters
const droppable = scored
    .filter((s) => !alwaysKeep.has(s.idx) && s.score < 0.5)
    .sort((a, b) => a.score - b.score);

// Drop lowest until under budget
for (const s of droppable) {
    toDrop.add(s.idx);
    const remaining = updatedMsgs.filter((_: any, i: number) => !toDrop.has(i));
    if (estimateTokens(remaining) <= BUDGET) break;
}
```

### What's missing

| Missing component | Effect | When it hurts |
| --- | --- | --- |
| **Recency** | A chunk from 1 minute ago has same standing as one from 1 hour ago with same model score | Long sessions where recent context is disproportionately important |
| **Entity overlap** | Chunks mentioning entities in the current query get no boost | Topic shifts — old context about the same topic should persist longer |
| **Fallback scoring** | No scoring = no eviction at all = budget blow | When the 4B model is unavailable or slow |

### Design doc formula (never implemented)

```
score = 0.5 × model_score + 0.3 × recency + 0.2 × entity_overlap
```

### Fix plan

Add a composite scoring function that doesn't require additional API calls:

```typescript
function computeFinalScore(
    modelScore: number,
    chunkIndex: number,        // proxy for recency (higher index = more recent)
    totalChunks: number,
    queryWords: string[],      // from the user query
    chunkPreview: string,      // available from chunkInfo
): number {
    // 1. Model score (already 0-1, from 4B model)
    const ms = modelScore;

    // 2. Recency: normalize chunk position to 0-1
    const recency = totalChunks > 0 ? chunkIndex / totalChunks : 0;

    // 3. Entity overlap: how many query words appear in this chunk's preview?
    const entityOverlap = queryWords.length > 0
        ? queryWords.filter(w => chunkPreview.toLowerCase().includes(w)).length / queryWords.length
        : 0;

    // Composite formula (from design doc)
    return 0.5 * ms + 0.3 * recency + 0.2 * entityOverlap;
}
```

And when 4B model is unavailable, use a fallback score based solely on recency:

```typescript
const modelScores = _4bAvailable
    ? await scoreChunksWith4BModel(chunkInfo, latestQuery)
    : chunkInfo.map((_, i) => i / chunkInfo.length); // recency-only fallback
```

### File to change

- `.pi/extensions/core/events/context.ts`

---

## Issue #8 — Learning signal uses overlap selection, not explicit labels

**Priority:** 🟡 P1 — Learning quality
**Area:** `turn.ts`
**Fix complexity:** 2 lines

### Current behavior

```typescript
// In turn.ts (turn_end handler):
const extractedLabels: string[] = (globalThis as any).__lastExtractedLabels || [];
if (extractedLabels.length > 0) {
    // OVERLAP SELECTION: only entities mentioned in the response text are "used"
    const usedLabels = extractedLabels.filter((name: string) =>
        responseText.toLowerCase().includes(name.toLowerCase()),
    );
    if (usedLabels.length > 0) {
        await ilo.learn({
            query: userText,
            responseText,
            usedLabels,
            quality: 0.8,
        });
    }
}
```

### The bias problem

The Rust handler correctly uses `LearningSignal::from_explicit()` when `used_labels` is provided. But the **selection** of which labels to pass is done via text overlap on the TypeScript side.

This creates a confirmation bias loop:

1. ILO retrieves entities A, B, C (some relevant, some noise)
2. They're injected into context → LLM sees them
3. LLM response mentions A, B, C (because they were in the context)
4. Overlap filter says: "A, B, C were all used!" → strengthens all of them
5. Next query retrieves A, B, C again (they were strengthened)
6. The system never learns which entities were ACTUALLY useful

### Fix

Remove the overlap filter. All entities the 4B model extracted from the query are relevant. They ALL contributed to framing the response, regardless of whether the LLM repeated their names.

```typescript
// All 4B-extracted entities are relevant to this query — use them all
const usedLabels = extractedLabels;  // ← filter removed
```

This is a 2-line change.

### File to change

- `.pi/extensions/core/events/turn.ts` — Remove `.filter()` on `extractedLabels`

---

## Issue #12 — Hardcoded 4B model ID ("default")

**Priority:** 🟢 P2 — Fragility
**Area:** `context-rebuild-llm.ts`
**Fix complexity:** 5 lines, ~15 min

### Current behavior

```typescript
// In context-rebuild-llm.ts:
const _4B_MODEL = process.env.ILO_4B_MODEL || "default";
//                                          ^^^^^^^
// This "default" is sent as the model ID in API calls to the 4B server
```

Every API call to `http://127.0.0.1:1236/v1/chat/completions` includes:

```json
{ "model": "default", ... }
```

Meanwhile, in `index.ts`, pi discovers the actual model ID from the server:

```typescript
const { data } = await res.json();
for (const m of data) {
    models.push({ id: m.id, ... });  // e.g., "qwen3.5-35b-a3b-Q4_K_M"
}
```

### Why it mostly works

Most OpenAI-compatible servers (including llama.cpp) accept any model ID and use whatever model is loaded. So `"default"` works in practice.

### Why it's fragile

1. If multiple models are loaded on different ports, the 4B request could be routed to the wrong model
2. If the server is strict about model IDs, it returns 400 Bad Request
3. The `is4BModelAvailable()` function already fetches `/v1/models` — it has the real ID but throws it away

### Fix

```typescript
// Module-level cache for the real model ID
let _4bModelId: string | null = null;

export async function is4BModelAvailable(): Promise<boolean> {
    try {
        const res = await fetch(`http://127.0.0.1:${_4B_PORT}/v1/models`, {
            signal: AbortSignal.timeout(2000),
        });
        if (!res.ok) return false;
        // Capture the actual model ID from the server response
        const data = await res.json() as { data?: Array<{ id: string }> };
        if (data?.data?.[0]?.id) {
            _4bModelId = data.data[0].id;
        }
        return true;
    } catch {
        return false;
    }
}

// Helper: get the model ID to use in API calls
function getModelId(): string {
    return _4bModelId || process.env.ILO_4B_MODEL || "default";
}
```

Then replace all uses of `_4B_MODEL` with `getModelId()`.

### File to change

- `.pi/extensions/core/lib/context-rebuild-llm.ts`

---

## Issue #9 — No pinned/stable memory tier

**Priority:** 🟢 P2 — Cross-session persistence
**Area:** `retrieval.rs` (Rust) + optional `context.ts`
**Fix complexity:** 10 lines Rust, optional 5 lines TS

### Gap A: Retrieval doesn't boost important entities

The `find_seeds` function in `retrieval.rs` only finds entities matching query words. If the query is "fix login", entities about "deployment pipeline" won't be found — even if they're high-confidence cross-session entities.

**Fix (Rust side):** Always include the "user" entity in seed results:

```rust
// In find_seeds(), after all phases:
// Always include the "user" entity for identity persistence across sessions
if let Ok(nodes) = store.find_nodes(&NodeQuery {
    type_: Some(NodeType::Entity),
    tags: vec!["user".into()],
    label_contains: Some("user".into()),
    limit: 1,
}).await {
    if let Some(user) = nodes.first() {
        seeds.push(Seed {
            node_id: user.id.clone(),
            match_score: 1.0,
            label: user.label.clone(),
        });
    }
}
```

### Gap B: Context eviction treats all chunks equally

The design doc described a "Stable Memory" tier (~2K tokens of high-confidence entities that are never evicted). Currently, everything competes equally.

**Fix (optional TS side):** Add a `priority` check to the alwaysKeep set:

```typescript
// Also keep any "pinned" memory messages
updatedMsgs.forEach((msg, i) => {
    if (msg.customType === "ilo_memory" && (msg as any).priority === "high") {
        alwaysKeep.add(i);
    }
});
```

But — is this actually needed? The design doc says "Everything competes equally, momentum decides relevance" deliberately. The user entity survives in ILO's graph regardless. This issue is lower priority.

### Files to change

- `mem-arch/src/retrieval.rs` — Add user entity to seed results
- `.pi/extensions/core/events/context.ts` — Optional: priority eviction protection

---

## Rust Sidecar: Dead code (`handlers::status`)

**Priority:** 🟢 P2 — Cleanliness
**Area:** `handlers.rs`
**Fix complexity:** Delete 12 lines

### Current state

`handlers.rs` has a `status` function at line 20 that is **never registered in the router**. The router uses `crud::status` at line 31 instead.

### Details

From `router.rs`:

```rust
.route("/status", get(crud::status))           // ← registered: crud::status
// handlers::status is NOT in router.rs anywhere
```

The old `handlers::status` (12 lines) returns `{ status, version, db_connected, uptime_secs }`.

The new `crud::status` (~25 lines) returns `{ status, version, uptime_secs, counts: { entities, claims, turns, links } }`.

`crud::status` is a superset — it adds entity/claim/turn/link counts. The old function is strictly worse.

### Fix

**Delete** lines 20-31 from `handlers.rs` (the `pub async fn status` function).

### File to change

- `mem-arch/src/server/handlers.rs` — Delete function

---

## Rust Sidecar: Blocking `embed()` without async signal

**Priority:** 🟢 P2 — Footgun prevention
**Area:** `embed.rs`
**Fix complexity:** Rename + doc comment, ~5 min

### Current state

```rust
// embed.rs — module-level public function
pub fn embed(text: &str, is_query: bool) -> Option<Vec<f32>> {
    // ... BLOCKING: ureq::post(EMBED_URL).send(body_str)...
    // No async, no timeout configurable from outside
}
```

### Usage analysis

All 4 call sites correctly wrap in `spawn_blocking`:

| Call site | File | Pattern |
| --- | --- | --- |
| Line 59 | `crud.rs` | `tokio::task::spawn_blocking(move \|\| { embed(...) })` |
| Line 710 | `crud.rs` | `tokio::task::spawn_blocking(move \|\| { embed(...) })` |
| Line 57 | `handlers.rs` | `tokio::task::spawn_blocking(move \|\| { embed(...) })` |
| Line 393 | `handlers.rs` | `tokio::task::spawn_blocking(move \|\| { embed(...) })` |

The pattern is **correct** but **fragile** — a future developer calling `embed()` directly from an async context would block the tokio runtime (1-4 threads serving all HTTP requests).

### Fix options

| Option | Effort | Upside |
| -------- | :------: | -------- |
| Rename to `embed_blocking()` + doc comment | 5 min | Type-level signal. No behavior change. |
| Switch to `reqwest` (async HTTP) | 2 hrs | True async, no `spawn_blocking` needed. Adds heavy dep. |
| Keep as-is + `#[doc(hidden)]` | 2 min | Prevents IDE discovery. No code change. |

**Recommendation:** Rename to `embed_blocking()` + update doc comment + add doc note. This matches Rust conventions for blocking variants (e.g., `std::sync::Mutex::lock()` vs async alternatives). Also add `embed_batch_blocking()`.

### File to change

- `mem-arch/src/embed.rs` — Rename both `embed` and `embed_batch` to `_blocking` suffix

---

## Rust Sidecar: Crate naming confusion (package=ilo, lib=mem_arch)

**Priority:** 🔵 P3 — Consistency
**Area:** `Cargo.toml`
**Fix complexity:** 1 line, ~5 min

### Current state

```toml
[package]
name = "ilo"              # Package name (what cargo publish sees)

[lib]
name = "mem_arch"          # Library name (what `use` statements see)
path = "src/lib.rs"

[[bin]]
name = "ilo"               # Binary name (what cargo run builds)
path = "src/main.rs"
```

Current imports look like:

```rust
use mem_arch::types::NodeType;
use mem_arch::store::Store;
```

The directory is `mem-arch/`, the package is `ilo`, the lib is `mem_arch`, the binary is `ilo`. This creates confusion:

- Is the crate called "ilo" or "mem-arch" or "mem_arch"?
- If someone publishes to crates.io, users install `cargo add ilo` but import with `use mem_arch::...`
- The `Cargo.lock` and `Cargo.toml` refer to "ilo" but the source uses "mem_arch"

### Fix options

**Option A: Align to directory** (minimal change)

```toml
[package]
name = "mem-arch"           # matches directory
```

Lib stays `mem_arch` (Rust convention: lib must use underscores). Binary stays `ilo`.

**Option B: Use "ilo" consistently** (cleaner)

```toml
[package]
name = "ilo"

[lib]
name = "ilo"                # import as `ilo::types::NodeType`
```

But this requires renaming `mem-arch/` directory to `core/` or keeping the mismatch.

**Recommendation:** Option A. Make package name match directory. Minimal disruption.

### File to change

- `mem-arch/Cargo.toml` — Change `name = "ilo"` to `name = "mem-arch"`

---

## Rust Sidecar: Large file `crud.rs` (783 lines)

**Priority:** 🔵 P3 — Maintainability
**Area:** `crud.rs`
**Fix complexity:** Split into 4 files, ~30 min

### Current state

| File | Lines | Concern |
|------|:-----:|---------|
| `crud.rs` | **783** | All REST CRUD handlers + status + helper |

For comparison, Rust convention keeps files under 400-500 lines. Splitting would improve maintainability when working on individual resources.

### Proposed split

```
crud.rs (783 lines)  →
  ├── entity_handlers.rs  (~250 lines) — create_entities, search, get, update, delete
  ├── claim_handlers.rs   (~100 lines) — create, get, update, delete
  ├── link_handlers.rs    (~100 lines) — create, update, delete
  ├── batch.rs            (~200 lines) — batch endpoint
  └── status.rs           (~30 lines)  — status endpoint
```

### server/mod.rs changes

Need to update `mod.rs` to declare the new modules and re-export them.

**Recommendation:** Only split if you're actively working on these endpoints. For now, document the split plan.

---

## Rust Sidecar: `resolve_entity_store` thin wrapper duplication

**Priority:** 🔵 P3 — Code smell
**Area:** `crud.rs`
**Fix complexity:** Delete wrapper, update call sites

### Current state

`crud.rs` has a separate `resolve_entity_store` function (line 779) that wraps `helpers::resolve_entity`:

```rust
async fn resolve_entity_store(
    store: &mem_arch::ladybug::LadybugStore,
    label: &str,
) -> Option<String> {
    super::helpers::resolve_entity(store, label).await  // ← identical call
}
```

This exists because the batch endpoint (lines 460-470) works with `LadybugStore` directly (not `dyn Store`), so it can't call helpers that take `&dyn Store`. The function is just a thin wrapper to satisfy the type checker.

### Fix

- Change the batch endpoint to use `&dyn Store` instead of `&LadybugStore`
- Delete `resolve_entity_store`
- Use `helpers::resolve_entity` directly

### File to change

- `mem-arch/src/server/crud.rs` — Remove wrapper, fix batch endpoint signature

---

## Rust Sidecar: `extract.rs` is 680 lines of mostly dead code

**Priority:** 🔵 P3 — Dead weight
**Area:** `extract.rs`
**Fix complexity:** Mark as deprecated or delete

### Current state

The heuristic extractor at `extract.rs` (680 lines) is **never called by the extension**. All extraction goes through the 4B model. The only call site is in `handlers.rs`:

```rust
// handlers.rs line 367 (in the /extract endpoint handler):
mem_arch::extract::extract(&req.content, &graph)
```

This `/extract` endpoint is exposed by the extension's `ilo.extract()` method — but the extension **never calls it**. The extension uses the 4B model via `analyzeWith4BModel()` instead.

### Options

1. **Mark as deprecated**: Add `#[deprecated(note = "Use 4B model extraction instead")]` — keeps it as last-resort fallback
2. **Remove entirely**: The 4B model provides significantly better extraction
3. **Keep as-is**: It's a fallback for direct API users who don't have a 4B model

**Recommendation:** Mark as `#[deprecated]` with a clear note. Don't delete — it's a valid fallback for API users without a 4B model.

### File to change

- `mem-arch/src/extract.rs` — Add deprecation attribute to `pub fn extract()`

---

## Rust Sidecar: No CI/lint config (clippy, rustfmt, CI)

**Priority:** 🔵 P3 — Process
**Area:** Project root
**Fix complexity:** 3 new config files, ~30 min

### Missing items

1. **No `clippy.toml`** — No custom lint configuration
2. **No `rustfmt.toml`** — No custom formatting rules
3. **No GitHub Actions** — No CI pipeline (no `cargo test` on push, no clippy checks)
4. **No `deny.toml`** — No dependency audit

### Recommended additions

**`clippy.toml`** at project root:

```toml
# clippy.toml
min_rust_version = "1.75"
allow = ["module_inception"]
too-many-arguments-threshold = 6
```

**`.github/workflows/ci.yml`:**

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions-rust-lang/setup-rust-toolchain@v1
      - run: cargo test --manifest-path mem-arch/Cargo.toml
      - run: cargo clippy --manifest-path mem-arch/Cargo.toml -- -D warnings
```

**Fix:** Add these files when setting up the project for CI.

---

## Rust Sidecar: No benches/ directory for performance benchmarks

**Priority:** 🔵 P3 — Performance tracking
**Area:** `mem-arch`
**Fix complexity:** New directory + criterion, ~1 hour

### Current state

- ✅ Comprehensive **tests** in `mem-arch/tests/` (6 test files)
- ❌ No **benchmarks** in `mem-arch/benches/`

For performance-critical code (retrieval, search index, learning), criterion benchmarks would help track regressions.

### Recommended structure

```
mem-arch/benches/
├── retrieval_bench.rs     — PPR traversal under various graph sizes
├── search_bench.rs        — FTS + vector search at 100, 1000, 10000 nodes
└── learning_bench.rs      — Weight computation at scale
```

**Fix:** Add when performance becomes a concern.

---

## Project Structure: Dual `var/` directories

**Priority:** 🟢 P2 — Cleanliness
**Area:** Project root
**Fix complexity:** Delete 1 directory

### Current state

| Directory | Size | Contents | Status |
|-----------|:----:|----------|--------|
| `var/` | **12 MB** | `ilo_data.lbug`, `embed.log`, `ilo.lock`, `ilo.pid` | **Active** — used by extension's `ILO_DB_PATH=../var/ilo_data.lbug` |
| `mem-arch/var/` | **20 KB** | `ilo_data.lbug`, `ilo.lock`, `ilo.pid`, `ilo.sock` | **Stale** — Rust binary's default CWD when run from `mem-arch/`, but extension overrides the path |

The Rust binary defaults to `./var/ilo_data.lbug` (relative to CWD). When the extension starts it, CWD is the project root → it writes to `mem-arch/var/`. But the extension passes `ILO_DB_PATH=../var/ilo_data.lbug` which overrides to root `var/`. So `mem-arch/var/` is always stale.

### Fix

1. **Delete** `mem-arch/var/` directory
2. **Optionally add** `mem-arch/var/` to `.gitignore` if the Rust binary might be run directly from `mem-arch/`

### Files to change

- `mem-arch/var/` — Delete directory
- `.gitignore` — Optional: add `mem-arch/var/`

---

## Project Structure: Nested git repo (Qwen3.6 model config)

**Priority:** 🟢 P2 — Git cleanliness
**Area:** Project root
**Fix complexity:** 2 options, ~5 min each

### Current state

```
Qwen3.6-35B-A3B-MTPLX-Optimized-Speed/
└── .git/                    ← separate git repository!
```

This creates constant `git status` noise:

```
$ git status
    m Qwen3.6-35B-A3B-MTPLX-Optimized-Speed
```

### Fix options

**Option A: Remove the nested .git** (model config becomes tracked content)

```bash
rm -rf Qwen3.6-35B-A3B-MTPLX-Optimized-Speed/.git
```

**Option B: Ignore the directory entirely** (model lives independently)

```
echo "Qwen3.6-35B-A3B-MTPLX-Optimized-Speed/" >> .gitignore
```

**Recommendation:** Option B. This model config is a separate published artifact. No need to track it in the ILO repo.

### Files to change

- `.gitignore` — Add `Qwen3.6-35B-A3B-MTPLX-Optimized-Speed/`

---

## Project Structure: Orphan root-level stale files

**Priority:** 🔵 P3 — Cleanliness
**Area:** Project root
**Fix complexity:** Move/delete 8 files, ~15 min

### File inventory

| File | Type | Status | Action |
| ------ | ------ | -------- | -------- |
| `ARCHITECTURE.md` | Documentation | **Stale** — describes old LinkType enum (8-value) that no longer exists | Move to `docs/archive/architecture-v0.1.md` |
| `sliding-context-benchmark.md` | Design spec | Design artifact | Move to `docs/design/` |
| `sliding-context-window-comparison.md` | Design spec | Design artifact | Move to `docs/design/` |
| `sliding-format-spec.md` | Design spec | Design artifact | Move to `docs/design/` |
| `test-context-hook.ts` | Test file | **Orphan** — not in a test directory | Delete or move to `pi-extension/test/` |
| `test-context-hook-2.ts` | Test file | **Orphan** — same, likely a variant | Delete or move to `pi-extension/test/` |
| `cv/` directory | Personal | **Not project-related** | Consider moving outside repo |
| `outputs/` directory | CLI tuning outputs | **Artifacts** | Move to `benchmark/outputs/` or add to `.gitignore` |

---

## Project Structure: Design docs scattered across 3+ locations

**Priority:** 🔵 P3 — Documentation
**Area:** `design/` + `mem-arch/docs/` + top-level `ARCHITECTURE.md` + `sliding-*.md`
**Fix complexity:** Consolidate into single `docs/` directory, ~1 hour

### Current locations

| Location | Contents | Purpose |
| ---------- | ---------- | --------- |
| `design/` (7 files) | `context-attention-model.md`, `context-rebuild-architecture.md`, etc. | Old design specs |
| `design/final/` (4 files) | `01-architecture-overview.md`, `02-context-rebuild-system.md`, etc. | Current design docs |
| `mem-arch/docs/` (6 files) | `ALGORITHM_SPEC.md`, `FAILURE_POINTS.md`, `SYSTEM_ARCHITECTURE.md`, etc. | Rust crate documentation |
| Root `ARCHITECTURE.md` | Full system architecture | **Stale** — references old link types |
| Root `sliding-*.md` | `sliding-context-benchmark.md`, etc. | Context window research |

### Proposed consolidated structure

```
docs/
├── architecture.md                  ← Single source of truth (current system)
├── retrieval.md                     ← 3-factor PPR algorithm
├── learning.md                      ← Hebbian learning formula
├── scoring.md                       ← Context scoring formula
├── graph-schema.md                  ← Node types, link types, properties
├── design/                          ← Design artifacts (preserved for reference)
│   ├── archive/                     ← Stale versions of architecture docs
│   └── research/                    ← Context window research, sliding window specs
├── rust/                            ← Rust crate docs (from mem-arch/docs/)
│   ├── algorithm-spec.md
│   ├── failure-points.md
│   ├── interaction-loop.md
│   └── stress-test.md
└── README.md                        ← Navigation index
```

---

## Project Structure: TOP-LEVEL — The pi-extension lives in a hidden `.pi/` directory

**Priority:** 🟡 P1 — Accessibility
**Area:** Project root
**Fix complexity:** Major — move all files, create settings, ~1-2 hours

### Current state

```
ilo/
└── .pi/extensions/core/             ← Hidden dotfile directory
    ├── index.ts
    ├── events/ { context.ts, turn.ts, input.ts }
    ├── lib/ { ilo-client.ts, ilo-manager.ts, ... }
    └── tools/ { task.ts, diagnostics.ts, ... }
```

**Problems:**

- Hidden directory: `cd .pi/extensions/core` isn't discoverable
- Awkward import paths: `import { ilo } from "../lib/ilo-client"` relative from `.pi/extensions/core/events/`
- Not visible in `ls` or project tree at a glance
- Can't be `npm install`-ed as a standalone package
- No `package.json` (dependencies declared in root `package.json`)

### Proposed state

```
ilo/
├── pi-extension/                    ← Visible top-level directory
│   ├── package.json                 ← With pi manifest
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts
│   │   ├── events/
│   │   ├── pipeline/
│   │   ├── client/
│   │   ├── lifecycle/
│   │   └── tools/
│   └── test/
├── .pi/
│   └── settings.json                ← { "packages": ["../pi-extension"] }
├── mem-arch/                        ← Unchanged
├── ...
```

Pi discovers the extension via `.pi/settings.json` pointing to the local package. No files in `.pi/extensions/`.

### The two approaches

**Approach A: Pi Package** (recommended)

- `pi-extension/package.json` has `{ "pi": { "extensions": ["./src/index.ts"] } }`
- `.pi/settings.json` has `{ "packages": ["../pi-extension"] }`
- Pi loads it as a proper package
- Versionable, installable, filterable

**Approach B: Settings extensions path** (simpler)

- `.pi/settings.json` has `{ "extensions": ["../pi-extension/src/index.ts"] }`
- No package.json manifest needed
- Simpler setup, but not a real package

**Recommendation:** Approach A (Pi Package). It's what pi packages are designed for. The `with-deps` example in pi's examples shows exactly this pattern.

### Files to change

- **Create** `pi-extension/package.json`
- **Create** `.pi/settings.json`
- **Create** `pi-extension/src/` with subdirectories
- **Move** all files from `.pi/extensions/core/` into new structure
- **Delete** `.pi/extensions/core/`

---

## Project Structure: Extension internal organization — `context.ts` is bloated

**Priority:** 🟡 P1 — Maintainability
**Area:** `.pi/extensions/core/events/context.ts`
**Fix complexity:** Split into 4 files, ~30 min

### Current state

`context.ts` has **4 distinct responsibilities** in one file:

| Lines | Responsibility | What it does |
| :-----: | --------------- | ------------- |
| ~30 | **Module setup** | Imports, constants, helper functions (`extractPreview`, `findLatestUserQuery`, `estimateTokens`) |
| 106-145 | **RECALL** | Calls `ilo.recall()`, injects memory messages into context |
| 148-197 | **SCORE** | Calls `scoreChunksWith4BModel()`, binary threshold eviction |
| 206-247 | **EXTRACT** | Calls `analyzeWith4BModel()`, stores entities/claims via `ilo.remember()` |
| 250-258 | **CONVERT** | Memory → system role conversion |

### Proposed split

```
pi-extension/src/pipeline/
├── recall.ts          ← Step 1: Memory recall (ilo.recall + injection)
├── score.ts           ← Step 2: 4B scoring + composite formula + eviction
├── extract.ts         ← Step 3: 4B entity/claim extraction, store labels
└── convert.ts         ← Step 4: Memory → system role conversion
```

And a coordinator that calls them in sequence:

```typescript
// In index.ts or events/context.ts:
export async function runPipeline(event: any): Promise<void> {
    const msgs = event.payload?.messages;
    if (!msgs || msgs.length === 0) return;

    await recallMemory(msgs);       // Step 1
    await scoreContext(msgs);        // Step 2
    await extractEntities(msgs);     // Step 3
    convertMemoryRoles(msgs);        // Step 4
}
```

Benefits:

- Each step testable in isolation
- Each file under 100 lines
- Fix #13, #7, #8 become isolated changes to single pipeline steps

---

## Project Structure: Dead web tool files in extension (4 files)

**Priority:** 🟢 P2 — Dead code
**Area:** `.pi/extensions/core/lib/web-lib.ts` + `tools/web-search.ts` + `tools/web-scrape.ts` + `tools/web-crawl.ts`
**Fix complexity:** Delete 4 files, ~2 min

### Evidence

From `index.ts`:

```typescript
// Web tools disabled — pi-web-access provides better versions
// import { registerWebSearchTool } from './tools/web-search';
// import { registerWebScrapeTool } from './tools/web-scrape';
// import { registerWebCrawlTool } from './tools/web-crawl';
```

All 4 imports are commented out. None of these tools are registered. The files exist in the codebase but are never loaded.

### Files to delete

- `.pi/extensions/core/lib/web-lib.ts`
- `.pi/extensions/core/tools/web-search.ts`
- `.pi/extensions/core/tools/web-scrape.ts`
- `.pi/extensions/core/tools/web-crawl.ts`

---

## Project Structure: Only Rust tests, no TypeScript tests for extension

**Priority:** 🔵 P3 — Test coverage
**Area:** `pi-extension/`
**Fix complexity:** New `test/` directory with vitest, ~2 hours

### Current state

| Area | Test framework | Test files | Coverage |
| ------ | :-------------: | :----------: | :--------: |
| Rust sidecar (`mem-arch/`) | `cargo test` | 6 files in `tests/` + inline `#[cfg(test)]` in src | ✅ Comprehensive |
| TypeScript extension (`pi-extension/`) | **None** | **0 files** | ❌ None |

### Recommended additions

```
pi-extension/test/
├── pipeline/
│   ├── score.test.ts          — Test composite scoring formula
│   ├── extract.test.ts        — Test entity/claim extraction flow
│   └── recall.test.ts         — Test memory recall injection
├── events/
│   └── turn.test.ts           — Test turn_end handler
└── tools/
    └── memory-tools.test.ts   — Test memory tool implementations
```

Uses `vitest` (already compatible with the extension's TypeScript).

---

## Project Structure: No Makefile for cross-language orchestration

**Priority:** 🔵 P3 — Developer experience
**Area:** Project root
**Fix complexity:** New Makefile, ~30 min

### Current state

No unified command interface. Developers must remember:

- `cd mem-arch && cargo build --release` for Rust
- `cd .pi/extensions/core && ...` — no npm scripts for the extension (it uses root package.json)
- `cd benchmark && python ...` for benchmarks

### Recommended Makefile

```makefile
# ILO Monorepo

.PHONY: all build test clean dev

all: build

# Rust sidecar
build-rust:
 cd mem-arch && cargo build --release

# Dev mode (watch)
dev-rust:
 cd mem-arch && cargo watch -x run

# TypeScript extension
test-ts:
 cd pi-extension && npx vitest run

# Rust tests
test-rust:
 cd mem-arch && cargo test

# All tests
test: test-rust test-ts

# Clean
clean:
 cd mem-arch && cargo clean
 rm -rf var/*.lbug

# Run everything
dev:
 make -j2 dev-rust
```

---

## Executive Summary: Priority-Ordered Execution Plan

### Week 1 — Critical bugs (high impact, low effort)

| Order | Issue | Files | Time |
| :-----: | ------- | ------- | :----: |
| 1 | **#13 Fix**: Add `allEntities` to TS client | `ilo-client.ts` | 15 min |
| 2 | **#13 Fix**: context.ts → store labels only | `context.ts` | 30 min |
| 3 | **#13 Fix**: turn.ts → pass saved labels | `turn.ts` | 15 min |
| 4 | **#8 Fix**: Remove overlap filter | `turn.ts` | 5 min |
| 5 | **#12 Fix**: Auto-detect 4B model ID | `context-rebuild-llm.ts` | 15 min |
| 6 | Delete dead `handlers::status` | `handlers.rs` | 5 min |
| 7 | Delete dead web tool files | 4 files | 2 min |
| 8 | Remove `mem-arch/var/` | directory | 1 min |
| 9 | Add nested repo to `.gitignore` | `.gitignore` | 1 min |

> ✅ **Done**: Issue #23 (duplicate key race condition) — fixed in helpers.rs + handlers.rs

### Week 2 — Quality improvements (moderate effort)

| Order | Issue | Files | Time |
| :-----: | ------- | ------- | :----: |
| 10 | **#7 Fix**: Add composite scoring formula | `context.ts` | 30 min |
| 11 | **#9 Fix**: Add user entity to retrieval seeds | `retrieval.rs` | 15 min |
| 12 | Rename `embed()` to `embed_blocking()` | `embed.rs` + 4 call sites | 15 min |
| 13 | Mark `extract.rs` as deprecated | `extract.rs` | 2 min |

### Week 3 — Restructuring (larger effort)

| Order | Issue | Files | Time |
| :-----: | ------- | ------- | :----: |
| 14 | Create `pi-extension/` package | +`package.json`, +`settings.json` | 30 min |
| 15 | Move extension files to `pi-extension/` | ~12 files | 30 min |
| 16 | Split `context.ts` into `pipeline/` modules | 5 files | 45 min |
| 17 | Consolidate docs into `docs/` | ~15 files | 1 hour |
| 18 | Create Makefile | root | 30 min |

### Later — Nice to have

| Order | Issue | Files | Time |
| :-----: | ------- | ------- | :----: |
| 19 | Fix Cargo.toml naming | 1 line | 5 min |
| 20 | Add CI/lint config | 3 files | 30 min |
| 21 | Add benches/ for performance | +3 files | 1 hour |
| 22 | Add TypeScript tests | +5 files | 2 hours |
| 23 | Remove stale root files | ~8 files | 15 min |
| 24 | Split `crud.rs` by resource | +4 files | 30 min |
| 25 | Remove `resolve_entity_store` wrapper | `crud.rs` | 15 min |

---

## Issue #23 — Duplicate primary key error on entity creation (race condition)

**Priority:** 🔴 P0 — Runtime crash
**Area:** `helpers.rs` + `handlers.rs`
**Fix complexity:** 5 locations, **ALREADY FIXED**

### Root cause

Entity IDs were generated deterministically from entity labels:

```rust
let new_id = format!("e_{}", label_lower.replace(' ', "_"));
// "session history" → "e_session_history"
```

The `/remember` handler checks `resolve_entity()` under a READ lock, then writes under a WRITE lock. Between these two lock acquisitions, a concurrent request can also resolve the same label, find nothing, generate the same ID, and try to create it — causing a LadybugDB primary key violation:

```
ERROR ilo::server::handlers: WRITE BATCH ERROR:
Database error: Found duplicated primary key value e_session_history
```

### Fix applied

Changed all 5 locations that generated deterministic entity IDs to use `uid("e")` (UUID v7):

| Location | File | Changed |
| ---------- | ------ | :-------: |
| Entity mutations builder | `helpers.rs:35` | ✅ `uid("e")` |
| Claim reference entity creation | `helpers.rs:99` | ✅ `uid("e")` |
| `/ingest` source entity | `handlers.rs:186` | ✅ `uid("e")` |
| `/connect` from entity | `handlers.rs:291` | ✅ `uid("e")` |
| `/connect` to entity | `handlers.rs:299` | ✅ `uid("e")` |
| `/entity/update` fallback | `handlers.rs:346` | ✅ `uid("e")` |

This is safe because `resolve_entity()` searches by **label** (not by ID), so entities are still findable regardless of their ID format.
