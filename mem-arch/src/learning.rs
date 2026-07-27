//! Counter-based learning loop — frequency × recency weight formula.
//!
//! After each turn, collects signal (which entities were useful), updates
//! per-link counters (retrieved, useful, last_used_ms), and recomputes weight.
//!
//! weight = frequency × recency
//!   frequency = (useful + 1) / (retrieved + 2)      ← Beta(1,1) prior, 0 params
//!   recency   = exp(-Δt_ms × ln(2) / half_life_ms)  ← 1 param, Δt is real wall-clock time
//!
//! Using wall-clock timestamps instead of turn counters grounds the agent's
//! episodic memory in real time. A link decays based on how much real time
//! has passed since last use, not how many turns occurred in between.
//!
//! No separate decay, negative feedback, or Oja rule needed — the Beta prior
//! naturally drives noise edges toward 0 and useful edges toward 1.
//!
//! Future additions (from Microsoft 2025 paper architecture):
//! - Bayesian Surprise: |frequency - prior_expectation| for novelty weighting
//! - Outcome signal: goal completion feedback from UI/agent

use crate::config::LearningConfig;
use crate::store::Store;
use crate::types::*;

/// Signals collected from a single turn about which nodes were useful.
///
/// The agent should always prefer `from_explicit` over `from_overlap`.
/// Overlap detection creates a confirmation bias loop: if the LLM mentions
/// a noise entity that was wrongly retrieved, the system treats it as useful
/// and strengthens it. Explicit labels from the agent break this loop.
pub struct LearningSignal {
    pub turn_id: NodeId,
    pub query: String,
    pub retrieved_node_ids: Vec<NodeId>,
    pub used_node_ids: Vec<NodeId>,
    pub unused_node_ids: Vec<NodeId>,
    pub co_used_pairs: Vec<(NodeId, NodeId)>,
    /// Optional quality rating from the agent (0.0–1.0).
    /// Can be used later for Bayesian Surprise or Outcome gating.
    pub quality: f64,
}

impl LearningSignal {
    /// Build signal from explicit agent-provided labels (preferred).
    /// The agent knows which entities were actually useful because it built the
    /// prompt. This bypasses the overlap detection confirmation bias loop.
    pub fn from_explicit(
        turn_id: NodeId,
        query: impl Into<String>,
        all_retrieved_node_ids: Vec<NodeId>,
        used_node_ids: Vec<NodeId>,
        quality: f64,
    ) -> Self {
        let used_set: std::collections::HashSet<NodeId> = used_node_ids.iter().cloned().collect();
        let unused: Vec<NodeId> = all_retrieved_node_ids.iter()
            .filter(|id| !used_set.contains(*id))
            .cloned().collect();

        let mut co_used = Vec::new();
        let used_slice: Vec<&NodeId> = used_node_ids.iter().collect();
        for i in 0..used_slice.len() {
            for j in (i + 1)..used_slice.len() {
                co_used.push((used_slice[i].clone(), used_slice[j].clone()));
            }
        }

        LearningSignal {
            turn_id,
            query: query.into(),
            retrieved_node_ids: all_retrieved_node_ids,
            used_node_ids,
            unused_node_ids: unused,
            co_used_pairs: co_used,
            quality,
        }
    }

    /// Fallback: collect signal by checking which retrieved nodes appear in
    /// the response text. Entity overlap — if a retrieved entity's label
    /// appears in the response, it was "used".
    ///
    /// WARNING: This creates the confirmation bias loop. Use only when the
    /// agent cannot provide explicit labels.
    pub fn from_overlap(
        turn_id: NodeId,
        retrieved_nodes: &[ActivatedNode],
        response_text: &str,
    ) -> Self {
        let response_lower = response_text.to_lowercase();
        let mut used = Vec::new();
        let mut unused = Vec::new();

        for node in retrieved_nodes {
            if node.node_type != NodeType::Entity { continue; }
            if response_lower.contains(&node.label.to_lowercase()) {
                used.push(node.node_id.clone());
            } else {
                unused.push(node.node_id.clone());
            }
        }

        // Build co-used pairs (all combinations of used nodes)
        let mut co_used = Vec::new();
        for i in 0..used.len() {
            for j in (i + 1)..used.len() {
                co_used.push((used[i].clone(), used[j].clone()));
            }
        }

        let all_retrieved: Vec<NodeId> = retrieved_nodes.iter().map(|n| n.node_id.clone()).collect();

        LearningSignal {
            turn_id,
            query: String::new(),
            retrieved_node_ids: all_retrieved,
            used_node_ids: used,
            unused_node_ids: unused,
            co_used_pairs: co_used,
            quality: 0.0,
        }
    }
}

/// Read a link's counter properties. Returns (retrieved, useful, last_used_ms, first_used_ms).
/// Timestamps are wall-clock milliseconds since Unix epoch.
async fn read_link_counters(store: &impl Store, link_id: &str) -> (f64, f64, i64, i64) {
    // retrieved and useful are stored as Float (confidence-gated fractional values)
    let r = store.get_property(link_id, "retrieved").await.ok().flatten()
        .and_then(|p| match p.value {
            PropValue::Float(n) => Some(n),
            PropValue::Int(n) => Some(n as f64), // backward compat
            _ => None,
        }).unwrap_or(0.0);
    let u = store.get_property(link_id, "useful").await.ok().flatten()
        .and_then(|p| if let PropValue::Float(n) = p.value { Some(n) } else { None }).unwrap_or(0.0);
    let l = store.get_property(link_id, "last_used").await.ok().flatten()
        .and_then(|p| if let PropValue::Int(n) = p.value { Some(n) } else { None }).unwrap_or(0);
    let f = store.get_property(link_id, "first_used").await.ok().flatten()
        .and_then(|p| if let PropValue::Int(n) = p.value { Some(n) } else { None }).unwrap_or(0);
    (r, u, l, f)
}

/// Compute weight from counters using wall-clock timestamps.
///
/// weight = frequency × recency
///   frequency = (useful + 1) / (retrieved + 2)   ← Beta(1,1) prior
///   recency   = exp(-dt_ms × ln(2) / half_life_ms) ← real-time decay
///
/// If dt_ms ≤ 0 (just used or clock jitter), recency = 1.0 (no decay).
fn compute_weight(retrieved: f64, useful: f64, last_used_ms: i64, now_ms: i64, half_life_ms: f64) -> f64 {
    // Beta(1,1) prior: new edge starts at 0.5
    let frequency = (useful + 1.0) / (retrieved + 2.0);
    // Exponential decay from last use (real wall-clock time)
    let dt = (now_ms - last_used_ms) as f64;
    if dt <= 0.0 {
        return frequency;  // just used or clock jitter — no decay
    }
    let recency = (-dt * std::f64::consts::LN_2 / half_life_ms).exp();
    frequency * recency
}

/// Apply the counter-based learning update after a turn.
///
/// One-directional design: only co-used pairs get strengthened.
/// No explicit weakening pass — the passive recency decay (wall-clock time since last use)
/// handles forgetting naturally. The Beta prior `(useful+1)/(retrieved+2)` provides
/// separation between signal and noise without active link-weakening.
///
/// `now_ms` is the wall-clock timestamp (milliseconds since Unix epoch) of the current moment.
pub async fn learn(
    store: &mut impl Store,
    signal: &LearningSignal,
    config: &LearningConfig,
    now_ms: i64,
) -> Result<(), StoreError> {
    let mut mutations: Vec<StoreMutation> = Vec::new();
    // Track which link IDs we've already processed (avoid duplicates)
    let mut processed = std::collections::HashSet::new();

    // Phase 1: Update counters for co-used pairs (confidence-gated)
    for (a, b) in &signal.co_used_pairs {
        let links = store.find_links(a, None).await?;
        for link in &links {
            if (link.to == *b || link.from == *b) && !processed.contains(&link.id) {
                processed.insert(link.id.clone());
                let (ret, use_, _last_used, first_used) = read_link_counters(store, &link.id).await;

                // Confidence gating: multiply useful increment by geometric mean of node confidences
                let conf_a = store.get_node(a).await?.map(|n| n.confidence).unwrap_or(0.5);
                let conf_b = store.get_node(b).await?.map(|n| n.confidence).unwrap_or(0.5);
                let quality_factor = (conf_a * conf_b).sqrt(); // 0.3×0.9 → 0.52

                let new_ret = ret + 1.0;
                let new_use = use_ + quality_factor;
                // Track first_used: set when useful first becomes > 0
                let new_first = if use_ <= 0.0 && quality_factor > 0.0 { now_ms } else { first_used };
                let new_weight = compute_weight(new_ret, new_use, now_ms, now_ms, config.half_life_ms);

                // Update counter properties
                mutations.push(StoreMutation::SetProperty {
                    owner_id: link.id.clone(), owner_kind: OwnerKind::Link,
                    key: "retrieved".into(), value: PropValue::Float(new_ret),
                });
                mutations.push(StoreMutation::SetProperty {
                    owner_id: link.id.clone(), owner_kind: OwnerKind::Link,
                    key: "useful".into(), value: PropValue::Float(new_use),
                });
                mutations.push(StoreMutation::SetProperty {
                    owner_id: link.id.clone(), owner_kind: OwnerKind::Link,
                    key: "last_used".into(), value: PropValue::Int(now_ms),
                });
                if new_first > 0 && first_used == 0 {
                    mutations.push(StoreMutation::SetProperty {
                        owner_id: link.id.clone(), owner_kind: OwnerKind::Link,
                        key: "first_used".into(), value: PropValue::Int(new_first as i64),
                    });
                }
                mutations.push(StoreMutation::UpdateLinkWeight {
                    id: link.id.clone(),
                    weight: new_weight,
                });
            }
        }
    }

    // Write all mutations in one batch
    if !mutations.is_empty() {
        store.write_maintenance(mutations).await?;
    }

    Ok(())
}

/// Consolidation: check for hub nodes and compress dense clusters.
/// Same logic as before — works on link weights.
pub async fn consolidate(
    store: &impl Store,
    config: &LearningConfig,
    turn_count: u32,
) -> Result<String, StoreError> {
    if !turn_count.is_multiple_of(config.consolidation_interval) {
        return Ok("skipped (not due)".into());
    }

    let all_links = store.get_all_links().await?;

    // Find hub nodes (high total incident weight)
    let mut hub_scores: std::collections::HashMap<NodeId, f64> = std::collections::HashMap::new();
    for link in &all_links {
        *hub_scores.entry(link.from.clone()).or_insert(0.0) += link.weight;
        *hub_scores.entry(link.to.clone()).or_insert(0.0) += link.weight;
    }

    let hubs: Vec<NodeId> = hub_scores.into_iter()
        .filter(|(_, score)| *score > config.hub_threshold)
        .map(|(id, _)| id)
        .collect();

    if hubs.is_empty() {
        return Ok("no hubs found".into());
    }

    Ok(format!("consolidation triggered: {} hubs found", hubs.len()))
}
