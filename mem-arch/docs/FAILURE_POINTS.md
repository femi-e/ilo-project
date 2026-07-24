# ILO — Critical Failure Points & Testing Requirements

> Identified from production incidents: WAL corruption, silent tool failures,
> PPR dilution, cache staleness.

---

## 1. Graceful Shutdown & WAL Corruption ⚠️ *INCIDENT*

**What happened**: `kill $(cat pid)` (SIGTERM) during an idle period corrupted the
LadybugDB WAL. On restart, the DB refused to open: *"Checksum verification failed,
the WAL file is corrupted."* All data was lost.

### Root Cause
LadybugDB writes to a WAL (Write-Ahead Log) before checkpointing to the main
`.lbug` file. If the process is killed mid-write — even during an idle period
where no Rust code is running — the WAL can be left in an inconsistent state
that fails checksum verification on replay.

The main `.lbug` file stayed at 4KB (empty schema) while the WAL grew to 52KB
with actual data. After corruption, neither was usable.

### What Needs Testing

| Test | Scenario | Expected |
|------|----------|----------|
| **SIGTERM during idle** | Kill process while no request is being processed | WAL replayable on restart, zero data loss |
| **SIGTERM mid-request** | Kill process during `/remember` write_batch | Either full transaction commits or full rollback — no partial state |
| **SIGTERM mid-cache-sync** | Kill process after DB COMMIT but before `sync_cache()` | DB consistent on restart; cache rebuilt by `warm_cache()` |
| **Kill -9** | Force kill, no signal handler runs | WAL survives fsync; replayable on restart |
| **WAL corruption recovery** | Manually corrupt WAL file | Sidecar should detect corruption and start with empty DB rather than crash-looping |
| **Rapid restart loop** | Kill and restart 10 times in 1 second | No cascading corruption from partial checkpoints |

### Current Protections
- No SIGTERM handler in the Rust sidecar (axum graceful shutdown exists but
  only handles Ctrl+C during `serve()`, not after)
- No WAL size limit or periodic checkpoint
- No corruption detection with automatic recovery (delete WAL, rebuild from cache)

---

## 2. Cache/DB Consistency After Write ⚠️ *DESIGN ISSUE*

**What could happen**: The write path has three steps inside a single function,
but only steps 1-2 are atomic:

```
write_batch():
  1. BEGIN TRANSACTION (DB)     ← atomic
  2. Apply mutations + COMMIT   ← atomic  
  3. sync_cache(&mutations)     ← NOT atomic with above
```

If the process crashes after step 2 but before step 3, the in-memory cache
is stale (missing the new nodes/links). On restart, `warm_cache()` rebuilds
the cache from the DB, which is correct — but for the *current session*,
subsequent reads won't find the data.

If `sync_cache()` panics (e.g., poisoned Mutex), step 2 succeeded but the
cache is corrupted for the rest of the session.

### What Needs Testing

| Test | Scenario | Expected |
|------|----------|----------|
| **Crash after COMMIT** | Fail after step 2, before step 3 | Restart recovers correctly via warm_cache |
| **Panic in sync_cache** | Mutex poison or OOM during cache sync | Error propagates to caller, cache is rebuilt |
| **Concurrent read during write** | Read request arrives between steps 2 and 3 | Reader sees stale cache (missing new data) but doesn't crash |
| **cache vs DB mismatch** | Deliberately corrupt cache (wrong node/link) | Next read should return correct data from DB... but it reads from cache |
| **Tag index desync** | Write creates tagged node, cache sync fails | Tag index doesn't include new node; tag-filtered searches miss it |

### Current Protections
- `warm_cache()` on startup rebuilds everything from DB (fixes crash recovery)
- Mutex lock is held briefly per operation
- No protection against stale cache within a session

---

## 3. Tool Error Handling & Silent Failures ⚠️ *INCIDENT*

**What happened**: The `store` tool passed `Date.now()` (~1.7 trillion) as
`turnIndex: u32` (max ~4.3 billion). Rust serde failed to deserialize the
request. The tool never checked `res.ok` and printed "Stored belief" anyway.
Eight architecture facts silently evaporated.

### Root Cause
Three compounding failures:
1. Type mismatch: JavaScript number → Rust `u32` with no validation layer
2. No error check: `const res = await ilo.remember(...)` → result ignored
3. Misleading response: Hard-coded success message regardless of actual result

### What Needs Testing

| Test | Scenario | Expected |
|------|----------|----------|
| **Type overflow** | Pass values exceeding Rust type limits (u32, u64, i64) | Deserialization fails with clear error |
| **Null / undefined** | Omit required fields from the TypeScript client | Client validates before sending |
| **Socket disconnect** | ILO sidecar dies between request and response | Timeout triggers, error propagates to tool response |
| **All tool error paths** | Every tool checks `res.ok` and returns descriptive error | No tool ever prints success when write failed |
| **Timeout behavior** | UDS socket hangs (e.g., LadybugDB lock held for 30s) | Client times out within 5s, returns error to LLM |
| **Malformed JSON** | Send invalid JSON to Rust server | Server returns 400 with parse error description |

### Current Protections
- `store` and `forget` tools now check `res.ok` (fixed this session)
- Other tools (`search`, `ingest`, `connect`, `project_tree`, `git_*`) — need audit

---

## 4. SearchIndex Not Rebuilt After Write ⚠️ *PERFORMANCE BUG*

**What happens**: The `remember` handler stores data in LadybugDB + caches,
but never rebuilds the in-memory `SearchIndex`. The `ingest` handler **does**
rebuild it. This means:

- Entities stored via `remember` (the main path) are invisible to FTS search
  until the sidecar restarts
- They're only findable via store-backed label matching (Phase 1-2 of retrieval)
- If the entity label doesn't match any query word, it's invisible

### Impact
- FTS is essentially broken for recently stored data
- The SearchIndex becomes more stale over time as more turns accumulate
- Vector search is also affected (embeddings stored but not indexed)

### What Needs Testing

| Test | Scenario | Expected |
|------|----------|----------|
| **FTS consistency** | Store entity via remember, immediately search by label | FTS finds it (not just label match) |
| **Batch write search** | Store 100 entities, search for each | All found via FTS |
| **SearchIndex memory** | Index 10K entities, measure memory usage | Under 50MB |
| **Rebuild cost** | Measure time for SearchIndex::build() with 1K, 10K, 100K nodes | Scales linearly, <1ms for 1K |
| **Incremental merge** | SearchIndex::merge() after single write | Correctly adds new nodes without duplicates |

### Current Protections
- `ingest` handler correctly calls `search_index.write().await.merge(&nodes)`
- `remember` handler does NOT — this is the bug
- On restart, `warm_cache` + `SearchIndex::build` resets everything

---

## 5. PPR Algorithm Edge Cases ⚠️ *ALGORITHMIC BUG*

**What happened**: Hub nodes with many edges (ILO with 15+ incoming links) had
their energy spread so thin by `1/fan` normalization that no connection survived
the 0.02 threshold. A node with 16 edges effectively disappeared from the graph.

**What was fixed**: Weight-aware normalization (`sum_weight` instead of `fan`).

### Remaining Edge Cases

| Test | Scenario | Expected |
|------|----------|----------|
| **Single-node graph** | Only one entity, no links | Returns seed only, no crash |
| **All-zero weights** | All links have weight 0.0 | sum_weight = 0.0 → division by zero → crash |
| **Symmetric bidirectional** | A ↔ B with same weight in both directions | Both nodes found, no double-counting |
| **Deep chain** | A → B → C → D → E → F with max_hops=3 | Stops at D, no crash |
| **Self-loop only** | A → A with weight 1.0 | Filtered by `target == nid`, no infinite loop |
| **Disconnected components** | A → B and C → D (no path between them) | Only the component containing the seed is expanded |
| **Max nodes per hop** | 50 edges from one node, top 8 get through | Lateral inhibition works, no crash |
| **Negative weights** | Link weight = -0.5 | Should be rejected at creation time |
| **NaN propagation** | NaN confidence or weight | Should not crash, but NaN floats in f64 comparisons are unpredictable |
| **label_sim with empty query** | Query is "" after stop word filtering | Returns 0.2 for all, no panic |

---

## 6. Embedding Model Reliability

**What could happen**: The BGE embedding model downloads from HuggingFace Hub
on first call. If the network is unavailable, `get_model()` panics via `expect()`.

| Test | Scenario | Expected |
|------|----------|----------|
| **Offline first call** | No internet when `/embed` is first called | Graceful fallback (return empty vector, skip vector search) |
| **Corrupted model files** | Partial download, safetensors fails to load | Clear error, don't crash the server |
| **OOM on batch** | embed_batch with 1000 texts simultaneously | Returns error, doesn't OOM the process |
| **Concurrent first calls** | Two requests trigger lazy init simultaneously | OnceLock ensures only one init |

---

## 7. Concurrency & Lock Contention

| Test | Scenario | Expected |
|------|----------|----------|
| **RwLock write starvation** | Continuous writes starve readers | Readers get through within timeout |
| **Mutex poisoning in cache** | A panic inside Mutex lock poisons it | Next access returns error, not hangs |
| **Deadlock: write + cache** | Write holds RwLock, tries to acquire cache Mutex | No deadlock (Mutex is independent of RwLock) |
| **Concurrent seq link** | Two turns created simultaneously, both query for "most recent turn" | Only one gets the previous turn; the other gets none (no crash) |

---

## Priority Matrix

| Failure Point | Severity | Likelihood | Detected? | Fix Status |
|--------------|:--------:|:----------:|:---------:|:----------:|
| WAL corruption on kill | 🔴 Data loss | High | ✅ This session | ✅ Fixed |
| Silent tool failures | 🔴 Data loss | High | ✅ This session | ✅ Fixed |
| Cache/DB desync | 🟡 Partial loss | Medium | ❌ | ⏳ Drop + warm_cache |
| SearchIndex staleness | 🟡 FTS broken | High | ✅ This session | ✅ Fixed |
| PPR fanout dilution | 🟡 Graph invisible | Medium | ✅ This session | ✅ Fixed |
| Division by zero (0-sum weights) | 🔴 Crash | Low | ❌ | ✅ Fixed |
| Embedding model panic | 🟡 Server crash | Medium | ❌ | ✅ Fixed |
| Mutex poisoning crash | 🔴 Server crash | Low | ❌ | ✅ Fixed |
| NaN weight/confidence propagation | 🟡 Bug | Low | ❌ | ✅ Fixed |
