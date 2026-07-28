use std::collections::HashMap;
use std::sync::Arc;
use axum::{Json, Extension, extract::Path, http::StatusCode, response::IntoResponse};
use mem_arch::store::Store;
use mem_arch::types::*;
use super::super::AppState;
use super::super::helpers::{build_entity_mutations, json_to_propvalue};
use super::super::types::{EntityCreateReq, EntityListReq, EntityUpdateReq, EntityCreateResp,
    EntityListResp, EntitySummary, EntityDetailResp, LinkSummary, DeleteResp};
use super::{store_entity_embeddings, rebuild_search_index, format_timestamp};

/// POST /entities  — Create one or more entities
pub async fn create_entities(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<EntityCreateReq>,
) -> impl IntoResponse {
    let mut entity_ids = HashMap::new();
    let (mutations, created) = {
        let store = state.store.read().await;
        build_entity_mutations(&store, &req.entities, &mut entity_ids).await
    };

    // Write mutations
    if let Err(e) = state.store.write().await.write_maintenance(mutations).await {
        tracing::error!("create_entities write failed: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
    }

    // Embed + rebuild
    store_entity_embeddings(&state, &created, &req.entities).await;
    rebuild_search_index(&state).await;

    (StatusCode::OK, Json(EntityCreateResp { created: created.clone(), count: created.len() })).into_response()
}

/// POST /entities/search  — List/filter entities
pub async fn search_entities(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<EntityListReq>,
) -> Json<EntityListResp> {
    let store = state.store.read().await;
    let limit = req.limit.unwrap_or(50);
    let offset = req.offset.unwrap_or(0);

    let nodes = if let Some(tag) = &req.tag {
        store.find_nodes_by_tag(tag).await.unwrap_or_default()
    } else {
        let type_filter = req.r#type.as_deref().and_then(|t| t.parse::<NodeType>().ok());
        store.find_nodes(&NodeQuery {
            type_: type_filter.or(Some(NodeType::Entity)),
            tags: vec![],
            label_contains: req.label_contains.clone(),
            limit: limit + offset, // fetch enough for pagination
        }).await.unwrap_or_default()
    };

    let total = nodes.len();
    let summaries: Vec<EntitySummary> = nodes.into_iter()
        .skip(offset)
        .take(limit)
        .map(|n| EntitySummary {
            id: n.id,
            label: n.label,
            r#type: n.type_.as_str().to_string(),
            tags: n.tags,
            confidence: n.confidence,
            created_at: format_timestamp(&n.created_at),
        })
        .collect();

    Json(EntityListResp { nodes: summaries, total })
}

/// GET /entities/{id_or_label}  — Get entity by ID or label
pub async fn get_entity(
    Extension(state): Extension<Arc<AppState>>,
    Path(id_or_label): Path<String>,
) -> Json<serde_json::Value> {
    let store = state.store.read().await;

    // Try as ID first, then as label
    let node = match store.get_node(&id_or_label).await.unwrap_or(None) {
        Some(n) => Some(n),
        None => store.find_nodes(&NodeQuery {
            type_: Some(NodeType::Entity),
            tags: vec![],
            label_contains: Some(id_or_label.to_lowercase()),
            limit: 1,
        }).await.unwrap_or_default().into_iter().next(),
    };

    match node {
        Some(n) => {
            let props = store.get_all_properties(&n.id).await.unwrap_or_default();
            let mut prop_map = serde_json::Map::new();
            for p in &props {
                prop_map.insert(p.key.clone(), serde_json::to_value(&p.value).unwrap_or_default());
            }

            let outgoing = store.find_links(&n.id, None).await.unwrap_or_default();
            let incoming = store.find_links_to(&n.id, None).await.unwrap_or_default();

            let mut link_summaries = Vec::new();
            for link in outgoing.iter().chain(incoming.iter()) {
                let mut link_props = serde_json::Map::new();
                let link_props_raw = store.get_all_properties(&link.id).await.unwrap_or_default();
                for p in &link_props_raw {
                    link_props.insert(p.key.clone(), serde_json::to_value(&p.value).unwrap_or_default());
                }
                link_summaries.push(LinkSummary {
                    id: link.id.clone(),
                    r#type: link.type_.as_str().to_string(),
                    from: link.from.clone(),
                    to: link.to.clone(),
                    weight: link.weight,
                    properties: link_props,
                });
            }

            Json(serde_json::json!(EntityDetailResp {
                id: n.id,
                label: n.label,
                r#type: n.type_.as_str().to_string(),
                tags: n.tags,
                confidence: n.confidence,
                embedding: n.embedding,
                properties: prop_map,
                links: link_summaries,
                created_at: format_timestamp(&n.created_at),
                updated_at: format_timestamp(&n.updated_at),
            }))
        }
        None => Json(serde_json::json!({"error": "not found", "id": id_or_label})),
    }
}

/// PATCH /entities/{id}  — Update entity fields
pub async fn update_entity(
    Extension(state): Extension<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<EntityUpdateReq>,
) -> impl IntoResponse {
    // Validate ID format early to avoid Cypher injection
    if !id.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid id format"}))).into_response();
    }

    let store = state.store.read().await;
    let existing = store.get_node(&id).await.unwrap_or(None);
    drop(store);

    match existing {
        Some(_) => {
            let mut mutations = Vec::new();

            // Apply field updates via raw_query (under write lock — acquired below)
            if req.label.is_some() || req.tags.is_some() || req.confidence.is_some() {
                let mut raw_updates = Vec::new();
                if let Some(label) = &req.label {
                    raw_updates.push(format!("n.label = '{}'", label.replace('\'', "''")));
                }
                if let Some(tags) = &req.tags {
                    let tags_str: String = tags.iter()
                        .map(|t| format!("'{}'", t.replace('\'', "''")))
                        .collect::<Vec<_>>()
                        .join(", ");
                    raw_updates.push(format!("n.tags = [{}]", tags_str));
                }
                if let Some(confidence) = req.confidence {
                    raw_updates.push(format!("n.confidence = {}", confidence));
                }
                let set_clause = raw_updates.join(", ");
                let query = format!("MATCH (n:Node {{id: '{}'}}) SET {}", id.replace('\'', "''"), set_clause);
                let store = state.store.read().await;
                let _ = store.raw_query(&query).await;
                drop(store);
            }

            // Apply property updates
            if let Some(props) = &req.properties {
                for (k, v) in props {
                    mutations.push(StoreMutation::SetProperty {
                        owner_id: id.clone(),
                        owner_kind: OwnerKind::Node,
                        key: k.clone(),
                        value: json_to_propvalue(v),
                    });
                }
                if let Err(e) = state.store.write().await.write_maintenance(mutations).await {
                    tracing::error!("update_entity properties write failed: {e}");
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
                }
            }

            (StatusCode::OK, Json(serde_json::json!({"status": "ok", "id": id}))).into_response()
        }
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "not found", "id": id}))).into_response(),
    }
}

/// DELETE /entities/{id}  — Delete entity (cascade: claims + links + props)
pub async fn delete_entity(
    Extension(state): Extension<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let mut store = state.store.write().await;
    let existing = store.get_node(&id).await.unwrap_or(None);
    if existing.is_none() {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "not found", "id": id}))).into_response();
    }

    let mut mutations = Vec::new();
    let mut claims_del = 0usize;
    let mut links_del = 0usize;

    // Find claims that reference this entity
    let incoming = store.find_links_to(&id, Some("relates")).await.unwrap_or_default();
    for link in &incoming {
        let claim_id = &link.from;
        // Delete claim properties
        let claim_props = store.get_all_properties(claim_id).await.unwrap_or_default();
        for p in &claim_props {
            mutations.push(StoreMutation::DeleteProperty { owner_id: claim_id.clone(), key: p.key.clone() });
        }
        // Delete claim's outgoing links
        let claim_links = store.find_links(claim_id, None).await.unwrap_or_default();
        for cl in &claim_links {
            mutations.push(StoreMutation::DeleteLink { id: cl.id.clone() });
            links_del += 1;
        }
        mutations.push(StoreMutation::DeleteNode { id: claim_id.clone() });
        claims_del += 1;
    }

    // Delete all links to/from this entity
    let outgoing = store.find_links(&id, None).await.unwrap_or_default();
    for link in &outgoing {
        mutations.push(StoreMutation::DeleteLink { id: link.id.clone() });
        links_del += 1;
    }
    for link in &incoming {
        if link.type_.as_str() != "relates" {
            mutations.push(StoreMutation::DeleteLink { id: link.id.clone() });
            links_del += 1;
        }
    }

    // Delete entity properties
    let props = store.get_all_properties(&id).await.unwrap_or_default();
    for p in &props {
        mutations.push(StoreMutation::DeleteProperty { owner_id: id.clone(), key: p.key.clone() });
    }

    mutations.push(StoreMutation::DeleteNode { id: id.clone() });

    match store.write_maintenance(mutations).await {
        Ok(()) => {
            tracing::info!("Deleted entity {id}: {claims_del} claims, {links_del} links");
            (StatusCode::OK, Json(DeleteResp {
                status: "ok".into(),
                deleted: id,
                claims_deleted: Some(claims_del),
                links_deleted: Some(links_del),
            })).into_response()
        }
        Err(e) => {
            tracing::error!("delete_entity write failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}
