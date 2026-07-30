//! In-memory search index for ILO.
//!
//! Builds an FTS inverted index + vector store from the node cache.
//! No external dependencies — uses only std collections.
//!
//! FTS: builds an inverted index from node labels on startup.
//!   Tokenizes by splitting on whitespace/punctuation, lowercases,
//!   builds postings lists, scores with TF/BM25.
//!
//! Vector: stores node embeddings in a HashMap, returns top-K
//!   by cosine similarity. O(n) scan — fine for <10K nodes.
//!
//! Both are rebuilt on every cache warm (on startup, after writes).
//! At current scale (<1K entities) this is <1ms.

use crate::types::{STOP_WORDS, *};
use std::collections::HashMap;

// ── Constants ───────────────────────────────────────────────────────

const K1: f64 = 1.2; // BM25 saturation
const B: f64 = 0.75; // BM25 length normalization
const MIN_TERM_LEN: usize = 1;

/// In-memory search index rebuilt from the node cache.
///
/// Two sub-indexes:
/// - `inverted_index`: term → list of (node_id, term_frequency_in_label)
/// - `embeddings`: node_id → embedding vector
pub struct SearchIndex {
    /// FTS inverted index: term → [(node_id, term_frequency)]
    inverted_index: HashMap<String, Vec<(NodeId, f64)>>,
    /// Document frequency per term: term → how many nodes contain it
    df: HashMap<String, f64>,
    /// Average label length (for BM25 length normalization)
    avg_label_len: f64,
    /// Total nodes indexed
    total_docs: usize,

    /// Vector store: node_id → embedding
    embeddings: HashMap<NodeId, Vec<f32>>,
    /// Full node records keyed by id (preserves type, tags, timestamps)
    nodes: HashMap<NodeId, NodeRecord>,
}

impl SearchIndex {
    /// Build a new search index from a list of node records.
    ///
    /// Called on startup (warm_cache) and after write_batch.
    /// At current scale (<1K nodes), this completes in <1ms.
    pub fn build(nodes: &[NodeRecord]) -> Self {
        let mut inverted_index: HashMap<String, Vec<(NodeId, f64)>> = HashMap::new();
        let mut df: HashMap<String, f64> = HashMap::new();
        let mut total_label_len = 0usize;
        let total_docs = nodes.len();
        let mut embeddings = HashMap::new();
        let mut nodes_map = HashMap::new();

        for node in nodes {
            nodes_map.insert(node.id.clone(), node.clone());
            total_label_len += node.label.len();

            // Index embeddings
            if let Some(ref emb) = node.embedding {
                embeddings.insert(node.id.clone(), emb.clone());
            }

            // Tokenize label for FTS
            let terms = tokenize(&node.label);
            let mut term_count: HashMap<String, f64> = HashMap::new();
            for term in &terms {
                *term_count.entry(term.clone()).or_insert(0.0) += 1.0;
            }

            for (term, tf) in term_count {
                inverted_index
                    .entry(term.clone())
                    .or_default()
                    .push((node.id.clone(), tf));
                *df.entry(term).or_insert(0.0) += 1.0;
            }
        }

        let avg_label_len = if total_docs > 0 {
            total_label_len as f64 / total_docs as f64
        } else {
            1.0
        };

        SearchIndex {
            inverted_index,
            df,
            avg_label_len,
            total_docs,
            embeddings,
            nodes: nodes_map,
        }
    }

    /// FTS search — returns seeds scored by BM25.
    ///
    /// Phase 0 in the seed chain. Scores are normalized to 0.0-1.0
    /// by dividing BM25 scores by the top score.
    pub fn search_fts(&self, query: &str, limit: usize) -> Vec<Seed> {
        if self.total_docs == 0 {
            return vec![];
        }

        let query_terms = tokenize(query);
        if query_terms.is_empty() {
            return vec![];
        }

        // Score each matching document with BM25
        let mut scores: HashMap<NodeId, (f64, &str)> = HashMap::new();

        for term in &query_terms {
            if let Some(postings) = self.inverted_index.get(term) {
                let df_term = self.df.get(term).copied().unwrap_or(1.0);
                let idf = ((self.total_docs as f64 - df_term + 0.5) / (df_term + 0.5) + 1.0).ln();

                for (node_id, tf) in postings {
                    let label_len = self
                        .nodes
                        .get(node_id)
                        .map(|n| n.label.len() as f64)
                        .unwrap_or(self.avg_label_len);
                    let norm = 1.0 - B + B * (label_len / self.avg_label_len);
                    let bm25 = idf * (tf * (K1 + 1.0)) / (tf + K1 * norm);

                    let entry = scores.entry(node_id.clone()).or_insert((0.0, ""));
                    entry.0 += bm25;
                    // Prefer the first-discovered label (longest match tends to win)
                    if entry.1.is_empty() {
                        if let Some(node) = self.nodes.get(node_id) {
                            entry.1 = &node.label;
                        }
                    }
                }
            }
        }

        // Sort by score descending, take top N
        let mut results: Vec<(f64, &NodeId, &str)> = scores
            .iter()
            .map(|(id, (score, label))| (*score, id, *label))
            .collect();
        results.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

        let top_score = results.first().map(|r| r.0).unwrap_or(1.0);
        let top_score = if top_score > 0.0 { top_score } else { 1.0 };

        results
            .into_iter()
            .take(limit)
            .map(|(score, id, label)| Seed {
                node_id: id.clone(),
                match_score: (score / top_score).min(1.0).max(0.1),
                label: label.to_string(),
            })
            .collect()
    }

    /// Vector search — returns seeds by cosine similarity to query_emb.
    ///
    /// Phase 0.5 in seed chain. Scores are cosine similarity (0.0-1.0).
    /// Requires nodes to have embeddings populated (see `/remember`).
    pub fn search_vector(&self, query_emb: &[f32], limit: usize) -> Vec<Seed> {
        if self.embeddings.is_empty() || query_emb.is_empty() {
            return vec![];
        }

        let query_norm = vector_norm(query_emb);
        if query_norm == 0.0 {
            return vec![];
        }

        let mut results: Vec<(f64, &NodeId)> = Vec::new();

        for (node_id, node_emb) in &self.embeddings {
            let dot: f32 = query_emb
                .iter()
                .zip(node_emb.iter())
                .map(|(a, b)| a * b)
                .sum();
            let node_norm = vector_norm(node_emb);
            let cosine = if node_norm > 0.0 {
                (dot / (query_norm * node_norm)) as f64
            } else {
                0.0
            };
            // Cosine similarity -> [0, 1] (clamp from [-1, 1])
            let score = ((cosine + 1.0) / 2.0).clamp(0.0, 1.0);
            results.push((score, node_id));
        }

        results.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

        results
            .into_iter()
            .take(limit)
            .map(|(score, id)| Seed {
                node_id: id.clone(),
                match_score: score,
                label: self
                    .nodes
                    .get(id)
                    .map(|n| n.label.clone())
                    .unwrap_or_default(),
            })
            .collect()
    }

    /// Check whether FTS has any terms indexed.
    pub fn has_fts(&self) -> bool {
        !self.inverted_index.is_empty()
    }

    /// Check whether any embeddings are indexed.
    pub fn has_vectors(&self) -> bool {
        !self.embeddings.is_empty()
    }

    /// Number of embeddings stored.
    pub fn vector_count(&self) -> usize {
        self.embeddings.len()
    }

    /// Merge new nodes into the index (rebuild from full cache + new nodes).
    ///
    /// For simplicity, this rebuilds the entire index from scratch.
    /// At current scale (<1K nodes), this is <1ms even on every write.
    /// Preserves the original NodeRecord data (type, tags, timestamps).
    pub fn merge(&mut self, new_nodes: &[NodeRecord]) {
        let mut all_nodes: Vec<NodeRecord> = Vec::with_capacity(self.nodes.len() + new_nodes.len());

        for node in self.nodes.values() {
            all_nodes.push(node.clone());
        }
        all_nodes.extend_from_slice(new_nodes);

        *self = Self::build(&all_nodes);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────

/// Tokenize text into lowercase, stemmed-like terms.
/// Splits on whitespace/punctuation, drops short/stop words.
fn tokenize(text: &str) -> Vec<String> {
    text.split_whitespace()
        .flat_map(|w| w.split(|c: char| c.is_ascii_punctuation() && c != '-' && c != '_'))
        .map(|w| w.to_lowercase())
        .filter(|w| {
            let trimmed = w.trim();
            trimmed.len() >= MIN_TERM_LEN
                && !STOP_WORDS.contains(&trimmed)
                && trimmed.chars().any(|c| c.is_alphanumeric())
        })
        .map(|w| w.trim().to_string())
        .collect()
}

/// Compute L2 norm of a float vector.
fn vector_norm(v: &[f32]) -> f32 {
    v.iter().map(|x| x * x).sum::<f32>().sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_node(id: &str, label: &str, confidence: f64) -> NodeRecord {
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

    #[test]
    fn test_fts_finds_label_match() {
        let nodes = vec![
            make_node("e_ailo", "Ailo", 0.9),
            make_node("e_rust", "Rust", 0.8),
            make_node("e_python", "Python", 0.7),
        ];
        let index = SearchIndex::build(&nodes);
        let results = index.search_fts("ailo", 5);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].node_id, "e_ailo");
    }

    #[test]
    fn test_fts_multi_word_query() {
        let nodes = vec![
            make_node("e_ailo", "Ailo Assistant", 0.9),
            make_node("e_rust", "Rust Language", 0.8),
            make_node("e_py", "Python Programming Language", 0.7),
        ];
        let index = SearchIndex::build(&nodes);
        let results = index.search_fts("rust language", 5);
        assert!(results.iter().any(|s| s.node_id == "e_rust"));
    }

    #[test]
    fn test_fts_returns_empty_for_no_match() {
        let nodes = vec![make_node("e_ailo", "Ailo", 0.9)];
        let index = SearchIndex::build(&nodes);
        let results = index.search_fts("nonexistent", 5);
        assert!(results.is_empty());
    }

    #[test]
    fn test_fts_ranks_exact_higher() {
        let nodes = vec![
            make_node("e_ailo", "Ailo Project", 0.9),
            make_node("e_other", "Another Project Tool", 0.8),
        ];
        let index = SearchIndex::build(&nodes);
        let results = index.search_fts("ailo", 5);
        assert_eq!(results[0].node_id, "e_ailo");
    }

    #[test]
    fn test_vector_no_embeddings_returns_empty() {
        let nodes = vec![make_node("e_ailo", "Ailo", 0.9)];
        let index = SearchIndex::build(&nodes);
        let results = index.search_vector(&[0.1, 0.2, 0.3], 5);
        assert!(results.is_empty());
    }

    #[test]
    fn test_vector_with_embeddings() {
        let nodes = vec![
            NodeRecord {
                id: "e_ailo".to_string(),
                type_: NodeType::Entity,
                tags: vec![],
                label: "Ailo".to_string(),
                confidence: 0.9,
                embedding: Some(vec![1.0, 0.0, 0.0]),
                created_at: chrono::Utc::now().naive_utc(),
                updated_at: chrono::Utc::now().naive_utc(),
            },
            NodeRecord {
                id: "e_other".to_string(),
                type_: NodeType::Entity,
                tags: vec![],
                label: "Other".to_string(),
                confidence: 0.5,
                embedding: Some(vec![0.0, 1.0, 0.0]),
                created_at: chrono::Utc::now().naive_utc(),
                updated_at: chrono::Utc::now().naive_utc(),
            },
        ];
        let index = SearchIndex::build(&nodes);
        // Query vector matches first node exactly
        let results = index.search_vector(&[1.0, 0.0, 0.0], 5);
        assert!(!results.is_empty());
        assert_eq!(results[0].node_id, "e_ailo");
        assert!(results[0].match_score > 0.9);
    }

    #[test]
    fn test_tokenize_drops_stop_words() {
        let tokens = tokenize("the and for rust");
        assert_eq!(tokens, vec!["rust"]);
    }

    #[test]
    fn test_tokenize_splits_punctuation() {
        let tokens = tokenize("Ailo's Project - Rust");
        assert!(tokens.iter().any(|t| t == "ailo"));
        assert!(tokens.iter().any(|t| t == "project"));
        assert!(tokens.iter().any(|t| t == "rust"));
        // Standalone hyphen is filtered (non-alphanumeric)
        assert!(!tokens.iter().any(|t| t == "-"));
        // C++ query — keeps "c" due to MIN_TERM_LEN=1
        let tokens2 = tokenize("C++");
        assert!(tokens2.iter().any(|t| t == "c"));
    }

    #[test]
    fn test_empty_index_returns_empty() {
        let index = SearchIndex::build(&[]);
        assert!(index.search_fts("test", 5).is_empty());
        assert!(index.search_vector(&[1.0, 0.0], 5).is_empty());
    }

    #[test]
    fn test_merge_preserves_existing_entries() {
        let nodes = vec![make_node("e_ailo", "Ailo", 0.9)];
        let mut index = SearchIndex::build(&nodes);
        let new_nodes = vec![make_node("e_rust", "Rust", 0.8)];
        index.merge(&new_nodes);
        assert_eq!(index.nodes.len(), 2);
        let results = index.search_fts("rust", 5);
        assert_eq!(results.len(), 1);
    }
}
