# ILO Retrieval & Learning Loops — Stress Test

Systematic evaluation of the ILO cognitive runtime design against known failure
modes from spreading activation theory, Hebbian learning, GraphRAG, and general
RAG literature.

---

## Threat Model

Each failure mode is assessed as:

- **Severity**: Critical / High / Medium / Low
- **Likelihood**: Certain / Likely / Possible / Unlikely
- **Mitigation**: How ILO addresses it (or doesn't)
- **Residual Risk**: What remains unmitigated

---

## 1. Spreading Activation Failure Modes

### 1.1 Infinite Propagation Loop

| | |
|---|---|
| **Description** | Cycles in the graph cause activation to circulate forever. Node A → B → C → A, energy keeps flowing. |
| **Severity** | Critical — would never terminate |
| **Likelihood** | Likely — graphs naturally have cycles (alice↔turn↔alice) |
| **Research** | Wikipedia: "Variations permit repeated firings and loops through the graph, terminating after a steady state is reached or max iterations exceeded." |

**ILO's exposure:** Our current design does NOT prevent re-activation of already-fired nodes. In the test harness, cycles exist (anxiety→t140→anxiety) and the algorithm repeatedly re-activates nodes on each hop because it spreads from ALL currently activated nodes, not just newly-activated ones.

**Mitigation:** Add a **fired set** — never propagate from a node more than once per retrieval. Standard in spreading activation literature. Add after propagation, before next hop:

```rust
let fired: HashSet<NodeId> = activation.keys().cloned().collect();
// Only propagate from nodes NOT in the fired set
```

**Test:** The harness already shows this problem — in Test A, hop 2 re-activates anxiety (0.1127) from t140, and hop 3 does it again. This is wasted computation. Adding the fired set cuts hop-2+ computation in half.

**Residual risk:** None — standard fix, well understood.

### 1.2 Hub Node Domination (The "Paris Problem")

| | |
|---|---|
| **Description** | A highly-connected node (e.g., "Paris" in a geography graph) absorbs all activation because it's linked to everything. Every query that touches any geographic concept floods "Paris" with energy. |
| **Severity** | High — drowns out legitimate deep answers |
| **Likelihood** | Likely — real graphs have power-law degree distributions |
| **Research** | Collins & Loftus (1975) identified the **fan effect**: nodes with many connections dilute activation across all of them. Our current code addresses this with `fan` division. But the real risk is that a hub node itself becomes over-activated because it receives energy from MANY incoming paths. |

**ILO's exposure:** Our fan-out division only helps OUTGOING edges. A hub node with high in-degree (many nodes link TO it) will accumulate energy from all those incoming paths. The hub itself becomes overly activated even when it's not relevant.

**Example:** Entity "Alice" has 100 incoming LINK:ref from 100 different turns. Query "weather" accidentally activates one turn that references Alice. Alice gets activation from that turn. But Alice also gets activation from 99 other turns in subsequent hops because all of them point to Alice. Alice dominates the context even though she's not relevant to "weather".

**Mitigation:** Apply fan attenuation to INCOMING edges too. Each target node should divide its incoming activation by its in-degree:

```rust
// Accumulate raw activation
next[target] += propagated;

// AFTER all propagation for this hop, attenuate by in-degree
for (target_id, energy) in &next {
    let in_degree = incoming_links(target_id).len();
    next[target_id] = energy / (1.0 + (in_degree as f64).sqrt() * 0.1);
}
```

This is a **soft in-degree penalty** — a node with 100 incoming links has its activation damped by ~50%, while a node with 4 incoming links is barely affected.

**Residual risk:** Medium — optimal damping factor needs tuning per dataset.

### 1.3 Energy Vanishing (Shallow Retrieval Trap)

| | |
|---|---|
| **Description** | After 3-4 hops, activation drops below threshold. Deep answers are never reached. |
| **Severity** | High — makes multi-hop reasoning impossible |
| **Likelihood** | Certain — mathematically guaranteed with fan-out and decay |
| **Research** | Wikipedia: "Most often weights decay as activation propagates." Synapse paper: found the same issue and uses lateral inhibition sparingly at depth. Our own harness confirmed this — answer at depth 4 had activation 0.0114, barely above threshold. |

**ILO's exposure:** Our default MAX_HOPS=4 and ACTIVATION_THRESHOLD=0.005 means depth-4 answers barely survive. With larger graphs (more fan-out), depth-4 answers would die.

**Mitigation (two options):**
1. **Increase MAX_HOPS** — but this adds noise and computation
2. **Recursive seeding** — at hop 3, take the top activated node and start a NEW propagation from it as a fresh seed. This effectively resets the energy budget for deep search.

```rust
if hop == 3 && !found_answer {
    let best = get_highest_activation_at_depth(hop);
    // Fork: run a new propagation from best, parallel to existing
    let deeper = spread_activation(graph, &[(best.id, best.confidence)], 2, ...);
    merge_results(&mut results, deeper);
}
```

This is **recursive retrieval** — a depth-2 search from a depth-3 node reaches depth 5 with full energy, not attenuated energy.

**Residual risk:** Medium — recursive retrieval doubles computation. Use sparingly.

---

## 2. Hebbian Learning Failure Modes

### 2.1 Catastrophic Forgetting

| | |
|---|---|
| **Description** | Learning new associations destroys old ones. If the agent learns "Alice works on Zephyr" after knowing "Alice works on ILO", the ILO connection decays. |
| **Severity** | Critical — agent loses long-term knowledge |
| **Likelihood** | Likely — classic Hebbian failure mode |
| **Research** | SNAP paper (arXiv 2410.15318): "ANNs suffer from catastrophic forgetting where learning new tasks causes forgetting of old tasks." The stability-plasticity dilemma is well-documented. Nature paper (2025): catastrophic forgetting is a "critical challenge in lifelong learning." |

**ILO's exposure:** Our global decay (λ=0.001 per turn) means every link decays slightly every turn. If "Alice↔ILO" is not reinforced, it decays to ~72% after 100 turns and ~37% after 1000 turns (approximately 50% of conversations in a busy system). The link would need Hebbian reinforcement every ~100 turns to stay strong.

**Mitigation (three layers):**

1. **Confidence-gated decay** — don't decay high-confidence links as much:
   ```rust
   let effective_lambda = DECAY_LAMBDA * (1.0 - node.confidence * 0.9);
   link.weight *= (1.0 - effective_lambda);
   ```
   A link from a 0.95-confidence node decays 10x slower than a 0.1-confidence node.

2. **Periodic strengthening** — on consolidation, re-strengthen links to high-confidence entities that are connected via semantic nodes (the compressed knowledge acts as a "backbone" that doesn't decay).

3. **Sleep consolidation** — batch re-play important links at low-traffic times (inspired by HeLa-Mem's Reflective Agent).

**Test:** Create a link with initial weight 0.8. Run 500 learning cycles without reinforcing it. Check final weight. Without mitigation: ~0.8 × (0.999)^500 ≈ 0.49. With confidence-gated decay: ~0.8 × (1 - 0.001×0.1)^500 ≈ 0.76.

**Residual risk:** Low with mitigations. But the optimal decay rate is dataset-dependent.

### 2.2 Positive Feedback Loop (Weight Saturation)

| | |
|---|---|
| **Description** | Frequently co-used links get stronger → they get activated more → they get used more → they get even stronger. Eventually all weights in a subgraph saturate at 1.0, losing all discriminative power. |
| **Severity** | High — graph becomes flat (all links equal) |
| **Likelihood** | Likely — this is the expected behaviour of unbounded Hebbian learning |
| **Research** | Hopfield networks literature: correlated patterns cause prototype formation where all weights converge. Mathematical analysis shows that without constraints, Hebbian learning converges to a single attractor. |

**ILO's exposure:** Our current Hebbian update has a (1.0 - w) term that naturally saturates — a link at 0.95 gets Δ=0.0005 while a link at 0.3 gets Δ=0.035. This prevents hard saturation at 1.0. However, the saturation point is HIGH (0.99+) and a group of co-used links will all converge toward it, reducing the gradient between them.

**Mitigation — Oja's rule:** Instead of our current simple Hebbian, use Oja's rule which includes a forgetting term proportional to the square of the weight:

```rust
// Oja's rule: Δw = η * (activation_a * activation_b - w² * activation_b²)
// Simplified for our case:
let oja_decay = w * w * 0.01;  // stronger decay for high weights
let delta = HEBBIAN_ETA * (1.0 - w) * kalman_gain - oja_decay;
link.weight = (w + delta).clamp(0.0, 1.0);
```

This means: at w=0.3, oja_decay=0.0009 (negligible). At w=0.95, oja_decay=0.009 (significant, ~40% of the Hebbian increase). The link stabilizes at an equilibrium point rather than at 1.0.

**Residual risk:** Low. Oja's rule is well-established.

### 2.3 No-Learning Deadlock (Cold Start)

| | |
|---|---|
| **Description** | A brand-new graph has all links at default weight. Hebbian updates from the first few turns barely change anything because the learning rate is small. The system stays in a near-random state for the first N turns. |
| **Severity** | Medium — slow initial learning |
| **Likelihood** | Certain — happens with every new deployment |
| **Research** | Standard cold-start problem in recommender systems and memory-augmented agents. GraphRAG paper: "Once the index is constructed, its topology remains fixed." HippoRAG and HeLa-Mem handle this by pre-seeding the graph with extracted entities. |

**ILO's exposure:** New graph = all links at weight 0.5. First retrieval is essentially random walk — no Hebbian knowledge yet.

**Mitigation:**

1. **Bootstrapping phase:** On first N turns, use a higher learning rate (HEBBIAN_ETA = 0.3 instead of 0.1). After N turns, drop to normal rate.
2. **Default link weights by type:** Different link types get different initial weights:
   - LINK:ref (turn→entity) = 0.7 (strong — turns always reference entities)
   - LINK:has (entity→entity) = 0.5 (moderate — may or may not be related)
   - LINK:dep (dependency) = 0.6
   - LINK:con (contradiction) = 0.4 (rare, should be careful)
3. **Entity similarity boost:** At startup, for any two entities that share tags, create a LINK:ref with weight 0.3. This gives the seed structure to work with.

**Residual risk:** Low — initial Hebbian rate boost is simple and well-understood.

---

## 3. Retrieval Quality Failure Modes

### 3.1 Retrieval Drift (Spurious Path)

| | |
|---|---|
| **Description** | The propagation follows a semantically plausible but factually wrong path. Query "Who won the 2024 election?" finds "Trump" via a chain of turns about "voting patterns" even though the actual answer is elsewhere. |
| **Severity** | High — produces wrong answers confidently |
| **Likelihood** | Possible — depends on graph quality |
| **Research** | C2RAG paper (ICML 2026): "Spurious triples are semantically plausible yet violate constraint semantics, making relevance-based retrievers drift toward pseudo-evidence." The 7 failures paper also identifies "noisy context" as a top failure point. |

**ILO's exposure:** Our spreading activation has no fact-checking mechanism. It propagates along ANY path, regardless of whether the path is factually correct. The confidence gating (activation × confidence) helps but doesn't eliminate the risk — a high-confidence spurious entity will be retrieved.

**Mitigation:**

1. **Path trust decay:** A node reached via a long path (depth ≥ 3) should have its activation discounted by the *minimum* confidence along the path, not just its own confidence:

```rust
let path_min_confidence = min(node.confidence, link.source.confidence, ...);
let trust_score = activation * path_min_confidence;
```

2. **Contradiction check:** If a LINK:con (contradiction) exists between two retrieved nodes, flag both and reduce their trust scores.

3. **Evidence chains in output:** The context block should always include the path so the LLM can assess provenance:
   ```
   [ENTITY] schedule (score: 0.08)
     via: anxiety → Turn#140 → schedule
   ```
   This lets the LLM judge whether the path is plausible.

**Residual risk:** Medium — path trust decay helps but isn't perfect. The LLM's own reasoning is the final safeguard.

### 3.2 Context Saturation (Token Budget Overflow)

| | |
|---|---|
| **Description** | Too many activated nodes exceed the LLM's context window. The system must either truncate (losing important data) or increase context window (slowing inference). |
| **Severity** | High — forces hard tradeoffs |
| **Likelihood** | Likely — with 5 seeds and 4 hops, a dense graph can easily activate 50+ nodes |
| **Research** | MemGPT and many others identify context management as the core problem. The Synapse paper reports 95% token reduction vs full-context methods. |

**ILO's exposure:** Our test harness activated 11 nodes from 200-node graph with 3 seeds. A real graph with 5000+ nodes and dense connectivity could activate 100+ nodes, far exceeding the context budget.

**Mitigation:**

1. **Tiered truncation (three passes):**
   ```
   Pass 1: Keep all seed nodes (guaranteed relevance)
   Pass 2: Keep entities with score > 0.1 (high relevance)
   Pass 3: Keep claims with score > 0.05 (medium relevance)
   Pass 4: If still over budget, drop lowest-score nodes
   ```
2. **Semantic compression:** Instead of listing all properties for all activated nodes, compress. E.g., 5 activated entities with "status: active" → just note "[all active]" once.
3. **View-based pre-filtering:** The View's `entity_filter` and `claim_filter` run BEFORE propagation, not after. This prevents irrelevant nodes from being activated in the first place.

**Residual risk:** Low — tiered truncation is standard practice.

### 3.3 Temporal Blindness (Wrong Time)

| | |
|---|---|
| **Description** | Old turns about a topic get activated alongside new turns. The LLM receives conflicting information without temporal context. |
| **Severity** | Medium — creates confusion for the LLM |
| **Likelihood** | Likely — if temporal decay is too weak, old data persists |
| **Research** | The "outdated content" failure mode from the RAG failures survey. Snorkel: "teams should check older documents and ensure they remain accurate." |

**ILO's exposure:** Our temporal decay uses `1/(1+age×0.0001)`. A 100-hour-old turn gets factor 0.99 (barely decayed). A 10,000-hour-old turn gets factor 0.5 (significantly decayed). But the threshold for "old" depends on the domain — for news, 24 hours is old; for medical knowledge, 2 years is still current.

**Mitigation:**

1. **Per-domain time windows:** View nodes should specify `time_window`. A "news" view has a 24-hour window. A "medical" view has a 1-year window.
2. **Timestamp qualifiers in context:** Every turn in the context block should include its age:
   ```
   [TURN] #142 (2h ago): "Alice said she works on ILO"
   [TURN] #98 (30d ago): "Bob mentioned project deadlines"
   ```
   This lets the LLM decide how much to trust old information.
3. **Dynamic half-life:** Decay rate should be faster for frequently-changing types (entity status) and slower for stable types (person name):

```rust
fn temporal_factor(turn_time: u64, now: u64, stability_hours: f64) -> f64 {
    let age_hours = (now - turn_time) as f64 / 3600.0;
    (-age_hours / stability_hours).exp() // exponential decay with configurable half-life
}
// Entity "person" → stability_hours = 8760 (1 year)
// Entity "project_status" → stability_hours = 168 (1 week)
// Turn → stability_hours = 720 (30 days)
```

**Residual risk:** Medium — dynamic half-life needs per-entity-type configuration.

---

## 4. Consolidation Failure Modes

### 4.1 Semantic Compression Loss

| | |
|---|---|
| **Description** | Consolidation compresses a cluster| Description | Compression loses detail. The LLM gets a summary instead of the raw turns, potentially missing subtle cues. |
| **Severity** | Medium — lossy by design |
| **Likelihood** | Certain — compression is inherently lossy |
| **Research** | HeLa-Mem's reflective consolidation does this deliberately. The tradeoff is well-understood: more compression = smaller graph = less precision. |

**ILO's exposure:** Aggressive consolidation could destroy nuanced information. E.g., 20 turns about "Alice's project preferences" (where she mentioned 5 different projects in different contexts) get compressed into "Alice discusses projects" — losing the preference weightings.

**Mitigation:**
1. **Leave original traces:** When consolidating, keep the LINKs from the original Entity nodes to the new Episode node, but keep the original nodes as low-weight leaves. The original data is still reachable if needed.
2. **Consolidation only when redundant:** Only consolidate when cluster density > threshold (highly interconnected). Sparse clusters are preserved.
3. **Confidence inheritance:** The new semantic node inherits the MINIMUM confidence of its members, not the average. This prevents over-confidence in compressed knowledge.

**Residual risk:** Medium — requires threshold tuning.

### 4.2 Premature Consolidation

| | |
|---|---|
| **Description** | A cluster is consolidated after only 3-4 turns, creating a semantic node before the pattern is stable. The summary is wrong and pollutes future retrievals. |
| **Severity** | High — bad consolidation poisons the graph |
| **Likelihood** | Possible — if hub threshold is set too low |
| **Research** | HeLa-Mem uses Hebbian Distillation only on "hub nodes" with total edge weight exceeding a threshold δ_hub. This threshold is critical. |

**ILO's exposure:** Our proposed `CONSOLIDATION_INTERVAL=50` turns and `HUB_THRESHOLD=5.0` are arbitrary. A cluster of 3 turns with edge weights summing to 5.0 is quite small — could easily be a coincidence rather than a meaningful pattern.

**Mitigation:**
1. **Dual threshold:** Trigger consolidation only when BOTH conditions are met: cluster density > 0.7 (70% of possible edges exist) AND minimum turn count > 5.
2. **LLM validation:** Before consolidating, run the cluster through the LLM: "Does this cluster represent a coherent topic? Yes/No." Only consolidate on "Yes."
3. **Trial consolidation:** Create the semantic node with a short TTL (e.g., 100 turns). If it's not re-accessed, archive it. This prevents bad consolidations from persisting.

**Residual risk:** Low — LLM validation adds one cheap LLM call per consolidation.

---

## 5. System-Level Failure Modes

### 5.1 Feedback Loop Oscillation

| | |
|---|---|
| **Description** | The learning loop overcorrects. Turn N: strengthen link A. Turn N+1: strengthen link A more (because it was just strengthened). Turn N+2: strengthen it even more. Positive feedback without stabilisation. |
| **Severity** | High — weights diverge to extremes |
| **Likelihood** | Likely — if Hebbian updates happen every turn without bounds |
| **Research** | Standard issue in online learning. The stability-plasticity dilemma is precisely this: too much plasticity causes oscillation. |

**ILO's exposure:** If a link is strengthened every turn (because both nodes are frequently co-retrieved), it accelerates toward 1.0 despite the (1-w) term. The Kalman gain reduces updates for high-confidence nodes, but confidence itself changes slowly.

**Mitigation:**
1. **Learning rate decay:** Decrease HEBBIAN_ETA over time:
   ```rust
   let adjusted_eta = HEBBIAN_ETA / (1.0 + total_turns as f64 * 0.001);
   ```
   After 1000 turns, η = 0.091 (vs 0.1). After 10000, η = 0.05. Learning slows as the system matures.
2. **Diminishing returns per link:** Each link tracks how many times it's been updated. After N updates, further updates are discounted:
   ```rust
   let update_count = link.update_count;
   let novelty_bonus = 1.0 / (1.0 + update_count as f64 * 0.1);
   delta *= novelty_bonus;
   ```
3. **Weight ceiling:** Hard-cap weights at 0.95 instead of 1.0. This prevents saturation and leaves headroom.

**Residual risk:** Low — standard annealing techniques.

### 5.2 Cache Inconsistency (Stale Reads)

| | |
|---|---|
| **Description** | The in-memory cache (73,000x faster) serves stale data because a write to LadybugDB didn't invalidate the cache entry. |
| **Severity** | High — invisible stale data |
| **Likelihood** | Likely — cache invalidation is famously hard |
| **Research** | The README already documents this: the cache must be invalidated on every write. The lbug crate's API doesn't have cache notifications. |

**ILO's exposure:** If `write_batch` writes to LadybugDB but doesn't update the in-memory `node_cache` or `link_index`, subsequent reads from cache return stale data.

**Mitigation:**
1. **Write-through cache:** Every `write_batch` writes to BOTH LadybugDB AND the in-memory cache in the same operation. Never write to one without the other.
2. **Version stamps:** Every cache entry has a `version: u64` that increments on each write. Before serving from cache, check if the node's DB version matches. If not, invalidate and re-read.
3. **TTL-based invalidation:** Entries older than N seconds are considered stale. Simple but effective.

```rust
fn write_batch(&mut self, batch: WriteBatch) -> Result<()> {
    self.db.query("BEGIN TRANSACTION")?;
    // ... write mutations ...
    self.db.query("COMMIT")?;
    
    // Update cache synchronously
    for mutation in &batch.mutations {
        self.cache.apply(mutation);  // same data as DB
    }
    Ok(())
}

fn get_node(&self, id: &NodeId) -> Result<NodeRecord> {
    if let Some(cached) = self.cache.get(id) {
        if !cached.is_stale() { return Ok(cached.data); }
    }
    let node = self.db_query_node(id)?;
    self.cache.insert(id.clone(), node.clone());
    Ok(node)
}
```

**Residual risk:** Low — write-through cache is a solved problem.

### 5.3 Entity Ambiguity (Wrong Alice)

| | |
|---|---|
| **Description** | The query mentions "Alice" but there are two Alice entities (Alice_work, Alice_personal). The system activates the wrong one. |
| **Severity** | Medium — wrong context injected |
| **Likelihood** | Likely — common in real-world data |
| **Research** | Standard entity disambiguation problem in NLP. Our harness test showed that confidence-weighted disambiguation works when confidence differs (0.95 vs 0.30). But when both Alices have similar confidence, it fails. |

**ILO's exposure:** Our seed-finding returns ALL matches with their scores. If both Alices have confidence 0.9, both get activated. The propagation then follows both paths, potentially mixing contexts (Alice_work → ILO + Alice_personal → hobby = confused LLM).

**Mitigation:**
1. **Seed competition:** Among same-label seeds, only keep the one with highest confidence × match_score. Drop the rest.
2. **View-based disambiguation:** A View's `entity_filter` can specify which entities to include:
   ```
   View "code-review": entity_filter = ["person:developer"]
   View "social": entity_filter = ["person:friend"]
   ```
   Only entities matching the filter become seeds.
3. **Query context boost:** Extract additional context from the query to disambiguate. "What does Alice think about ILO?" → the presence of "ILO" in the query should boost `Alice_work` over `Alice_personal` even before propagation starts.

```rust
fn disambiguate(query: &str, candidates: &[(NodeId, f64)], graph: &FakeGraph) -> Vec<(NodeId, f64)> {
    let query_words: HashSet<&str> = query.split_whitespace().collect();
    let mut scored = Vec::new();
    for (id, base_score) in candidates {
        let node = graph.get(id).unwrap();
        // Boost if any of the node's tags appear in the query
        let tag_overlap = node.tags.iter().filter(|t| query_words.contains(t.as_str())).count();
        let boost = 1.0 + tag_overlap as f64 * 0.2;
        scored.push((id.clone(), base_score * boost));
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    scored.truncate(1); // keep only the best candidate per name
    scored
}
```

**Residual risk:** Medium — query context boost is heuristic. An LLM call for disambiguation would be more accurate but slower.

---

## Summary: Critical Fixes Needed Before Implementation

| # | Issue | Severity | Fix | Effort |
|---|-------|----------|-----|--------|
| 1 | **Infinite propagation** (cycles) | Critical | Add fired set to prevent re-activation | 1 hour |
| 2 | **Hub node domination** (in-degree) | High | Add in-degree attenuation | 2 hours |
| 3 | **Catastrophic forgetting** (decay) | High | Confidence-gated decay | 2 hours |
| 4 | **Weight saturation** (Oja's rule) | High | Replace simple Hebbian with Oja | 1 hour |
| 5 | **Energy vanishing** (depth 4+) | High | Recursive seeding at depth 3 | 3 hours |
| 6 | **Cache inconsistency** | High | Write-through cache | 2 hours |
| 7 | **Retrieval drift** (spurious paths) | Medium | Path trust decay | 2 hours |
| 8 | **Context saturation** (overflow) | Medium | Tiered truncation | 1 hour |
| 9 | **Entity ambiguity** (wrong Alice) | Medium | Query context boost + View filters | 3 hours |
| 10 | **Cold start** (no learning) | Medium | Bootstrapping phase with higher η | 1 hour |
| 11 | **Premature consolidation** | Medium | Dual threshold + LLM validation | 2 hours |
| 12 | **Feedback oscillation** | Medium | Learning rate decay | 1 hour |
| 13 | **Temporal blindness** | Medium | Dynamic half-life per type | 2 hours |
| 14 | **Semantic compression loss** | Medium | Keep original traces | 1 hour |

**Total estimated effort to fix all identified issues: ~24 hours.**

Of these, items 1-2 should be fixed in the test harness before starting implementation (they're algorithmic, not architectural). Items 3-6 should be designed into the Store trait from day one. Items 7-14 are refinements that can be added incrementally.

---

## Residual Risks (Not Addressed, Should Be Monitored)

| Risk | Why not addressed | Trigger for action |
|------|-----------------|-------------------|
| **LLM hallucinates despite correct context** | This is an LLM problem, not a retrieval problem | Monitor response accuracy in production |
| **Graph becomes too large (>1M nodes)** | LadybugDB handles this; cache may need eviction | Monitor cache memory usage |
| **User intentionally poisons the graph** | Security boundary — user could lie to the agent | Add user intent verification (future) |
| **Multi-language entities (non-English)** | Our matching is English-centric | Add language detection and multilingual embeddings |
