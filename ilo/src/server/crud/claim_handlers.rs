use std::collections::HashMap;
use std::sync::Arc;
use axum::{Json, Extension, extract::Path, http::StatusCode, response::IntoResponse};
use ilo::store::Store;
use ilo::types::*;
use super::super::AppState;
use super::super::helpers::{build_claim_mutations, json_to_propvalue};
use super::super::types::{ClaimCreateReq, ClaimUpdateReq, ClaimCreateResp, ClaimDetailResp, EntitySummary};
use super::format_timestamp;

/// POST /claims  — Create claims
pub async fn create_claims(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<ClaimCreateReq>,
) -> impl IntoResponse {
    let mut entity_ids = HashMap::new();
    let mutations = {
        let store = state.store.read().await;
        build_claim_mutations(&store, &req.claims, &mut entity_ids).await
    };

    let created_ids: Vec<String> = mutations.iter().filter_map(|m| {
        if let StoreMutation::CreateNode { id, type_, .. } = m {
            if *type_ == NodeType::Claim { Some(id.clone()) } else { None }
        } else { None }
    }).collect();

    match state.store.write().await.write_maintenance(mutations).await {
        Ok(()) => (StatusCode::OK, Json(ClaimCreateResp { created: created_ids.clone(), count: created_ids.len() })).into_response(),
        Err(e) => {
            tracing::error!("create_claims write failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

/// GET /claims/{id}  — Get claim with entities
pub async fn get_claim(
    Extension(state): Extension<Arc<AppState>>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    let store = state.store.read().await;
    match store.get_node(&id).await.unwrap_or(None) {
        Some(node) => {
            let props = store.get_all_properties(&id).await.unwrap_or_default();
            let mut prop_map = serde_json::Map::new();
            let mut provenance = None;
            for p in &props {
                if p.key == "provenance" {
                    if let PropValue::String(s) = &p.value {
                        provenance = Some(s.clone());
                    }
                } else {
                    prop_map.insert(p.key.clone(), serde_json::to_value(&p.value).unwrap_or_default());
                }
            }

            let relates_links = store.find_links(&id, Some("relates")).await.unwrap_or_default();
            let mut entities = Vec::new();
            for link in &relates_links {
                if let Some(en) = store.get_node(&link.to).await.unwrap_or(None) {
                    entities.push(EntitySummary {
                        id: en.id,
                        label: en.label,
                        r#type: "entity".into(),
                        tags: en.tags,
                        confidence: en.confidence,
                        created_at: format_timestamp(&en.created_at),
                    });
                }
            }

            Json(serde_json::json!(ClaimDetailResp {
                id: node.id,
                content: node.label,
                confidence: node.confidence,
                provenance,
                properties: prop_map,
                entities,
                created_at: format_timestamp(&node.created_at),
            }))
        }
        None => Json(serde_json::json!({"error": "not found", "id": id})),
    }
}

/// PATCH /claims/{id}  — Update claim
pub async fn update_claim(
    Extension(state): Extension<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<ClaimUpdateReq>,
) -> impl IntoResponse {
    if !id.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid id format"}))).into_response();
    }

    let mut store = state.store.write().await;
    let existing = store.get_node(&id).await.unwrap_or(None);
    if existing.is_none() {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "not found", "id": id}))).into_response();
    }

    // Now under WRITE lock — safe to mutate
    if let Some(confidence) = req.confidence {
        let query = format!("MATCH (n:Node {{id: '{}'}}) SET n.confidence = {}", id.replace('\'', "''"), confidence);
        let _ = store.raw_query(&query).await;
    }

    if let Some(props) = &req.properties {
        let mut mutations = Vec::new();
        for (k, v) in props {
            mutations.push(StoreMutation::SetProperty {
                owner_id: id.clone(),
                owner_kind: OwnerKind::Node,
                key: k.clone(),
                value: json_to_propvalue(v),
            });
        }
        let _ = store.write_maintenance(mutations).await;
    }
    drop(store);

    (StatusCode::OK, Json(serde_json::json!({"status": "ok", "id": id}))).into_response()
}

/// DELETE /claims/{id}  — Delete claim (keeps entities)
pub async fn delete_claim(
    Extension(state): Extension<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let mut store = state.store.write().await;
    let existing = store.get_node(&id).await.unwrap_or(None);
    if existing.is_none() {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "not found", "id": id}))).into_response();
    }

    let mut mutations = Vec::new();

    // Remove Relates links (entities stay)
    let outgoing = store.find_links(&id, Some("relates")).await.unwrap_or_default();
    for link in &outgoing {
        mutations.push(StoreMutation::DeleteLink { id: link.id.clone() });
    }

    // Remove properties
    let props = store.get_all_properties(&id).await.unwrap_or_default();
    for p in &props {
        mutations.push(StoreMutation::DeleteProperty { owner_id: id.clone(), key: p.key.clone() });
    }

    mutations.push(StoreMutation::DeleteNode { id: id.clone() });

    match store.write_maintenance(mutations).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"status": "ok", "deleted": id}))).into_response(),
        Err(e) => {
            tracing::error!("delete_claim write failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}
