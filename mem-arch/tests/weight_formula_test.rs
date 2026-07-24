//! Brute-force: proposed frequency×recency vs current Hebbian+Oja.
//!
//! Tests both weight formulas across controlled scenarios to validate
//! the proposed design before committing to rewriting learning.rs.

use std::collections::HashMap;
use mem_arch::learning::{learn, LearningSignal};
use mem_arch::store::Store;
use mem_arch::types::*;
use mem_arch::ladybug::LadybugStore;
use mem_arch::config::LearningConfig;

// ─── Proposed formula (wall-clock timestamps) ────────────────────────

fn weight_proposed(retrieved: f64, useful: f64, last_used_ms: i64, now_ms: i64, half_life_ms: f64) -> f64 {
    // Beta(1,1) prior: new edge starts at 0.5
    let frequency = (useful + 1.0) / (retrieved + 2.0);
    // Exponential decay from last use (real time)
    let dt = (now_ms - last_used_ms) as f64;
    if dt <= 0.0 { return frequency; }
    let recency = (-dt * std::f64::consts::LN_2 / half_life_ms).exp();
    frequency * recency
}

// ─── Pure math tests (no database needed) ────────────────────────────

#[test]
fn test_formula_edge_cases() {
    // Use a fast half-life (1 second) so we can see meaningful decay
    // without astronomical timestamp values.
    let hl = 1_000.0; // 1 second half-life

    // New edge, never retrieved — should be 0.5 (Beta prior, dt=0)
    let w = weight_proposed(0.0, 0.0, 1000, 1000, hl);
    assert!((w - 0.5).abs() < 0.001, "New edge should be 0.5, got {w}");

    // Perfect edge: always useful, just used now (dt=0)
    let w = weight_proposed(100.0, 100.0, 50000, 50000, hl);
    let expected_freq = (100.0 + 1.0) / (100.0 + 2.0); // 0.990
    assert!((w - expected_freq).abs() < 0.001,
        "Perfect edge should be ~0.99, got {w}");

    // Never useful: 0 out of 10, not used for 49 seconds
    // dt = 50000 - 1000 = 49000ms, rec = exp(-49000 * ln2 / 1000) ≈ 2.8e-15
    let w = weight_proposed(10.0, 0.0, 1000, 50000, hl);
    let freq = (0.0 + 1.0) / (10.0 + 2.0); // 0.083
    let rec = (-49000.0_f64 * std::f64::consts::LN_2 / hl).exp();
    assert!((w - freq * rec).abs() < 0.001,
        "Never-useful edge: freq={freq:.4}, rec={rec:.4}, w={w:.4}");

    // Long ago: freq high, recency near 0
    // dt = 500000 - 10000 = 490000ms ≈ 8 minutes
    // With 1s half-life, rec ≈ 0 (essentially zero)
    let w = weight_proposed(50.0, 45.0, 10000, 500000, hl);
    assert!(w < 0.1, "Old reliable edge should be weak, got {w:.4}");

    // Single co-occurrence, just now (dt=0)
    let w = weight_proposed(1.0, 1.0, 20000, 20000, hl);
    assert!((w - 0.667).abs() < 0.01, "1/1 recent should be ~0.667, got {w:.4}");

    println!("Frequency×recency (timestamp) edge cases all pass.");
}

#[test]
fn test_weight_surface() {
    println!("\n=== Weight surface: frequency × recency ===");
    println!("        | rec=0.0  0.2    0.4    0.6    0.8    1.0");
    println!("--------+----------------------------------------------");
    for freq in (0..=10).map(|i| i as f64 / 10.0) {
        print!("freq={:.1} |", freq);
        for rec in (0..=10).map(|i| i as f64 / 10.0) {
            print!(" {:.4}", freq * rec);
        }
        println!();
    }
    println!();
    println!("Properties:");
    println!("  - Both signals must be >0 for weight >0 (multiplicative gate)");
    println!("  - weight=1 only when both freq=1 AND rec=1");
    println!("  - A reliable edge from long ago (freq=1, rec=0) → weight=0 (forgotten)");
    println!("  - A new edge (freq=0.5, rec=1) → weight=0.5 (uncertain but plausible)");
}

// ─── Database-backed tests (compares proposed vs current) ────────────

fn build_test_graph(store: &mut LadybugStore, labels: &[&str]) -> HashMap<String, String> {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let mut ids = HashMap::new();
    let mut mutations = Vec::new();

    for (i, label) in labels.iter().enumerate() {
        let id = format!("e_{}", i);
        ids.insert(label.to_string(), id.clone());
        mutations.push(StoreMutation::CreateNode {
            id, type_: NodeType::Entity, tags: vec![], label: label.to_string(), confidence: 0.9,
        });
    }

    // Create fully connected graph
    for i in 0..labels.len() {
        for j in (i+1)..labels.len() {
            let from = format!("e_{}", i);
            let to = format!("e_{}", j);
            mutations.push(StoreMutation::CreateLink {
                id: format!("l_{}_{}", i, j),
                from, to, type_: LinkType::Ref, tags: vec![], weight: 0.3,
            });
        }
    }

    rt.block_on(async {
        store.write_batch(WriteBatch {
            turn: TurnRecord {
                id: "t_setup".into(),
                turn_index: 0,
                user_text: Some("setup".into()), response_text: Some("setup".to_string()),
                model: Some("test".to_string()), tokens_in: Some(0), tokens_out: Some(0), duration_ms: Some(0),
            },
            mutations,
        }).await.unwrap();
    });
    ids
}

#[test]
fn test_current_vs_proposed() {
    // Run the current Hebbian+Oja learning loop on a controlled scenario
    let mut store = LadybugStore::new(":memory:").unwrap();
    let ids = build_test_graph(&mut store, &["Alice", "ILO", "Bob", "Xanadu"]);
    let config = LearningConfig::default();
    let rt = tokio::runtime::Runtime::new().unwrap();

    // Phase 1: Alice+ILO always useful (10 turns)
    for i in 0..10 {
        let retrieved: Vec<ActivatedNode> = ["Alice", "ILO", "Bob"].iter().map(|label| {
            ActivatedNode {
                node_id: ids.get(*label).unwrap().clone(),
                label: label.to_string(),
                node_type: NodeType::Entity,
                activation: 1.0, depth: 0, path: vec![], properties: HashMap::new(),
            }
        }).collect();

        let signal = LearningSignal::from_overlap(
            format!("t_{}", i), &retrieved,
            "Alice works on the ILO project",
        );
        rt.block_on(learn(&mut store, &signal, &config, (i * 1000) as i64)).unwrap();
    }

    // Read current weights
    rt.block_on(async {
        let links = store.get_all_links().await.unwrap();
        let current_alice_ilo = links.iter()
            .find(|l| {
                let a = &l.from; let b = &l.to;
                (a == ids.get("Alice").unwrap() && b == ids.get("ILO").unwrap()) ||
                (a == ids.get("ILO").unwrap() && b == ids.get("Alice").unwrap())
            })
            .map(|l| l.weight).unwrap_or(0.0);

        let current_alice_bob = links.iter()
            .find(|l| {
                let a = &l.from; let b = &l.to;
                (a == ids.get("Alice").unwrap() && b == ids.get("Bob").unwrap()) ||
                (a == ids.get("Bob").unwrap() && b == ids.get("Alice").unwrap())
            })
            .map(|l| l.weight).unwrap_or(0.0);

        // Compute proposed weights for the same scenario
        // After 10 turns at 1-second intervals: all links just used
        // Alice↔ILO co-occurred 10 times, used 10 times, last used at turn 9 (9000ms)
        let proposed_alice_ilo = weight_proposed(10.0, 10.0, 9000, 9000, 86_400_000.0);
        // Alice↔Bob: retrieved 10 times, used 0 times, never used (last_used_ms=0)
        // dt = 9000 - 0 = 9000ms, with 1-day half-life: rec ≈ 0.9999
        let proposed_alice_bob = weight_proposed(10.0, 0.0, 0, 9000, 86_400_000.0);

        println!("\n=== Current (Hebbian+Oja) vs Proposed (freq×rec) ===");
        println!("Alice↔ILO (always useful):");
        println!("  Current:   {:.4}", current_alice_ilo);
        println!("  Proposed:  {:.4} (freq={:.4}, rec={:.4})",
            proposed_alice_ilo,
            (10.0 + 1.0) / (10.0 + 2.0),
            1.0);
        println!();
        println!("Alice↔Bob (always noise):");
        println!("  Current:   {:.4}", current_alice_bob);
        println!("  Proposed:  {:.4} (freq={:.4}, rec={:.4})",
            proposed_alice_bob,
            (0.0 + 1.0) / (10.0 + 2.0),
            (-9000.0_f64 * std::f64::consts::LN_2 / 86_400_000.0).exp());
        println!();
        println!("Separation ratio (useful / noise):");
        println!("  Current:   {:.1}x", current_alice_ilo / current_alice_bob.max(0.001));
        println!("  Proposed:  {:.1}x", proposed_alice_ilo / proposed_alice_bob.max(0.001));
        println!();

        // Both should show separation
        assert!(current_alice_ilo > current_alice_bob,
            "Current: useful ({:.4}) should be > noise ({:.4})", current_alice_ilo, current_alice_bob);
        assert!(proposed_alice_ilo > proposed_alice_bob,
            "Proposed: useful ({:.4}) should be > noise ({:.4})", proposed_alice_ilo, proposed_alice_bob);
    });
}
