//! Stress test suite — pushes ILO to resource and performance limits.
//!
//! Tests:
//!   - 1000+ entity rapid ingestion
//!   - Large batch writes (10K mutations)
//!   - Many sequential turns (simulate a long session)
//!   - Index rebuild performance
//!   - PPR traversal on dense graphs
//!   - Learning loop on large link matrices
//!
//! Run with: cargo test --test stress_test -- --nocapture
//! Some tests may take >10s.

use mem_arch::ladybug::LadybugStore;
use mem_arch::store::Store;
use mem_arch::types::*;
use mem_arch::retrieval;
use mem_arch::search::SearchIndex;
use std::time::Instant;

fn temp_db(name: &str) -> LadybugStore {
    let path = format!("/tmp/ilo_stress_{}.lbug", name);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}.wal", path));
    LadybugStore::new(&path).expect("failed to create temp DB")
}

/// Write mutations to store.
async fn apply_batch(store: &mut LadybugStore, mutations: Vec<StoreMutation>) {
    store.write_maintenance(mutations).await.unwrap();
}

// ══════════════════════════════════════════════════════════════════════
// 1. RAPID INGESTION — 1000 entities
// ══════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_ingest_1000_entities() {
    let mut store = temp_db("ingest1k");
    let start = Instant::now();

    let mut mutations = Vec::with_capacity(1000);
    for i in 0..1000 {
        mutations.push(StoreMutation::CreateNode {
            id: format!("e_{}", i),
            type_: NodeType::Entity,
            tags: vec!["test".into()],
            label: format!("Entity {}", i),
            confidence: 0.5 + (i as f64 / 2000.0),
        });
    }
    apply_batch(&mut store, mutations).await;
    let elapsed = start.elapsed();

    let count = store.find_nodes_by_type(&NodeType::Entity).await.unwrap().len();
    assert_eq!(count, 1000, "all 1000 entities should be stored");
    eprintln!("  ingested 1000 entities in {:?}", elapsed);
}

// ══════════════════════════════════════════════════════════════════════
// 2. LARGE BATCH — 5000 link mutations
// ══════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_5000_links_batch() {
    let mut store = temp_db("5k_links");
    let start = Instant::now();

    // Create 100 entities
    let mutations: Vec<StoreMutation> = (0..100).map(|i| {
        StoreMutation::CreateNode {
            id: format!("e_{}", i), type_: NodeType::Entity,
            tags: vec![], label: format!("Node {}", i), confidence: 0.7,
        }
    }).collect();
    apply_batch(&mut store, mutations).await;

    // Create 5000 links between them
    let mut link_mutations = Vec::with_capacity(5000);
    for i in 0..5000 {
        let from = i % 100;
        let to = (i + 1) % 100;
        link_mutations.push(StoreMutation::CreateLink {
            id: format!("l_{}", i),
            from: format!("e_{}", from),
            to: format!("e_{}", to),
            type_: LinkType::Relates, rel: String::new(),
            tags: vec![],
            weight: 0.5, confidence: 0.5,
        });
    }
    apply_batch(&mut store, link_mutations).await;
    let elapsed = start.elapsed();

    let link_count = store.get_all_links().await.unwrap().len();
    assert_eq!(link_count, 5000, "all 5000 links should be stored");
    eprintln!("  created 5000 links in {:?}", elapsed);
}

// ══════════════════════════════════════════════════════════════════════
// 3. FULL PPR ON DENSE GRAPH (100 nodes, 1000 links)
// ══════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_ppr_on_dense_graph() {
    let mut store = temp_db("dense_ppr");
    let mut count = 0usize;

    // Create 100 entities with cluster structure
    let mut mutations = Vec::new();
    for i in 0..100 {
        mutations.push(StoreMutation::CreateNode {
            id: format!("e_{}", i), type_: NodeType::Entity,
            tags: vec![if i < 50 { "cluster_a" } else { "cluster_b" }.into()],
            label: format!("Entity {}", i), confidence: 0.7,
        });
    }
    // Create 1000 random-ish links biased toward same-cluster connections
    for i in 0..100 {
        for j in (i+1)..(i+20).min(100) {
            let weight = if (i < 50) == (j < 50) { 0.8 } else { 0.2 };
            mutations.push(StoreMutation::CreateLink {
                id: format!("l_{}_{}", i, j),
                from: format!("e_{}", i), to: format!("e_{}", j),
                type_: LinkType::Relates, rel: String::new(), tags: vec![], weight, confidence: 0.5,
            });
            count += 1;
        }
    }
    apply_batch(&mut store, mutations).await;

    // Build search index
    let nodes = store.find_nodes_by_type(&NodeType::Entity).await.unwrap();
    let idx = SearchIndex::build(&nodes);
    let tag_idx = store.get_tag_index().await.unwrap();

    // Run PPR recall
    let start = Instant::now();
    let result = retrieval::retrieve("Entity 5", &store, &tag_idx, None, Some(&idx), None, None).await.unwrap();
    let elapsed = start.elapsed();

    assert!(!result.activated_nodes.is_empty(), "PPR should find connected nodes");
    assert!(result.activated_nodes.len() <= 50, "PPR should not return all nodes");
    eprintln!("  PPR on {} links: {} activated nodes in {:?}", count, result.activated_nodes.len(), elapsed);
}

// ══════════════════════════════════════════════════════════════════════
// 4. SEARCH INDEX BUILD PERFORMANCE
// ══════════════════════════════════════════════════════════════════════

#[test]
fn test_index_build_1000_nodes() {
    let nodes: Vec<NodeRecord> = (0..1000).map(|i| {
        let labels = vec![
            "Rust Programming Language",
            "Python Data Science",
            "JavaScript Web Development",
            "Ailo Cognitive Runtime",
            "LadybugDB Graph Database",
            "Machine Learning Pipeline",
            "Cloud Infrastructure Deployment",
            "API Gateway Service",
            "Authentication Provider",
            "Monitoring Dashboard",
        ];
        NodeRecord {
            id: format!("e_{}", i),
            type_: NodeType::Entity,
            tags: vec![],
            label: labels[i % 10].to_string(),
            confidence: 0.7,
            embedding: None,
            created_at: chrono::Utc::now().naive_utc(),
            updated_at: chrono::Utc::now().naive_utc(),
        }
    }).collect();

    let start = Instant::now();
    let idx = SearchIndex::build(&nodes);
    let build_time = start.elapsed();
    eprintln!("  built index of {} nodes in {:?}", nodes.len(), build_time);
    assert!(build_time.as_millis() < 500, "index build should be <500ms for 1K nodes");

    // FTS should still work
    let results = idx.search_fts("rust", 10);
    assert!(!results.is_empty(), "FTS should find rust-related nodes");
}

// ══════════════════════════════════════════════════════════════════════
// 5. SIMULATED SESSION — 100 sequential turns
// ══════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_100_turn_session() {
    let mut store = temp_db("100turns");
    let start = Instant::now();
    let mut prev_turn_id: Option<String> = None;

    for i in 0..100 {
        let turn_id = format!("t_{}", i);
        let user_text = format!("This is turn number {}", i);
        let response_text = format!("Response for turn number {}", i);

        let mut mutations = Vec::new();
        // Every 5th turn, add a new entity
        if i % 5 == 0 {
            mutations.push(StoreMutation::CreateNode {
                id: format!("e_session_{}", i),
                type_: NodeType::Entity,
                tags: vec!["session_entity".into()],
                label: format!("Session Entity {}", i),
                confidence: 0.7,
            });
            // Link it to the turn
            mutations.push(StoreMutation::CreateLink {
                id: format!("ctx_{}", i),
                from: turn_id.clone(),
                to: format!("e_session_{}", i),
                type_: LinkType::References, rel: String::new(),
                tags: vec![],
                weight: 0.5, confidence: 0.5,
            });
        }

        // Link to previous turn for temporal ordering
        if let Some(prev) = &prev_turn_id {
            mutations.push(StoreMutation::CreateLink {
                id: format!("seq_{}", i),
                from: prev.clone(),
                to: turn_id.clone(),
                type_: LinkType::Precedes, rel: String::new(),
                tags: vec![],
                weight: 0.9, confidence: 0.5,
            });
        }

        let turn = TurnRecord {
            id: turn_id.clone(),

            turn_index: i as u32,
            user_text: Some(user_text),
            response_text: Some(response_text),
            model: Some("test-model".into()),
            tokens_in: Some(100),
            tokens_out: Some(200),
            duration_ms: Some(500),
        };
        store.write_batch(WriteBatch { turn, mutations }).await.unwrap();
        prev_turn_id = Some(turn_id);
    }

    let elapsed = start.elapsed();
    eprintln!("  completed 100-turn session in {:?}", elapsed);

    // Verify turn count
    let turns = store.find_nodes_by_type(&NodeType::Turn).await.unwrap();
    assert_eq!(turns.len(), 100, "all 100 turns should exist");

    // Verify entities
    let entities = store.find_nodes_by_type(&NodeType::Entity).await.unwrap();
    assert_eq!(entities.len(), 20, "20 session entities should exist");

    // Verify temporal links
    let seq_links = store.get_all_links().await.unwrap();
    let seq_count = seq_links.iter().filter(|l| l.type_ == LinkType::Precedes).count();
    assert_eq!(seq_count, 99, "99 seq links between 100 turns");
}

// ══════════════════════════════════════════════════════════════════════
// 6. LEARNING LOOP — 200 turns with simulated feedback
// ══════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_learning_200_turns() {
    use mem_arch::config::LearningConfig;
    use mem_arch::learning::{learn, LearningSignal};

    let mut store = temp_db("learn200");
    let entity_ids: Vec<String> = (0..10).map(|i| format!("e_lrn_{}", i)).collect();

    // Create 10 entities
    let mut mutations: Vec<StoreMutation> = entity_ids.iter().enumerate().map(|(i, id)| {
        StoreMutation::CreateNode {
            id: id.clone(), type_: NodeType::Entity,
            tags: vec![], label: format!("Learn Entity {}", i), confidence: 0.8,
        }
    }).collect();
    // Create all 45 pairwise edges at weight 0.3
    for i in 0..10 {
        for j in (i+1)..10 {
            mutations.push(StoreMutation::CreateLink {
                id: format!("l_{}_{}", i, j),
                from: entity_ids[i].clone(), to: entity_ids[j].clone(),
                type_: LinkType::Relates, rel: String::new(), tags: vec![], weight: 0.3, confidence: 0.5,
            });
        }
    }
    apply_batch(&mut store, mutations).await;

    let config = LearningConfig::default();

    // Run 200 turns
    let start = Instant::now();
    for turn in 0..200 {
        // Cluster A: entities 0-4 co-occur
        let used = if turn % 2 == 0 {
            entity_ids[0..5].to_vec()
        } else {
            entity_ids[5..10].to_vec()
        };
        let signal = LearningSignal::from_explicit(
            format!("t_{}", turn), "test query",
            entity_ids.clone(), used, 0.8,
        );
        learn(&mut store, &signal, &config, chrono::Utc::now().timestamp_millis()).await.unwrap();
    }
    let elapsed = start.elapsed();
    eprintln!("  completed 200 learning turns in {:?}", elapsed);

    // Check: cluster A links should be stronger than cross-cluster links
    let all_links = store.get_all_links().await.unwrap();
    let mut intra_a = Vec::new();
    let mut cross = Vec::new();
    for link in &all_links {
        let fi = link.from.strip_prefix("e_lrn_").and_then(|s| s.parse::<usize>().ok()).unwrap_or(99);
        let ti = link.to.strip_prefix("e_lrn_").and_then(|s| s.parse::<usize>().ok()).unwrap_or(99);
        if fi < 5 && ti < 5 {
            intra_a.push(link.weight);
        } else if fi >= 5 && ti >= 5 {
            // intra-b, skip
        } else {
            cross.push(link.weight);
        }
    }

    let avg_intra_a = intra_a.iter().copied().sum::<f64>() / intra_a.len().max(1) as f64;
    let avg_cross = cross.iter().copied().sum::<f64>() / cross.len().max(1) as f64;
    eprintln!("  avg intra-cluster weight: {:.3}, avg cross-cluster: {:.3}", avg_intra_a, avg_cross);
    // After 200 turns, intra-cluster should be measurably higher
    assert!(avg_intra_a > avg_cross, "learning should strengthen co-used links");
}

// ══════════════════════════════════════════════════════════════════════
// 7. CACHE WARM AFTER LARGE STATE
// ══════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_cache_warm_large_db() {
    // Create a store, fill it, close it, reopen it (triggers warm_cache)
    let path = "/tmp/ilo_stress_cache_warm.lbug";
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{}.wal", path));

    {
        let mut store = LadybugStore::new(path).unwrap();
        let mut mutations = Vec::new();
        for i in 0..500 {
            mutations.push(StoreMutation::CreateNode {
                id: format!("e_{}", i), type_: NodeType::Entity,
                tags: vec![], label: format!("Entity {}", i), confidence: 0.5,
            });
        }
        store.write_maintenance(mutations).await.unwrap();
    } // store dropped here

    // Reopen — calls warm_cache explicitly
    let start = Instant::now();
    let store = LadybugStore::new(path).unwrap();
    store.warm_cache().unwrap();
    let elapsed = start.elapsed();
    eprintln!("  warm_cache with 500 nodes in {:?}", elapsed);
    assert!(elapsed.as_millis() < 1000, "warm_cache should be <1s for 500 nodes");

    let count = store.find_nodes_by_type(&NodeType::Entity).await.unwrap().len();
    assert_eq!(count, 500);

    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{}.wal", path));
}
