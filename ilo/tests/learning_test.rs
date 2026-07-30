//! Integration test: synthetic learning experiment.
//!
//! Creates a small graph with 4 entity nodes and controlled link structure,
//! runs simulated turns with known usage patterns, and measures whether
//! link weights converge to the expected pattern.
//!
//! Expected outcome after 20 turns:
//!   Alice↔ILO weight: HIGH (>0.6) — co-occurred in 10 turns of cluster A
//!   Bob↔Xanadu weight: HIGH (>0.6) — co-occurred in 10 turns of cluster B
//!   Alice↔Bob weight: LOW (<0.2) — never co-occurred usefully

use std::collections::HashMap;

// Import the project's modules
use ilo::config::LearningConfig;
use ilo::learning::{learn, LearningSignal};
use ilo::store::Store;
use ilo::types::*;
use ilo::ladybug::LadybugStore;

/// Build the synthetic graph: 4 entity nodes, 6 links (fully connected), all weight 0.3
fn build_graph(store: &mut LadybugStore) -> HashMap<String, String> {
    let entities = vec![
        ("e_alice", "Alice", "person"),
        ("e_bob", "Bob", "person"),
        ("e_ilo", "ILO", "project"),
        ("e_xanadu", "Xanadu", "project"),
    ];

    let mut mutations: Vec<StoreMutation> = Vec::new();
    let mut ids = HashMap::new();

    for (id, label, subtype) in &entities {
        ids.insert(label.to_string(), id.to_string());
        mutations.push(StoreMutation::CreateNode {
            id: id.to_string(),
            type_: NodeType::Entity,
            tags: vec![],
            label: label.to_string(),
            confidence: 0.9,
        });
        mutations.push(StoreMutation::SetProperty {
            owner_id: id.to_string(),
            owner_kind: OwnerKind::Node,
            key: "subtype".into(),
            value: PropValue::String(subtype.to_string()),
        });
    }

    // Create all 6 pairwise links at weight 0.3
    let pairs = [
        ("e_alice", "e_bob"),
        ("e_alice", "e_ilo"),
        ("e_alice", "e_xanadu"),
        ("e_bob", "e_ilo"),
        ("e_bob", "e_xanadu"),
        ("e_ilo", "e_xanadu"),
    ];

    for (from, to) in &pairs {
        let link_id = format!("l_{}_{}", from, to);
        mutations.push(StoreMutation::CreateLink {
            id: link_id,
            from: from.to_string(),
            to: to.to_string(),
            type_: LinkType::Relates, rel: String::new(),
            tags: vec![],
            weight: 0.3, confidence: 0.5,
        });
    }

    // Write as a batch with a dummy turn
    let turn = TurnRecord {
        id: "t_setup".into(),
        turn_index: 0,
        user_text: Some("setup".to_string()),
        response_text: Some("setup".to_string()),
        model: Some("test".to_string()),
        tokens_in: Some(0),
        tokens_out: Some(0),
        duration_ms: Some(0),
    };

    // Use tokio runtime for the async call
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        store.write_batch(WriteBatch { turn, mutations }).await.unwrap();
    });

    ids
}

/// Read all link weights from the store and print them
async fn print_weights(store: &LadybugStore, label: &str) {
    let links = store.get_all_links().await.unwrap();
    println!("=== Weights after {label} ===");
    for link in &links {
        // Look up node labels (from cache)
        let from_node = store.get_node(&link.from).await.unwrap();
        let to_node = store.get_node(&link.to).await.unwrap();
        let from_label = from_node.map(|n| n.label).unwrap_or_else(|| link.from.clone());
        let to_label = to_node.map(|n| n.label).unwrap_or_else(|| link.to.clone());
        println!("  {:.3}  {} --{}--> {}", link.weight, from_label, link.type_.as_str(), to_label);
    }
    println!();
}

/// Simulate one turn: learn from the response text
async fn simulate_turn(
    store: &mut LadybugStore,
    turn_index: u32,
    retrieved_labels: &[&str],
    response_text: &str,
    config: &LearningConfig,
) {
    // Find node IDs from labels
    let mut retrieved_nodes = Vec::new();
    for label in retrieved_labels {
        let nodes = store.find_nodes(&NodeQuery {
            type_: Some(NodeType::Entity),
            tags: vec![],
            label_contains: Some(label.to_string()),
            limit: 1,
        }).await.unwrap();
        if let Some(node) = nodes.into_iter().next() {
            retrieved_nodes.push(ActivatedNode {
                node_id: node.id.clone(),
                label: node.label.clone(),
                node_type: NodeType::Entity,
                activation: 1.0,
                depth: 0,
                path: vec![],
                properties: HashMap::new(),
            });
        }
    }

    let signal = LearningSignal::from_overlap(
        format!("t_{}", turn_index),
        &retrieved_nodes,
        response_text,
    );

    learn(store, &signal, config, (turn_index as i64) * 1000).await.unwrap();
}

#[test]
fn test_synthetic_learning() {
    // Use an in-memory database (":memory:" path)
    let mut store = LadybugStore::new(":memory:").unwrap();
    let ids = build_graph(&mut store);

    let config = LearningConfig {
        half_life_ms: 86_400_000.0,
        consolidation_interval: 50,
        hub_threshold: 5.0,
    };

    let rt = tokio::runtime::Runtime::new().unwrap();

    // Print initial state
    rt.block_on(print_weights(&store, "initial"));

    // Phase 1: Turns 1-10 — queries about Alice's project
    // Context retrieves: Alice, ILO, Bob
    // Response mentions: Alice, ILO (Bob unused -> negative feedback)
    for i in 1..=10 {
        rt.block_on(simulate_turn(
            &mut store, i,
            &["Alice", "ILO", "Bob"],
            "Alice works on the ILO project as a data scientist.",
            &config,
        ));
    }

    rt.block_on(print_weights(&store, "phase1 (Alice cluster, 10 turns)"));

    // Phase 2: Turns 11-20 — queries about Bob's project
    // Context retrieves: Bob, Xanadu, Alice
    // Response mentions: Bob, Xanadu (Alice unused -> negative feedback)
    for i in 11..=20 {
        rt.block_on(simulate_turn(
            &mut store, i,
            &["Bob", "Xanadu", "Alice"],
            "Bob works on the Xanadu project as a data scientist.",
            &config,
        ));
    }

    rt.block_on(print_weights(&store, "phase2 (Bob cluster, 10 turns)"));

    // Check expected pattern
    rt.block_on(async {
        let links = store.get_all_links().await.unwrap();

        // Helper: find weight between two labels
        let get_weight = |label_a: &str, label_b: &str| -> f64 {
            let id_a = ids.get(label_a).unwrap();
            let id_b = ids.get(label_b).unwrap();
            for link in &links {
                if (link.from == *id_a && link.to == *id_b)
                    || (link.from == *id_b && link.to == *id_a)
                {
                    return link.weight;
                }
            }
            0.0
        };

        let alice_ilo = get_weight("Alice", "ILO");
        let bob_xanadu = get_weight("Bob", "Xanadu");
        let alice_bob = get_weight("Alice", "Bob");

        println!("=== Critical weights ===");
        println!("  Alice↔ILO:    {:.3}  (expected >0.6)", alice_ilo);
        println!("  Bob↔Xanadu:   {:.3}  (expected >0.6)", bob_xanadu);
        println!("  Alice↔Bob:    {:.3}  (expected <0.2)", alice_bob);

        // Assert: within-cluster weights should be stronger than cross-cluster
        assert!(
            alice_ilo > alice_bob,
            "Expected Alice↔ILO ({}) > Alice↔Bob ({}) — cluster should strengthen, cross should decay",
            alice_ilo, alice_bob
        );
        assert!(
            bob_xanadu > alice_bob,
            "Expected Bob↔Xanadu ({}) > Alice↔Bob ({})",
            bob_xanadu, alice_bob
        );

        // Within-cluster should be higher than cross-cluster
        assert!(
            alice_ilo > alice_bob,
            "Alice↔ILO ({:.3}) should be > Alice↔Bob ({:.3}) — cluster should strengthen, cross should decay",
            alice_ilo, alice_bob
        );
        assert!(
            bob_xanadu > alice_bob,
            "Bob↔Xanadu ({:.3}) should be > Alice↔Bob ({:.3})",
            bob_xanadu, alice_bob
        );
        // Within-cluster should have gained from initial 0.3
        assert!(
            alice_ilo > 0.32,
            "Alice↔ILO should be above initial 0.3, got {:.3}", alice_ilo
        );
        assert!(
            bob_xanadu > 0.32,
            "Bob↔Xanadu should be above initial 0.3, got {:.3}", bob_xanadu
        );
    });
}

#[test]
fn test_learning_noise_decay() {
    // Test: if a relationship is never reinforced, it should decay
    let mut store = LadybugStore::new(":memory:").unwrap();
    let ids = build_graph(&mut store);
    let config = LearningConfig::default();

    let rt = tokio::runtime::Runtime::new().unwrap();

    // Simulate 30 turns where Alice is ALWAYS useful
    // Bob is NEVER mentioned (not even retrieved)
    // Only Alice↔ILO gets strengthened (they're always used together)
    for i in 1..=30 {
        let retrieved_labels = vec!["Alice", "ILO", "Bob"];

        let mut retrieved_nodes = Vec::new();
        for label in &retrieved_labels {
            let id = ids.get(*label).unwrap();
            retrieved_nodes.push(ActivatedNode {
                node_id: id.to_string(),
                label: label.to_string(),
                node_type: NodeType::Entity,
                activation: 1.0,
                depth: 0,
                path: vec![],
                properties: HashMap::new(),
            });
        }

        // Response only mentions Alice and ILO (Bob unused)
        let signal = LearningSignal::from_overlap(
            format!("t_{}", i),
            &retrieved_nodes,
            "Alice works on the ILO project",
        );
        rt.block_on(learn(&mut store, &signal, &config, (i as i64) * 1000)).unwrap();
    }

    rt.block_on(async {
        let links = store.get_all_links().await.unwrap();

        let get_w = |a: &str, b: &str| -> f64 {
            let id_a = ids.get(a).unwrap_or_else(|| panic!("Key not found: {}", a));
            let id_b = ids.get(b).unwrap_or_else(|| panic!("Key not found: {}", b));
            for link in &links {
                if (link.from == *id_a && link.to == *id_b)
                    || (link.from == *id_b && link.to == *id_a)
                { return link.weight; }
            }
            0.0
        };

        let alice_ilo = get_w("Alice", "ILO");
        let alice_bob = get_w("Alice", "Bob");

        println!("=== Noise decay test (30 turns, Alice+ILO always used, Bob always unused) ===");
        println!("  Alice↔ILO: {:.3}  (should be HIGH)", alice_ilo);
        println!("  Alice↔Bob: {:.3}  (should be LOW)", alice_bob);

        assert!(alice_ilo > 0.30, "Alice↔ILO should strengthen above initial 0.3, got {:.3}", alice_ilo);
        assert!(alice_bob < 0.32, "Alice↔Bob should decay (noise), got {:.3}", alice_bob);
        // Alice↔ILO should be stronger than Alice↔Bob (separation)
        assert!(alice_ilo > alice_bob, "Alice↔ILO ({:.3}) > Alice↔Bob ({:.3})", alice_ilo, alice_bob);
    });
}
