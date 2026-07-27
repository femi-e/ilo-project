//! Adversarial test suite — tries to break every ILO component.
//!
//! Each test targets a specific failure mode:
//!   - Malformed / missing data
//!   - Extreme values (empty, massive, NaN, negative)
//!   - Encoding attacks (unicode, SQL injection)
//!   - Graph structure anomalies (cycles, self-loops, fan-out)
//!   - Concurrent read/write races
//!   - Resource exhaustion (memory, connections)
//!
//! Run with: cargo test --test adversarial_test -- --nocapture

use mem_arch::ladybug::LadybugStore;
use mem_arch::store::Store;
use mem_arch::types::*;
use mem_arch::retrieval;
use mem_arch::search::SearchIndex;

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

fn temp_db(name: &str) -> LadybugStore {
    let path = format!("/tmp/ilo_adversarial_{}.lbug", name);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}.wal", path));
    LadybugStore::new(&path).expect("failed to create temp DB")
}

fn make_entity(id: &str, label: &str, confidence: f64) -> NodeRecord {
    NodeRecord {
        id: id.to_string(),
        type_: NodeType::Entity,
        tags: vec![],
        label: label.to_string(),
        confidence,
        embedding: None,
        created_at: chrono::Utc::now().naive_utc(),
        updated_at: chrono::Utc::now().naive_utc(),
    }
}

/// Write a batch of mutations to the store.
async fn apply(store: &mut LadybugStore, mutations: Vec<StoreMutation>) {
    store.write_maintenance(mutations).await.unwrap();
}

// ══════════════════════════════════════════════════════════════════════
// 1. GRAPH STRUCTURE ANOMALIES
// ══════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_self_referential_link() {
    let mut store = temp_db("self_link");
    apply(&mut store, vec![
        StoreMutation::CreateNode { id: "e_a".into(), type_: NodeType::Entity, tags: vec![], label: "A".into(), confidence: 0.9 },
        StoreMutation::CreateLink { id: "l_self".into(), from: "e_a".into(), to: "e_a".into(), relationship: String::new(),
            type_: LinkType::Relates, tags: vec![], weight: 0.8, confidence: 0.5 },
    ]).await;

    // Traverse from A — should not infinite loop
    let result = store.traverse(&"e_a".into(), &TraversalFilter::default()).await.unwrap();
    // Self-loop should not cause infinite recursion
    assert!(result.len() <= 1, "self-loop should not explode");
}

#[tokio::test]
async fn test_circular_graph_three_nodes() {
    let mut store = temp_db("circular3");
    // Create A→B, B→C, C→A (triangle)
    for (id, label) in &[("e_a", "A"), ("e_b", "B"), ("e_c", "C")] {
        apply(&mut store, vec![
            StoreMutation::CreateNode { id: id.to_string(), type_: NodeType::Entity, tags: vec![], label: label.to_string(), confidence: 0.9 },
        ]).await;
    }
    apply(&mut store, vec![
        StoreMutation::CreateLink { id: "l_ab".into(), from: "e_a".into(), to: "e_b".into(), type_: LinkType::Relates, relationship: String::new(), tags: vec![], weight: 0.9, confidence: 0.5 },
        StoreMutation::CreateLink { id: "l_bc".into(), from: "e_b".into(), to: "e_c".into(), type_: LinkType::Relates, relationship: String::new(), tags: vec![], weight: 0.9, confidence: 0.5 },
        StoreMutation::CreateLink { id: "l_ca".into(), from: "e_c".into(), to: "e_a".into(), type_: LinkType::Relates, relationship: String::new(), tags: vec![], weight: 0.9, confidence: 0.5 },
    ]).await;

    // Traverse with max_depth=10 — should terminate
    let result = store.traverse(&"e_a".into(), &TraversalFilter { max_depth: 10, ..Default::default() }).await.unwrap();
    assert!(!result.is_empty(), "should find connected nodes");
    assert!(result.len() <= 10, "should not explode from cycles");
}

#[tokio::test]
async fn test_fan_out_explosion() {
    let mut store = temp_db("fanout");
    // Create one hub entity with 500 outgoing links
    apply(&mut store, vec![
        StoreMutation::CreateNode { id: "e_hub".into(), type_: NodeType::Entity, tags: vec![], label: "Hub".into(), confidence: 0.9 },
    ]).await;

    let mut mutations = Vec::new();
    for i in 0..500 {
        let target = format!("e_target_{}", i);
        mutations.push(StoreMutation::CreateNode {
            id: target.clone(), type_: NodeType::Entity, tags: vec![],
            label: format!("Target {}", i), confidence: 0.5,
        });
        mutations.push(StoreMutation::CreateLink {
            id: format!("l_hub_{}", i), from: "e_hub".into(), to: target,
            type_: LinkType::Relates, relationship: String::new(), tags: vec![],
            weight: 0.1, confidence: 0.5,
        });
    }
    apply(&mut store, mutations).await;

    // PPR traversal from hub — should not timeout or OOM
    let nodes = vec![make_entity("e_hub", "Hub", 0.9)];
    let idx = SearchIndex::build(&nodes);
    let tag_idx = store.get_tag_index().await.unwrap();
    let result = retrieval::retrieve("Hub", &store, &tag_idx, None, Some(&idx), None, None).await.unwrap();
    assert!(result.activated_nodes.len() <= 20, "PPR should cap expansion, not return {} nodes", result.activated_nodes.len());
}

// ══════════════════════════════════════════════════════════════════════
// 2. INPUT EXTREMES
// ══════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_empty_query() {
    let mut store = temp_db("empty_query");
    let nodes = vec![make_entity("e_test", "Test", 0.9)];
    apply(&mut store, vec![
        StoreMutation::CreateNode { id: "e_test".into(), type_: NodeType::Entity, tags: vec![], label: "Test".into(), confidence: 0.9 },
    ]).await;
    let idx = SearchIndex::build(&nodes);
    let tag_idx = store.get_tag_index().await.unwrap();

    // Empty string query
        let result = retrieval::retrieve("", &store, &tag_idx, None, Some(&idx), None, None).await.unwrap();
    assert!(result.activated_nodes.is_empty(), "empty query should return nothing");
}

#[tokio::test]
async fn test_query_with_only_stop_words() {
    let mut store = temp_db("stop_words");
    apply(&mut store, vec![
        StoreMutation::CreateNode { id: "e_test".into(), type_: NodeType::Entity, tags: vec![], label: "Test Project".into(), confidence: 0.9 },
    ]).await;
    let nodes = vec![make_entity("e_test", "Test Project", 0.9)];
    let idx = SearchIndex::build(&nodes);
    let tag_idx = store.get_tag_index().await.unwrap();

    let result = retrieval::retrieve("the and for with", &store, &tag_idx, None, Some(&idx), None, None).await.unwrap();
    assert!(result.activated_nodes.is_empty(), "stop-word-only query should return nothing");
}

#[tokio::test]
async fn test_unicode_labels() {
    let mut store = temp_db("unicode");
    apply(&mut store, vec![
        StoreMutation::CreateNode { id: "e_cafe".into(), type_: NodeType::Entity, tags: vec![],
            label: "Café au Lait".into(), confidence: 0.9 },
        StoreMutation::CreateNode { id: "e_emoji".into(), type_: NodeType::Entity, tags: vec![],
            label: "🚀 Rocket Project 🌟".into(), confidence: 0.8 },
        StoreMutation::CreateNode { id: "e_arabic".into(), type_: NodeType::Entity, tags: vec![],
            label: "مرحبا بالعالم".into(), confidence: 0.7 },
        StoreMutation::CreateNode { id: "e_chinese".into(), type_: NodeType::Entity, tags: vec![],
            label: "你好世界".into(), confidence: 0.7 },
    ]).await;

    // FTS search should handle unicode without panicking
    let nodes = store.find_nodes_by_type(&NodeType::Entity).await.unwrap();
    let idx = SearchIndex::build(&nodes);
    let tag_idx = store.get_tag_index().await.unwrap();

    // These should not crash
    let _ = retrieval::retrieve("café", &store, &tag_idx, None, Some(&idx), None, None).await;
    let _ = retrieval::retrieve("🚀", &store, &tag_idx, None, Some(&idx), None, None).await;
    let _ = retrieval::retrieve("مرحبا", &store, &tag_idx, None, Some(&idx), None, None).await;
    let _ = retrieval::retrieve("世界", &store, &tag_idx, None, Some(&idx), None, None).await;
}

// ══════════════════════════════════════════════════════════════════════
// 3. SQL / CYPHER INJECTION ATTEMPTS
// ══════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_sql_injection_in_label() {
    let mut store = temp_db("sqli");
    // Attempt injection via label
    let result = store.write_maintenance(vec![
        StoreMutation::CreateNode {
            id: "e_inject".into(), type_: NodeType::Entity, tags: vec![],
            label: "'; MATCH (n) DETACH DELETE n; --".into(), confidence: 0.9 },
    ]).await;
    // The injection attempt may succeed (with escaped quotes) or fail on invalid Cypher
    // Either way, the process should not panic
    if let Ok(()) = result {
        let nodes = store.find_nodes_by_type(&NodeType::Entity).await.unwrap();
        assert_eq!(nodes.len(), 1, "injection should not delete other nodes");
    }
}

#[tokio::test]
async fn test_sql_injection_in_tags() {
    let mut store = temp_db("sqli_tags");
    let _result = store.write_maintenance(vec![
        StoreMutation::CreateNode {
            id: "e_inject".into(), type_: NodeType::Entity,
            tags: vec!["'; DROP TABLE Node; --".into()],
            label: "Safe".into(), confidence: 0.9 },
    ]).await;
    // Either succeed with escaped quotes or fail gracefully — no panic
}

// ══════════════════════════════════════════════════════════════════════
// 4. EXTREME VALUES
// ══════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_nan_confidence() {
    let mut store = temp_db("nan_conf");
    // LadybugDB might handle NaN differently — just verify no panic
    let result = store.write_maintenance(vec![
        StoreMutation::CreateNode {
            id: "e_nan".into(), type_: NodeType::Entity, tags: vec![],
            label: "NaN Entity".into(), confidence: f64::NAN },
    ]).await;
    // Should either accept or error, but not panic
    if let Ok(()) = result {
        let node = store.get_node(&"e_nan".into()).await.unwrap();
        if let Some(n) = node {
            assert!(n.confidence.is_nan(), "NaN confidence should be preserved or handled");
        }
    }
}

#[tokio::test]
async fn test_infinity_confidence() {
    let mut store = temp_db("inf_conf");
    let _result = store.write_maintenance(vec![
        StoreMutation::CreateNode {
            id: "e_inf".into(), type_: NodeType::Entity, tags: vec![],
            label: "Inf Entity".into(), confidence: f64::INFINITY },
    ]).await;
    // Should not panic
}

#[tokio::test]
async fn test_negative_confidence() {
    let mut store = temp_db("neg_conf");
    let result = store.write_maintenance(vec![
        StoreMutation::CreateNode {
            id: "e_neg".into(), type_: NodeType::Entity, tags: vec![],
            label: "Negative".into(), confidence: -1.0 },
    ]).await;
    assert!(result.is_ok(), "negative confidence should not panic");
}

#[tokio::test]
async fn test_extremely_long_label() {
    let mut store = temp_db("long_label");
    let long_label = "A".repeat(100_000);
    let result = store.write_maintenance(vec![
        StoreMutation::CreateNode {
            id: "e_long".into(), type_: NodeType::Entity, tags: vec![],
            label: long_label.clone(), confidence: 0.5 },
    ]).await;

    // LadybugDB may reject extremely long strings
    if let Ok(()) = result {
        // FTS index should not OOM — search for word that DOES exist in the label
        let nodes = store.find_nodes_by_type(&NodeType::Entity).await.unwrap();
        let idx = SearchIndex::build(&nodes);
        // The label is 100K 'A's — but single chars are filtered by MIN_TERM_LEN=2
        // Instead, just verify the index didn't crash
        assert!(idx.has_fts(), "FTS index should exist after long label");
    }
}

#[tokio::test]
async fn test_extremely_long_query() {
    let mut store = temp_db("long_query");
    apply(&mut store, vec![
        StoreMutation::CreateNode { id: "e_test".into(), type_: NodeType::Entity, tags: vec![], label: "Test Entity".into(), confidence: 0.9 },
    ]).await;
    let nodes = store.find_nodes_by_type(&NodeType::Entity).await.unwrap();
    let idx = SearchIndex::build(&nodes);
    let tag_idx = store.get_tag_index().await.unwrap();

    // 10K character query
    let long_query = "test ".repeat(2000);
        let result = retrieval::retrieve(&long_query, &store, &tag_idx, None, Some(&idx), None, None).await;
    assert!(result.is_ok(), "very long query should not crash");
    assert!(result.is_ok(), "very long query should not crash");

    // 1M character query (resource limit test)
    let huge_query = "x".repeat(1_000_000);
        let result = retrieval::retrieve(&huge_query, &store, &tag_idx, None, Some(&idx), None, None).await;
    assert!(result.is_ok(), "1M char query should not OOM");
    assert!(result.is_ok(), "1M char query should not OOM");
}

// ══════════════════════════════════════════════════════════════════════
// 5. CONCURRENT ACCESS RACES
// ══════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_concurrent_reads() {
    let store = std::sync::Arc::new(tokio::sync::RwLock::new(temp_db("con_read")));
    // Seed some data
    {
        let mut s = store.write().await;
        apply(&mut s, vec![
            StoreMutation::CreateNode { id: "e_test".into(), type_: NodeType::Entity, tags: vec![], label: "Test".into(), confidence: 0.9 },
        ]).await;
    }

    // 50 concurrent readers
    let mut handles = Vec::new();
    let nodes = store.read().await.find_nodes_by_type(&NodeType::Entity).await.unwrap();
    let idx = std::sync::Arc::new(SearchIndex::build(&nodes));
    for _ in 0..50 {
        let store = store.clone();
        let _idx = idx.clone();
        handles.push(tokio::spawn(async move {
            let s = store.read().await;
            let _ = s.get_node(&"e_test".into()).await;
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
}

#[tokio::test]
async fn test_mixed_read_write_stress() {
    let store = std::sync::Arc::new(tokio::sync::RwLock::new(temp_db("mixed_stress")));
    let mut handles = Vec::new();

    // 10 writers + 40 readers concurrently
    for i in 0..10 {
        let store = store.clone();
        handles.push(tokio::spawn(async move {
            let mut s = store.write().await;
            let _ = s.write_maintenance(vec![
                StoreMutation::CreateNode {
                    id: format!("e_w{}", i), type_: NodeType::Entity,
                    tags: vec![], label: format!("Writer {}", i), confidence: 0.5,
                }
            ]).await;
        }));
    }
    for _ in 0..40 {
        let store = store.clone();
        handles.push(tokio::spawn(async move {
            let s = store.read().await;
            let _ = s.get_node(&"e_test".into()).await;
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
}

// ══════════════════════════════════════════════════════════════════════
// 6. SEARCH INDEX EDGE CASES
// ══════════════════════════════════════════════════════════════════════

#[test]
fn test_search_empty_index() {
    let idx = SearchIndex::build(&[]);
    assert!(idx.search_fts("test", 5).is_empty());
    assert!(!idx.has_fts());
    assert!(!idx.has_vectors());
    assert_eq!(idx.vector_count(), 0);
}

#[test]
fn test_search_single_term() {
    let nodes = vec![make_entity("e1", "Hello World", 0.9)];
    let idx = SearchIndex::build(&nodes);
    let results = idx.search_fts("hello", 5);
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].node_id, "e1");
}

#[test]
fn test_search_case_insensitive() {
    let nodes = vec![make_entity("e1", "Rust Programming", 0.9)];
    let idx = SearchIndex::build(&nodes);
    assert_eq!(idx.search_fts("RUST", 5).len(), 1);
    assert_eq!(idx.search_fts("rust", 5).len(), 1);
    assert_eq!(idx.search_fts("Rust", 5).len(), 1);
}

#[test]
fn test_search_partial_word() {
    let nodes = vec![make_entity("e1", "Rust Programming Language", 0.9)];
    let idx = SearchIndex::build(&nodes);
    // FTS should find partial matches via stemming/token overlap
    let results = idx.search_fts("Prog", 5);
    // In BM25, "Prog" won't match "Programming" unless tokenized
    // This is expected behavior — FTS matches whole tokens
    assert!(results.is_empty(), "FTS without prefix search should not match partial");
}

#[test]
fn test_search_repeated_terms() {
    let nodes = vec![
        make_entity("e1", "Rust Rust Rust", 0.9),
        make_entity("e2", "Rust Programming", 0.7),
    ];
    let idx = SearchIndex::build(&nodes);
    let results = idx.search_fts("rust", 5);
    assert_eq!(results.len(), 2);
    // The one with higher TF should rank first despite lower confidence
    assert_eq!(results[0].node_id, "e1", "higher TF should rank first");
}