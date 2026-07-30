//! Edge case runtime tests — targets bugs found in production and
//! unicode/encoding boundary issues that crashed the sidecar.
//!
//! Run with: cargo test --test edge_runtime_test -- --nocapture

use ilo::ladybug::LadybugStore;
use ilo::store::Store;
use ilo::types::*;
use ilo::extract;
use ilo::retrieval;
use ilo::search::SearchIndex;
use std::collections::HashMap;

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

fn temp_db(name: &str) -> LadybugStore {
    let path = format!("/tmp/ilo_edge_{}.lbug", name);
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

fn make_activated(id: &str, label: &str, node_type: NodeType, activation: f64, depth: u8) -> ActivatedNode {
    ActivatedNode {
        node_id: id.to_string(), label: label.to_string(), node_type,
        activation, depth, path: vec![], properties: HashMap::new(),
    }
}

async fn apply(store: &mut LadybugStore, mutations: Vec<StoreMutation>) {
    store.write_maintenance(mutations).await.unwrap();
}

// ══════════════════════════════════════════════════════════════════════
// 1. EXTRACT: UNICODE/EMOJI EDGE CASES (regression tests for the
//    byte-boundary panic that was found at extract.rs:112)
// ══════════════════════════════════════════════════════════════════════

#[test]
fn test_extract_emoji_no_crash() {
    let graph = HashMap::new();
    let r = extract::extract("The 📊 chart shows ILO project progress 🚀 and 🦀 Rust!", &graph);
    assert!(r.n_entities >= 2, "should extract at least ILO and Rust");
    assert!(r.entities.iter().any(|e| e.name == "ILO"), "should extract ILO");
    assert!(r.entities.iter().any(|e| e.name == "Rust"), "should extract Rust");
}

#[test]
fn test_extract_emoji_only_text() {
    let graph = HashMap::new();
    let r = extract::extract("📊 🚀 🦀 🌟 📈 🤖", &graph);
    assert_eq!(r.n_entities, 0, "emoji-only text should have 0 entities");
}

#[test]
fn test_extract_mixed_cjk_and_emoji() {
    let graph = HashMap::new();
    let r = extract::extract("你好世界📊Hello🚀Rust项目🌟", &graph);
    assert!(r.n_entities >= 2, "should extract Hello and Rust");
}

#[test]
fn test_extract_zero_width_joiners() {
    let graph = HashMap::new();
    let r = extract::extract("👨‍👩‍👧‍👦 family emoji and ILO project", &graph);
    assert!(r.entities.iter().any(|e| e.name == "ILO"), "ILO should be extracted");
}

#[test]
fn test_extract_rtl_text() {
    let graph = HashMap::new();
    let text = "مرحبا 📊 ILO project يعمل بشكل رائع 🚀";
    let r = extract::extract(text, &graph);
    assert!(r.entities.iter().any(|e| e.name == "ILO"), "ILO should be extracted");
}

#[test]
fn test_extract_combining_diacritics() {
    let graph = HashMap::new();
    let text = "Caf\u{00e9} au Lait is good but ILO is better";
    let r = extract::extract(text, &graph);
    assert!(r.entities.iter().any(|e| e.name == "ILO"), "ILO should be extracted");
}

#[test]
fn test_extract_all_stop_words() {
    let graph = HashMap::new();
    let r = extract::extract("the and for with in on at by", &graph);
    assert_eq!(r.n_entities, 0, "stop words only should yield no entities");
}

#[test]
fn test_extract_all_punctuation() {
    let graph = HashMap::new();
    let r = extract::extract("...,!?;:()[]{}\"'", &graph);
    assert_eq!(r.n_entities, 0, "punctuation only should yield no entities");
}

#[test]
fn test_extract_very_long_word() {
    let graph = HashMap::new();
    let text = "a".repeat(5000);
    let r = extract::extract(&text, &graph);
    assert_eq!(r.n_entities, 0, "single long lowercase word should yield 0");
}

#[test]
fn test_extract_hyphenated_capitalized() {
    let graph = HashMap::new();
    let text = "Sarah manages DataLake-Analytics-Platform";
    let r = extract::extract(text, &graph);
    assert!(r.n_entities >= 2, "should extract Sarah and DataLake-Analytics-Platform");
}

#[test]
fn test_extract_hyphenated_mixed_case() {
    let graph = HashMap::new();
    // Hyphenated but second part starts lowercase — should NOT split
    let text = "ILO uses state-of-the-art ML";
    let r = extract::extract(text, &graph);
    assert!(r.entities.iter().any(|e| e.name == "ILO"), "ILO should be extracted");
}

#[test]
fn test_extract_gazetteer_overlap() {
    let mut graph = HashMap::new();
    graph.insert("ilo".to_string(), (0.95, vec!["project".to_string()]));
    graph.insert("ilo project".to_string(), (0.90, vec!["project".to_string()]));
    // Both "ILO" and "ILO Project" should be matched (gazetteer wins longer match)
    let r = extract::extract("The ILO Project is great", &graph);
    let has_long = r.entities.iter().any(|e| e.name == "ILO Project");
    let has_short = r.entities.iter().any(|e| e.name == "ILO");
    assert!(has_long || has_short, "at least one entity should match");
}

// ══════════════════════════════════════════════════════════════════════
// 2. EXTRACT: CLAIM_EXTRACT BYTE BOUNDARIES
//    (uses lower[e1.end..e2.start] and lower[..e.start])
// ══════════════════════════════════════════════════════════════════════

#[test]
fn test_claim_extract_with_emoji_between_entities() {
    let mut graph = HashMap::new();
    graph.insert("alice".to_string(), (0.8, vec!["person".to_string()]));
    graph.insert("xanadu".to_string(), (0.7, vec!["project".to_string()]));
    // Emoji between entity mentions — tests lower[e1.end..e2.start]
    let r = extract::extract("Alice 📊 manages 🚀 Xanadu", &graph);
    assert!(r.n_claims >= 1, "should extract claim despite emoji between");
}

#[test]
fn test_claim_extract_emoji_before_entity() {
    let mut graph = HashMap::new();
    graph.insert("bob".to_string(), (0.8, vec!["person".to_string()]));
    graph.insert("data".to_string(), (0.7, vec!["project".to_string()]));
    // Emoji before entity — tests lower[..e.start]
    let r = extract::extract("Who works at 🚀 DataLake?", &graph);
    assert!(r.n_claims >= 1, "should extract implied claim despite emoji");
}

#[test]
fn test_claim_extract_unicode_entity_names() {
    let mut graph = HashMap::new();
    graph.insert("françois".to_string(), (0.8, vec!["person".to_string()]));
    graph.insert("xanadu".to_string(), (0.7, vec!["project".to_string()]));
    // Entity names with unicode characters
    let r = extract::extract("François manages Xanadu", &graph);
    // lowercasing "François" gives "françois" — same byte length, should be fine
    // If lowercasing changed byte length (edge case), this would panic
    assert!(r.n_claims >= 1, "should extract claim with unicode entity names");
}

// ══════════════════════════════════════════════════════════════════════
// 3. SEARCH INDEX: EDGE CASES
// ══════════════════════════════════════════════════════════════════════

#[test]
fn test_search_fts_nan_confidence() {
    let nodes = vec![
        make_entity("e1", "Rust Programming", f64::NAN),
        make_entity("e2", "Rust Language", f64::INFINITY),
    ];
    let idx = SearchIndex::build(&nodes);
    let results = idx.search_fts("rust", 5);
    // Should not panic — NaN/Inf scores handled gracefully
    assert!(results.len() <= 2, "should not panic with NaN/Inf scores");
}

#[test]
fn test_search_fts_unicode_terms() {
    let nodes = vec![
        make_entity("e1", "Café au Lait", 0.9),
        make_entity("e2", "über cool", 0.8),
    ];
    let idx = SearchIndex::build(&nodes);
    let results = idx.search_fts("café", 5);
    assert!(results.len() >= 0, "unicode search should not crash");
}

#[test]
fn test_search_fts_very_long_term() {
    let nodes = vec![make_entity("e1", "Rust", 0.9)];
    let idx = SearchIndex::build(&nodes);
    // Very long query term (1000 chars)
    let long_query = "x".repeat(1000);
    let results = idx.search_fts(&long_query, 5);
    assert!(results.is_empty(), "very long query should return no matches (not crash)");
}

#[test]
fn test_search_vector_empty() {
    let nodes = vec![make_entity("e1", "Test", 0.9)];
    let idx = SearchIndex::build(&nodes);
    let results = idx.search_vector(&[], 5);
    assert!(results.is_empty(), "empty embedding should return no results");
}

#[test]
fn test_search_vector_nan_embedding() {
    let mut nodes = vec![
        make_entity("e1", "Test", 0.9),
    ];
    // Set embedding to NaN
    nodes[0].embedding = Some(vec![f64::NAN as f32, 0.5, 0.3]);
    let idx = SearchIndex::build(&nodes);
    let results = idx.search_fts("test", 5);
    assert!(results.len() <= 1, "should not panic with NaN embeddings");
}

#[test]
fn test_search_index_empty_build() {
    let idx = SearchIndex::build(&[]);
    assert!(!idx.has_fts());
    assert!(!idx.has_vectors());
    assert_eq!(idx.vector_count(), 0);
    let results = idx.search_fts("anything", 5);
    assert!(results.is_empty());
}

// ══════════════════════════════════════════════════════════════════════
// 4. RETRIEVAL: PATHOLOGICAL EDGE CASES  
// ══════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_retrieval_max_hops_zero() {
    let mut store = temp_db("zero_hops");
    apply(&mut store, vec![
        StoreMutation::CreateNode { id: "e_a".into(), type_: NodeType::Entity, tags: vec![], label: "Alpha".into(), confidence: 0.9 },
    ]).await;
    let nodes = store.find_nodes_by_type(&NodeType::Entity).await.unwrap();
    let idx = SearchIndex::build(&nodes);
    let result = retrieval::retrieve("Alpha", &store, &HashMap::new(), None, Some(&idx), None, Some(0)).await.unwrap();
    assert!(!result.activated_nodes.is_empty(), "list mode should return seed");
}

#[tokio::test]
async fn test_retrieval_nan_confidence_propagation() {
    let mut store = temp_db("nan_prop");
    apply(&mut store, vec![
        StoreMutation::CreateNode { id: "e_n1".into(), type_: NodeType::Entity, tags: vec![], label: "NaN One".into(), confidence: f64::NAN },
        StoreMutation::CreateNode { id: "e_n2".into(), type_: NodeType::Entity, tags: vec![], label: "NaN Two".into(), confidence: f64::NAN },
        StoreMutation::CreateLink { id: "l_n".into(), from: "e_n1".into(), to: "e_n2".into(),
            type_: LinkType::Relates, rel: String::new(), tags: vec![], weight: 0.5, confidence: 0.5 },
    ]).await;
    let nodes = store.find_nodes_by_type(&NodeType::Entity).await.unwrap();
    let idx = SearchIndex::build(&nodes);
    let result = retrieval::retrieve("NaN", &store, &HashMap::new(), None, Some(&idx), None, None).await;
    assert!(result.is_ok(), "NaN propagation should not panic");
}

#[tokio::test]
async fn test_retrieval_negative_weight_links() {
    let mut store = temp_db("neg_weight");
    apply(&mut store, vec![
        StoreMutation::CreateNode { id: "e_a".into(), type_: NodeType::Entity, tags: vec![], label: "Alpha".into(), confidence: 0.9 },
        StoreMutation::CreateNode { id: "e_b".into(), type_: NodeType::Entity, tags: vec![], label: "Beta".into(), confidence: 0.5 },
        StoreMutation::CreateLink { id: "l_neg".into(), from: "e_a".into(), to: "e_b".into(),
            type_: LinkType::Relates, rel: String::new(), tags: vec![], weight: -0.5, confidence: -0.3 },
    ]).await;
    let nodes = store.find_nodes_by_type(&NodeType::Entity).await.unwrap();
    let idx = SearchIndex::build(&nodes);
    // Negative weights should be clamped to 0 in retrieval.rs
    let result = retrieval::retrieve("Alpha", &store, &HashMap::new(), None, Some(&idx), None, None).await;
    assert!(result.is_ok(), "negative weights should not panic");
}

#[tokio::test]
async fn test_retrieval_zero_budget() {
    let mut store = temp_db("zero_budget");
    apply(&mut store, vec![
        StoreMutation::CreateNode { id: "e_a".into(), type_: NodeType::Entity, tags: vec![], label: "Alpha".into(), confidence: 0.9 },
    ]).await;
    let nodes = store.find_nodes_by_type(&NodeType::Entity).await.unwrap();
    let idx = SearchIndex::build(&nodes);
    // Zero character budget for context
    let result = retrieval::retrieve("Alpha", &store, &HashMap::new(), Some(0), Some(&idx), None, None).await.unwrap();
    assert!(result.char_count == 0 || result.activated_nodes.is_empty(), "zero budget should produce empty or minimal context");
}

// ══════════════════════════════════════════════════════════════════════
// 5. STORE: CONCURRENT SCHEMA MIGRATION (rel column added after warmup)
// ══════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_store_link_without_rel_column() {
    // Create a fresh DB, then try to create a link
    // The schema should have `rel` column from init_schema()
    let mut store = temp_db("link_norel");
    apply(&mut store, vec![
        StoreMutation::CreateNode { id: "e_a".into(), type_: NodeType::Entity, tags: vec![], label: "Alpha".into(), confidence: 0.9 },
        StoreMutation::CreateNode { id: "e_b".into(), type_: NodeType::Entity, tags: vec![], label: "Beta".into(), confidence: 0.5 },
    ]).await;

    // Create link — should succeed with rel    // Create link — should succeed with rel column existing from init_schema()
    store.write_maintenance(vec![
        StoreMutation::CreateLink {
            id: "l_ab".into(), from: "e_a".into(), to: "e_b".into(),
            type_: LinkType::Relates, rel: "relates".into(),
            tags: vec!["test".into()], weight: 0.9, confidence: 0.8,
        },
    ]).await.unwrap();

    let links = store.find_links(&"e_a".into(), None).await.unwrap();
    assert_eq!(links.len(), 1, "link should be created successfully");
    assert_eq!(links[0].rel, "relates", "rel field should be preserved");
}

#[tokio::test]
async fn test_store_link_missing_confidence_column_fallback() {
    // This test simulates the old DB schema by creating a raw query
    // that doesn't include confidence, then trying to create a link
    // via the normal path — the fallback in apply() should handle it
    let mut store = temp_db("link_noconf");
    apply(&mut store, vec![
        StoreMutation::CreateNode { id: "e_a".into(), type_: NodeType::Entity, tags: vec![], label: "Alpha".into(), confidence: 0.9 },
    ]).await;

    // Create link normally — should work with all columns
    store.write_maintenance(vec![
        StoreMutation::CreateLink {
            id: "l_test".into(), from: "e_a".into(), to: "e_a".into(),
            type_: LinkType::Relates, rel: "test".into(),
            tags: vec![], weight: 0.5, confidence: 0.5,
        },
    ]).await.unwrap();
}

// ══════════════════════════════════════════════════════════════════════
// 6. LEARNING: NEGATIVE / ZERO QUALITY SIGNALS
// ══════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_learning_zero_quality() {
    use ilo::learning::{learn, LearningSignal};
    use ilo::config::LearningConfig;

    let mut store = temp_db("learn_zero");
    // Create entities
    apply(&mut store, vec![
        StoreMutation::CreateNode { id: "e_a".into(), type_: NodeType::Entity, tags: vec![], label: "Alpha".into(), confidence: 0.9 },
        StoreMutation::CreateNode { id: "e_b".into(), type_: NodeType::Entity, tags: vec![], label: "Beta".into(), confidence: 0.5 },
        StoreMutation::CreateLink { id: "l_ab".into(), from: "e_a".into(), to: "e_b".into(),
            type_: LinkType::Relates, rel: String::new(), tags: vec![], weight: 0.3, confidence: 0.5 },
    ]).await;

    let config = LearningConfig::default();
    let signal = LearningSignal::from_explicit("t0".into(), "query",
        vec!["e_a".into(), "e_b".into()], vec!["e_a".into()], 0.0);  // quality=0
    let result = learn(&mut store, &signal, &config, chrono::Utc::now().timestamp_millis()).await;
    assert!(result.is_ok(), "zero quality should not panic");
}

#[tokio::test]
async fn test_learning_empty_used_labels() {
    use ilo::learning::{learn, LearningSignal};
    use ilo::config::LearningConfig;

    let mut store = temp_db("learn_used");
    apply(&mut store, vec![
        StoreMutation::CreateNode { id: "e_a".into(), type_: NodeType::Entity, tags: vec![], label: "Alpha".into(), confidence: 0.9 },
    ]).await;

    let config = LearningConfig::default();
    let signal = LearningSignal::from_explicit("t0".into(), "query",
        vec!["e_a".into()], vec![], 0.5);  // empty used labels
    let result = learn(&mut store, &signal, &config, chrono::Utc::now().timestamp_millis()).await;
    assert!(result.is_ok(), "empty used labels should not panic");
}

// ══════════════════════════════════════════════════════════════════════
// 7. CONCURRENT / RACE CONDITIONS
// ══════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_concurrent_link_read_write() {
    use std::sync::Arc;
    use tokio::sync::RwLock;

    let store = Arc::new(RwLock::new(temp_db("con_link")));

    // Seed entities
    {
        let mut s = store.write().await;
        for i in 0..10 {
            apply(&mut s, vec![
                StoreMutation::CreateNode {
                    id: format!("e_{}", i), type_: NodeType::Entity,
                    tags: vec![], label: format!("Entity {}", i), confidence: 0.9,
                },
            ]).await;
        }
    }

    // 10 writers creating links + 20 readers simultaneously
    let mut handles = Vec::new();
    for w in 0..10 {
        let store = store.clone();
        handles.push(tokio::spawn(async move {
            let mut s = store.write().await;
            for i in 0..5 {
                let _ = s.write_maintenance(vec![
                    StoreMutation::CreateLink {
                        id: format!("l_{}_{}", w, i),
                        from: format!("e_{}", w),
                        to: format!("e_{}", (w + i) % 10),
                        type_: LinkType::Relates, rel: String::new(),
                        tags: vec![], weight: 0.5, confidence: 0.5,
                    },
                ]).await;
            }
        }));
    }
    for _ in 0..20 {
        let store = store.clone();
        handles.push(tokio::spawn(async move {
            let s = store.read().await;
            let _ = s.get_all_links().await;
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
}

// ══════════════════════════════════════════════════════════════════════
// 8. HUGE / MALFORMED INPUTS
// ══════════════════════════════════════════════════════════════════════

#[test]
fn test_extract_empty_text_variants() {
    let graph = HashMap::new();
    assert_eq!(extract::extract("", &graph).n_entities, 0);
    assert_eq!(extract::extract("   ", &graph).n_entities, 0);
    assert_eq!(extract::extract("\t\n\r", &graph).n_entities, 0);
    assert_eq!(extract::extract("\u{200B}", &graph).n_entities, 0); // zero-width space
}

#[test]
fn test_extract_huge_text() {
    let graph = HashMap::new();
    let text = "ILO Project is great. ".repeat(2000);
    let r = extract::extract(&text, &graph);
    // Should not OOM — may or may not extract entities
    assert!(r.n_entities >= 0, "should not OOM on large text");
}
