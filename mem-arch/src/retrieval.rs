//! Retrieval — async 3-factor PPR algorithm using the Store trait.
//!
//! Seed chain (in order):
//!   0. FTS search (if SearchIndex provided)
//!   0.5 Vector search (if SearchIndex has embeddings)
//!   1. Exact label match
//!   2. Substring label match
//!   3. Tag/subtype fallback
//!   4. Recency fallback (implicit — handled upstream)

use crate::search::SearchIndex;
use crate::store::Store;
use crate::types::*;
use std::collections::{HashMap, HashSet};

const MAX_HOPS: u8 = 4;
const MIN_SCORE: f64 = 0.02;
const CONTEXT_BUDGET: usize = 8000;

const STOP_WORDS: [&str; 28] = ["the","and","for","about","with","tell","what",
    "how","why","when","are","but","not","all","can","has","had",
    "was","were","its","their","you","your","just","also","very","too","than"];

pub async fn retrieve(
    query: &str,
    store: &impl Store,
    tag_index: &HashMap<String, Vec<NodeId>>,
    budget: Option<usize>,
    search_index: Option<&SearchIndex>,
    query_embedding: Option<&[f32]>,
    max_hops: Option<u8>,
) -> Result<ContextBlock, StoreError> {
    let max_chars = budget.unwrap_or(CONTEXT_BUDGET);
    let hops = max_hops.unwrap_or(MAX_HOPS);
    let seeds = find_seeds(query, tag_index, store, search_index, query_embedding).await;
    if seeds.is_empty() {
        return Ok(ContextBlock { anchor_text: String::new(), activated_nodes: vec![], char_count: 0 });
    }
    let activated = if hops == 0 {
        // List mode: skip graph expansion, return seeds as activated nodes
        let mut nodes = Vec::new();
        for seed in &seeds {
            if let Ok(Some(node)) = store.get_node(&seed.node_id).await {
                nodes.push(ActivatedNode {
                    node_id: node.id.clone(),
                    label: node.label,
                    node_type: node.type_,
                    activation: seed.match_score,
                    depth: 0,
                    path: vec![seed.node_id.clone()],
                    properties: store.get_all_properties(&seed.node_id).await.unwrap_or_default()
                        .into_iter().map(|p| (p.key.clone(), p.value)).collect(),
                });
            }
        }
        nodes
    } else {
        expand_frontier(&seeds, store, query, hops).await?
    };
    let text = assemble_context(&activated, query, max_chars);
    let char_count = text.len();
    Ok(ContextBlock { anchor_text: text, activated_nodes: activated, char_count })
}

async fn find_seeds(
    query: &str,
    tag_index: &HashMap<String, Vec<NodeId>>,
    store: &impl Store,
    search_index: Option<&SearchIndex>,
    query_embedding: Option<&[f32]>,
) -> Vec<Seed> {
    let q = query.to_lowercase();
    
    // Extract meaningful words from query
    let words: Vec<&str> = q.split_whitespace()
        .map(|w| w.trim_matches(|c: char| c.is_ascii_punctuation()))
        .filter(|w| w.len() > 2 && !STOP_WORDS.contains(w))
        .collect();

    if words.is_empty() { return vec![]; }

    // Phase 0: FTS search via SearchIndex (score: BM25 normalized 0.1-1.0)
    if let Some(idx) = search_index {
        if idx.has_fts() {
            let fts_seeds = idx.search_fts(query, 10);
            if !fts_seeds.is_empty() {
                return fts_seeds;
            }
        }
    }

    // Phase 0.5: Vector search via SearchIndex (score: cosine similarity 0.0-1.0)
    if let Some(idx) = search_index {
        if idx.has_vectors() {
            if let Some(q_emb) = query_embedding {
                let vec_seeds = idx.search_vector(q_emb, 10);
                if !vec_seeds.is_empty() {
                    return vec_seeds;
                }
            }
        }
    }

    // Phase 1: Exact label match per word (score 1.0)
    let mut seeds: Vec<Seed> = Vec::new();
    for word in &words {
        if let Ok(nodes) = store.find_nodes(&NodeQuery {
            type_: Some(NodeType::Entity),
            tags: vec![],
            label_contains: Some(word.to_string()),
            limit: 10,
        }).await {
            for node in nodes {
                if node.label.to_lowercase() == *word {
                    seeds.push(Seed {
                        node_id: node.id,
                        match_score: 1.0,
                        label: node.label,
                    });
                }
            }
        }
    }
    // Deduplicate by node_id (same entity might match multiple words)
    let mut seen: std::collections::HashSet<NodeId> = std::collections::HashSet::new();
    seeds.retain(|s| seen.insert(s.node_id.clone()));
    if !seeds.is_empty() { return seeds; }

    // Phase 2: Substring label match per word (score 0.7)
    for word in &words {
        if let Ok(nodes) = store.find_nodes(&NodeQuery {
            type_: Some(NodeType::Entity),
            tags: vec![],
            label_contains: Some(word.to_string()),
            limit: 10,
        }).await {
            for node in nodes {
                seeds.push(Seed {
                    node_id: node.id,
                    match_score: 0.7,
                    label: node.label,
                });
            }
        }
    }
    seeds.retain(|s| seen.insert(s.node_id.clone()));
    if !seeds.is_empty() { return seeds; }

    // Phase 3: Tag fallback — any tag in the index works
    for word in &words {
        let tag = word.trim_end_matches('s');
        if let Some(ids) = tag_index.get(tag) {
            return ids.iter().map(|id| Seed {
                node_id: id.clone(),
                match_score: 0.3,
                label: String::new(),
            }).collect();
        }
    }
    vec![]
}

async fn expand_frontier(
    seeds: &[Seed],
    store: &impl Store,
    query: &str,
    max_hops: u8,
) -> Result<Vec<ActivatedNode>, StoreError> {
    let mut activation: HashMap<NodeId, f64> = HashMap::new();
    let mut depths: HashMap<NodeId, u8> = HashMap::new();
    let mut paths: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
    let mut fired: HashSet<NodeId> = HashSet::new();

    for seed in seeds {
        activation.insert(seed.node_id.clone(), seed.match_score);
        depths.insert(seed.node_id.clone(), 0);
        paths.insert(seed.node_id.clone(), vec![seed.node_id.clone()]);
    }

    for _hop in 1..=max_hops {
        let mut next_act: HashMap<NodeId, f64> = HashMap::new();
        let mut next_depth: HashMap<NodeId, u8> = HashMap::new();
        let mut next_path: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
        let mut new_nodes: HashSet<NodeId> = HashSet::new();

        for (nid, energy) in &activation {
            if *energy < MIN_SCORE || fired.contains(nid) { continue; }
            fired.insert(nid.clone());

            let outgoing = store.find_links(nid, None).await?;
            let incoming = store.find_links_to(nid, None).await?;
            let all_edges: Vec<&LinkRecord> = outgoing.iter().chain(incoming.iter()).collect();
            if all_edges.is_empty() { continue; }
            // Weight-aware normalization: use sum of weights instead of fan count.
            // This prevents low-weight edges (Context at 0.5) from diluting
            // high-weight signal (Evidence at 1.0) on hub nodes with many edges.
            let sum_weight: f64 = all_edges.iter().map(|l| l.weight).sum();
            // Guard against div-by-zero: if all weights are 0, treat each edge equally.
            let norm = if sum_weight > 0.0 { sum_weight } else { all_edges.len() as f64 };

            for link in &all_edges {
                let fwd = link.from == *nid;
                let target = if fwd { &link.to } else { &link.from };
                if target == nid { continue; }
                let d = if fwd { 1.0 } else { 0.5 };
                let t_node = match store.get_node(target).await? { Some(n) => n, None => continue };
                // Guard against NaN confidence or weight — treat as 0.
                let weight = if link.weight.is_finite() && link.weight >= 0.0 { link.weight } else { 0.0 };
                let conf = if t_node.confidence.is_finite() && t_node.confidence >= 0.0 { t_node.confidence } else { 0.0 };
                let product = conf * label_sim(query, &t_node.label, &t_node.type_);
                let prop = *energy * weight * product * d / norm;
                if prop < MIN_SCORE { continue; }
                *next_act.entry(target.clone()).or_insert(0.0) += prop;
                let cd = depths.get(nid).copied().unwrap_or(0) + 1;
                if cd < *next_depth.get(target).unwrap_or(&u8::MAX) {
                    next_depth.insert(target.clone(), cd);
                    if let Some(pp) = paths.get(nid) {
                        let mut np = pp.clone(); np.push(target.clone()); next_path.insert(target.clone(), np);
                    }
                }
                new_nodes.insert(target.clone());
            }
        }

        let mut sorted: Vec<(NodeId, f64)> = next_act.clone().into_iter().collect();
        sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        if sorted.len() > 8 {
            let top = sorted[7].1;
            for (i, (ni, en)) in sorted.iter().enumerate() {
                if i >= 8 {
                    let d = next_depth.get(ni).copied().unwrap_or(1);
                    let df = if d >= 3 { 0.3 } else { 1.0 };
                    let inh = (top - en) * 0.3 * df;
                    next_act.insert(ni.clone(), (*en - inh).max(0.0));
                }
            }
        }
        for (ni, en) in &next_act {
            if *en >= MIN_SCORE {
                // Use max() to preserve seed activation values — a seed with
                // match_score=1.0 shouldn't be overwritten by back-propagation
                // from its neighbors (which would give a much lower score).
                activation.entry(ni.clone()).and_modify(|e| *e = (*e).max(*en)).or_insert(*en);
                if let Some(d) = next_depth.get(ni) { depths.insert(ni.clone(), *d); }
                if let Some(p) = next_path.get(ni) { paths.insert(ni.clone(), p.clone()); }
            }
        }
        if new_nodes.is_empty() { break; }
    }

    let mut results: Vec<ActivatedNode> = Vec::new();
    for (nid, act) in &activation {
        if let Some(node) = store.get_node(nid).await? {
            let props = store.get_all_properties(nid).await?.into_iter().map(|p| (p.key.clone(), p.value)).collect();
            results.push(ActivatedNode {
                node_id: nid.clone(),
                label: node.label,
                node_type: node.type_,
                activation: *act,
                depth: depths.get(nid).copied().unwrap_or(0),
                path: paths.get(nid).cloned().unwrap_or_default(),
                properties: props,
            });
        }
    }
    results.sort_by(|a, b| b.activation.partial_cmp(&a.activation).unwrap_or(std::cmp::Ordering::Equal));
    Ok(results)
}

fn label_sim(query: &str, label: &str, _node_type: &NodeType) -> f64 {
    let q = query.to_lowercase();
    let l = label.to_lowercase();
    if q == l { return 1.0; }
    if l.contains(&q) || q.contains(&l) { return 0.6; }
    let qw: HashSet<&str> = q.split_whitespace().collect();
    let lw: HashSet<&str> = l.split_whitespace().collect();
    let overlap: HashSet<&&str> = qw.intersection(&lw).collect();
    if !overlap.is_empty() { return 0.4; }
    0.2
}

fn assemble_context(nodes: &[ActivatedNode], query: &str, max_chars: usize) -> String {
    let mut parts = vec![];
    parts.push(format!("@session [query: {}]", query));
    parts.push(format!("  [nodes: {}]", nodes.len()));
    parts.push(String::new());

    let seeds: Vec<&ActivatedNode> = nodes.iter().filter(|n| n.depth == 0).collect();
    if !seeds.is_empty() {
        parts.push("# Focus:".to_string());
        for n in &seeds {
            parts.push(format!("  {} [confidence: {:.2}]", n.label, n.activation));
        }
        parts.push(String::new());
    }

    let entities: Vec<&ActivatedNode> = nodes.iter().filter(|n| n.node_type == NodeType::Entity && n.depth > 0).collect();
    if !entities.is_empty() {
        parts.push("# Related:".to_string());
        for n in entities.iter().take(15) {
            parts.push(format!("  {} [rel: {:.2}]", n.label, n.activation));
        }
        parts.push(String::new());
    }

    let mut text = parts.join("\n");
    if text.len() > max_chars {
        // Find the nearest UTF-8 char boundary — truncating mid-char panics
        let mut boundary = max_chars;
        while !text.is_char_boundary(boundary) { boundary -= 1; }
        text.truncate(boundary);
        text.push_str("\n...");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock_store::MockStore;

    // ── label_sim tests ────────────────────────────────

    #[test]
    fn test_label_sim_exact_match() {
        assert!((label_sim("Ailo", "Ailo", &NodeType::Entity) - 1.0).abs() < 0.01);
    }

    #[test]
    fn test_label_sim_contains() {
        assert!((label_sim("Ailo", "Ailo Project", &NodeType::Entity) - 0.6).abs() < 0.01);
        assert!((label_sim("Ailo Project", "Ailo", &NodeType::Entity) - 0.6).abs() < 0.01);
    }

    #[test]
    fn test_label_sim_word_overlap() {
        assert!((label_sim("Rust lang", "Rust programming", &NodeType::Entity) - 0.4).abs() < 0.01);
    }

    #[test]
    fn test_label_sim_no_match() {
        assert!((label_sim("Python", "Rust", &NodeType::Entity) - 0.2).abs() < 0.01);
    }

    #[test]
    fn test_label_sim_case_insensitive() {
        assert!((label_sim("ailo", "AILO", &NodeType::Entity) - 1.0).abs() < 0.01);
    }

    // ── assemble_context tests ──────────────────────────

    fn make_activated(id: &str, label: &str, node_type: NodeType, activation: f64, depth: u8) -> ActivatedNode {
        ActivatedNode {
            node_id: id.to_string(), label: label.to_string(), node_type,
            activation, depth, path: vec![], properties: HashMap::new(),
        }
    }

    #[test]
    fn test_context_empty_nodes() {
        let ctx = assemble_context(&[], "test", 8000);
        assert!(ctx.contains("@session [query: test]"));
        assert!(ctx.contains("[nodes: 0]"));
        assert!(!ctx.contains("# Focus"));
    }

    #[test]
    fn test_context_with_focus_and_related() {
        let nodes = vec![
            make_activated("e1", "Ailo", NodeType::Entity, 0.95, 0),
            make_activated("e2", "Rust", NodeType::Entity, 0.45, 1),
        ];
        let ctx = assemble_context(&nodes, "Ailo", 8000);
        assert!(ctx.contains("# Focus:"));
        assert!(ctx.contains("Ailo [confidence: 0.95]"));
        assert!(ctx.contains("# Related:"));
        assert!(ctx.contains("Rust [rel: 0.45]"));
    }

    #[test]
    fn test_context_truncation() {
        let nodes = vec![
            make_activated("e1", "Ailo Project", NodeType::Entity, 0.95, 0),
            make_activated("e2", "Rust Programming Language", NodeType::Entity, 0.45, 1),
        ];
        let ctx = assemble_context(&nodes, "Ailo", 50);
        assert!(ctx.len() <= 55); // 50 + "\n..." = 54
        assert!(ctx.ends_with("..."));
    }

    // ── find_seeds tests ───────────────────────────────

    #[tokio::test]
    async fn test_find_seeds_exact_match() {
        let store = MockStore::new();
        let tag_idx = HashMap::new();
        store.add_entity("e_ailo", "Ailo", 0.9, vec![]);
        store.add_entity("e_rust", "Rust", 0.8, vec![]);

        let seeds = find_seeds("Ailo", &tag_idx, &store, None, None).await;
        assert_eq!(seeds.len(), 1);
        assert_eq!(seeds[0].node_id, "e_ailo");
        assert!((seeds[0].match_score - 1.0).abs() < 0.01);
    }

    #[tokio::test]
    async fn test_find_seeds_substring_match() {
        let store = MockStore::new();
        let tag_idx = HashMap::new();
        store.add_entity("e_rust", "Rust Programming", 0.9, vec![]);

        let seeds = find_seeds("Rust", &tag_idx, &store, None, None).await;
        assert!(!seeds.is_empty());
    }

    #[tokio::test]
    async fn test_find_seeds_no_match() {
        let store = MockStore::new();
        let tag_idx = HashMap::new();
        store.add_entity("e_ailo", "Ailo", 0.9, vec![]);

        let seeds = find_seeds("Nonexistent", &tag_idx, &store, None, None).await;
        assert!(seeds.is_empty());
    }

    #[tokio::test]
    async fn test_find_seeds_stop_words_only() {
        let store = MockStore::new();
        let tag_idx = HashMap::new();
        store.add_entity("e_test", "Test", 0.9, vec![]);

        let seeds = find_seeds("the and for", &tag_idx, &store, None, None).await;
        assert!(seeds.is_empty());
    }

    #[tokio::test]
    async fn test_find_seeds_multi_word() {
        let store = MockStore::new();
        let tag_idx = HashMap::new();
        store.add_entity("e_ailo", "Ailo", 0.9, vec![]);
        store.add_entity("e_rust", "Rust", 0.8, vec![]);

        let seeds = find_seeds("Ailo Rust", &tag_idx, &store, None, None).await;
        assert!(!seeds.is_empty());
    }

    // ── expand_frontier tests ───────────────────────────

    #[tokio::test]
    async fn test_expand_single_hop() {
        let store = MockStore::new();
        store.add_entity("e_ailo", "Ailo", 0.9, vec![]);
        store.add_entity("e_rust", "Rust", 0.8, vec![]);
        store.add_link("l1", "e_ailo", "e_rust", LinkType::Relates, "", 0.8, 0.5);

        let seeds = vec![Seed { node_id: "e_ailo".into(), match_score: 1.0, label: "Ailo".into() }];
        let result = expand_frontier(&seeds, &store, "Ailo", 4).await.unwrap();
        assert!(result.len() >= 2); // seed + 1 hop
        assert!(result.iter().any(|n| n.node_id == "e_ailo"));
        assert!(result.iter().any(|n| n.node_id == "e_rust"));
    }

    #[tokio::test]
    async fn test_expand_no_edges() {
        let store = MockStore::new();
        store.add_entity("e_ailo", "Ailo", 0.9, vec![]);

        let seeds = vec![Seed { node_id: "e_ailo".into(), match_score: 1.0, label: "Ailo".into() }];
        let result = expand_frontier(&seeds, &store, "Ailo", 4).await.unwrap();
        assert_eq!(result.len(), 1); // just the seed
    }

    #[tokio::test]
    async fn test_expand_low_weight_filtered() {
        let store = MockStore::new();
        store.add_entity("e_ailo", "Ailo", 0.9, vec![]);
        store.add_entity("e_rust", "Rust", 0.8, vec![]);
        // weight=0.01 link, but it's the only edge — weight-aware normalization
        // means it gets full energy (weight/sum_weight = 1.0).
        // The product confidence*label_sim = 0.8*0.2 = 0.16, so prop = 0.16,
        // well above MIN_SCORE. This is correct: a single weak edge with
        // no competition still propagates.
        store.add_link("l1", "e_ailo", "e_rust", LinkType::Relates, "", 0.01, 0.5);

        let seeds = vec![Seed { node_id: "e_ailo".into(), match_score: 1.0, label: "Ailo".into() }];
        let result = expand_frontier(&seeds, &store, "Ailo", 4).await.unwrap();
        assert_eq!(result.len(), 2); // seed + 1 hop via weak-but-only link
    }

    // ── retrieve integration tests ──────────────────────

    #[tokio::test]
    async fn test_retrieve_empty_query() {
        let store = MockStore::new();
        let tag_idx = HashMap::new();
        let result = retrieve("", &store, &tag_idx, None, None, None, None).await.unwrap();
        assert!(result.activated_nodes.is_empty());
        assert!(result.anchor_text.is_empty());
    }

    #[tokio::test]
    async fn test_retrieve_with_data() {
        let store = MockStore::new();
        let tag_idx = HashMap::new();
        store.add_entity("e_ailo", "Ailo", 0.9, vec![]);
        store.add_entity("e_rust", "Rust", 0.8, vec![]);
        store.add_link("l1", "e_ailo", "e_rust", LinkType::Relates, "", 0.8, 0.5);

        let result = retrieve("Ailo", &store, &tag_idx, Some(8000), None, None, None).await.unwrap();
        assert!(!result.activated_nodes.is_empty());
        assert!(result.anchor_text.contains("Ailo"));
        assert!(result.char_count > 0);
    }
}
