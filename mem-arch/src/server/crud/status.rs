use std::sync::Arc;
use axum::{Json, Extension};
use mem_arch::store::Store;
use mem_arch::types::NodeType;
use super::super::AppState;

/// GET /status  — Health + counts
pub async fn status(
    Extension(state): Extension<Arc<AppState>>,
) -> Json<serde_json::Value> {
    let store = state.store.read().await;
    let entities = store.find_nodes_by_type(&NodeType::Entity).await.unwrap_or_default().len();
    let claims = store.find_nodes_by_type(&NodeType::Claim).await.unwrap_or_default().len();
    let turns = store.find_nodes_by_type(&NodeType::Turn).await.unwrap_or_default().len();
    let links = store.get_all_links().await.unwrap_or_default().len();
    let db_ok = store.get_tag_index().await.is_ok();

    Json(serde_json::json!({
        "status": if db_ok { "ok" } else { "degraded" },
        "version": "0.1.0",
        "uptime_secs": super::super::router::START_TIME.elapsed().as_secs(),
        "counts": { "entities": entities, "claims": claims, "turns": turns, "links": links },
    }))
}
