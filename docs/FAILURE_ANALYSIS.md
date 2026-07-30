# Failure Analysis

Systematic evaluation of the ILO cognitive runtime against known failure modes from spreading activation theory, Hebbian learning, GraphRAG, and general RAG literature.

---

## 1. Graceful Shutdown & WAL Corruption

**What happened**: A SIGTERM during an idle period corrupted the LadybugDB WAL. On restart, the DB refused to open — checksum verification failed.

### Root Cause

LadybugDB writes to a WAL (Write-Ahead Log) before checkpointing to the main `.lbug` file. If the process is killed mid-write, the WAL can be left inconsistent. The main file stayed at 4KB (empty schema) while the WAL grew to 52KB with actual data. After corruption, neither was usable.

### Testing Requirements

| Test | Scenario | Expected |
| ------ | ---------- | ---------- |
| SIGTERM during idle | Kill process during idle period | WAL replayable, zero data loss |
| SIGTERM mid-request | Kill during `/remember` write | Full commit or full rollback — no partial state |
| Kill -9 | Force kill, no signal handler runs | WAL survives fsync; replayable on restart |
| WAL corruption recovery | Manually corrupt WAL file | Detect corruption, start with empty DB |

### Current Protections

- No SIGTERM handler (axum graceful shutdown handles Ctrl+C only)
- No WAL size limit or periodic checkpoint

---

## 2. Cache/DB Consistency After Write

**What could happen**: The write path has three steps but only steps 1-2 are atomic:

```
write_batch():
  1. BEGIN TRANSACTION (DB)     ← atomic
  2. Apply mutations + COMMIT   ← atomic
  3. sync_cache(&mutations)     ← NOT atomic with above
```

If the process crashes after step 2 but before step 3, the in-memory cache is stale. On restart, `warm_cache()` rebuilds from the DB, which is correct — but for the current session, subsequent reads won't find the data.

### Testing Requirements

| Test | Scenario | Expected |
| ------ | ---------- | ---------- |
| Crash after COMMIT | Fail after step 2, before step 3 | Restart recovers via warm_cache |
| Panic in sync_cache | Mutex poison during cache sync | Error propagates, cache rebuilt |
| Concurrent read during write | Read between steps 2 and 3 | Stale cache but no crash |
| Tag index desync | Write creates tagged node, cache sync fails | Tag-filtered searches miss it |

### Current Protections

- `warm_cache()` on startup rebuilds everything from DB
- Mutex lock held briefly per operation

---

## 3. Tool Error Handling & Silent Failures

**What happened**: The `store` tool passed `Date.now()` (~1.7 trillion) as `turnIndex: u32` (max ~4.3 billion). Rust serde failed to deserialize. The tool never checked `res.ok` and printed "Stored belief" anyway. Data silently disappeared.

### Root Cause

1. Type mismatch: JavaScript number → Rust `u32` with no validation layer
2. No error check: result was ignored
3. Misleading response: hard-coded success message

### Testing Requirements

| Test | Scenario | Expected |
| ------ | ---------- | ---------- |
| Type overflow | Pass values exceeding Rust type limits | Deserialization fails with clear error |
| Null / undefined | Omit required fields | Client validates before sending |
| Socket disconnect | Sidecar dies between request and response | Timeout triggers, error propagates |
| All tool error paths | Every tool checks response status | No tool ever prints success when write failed |
| Timeout behavior | Slow database lock | Client times out, returns error |

### Current Protections

- All tools now check response status (fixed after incident)

---

## 4. SearchIndex Not Rebuilt After Write

**What happens**: The `remember` handler stores data but never rebuilds the in-memory `SearchIndex`. The `ingest` handler does rebuild it. Entities stored via `remember` are invisible to FTS search until the sidecar restarts.

### Impact

- FTS is broken for recently stored data
- SearchIndex becomes more stale as turns accumulate

### Testing Requirements

| Test | Scenario | Expected |
| ------ | ---------- | ---------- |
| FTS consistency | Store entity, immediately search by label | FTS finds it |
| Batch write search | Store 100 entities, search for each | All found via FTS |
| Incremental merge | Merge after single write | Correctly adds without duplicates |

### Current Protections

- `ingest` handler correctly rebuilds SearchIndex
- `remember` handler does NOT — this is the bug

---

## 5. PPR Algorithm Edge Cases

**What happened**: Hub nodes with many edges (15+ incoming links) had energy spread so thin by `1/fan` normalization that no connection survived the threshold. A node with 16 edges effectively disappeared from the graph.

**Fix**: Weight-aware normalization (`sum_weight` instead of `fan`).

### Remaining Edge Cases

| Test | Scenario | Expected |
| ------ | ---------- | ---------- |
| Single-node graph | Only one entity, no links | Returns seed only, no crash |
| All-zero weights | All links have weight 0.0 | No division by zero |
| Symmetric bidirectional | A ↔ B with same weight both directions | Both found, no double-counting |
| Deep chain | A → B → C → D → E, max_hops=3 | Stops at D, no crash |
| Self-loop only | A → A with weight 1.0 | Filtered, no infinite loop |
| Disconnected components | A → B and C → D (no path) | Only seed component expanded |
| NaN propagation | NaN confidence or weight | Handled gracefully |

---

## 6. Embedding Model Reliability

| Test | Scenario | Expected |
| ------ | ---------- | ---------- |
| Offline first call | No internet when `/embed` first called | Graceful fallback (empty vector) |
| Corrupted model files | Partial download fails to load | Clear error, don't crash server |
| OOM on batch | 1000 texts simultaneously | Return error, don't OOM process |

---

## 7. Spreading Activation Failure Modes

### 7.1 Infinite Propagation Loop

| | |
| --- | --- |
| **Description** | Cycles cause activation to circulate forever (A → B → C → A) |
| **Severity** | Critical |
| **Likelihood** | Likely — graphs naturally have cycles |
| **Research** | Standard spreading activation literature requires a **fired set** |

**ILO's approach:** A fired set prevents re-activation of already-visited nodes. Standard in spreading activation literature.

### 7.2 Energy Dilution Through High-Degree Nodes

| | |
| --- | --- |
| **Description** | Hub nodes with many edges distribute energy too thinly |
| **Severity** | Medium |
| **Likelihood** | Likely in growing graphs |
| **Research** | Weighted fan-out normalization is the standard mitigation |

**ILO's approach:** Weight-aware normalization using `sum_weight` instead of raw `fan`.

### 7.3 Activation Overshoot

| | |
| --- | --- |
| **Description** | Too many nodes activated in early hops drowns the signal |
| **Severity** | Medium |
| **Likelihood** | Possible in dense graphs |
| **Research** | Lateral inhibition is the standard biological mechanism |

**ILO's approach:** Lateral inhibition — top M nodes survive, rest are suppressed.

---

## Priority Matrix

| Failure Point | Severity | Likelihood | Status |
| -------------- | :--------: | :----------: | :------: |
| WAL corruption on kill | Data loss | High | Monitor |
| Silent tool failures | Data loss | High | Fixed |
| Cache/DB desync | Partial loss | Medium | Fixed |
| SearchIndex staleness | FTS broken | High | Bug |
| PPR fanout dilution | Graph invisible | Medium | Fixed |
| Division by zero (0-sum weights) | Crash | Low | Fixed |
| Embedding model panic | Server crash | Medium | Fixed |
| Infinite propagation loop | Never terminates | Likely | Fixed |
| NaN weight/confidence propagation | Bug | Low | Fixed |
| Energy dilution through hubs | Invisible nodes | Likely | Fixed |
