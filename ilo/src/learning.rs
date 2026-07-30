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
    // Guard against NaN/Infinity inputs — treat as 0 for retrieved/useful
    let retrieved = if retrieved.is_finite() && retrieved >= 0.0 { retrieved } else { 0.0 };
    let useful = if useful.is_finite() && useful >= 0.0 { useful } else { 0.0 };
    let half_life = if half_life_ms.is_finite() && half_life_ms > 0.0 { half_life_ms } else { 1.0 };

    // Beta(1,1) prior: new edge starts at 0.5
    let frequency = (useful + 1.0) / (retrieved + 2.0);
    // Exponential decay from last use (real wall-clock time)
    let dt = (now_ms - last_used_ms) as f64;
    if dt <= 0.0 {
        return frequency;  // just used or clock jitter — no decay
    }
    let recency = (-dt * std::f64::consts::LN_2 / half_life).exp();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock_store::MockStore;

    // ── compute_weight tests ────────────────────────

    #[test]
    fn test_weight_beta_prior_new_edge() {
        // A brand-new link: 0 retrieved, 0 useful
        // frequency = (0 + 1) / (0 + 2) = 0.5, dt = 0 → no decay
        let w = compute_weight(0.0, 0.0, 1000, 1000, 1_000_000.0);
        assert!((w - 0.5).abs() < 0.001, "expected 0.5, got {}", w);
    }

    #[test]
    fn test_weight_all_useful() {
        // 10/10 useful: frequency = (10+1)/(10+2) = 11/12 ≈ 0.917
        let w = compute_weight(10.0, 10.0, 5000, 5000, 1_000_000.0);
        assert!((w - 0.9167).abs() < 0.001, "expected ~0.917, got {}", w);
    }

    #[test]
    fn test_weight_all_noise() {
        // 100 retrievals, 0 useful: frequency = 1/102 ≈ 0.0098
        let w = compute_weight(100.0, 0.0, 1000, 1000, 1_000_000.0);
        assert!(w < 0.02 && w > 0.005, "expected near 0.01, got {}", w);
    }

    #[test]
    fn test_weight_half_life_decay() {
        // dt = 1000ms, half_life = 1000ms → recency = exp(-ln2) = 0.5
        let w = compute_weight(1000.0, 1000.0, 0, 1000, 1000.0);
        assert!((w - 0.5).abs() < 0.01, "expected ~0.5, got {}", w);
    }

    #[test]
    fn test_weight_two_half_lives() {
        // dt = 2000ms, half_life = 1000ms → recency = exp(-2*ln2) = 0.25
        let w = compute_weight(1000.0, 1000.0, 0, 2000, 1000.0);
        assert!((w - 0.25).abs() < 0.01, "expected ~0.25, got {}", w);
    }

    #[test]
    fn test_weight_no_decay_when_dt_zero() {
        // dt = 0 → recency = 1.0
        let w = compute_weight(10.0, 5.0, 10000, 10000, 1_000_000.0);
        assert!((w - 0.5).abs() < 0.001, "expected 0.5, got {}", w);
    }

    #[test]
    fn test_weight_negative_dt_clock_jitter() {
        // Future timestamp (clock jitter) → no decay
        let w = compute_weight(10.0, 5.0, 20000, 10000, 1000.0);
        assert!((w - 0.5).abs() < 0.001, "expected 0.5, got {}", w);
    }

    #[test]
    fn test_weight_zero_retrieved_one_useful() {
        // Edge: (1+1)/(0+2) = 1.0
        let w = compute_weight(0.0, 1.0, 0, 0, 1_000_000.0);
        assert!((w - 1.0).abs() < 0.001, "expected 1.0, got {}", w);
    }

    #[test]
    fn test_weight_large_timestamps_realistic() {
        // Realistic scale: ~June 2025 epoch ms, one week decay
        let now = 1_750_000_000_000i64;
        let last_week = now - 7 * 24 * 3600 * 1000;
        let half_life = 7_776_000_000.0; // 90 days
        // frequency = (40+1)/(50+2) = 41/52 ≈ 0.7885
        // recency = exp(-604800000*ln2/7776000000) ≈ 0.9476
        // expected ≈ 0.747
        let w = compute_weight(50.0, 40.0, last_week, now, half_life);
        assert!((w - 0.74).abs() < 0.02, "expected ~0.747, got {}", w);
    }

    #[test]
    fn test_weight_nan_inputs() {
        // NaN inputs should not panic or produce NaN
        let w = compute_weight(f64::NAN, 0.0, 0, 0, 1000.0);
        assert!(w.is_finite(), "weight should be finite, got {}", w);
    }

    #[test]
    fn test_weight_infinity_inputs() {
        let w = compute_weight(f64::INFINITY, f64::INFINITY, 0, 0, 1000.0);
        assert!(w.is_finite(), "weight should be finite, got {}", w);
    }

    #[test]
    fn test_weight_negative_counters() {
        let w = compute_weight(-5.0, -3.0, 0, 0, 1000.0);
        assert!(w.is_finite() && w >= 0.0, "should be non-negative, got {}", w);
    }

    // ── LearningSignal::from_explicit tests ──────────

    #[test]
    fn test_from_explicit_all_used() {
        let signal = LearningSignal::from_explicit(
            "t_1".into(), "test",
            vec!["e_a".into(), "e_b".into()],
            vec!["e_a".into(), "e_b".into()], 0.8);
        assert_eq!(signal.used_node_ids.len(), 2);
        assert!(signal.unused_node_ids.is_empty());
        assert_eq!(signal.co_used_pairs.len(), 1);
        assert_eq!(signal.query, "test");
        assert!((signal.quality - 0.8).abs() < 0.01);
    }

    #[test]
    fn test_from_explicit_some_unused() {
        let signal = LearningSignal::from_explicit(
            "t_2".into(), "",
            vec!["e_a".into(), "e_b".into(), "e_c".into()],
            vec!["e_a".into()], 0.0);
        assert_eq!(signal.used_node_ids, vec!["e_a"]);
        assert_eq!(signal.unused_node_ids, vec!["e_b", "e_c"]);
        assert!(signal.co_used_pairs.is_empty());
    }

    #[test]
    fn test_from_explicit_none_used() {
        let signal = LearningSignal::from_explicit(
            "t_3".into(), "q",
            vec!["e_a".into(), "e_b".into()],
            vec![], 0.5);
        assert!(signal.used_node_ids.is_empty());
        assert_eq!(signal.unused_node_ids.len(), 2);
    }

    #[test]
    fn test_from_explicit_four_used_six_pairs() {
        // 4 used nodes = C(4,2) = 6 co-used pairs
        let signal = LearningSignal::from_explicit(
            "t_4".into(), "",
            vec!["e_a".into(), "e_b".into(), "e_c".into(), "e_d".into()],
            vec!["e_a".into(), "e_b".into(), "e_c".into(), "e_d".into()], 0.0);
        assert_eq!(signal.co_used_pairs.len(), 6);
        assert!(signal.co_used_pairs.contains(&("e_a".into(), "e_b".into())));
        assert!(signal.co_used_pairs.contains(&("e_c".into(), "e_d".into())));
    }

    #[test]
    fn test_from_explicit_empty_lists() {
        let signal = LearningSignal::from_explicit("t_5".into(), "", vec![], vec![], 0.0);
        assert!(signal.used_node_ids.is_empty());
        assert!(signal.unused_node_ids.is_empty());
        assert!(signal.co_used_pairs.is_empty());
    }

    // ── LearningSignal::from_overlap tests ───────────

    fn activated_node(id: &str, label: &str, node_type: NodeType) -> ActivatedNode {
        ActivatedNode {
            node_id: id.into(), label: label.into(), node_type,
            activation: 0.9, depth: 0, path: vec![],
            properties: std::collections::HashMap::new(),
        }
    }

    #[test]
    fn test_from_overlap_label_in_response() {
        let nodes = vec![activated_node("e_ailo", "Ailo", NodeType::Entity)];
        let signal = LearningSignal::from_overlap("t_1".into(), &nodes, "I use Ailo everyday");
        assert_eq!(signal.used_node_ids, vec!["e_ailo"]);
        assert!(signal.unused_node_ids.is_empty());
    }

    #[test]
    fn test_from_overlap_label_not_in_response() {
        let nodes = vec![activated_node("e_rust", "Rust", NodeType::Entity)];
        let signal = LearningSignal::from_overlap("t_2".into(), &nodes, "I like Python");
        assert!(signal.used_node_ids.is_empty());
        assert_eq!(signal.unused_node_ids, vec!["e_rust"]);
    }

    #[test]
    fn test_from_overlap_case_insensitive() {
        let nodes = vec![activated_node("e_ailo", "Ailo", NodeType::Entity)];
        let signal = LearningSignal::from_overlap("t_3".into(), &nodes, "AILO");
        assert_eq!(signal.used_node_ids, vec!["e_ailo"]);
    }

    #[test]
    fn test_from_overlap_skips_non_entity() {
        let nodes = vec![activated_node("t_99", "Turn #99", NodeType::Turn)];
        let signal = LearningSignal::from_overlap("t_1".into(), &nodes, "Turn #99");
        assert!(signal.used_node_ids.is_empty());
    }

    #[test]
    fn test_from_overlap_multi_word_label() {
        let nodes = vec![activated_node("e_proj", "Ailo Project", NodeType::Entity)];
        let signal = LearningSignal::from_overlap("t_1".into(), &nodes, "the Ailo Project team");
        assert_eq!(signal.used_node_ids, vec!["e_proj"]);
    }

    #[test]
    fn test_from_overlap_two_used_generates_co_used() {
        let nodes = vec![
            activated_node("e_a", "Alpha", NodeType::Entity),
            activated_node("e_b", "Beta", NodeType::Entity),
            activated_node("e_c", "Gamma", NodeType::Entity),
        ];
        let signal = LearningSignal::from_overlap(
            "t_1".into(), &nodes, "Alpha and Beta");
        assert_eq!(signal.used_node_ids, vec!["e_a", "e_b"]);
        assert_eq!(signal.unused_node_ids, vec!["e_c"]);
        assert_eq!(signal.co_used_pairs, vec![("e_a".into(), "e_b".into())]);
    }

    #[test]
    fn test_from_overlap_substring_does_not_match_backwards() {
        // `response_lower.contains(&label.to_lowercase())` means the response
        // must CONTAIN the full label. "Py" is shorter than "Python", so
        // "py".contains("python") is false. This is the correct behavior.
        let nodes = vec![activated_node("e_py", "Python", NodeType::Entity)];
        let signal = LearningSignal::from_overlap("t_1".into(), &nodes, "Py");
        assert!(signal.used_node_ids.is_empty(), "should not match backwards");
    }

    // ── learn() with MockStore tests ─────────────────

    #[tokio::test]
    async fn test_learn_updates_link_counters() {
        let mut store = MockStore::new();
        store.add_entity("e_a", "Alpha", 0.9, vec![]);
        store.add_entity("e_b", "Beta", 0.9, vec![]);
        store.add_link("l_ab", "e_a", "e_b", LinkType::Relates, "", 0.5, 0.5);

        let signal = LearningSignal::from_explicit(
            "t_1".into(), "",
            vec!["e_a".into(), "e_b".into()],
            vec!["e_a".into(), "e_b".into()], 0.0);

        let config = LearningConfig::default();
        learn(&mut store, &signal, &config, 1000).await.unwrap();

        // Verify properties were set on the link
        let p_ret = store.get_property("l_ab", "retrieved").await.unwrap();
        assert!(p_ret.is_some(), "retrieved should be set");
        if let Some(ref pr) = p_ret {
            if let PropValue::Float(v) = pr.value {
                assert!((v - 1.0).abs() < 0.01);
            } else {
                panic!("expected Float, got {:?}", pr.value);
            }
        }
    }

    #[tokio::test]
    async fn test_learn_confidence_gating() {
        let mut store = MockStore::new();
        store.add_entity("e_low", "LowConf", 0.3, vec![]);
        store.add_entity("e_high", "HighConf", 0.9, vec![]);
        store.add_link("l", "e_low", "e_high", LinkType::Relates, "", 0.5, 0.5);

        let signal = LearningSignal::from_explicit(
            "t_1".into(), "",
            vec!["e_low".into(), "e_high".into()],
            vec!["e_low".into(), "e_high".into()], 0.0);

        let config = LearningConfig::default();
        learn(&mut store, &signal, &config, 1000).await.unwrap();

        // useful = quality_factor = sqrt(0.3 * 0.9) = sqrt(0.27) ≈ 0.519
        let p_use = store.get_property("l", "useful").await.unwrap().unwrap();
        if let PropValue::Float(v) = p_use.value {
            assert!((v - 0.519).abs() < 0.01, "expected ~0.519, got {}", v);
        } else {
            panic!("expected Float, got {:?}", p_use.value);
        }
    }

    #[tokio::test]
    async fn test_learn_noop_on_unused_link() {
        // If no co-used pairs, learn should do nothing
        let mut store = MockStore::new();
        store.add_entity("e_a", "Alpha", 0.9, vec![]);
        store.add_entity("e_b", "Beta", 0.9, vec![]);
        store.add_link("l_ab", "e_a", "e_b", LinkType::Relates, "", 0.5, 0.5);

        // Signal with no co-used pairs (0 used nodes)
        let signal = LearningSignal::from_explicit(
            "t_1".into(), "",
            vec!["e_a".into(), "e_b".into()],
            vec![], 0.0);

        let config = LearningConfig::default();
        learn(&mut store, &signal, &config, 1000).await.unwrap();

        let p_ret = store.get_property("l_ab", "retrieved").await.unwrap();
        assert!(p_ret.is_none(), "should not have been set");
    }

    #[tokio::test]
    async fn test_learn_deduplicates_link_updates() {
        // Two co-used pairs that reference the same link — should only update once
        let mut store = MockStore::new();
        store.add_entity("e_a", "Alpha", 0.9, vec![]);
        store.add_entity("e_b", "Beta", 0.9, vec![]);
        store.add_link("l_ab", "e_a", "e_b", LinkType::Relates, "", 0.5, 0.5);

        // Create a signal with duplicate co-used pair (e_a,e_b) appearing twice
        // (normally from_explicit deduplicates via HashSet, so this tests the
        // in-link dedup logic in learn())
        let signal = LearningSignal {
            turn_id: "t_1".into(),
            query: String::new(),
            retrieved_node_ids: vec!["e_a".into(), "e_b".into()],
            used_node_ids: vec!["e_a".into(), "e_b".into()],
            unused_node_ids: vec![],
            co_used_pairs: vec![
                ("e_a".into(), "e_b".into()),
                ("e_a".into(), "e_b".into()),
            ],
            quality: 0.0,
        };

        let config = LearningConfig::default();
        learn(&mut store, &signal, &config, 1000).await.unwrap();

        // Retrieved should be 1, not 2 (deduped)
        let p_ret = store.get_property("l_ab", "retrieved").await.unwrap().unwrap();
        if let PropValue::Float(v) = p_ret.value {
            assert!((v - 1.0).abs() < 0.01, "expected 1.0, got {}", v);
        } else {
            panic!("expected Float");
        }
    }

    // ── consolidate tests ───────────────────────────

    #[tokio::test]
    async fn test_consolidate_skipped_when_not_due() {
        let store = MockStore::new();
        let config = LearningConfig { consolidation_interval: 50, ..Default::default() };
        let result = consolidate(&store, &config, 25).await.unwrap();
        assert_eq!(result, "skipped (not due)");
    }

    #[tokio::test]
    async fn test_consolidate_no_hubs() {
        let store = MockStore::new();
        let config = LearningConfig { consolidation_interval: 1, hub_threshold: 100.0, ..Default::default() };
        let result = consolidate(&store, &config, 100).await.unwrap();
        assert_eq!(result, "no hubs found");
    }

    #[tokio::test]
    async fn test_consolidate_detects_hubs() {
        let mut store = MockStore::new();
        store.add_entity("hub_a", "HubA", 0.9, vec![]);
        store.add_entity("e_b", "EntityB", 0.9, vec![]);
        store.add_entity("e_c", "EntityC", 0.9, vec![]);
        store.add_link("l_ab", "hub_a", "e_b", LinkType::Relates, "", 3.0, 0.5);
        store.add_link("l_ac", "hub_a", "e_c", LinkType::Relates, "", 3.0, 0.5);
        // hub_a has 6.0 total incident weight

        let config = LearningConfig { consolidation_interval: 1, hub_threshold: 5.0, ..Default::default() };
        let result = consolidate(&store, &config, 100).await.unwrap();
        assert!(result.contains("hubs found"), "expected hubs, got: {}", result);
    }
}
