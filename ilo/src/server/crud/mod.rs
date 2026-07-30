//! REST CRUD handlers — split by resource.
//! See individual modules for endpoint implementations.

pub mod entity_handlers;
pub mod claim_handlers;
pub mod link_handlers;
pub mod batch;
pub mod status;

pub use entity_handlers::*;
pub use claim_handlers::*;
pub use link_handlers::*;
pub use batch::*;
pub use status::*;

use std::sync::Arc;
use ilo::types::*;
use ilo::store::Store;
use super::AppState;

/// Generate embeddings for newly created entities and store them on the Node table.
/// Shared between `create_entities` and `batch` to avoid duplication.
pub async fn store_entity_embeddings(
    state: &Arc<AppState>,
    created_ids: &[String],
    all_entities: &[super::types::EntityInput],
) {
    if created_ids.is_empty() || all_entities.is_empty() {
        return;
    }

    // Only embed entities that were actually created (by index range)
    let max_idx = created_ids.len().min(all_entities.len());
    let mut embeddings: Vec<Option<Vec<f32>>> = Vec::with_capacity(max_idx);
    for i in 0..max_idx {
        embeddings.push(ilo::embed::embed(&all_entities[i].label, false).await);
    }

    let store = state.store.read().await;
    for (i, eid) in created_ids.iter().enumerate().take(max_idx) {
        if let Some(Some(ref emb)) = embeddings.get(i) {
            if !emb.is_empty() && emb.iter().any(|x| *x != 0.0) {
                let emb_str: String = emb.iter()
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                let _ = store.raw_query(&format!(
                    "MATCH (n:Node {{id: '{}'}}) SET n.embedding = [{}]",
                    eid.replace('\'', "''"), emb_str
                )).await;
            }
        }
    }
    drop(store);
}

/// Rebuild the in-memory search index to include new entities.
pub async fn rebuild_search_index(state: &Arc<AppState>) {
    if let Ok(nodes) = state.store.read().await.find_nodes_by_type(&NodeType::Entity).await {
        state.search_index.write().await.merge(&nodes);
    }
}

/// Format a NaiveDateTime to ISO-8601 string (repeated across handlers).
pub fn format_timestamp(ts: &chrono::NaiveDateTime) -> String {
    ts.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// Resolve link type string or default to "relates".
pub fn parse_link_type(s: Option<&str>) -> LinkType {
    s.and_then(|s| s.parse::<LinkType>().ok()).unwrap_or(LinkType::Relates)
}
