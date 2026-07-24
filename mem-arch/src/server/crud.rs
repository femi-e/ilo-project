//! REST CRUD handlers for ILO entities, claims, links.
//!
//! Resource-oriented endpoints:
//!   POST /entities/search   — List/filter entities
//!   GET  /entities/{id}      — Get entity with properties + links
//!   GET  /entities/{label}   — Quick lookup by label
//!   POST /entities           — Create entities (batch)
//!   PATCH /entities/{id}     — Update entity fields
//!   DELETE /entities/{id}    — Delete entity (cascade)
//!
//!   POST /claims             — Create claims
//!   GET  /claims/{id}        — Get claim with entities
//!   PATCH /claims/{id}       — Update claim
//!   DELETE /claims/{id}      — Delete claim
//!
//!   POST /links              — Create a link
//!   PATCH /links/{id}        — Update link
//!   DELETE /links/{id}       — Remove a link
//!
//!   POST /batch              — Atomic multi-write
//!   GET  /status             — Health + counts

use axum::{Json, Extension, extract::Path, http::StatusCode, response::IntoResponse};
use std::sync::Arc;

use mem_arch::store::Store;
use mem_arch::types::*;

use super::AppState;
use super::types::*;
use super::helpers::{build_entity_mutations, build_claim_mutations, json_to_propvalue};

// ═══════════════════════════════════════════════════════════
// ENTITIES
// ═══════════════════════════════════════════════════════════

/// POST /entities  — Create one or more entities
pub async fn create_entities(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<EntityCreateReq>,
) -> impl IntoResponse {
    let mut entity_ids = std::collections::HashMap::new();
    let (mutations, created) = {
        let store = state.store.read().await;
        build_entity_mutations(&store, &req.entities, &mut entity_ids).await
    };

    // Write, then drop the lock
    {
        let mut store = state.store.write().await;
        if let Err(e) = store.write_maintenance(mutations).await {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
        }
    }

    // Generate embeddings for newly created entities
    if !created.is_empty() {
        let labels: Vec<String> = req.entities.iter().map(|e| e.label.clone()).collect();
        let embeddings: Vec<Option<Vec<f32>>> = tokio::task::spawn_blocking(move || {
            labels.iter().map(|l| mem_arch::embed::embed(l, false)).collect()
        }).await.unwrap_or_default();

        let store = state.store.read().await;
        for (i, eid) in created.iter().enumerate() {
            if i < embeddings.len() {
                if let Some(emb) = &embeddings[i] {
                    if !emb.is_empty() && emb.iter().any(|x| *x != 0.0) {
                        let emb_str: String = emb.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", ");
                        let _ = store.raw_query(&format!(
                            "MATCH (n:Node {{id: '{}'}}) SET n.embedding = [{}]",
                            eid.replace('\'', "''"), emb_str
                        )).await;
                    }
                }
            }
        }
        drop(store);
    }

    // Rebuild search index
    if let Ok(nodes) = state.store.read().await.find_nodes_by_type(&NodeType::Entity).await {
        state.search_index.write().await.merge(&nodes);
    }
    (StatusCode::OK, Json(EntityCreateResp { created: created.clone(), count: created.len() })).into_response()
}

/// POST /entities/search  — List/filter entities
pub async fn search_entities(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<EntityListReq>,
) -> Json<EntityListResp> {
    let store = state.store.read().await;
    let limit = req.limit.unwrap_or(50);
    let nodes = if let Some(tag) = &req.tag {
        store.find_nodes_by_tag(tag).await.unwrap_or_default()
    } else {
        let type_filter = req.r#type.as_deref().and_then(|t| t.parse::<NodeType>().ok());
        store.find_nodes(&NodeQuery {
            type_: type_filter.or(Some(NodeType::Entity)),
            tags: vec![],
            label_contains: req.label_contains.clone(),
            limit,
        }).await.unwrap_or_default()
    };

    let total = nodes.len();
    let offset = req.offset.unwrap_or(0);
    let summaries: Vec<EntitySummary> = nodes.into_iter().skip(offset).take(limit).map(|n| EntitySummary {
        id: n.id,
        label: n.label,
        r#type: n.type_.as_str().to_string(),
        tags: n.tags,
        confidence: n.confidence,
        created_at: n.created_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
    }).collect();

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
        None => {
            store.find_nodes(&NodeQuery {
                type_: Some(NodeType::Entity),
                tags: vec![],
                label_contains: Some(id_or_label.to_lowercase()),
                limit: 1,
            }).await.unwrap_or_default().into_iter().next()
        }
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
            let all_links: Vec<_> = outgoing.iter().chain(incoming.iter()).collect();

            let mut link_summaries = Vec::new();
            for link in &all_links {
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
                created_at: n.created_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
                updated_at: n.updated_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
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
    let store = state.store.read().await;
    let existing = store.get_node(&id).await.unwrap_or(None);
    drop(store);

    match existing {
        Some(_) => {
            let mut mutations = Vec::new();
            let mut raw_updates = Vec::new();

            if let Some(label) = &req.label {
                raw_updates.push(format!("n.label = '{}'", label.replace('\'', "''")));
            }
            if let Some(tags) = &req.tags {
                let tags_str: String = tags.iter().map(|t| format!("'{}'", t.replace('\'', "''"))).collect::<Vec<_>>().join(", ");
                raw_updates.push(format!("n.tags = [{}]", tags_str));
            }
            if let Some(confidence) = req.confidence {
                raw_updates.push(format!("n.confidence = {}", confidence));
            }

            // Apply column updates via raw_query
            if !raw_updates.is_empty() {
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
                let mut store = state.store.write().await;
                let _ = store.write_maintenance(mutations).await;
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

    // Find claims that Support this entity
    let incoming = store.find_links_to(&id, Some(&LinkType::Supports)).await.unwrap_or_default();
    for link in &incoming {
        // Delete the claim node
        let claim_id = &link.from;
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
        // Don't double-count links already handled via claim deletes
        if link.type_ != LinkType::Supports {
            mutations.push(StoreMutation::DeleteLink { id: link.id.clone() });
            links_del += 1;
        }
    }

    // Delete entity properties
    let props = store.get_all_properties(&id).await.unwrap_or_default();
    for p in &props {
        mutations.push(StoreMutation::DeleteProperty { owner_id: id.clone(), key: p.key.clone() });
    }

    // Delete entity node
    mutations.push(StoreMutation::DeleteNode { id: id.clone() });

    match store.write_maintenance(mutations).await {
        Ok(()) => (StatusCode::OK, Json(DeleteResp {
            status: "ok".into(),
            deleted: id,
            claims_deleted: Some(claims_del),
            links_deleted: Some(links_del),
        })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

// ═══════════════════════════════════════════════════════════
// CLAIMS
// ═══════════════════════════════════════════════════════════

/// POST /claims  — Create claims
pub async fn create_claims(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<ClaimCreateReq>,
) -> impl IntoResponse {
    let mut entity_ids = std::collections::HashMap::new();
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
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
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

            let supports_links = store.find_links(&id, Some(&LinkType::Supports)).await.unwrap_or_default();
            let mut entities = Vec::new();
            for link in &supports_links {
                if let Some(en) = store.get_node(&link.to).await.unwrap_or(None) {
                    entities.push(EntitySummary {
                        id: en.id,
                        label: en.label,
                        r#type: "entity".into(),
                        tags: en.tags,
                        confidence: en.confidence,
                        created_at: en.created_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
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
                created_at: node.created_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
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
    let store = state.store.read().await;
    let existing = store.get_node(&id).await.unwrap_or(None);
    if existing.is_none() {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "not found", "id": id}))).into_response();
    }

    if let Some(confidence) = req.confidence {
        let query = format!("MATCH (n:Node {{id: '{}'}}) SET n.confidence = {}", id.replace('\'', "''"), confidence);
        let _ = store.raw_query(&query).await;
    }
    drop(store);

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
        let mut store = state.store.write().await;
        let _ = store.write_maintenance(mutations).await;
    }

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

    // Remove Supports links (entities stay)
    let outgoing = store.find_links(&id, Some(&LinkType::Supports)).await.unwrap_or_default();
    for link in &outgoing {
        mutations.push(StoreMutation::DeleteLink { id: link.id.clone() });
    }

    // Remove properties
    let props = store.get_all_properties(&id).await.unwrap_or_default();
    for p in &props {
        mutations.push(StoreMutation::DeleteProperty { owner_id: id.clone(), key: p.key.clone() });
    }

    // Remove claim node
    mutations.push(StoreMutation::DeleteNode { id: id.clone() });

    match store.write_maintenance(mutations).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"status": "ok", "deleted": id}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

// ═══════════════════════════════════════════════════════════
// LINKS
// ═══════════════════════════════════════════════════════════

/// POST /links  — Create a link
pub async fn create_link(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<LinkCreateReq>,
) -> impl IntoResponse {
    let (from_id, to_id) = {
        let store = state.store.read().await;
        let f_id = resolve_entity_store(&store, &req.from).await.unwrap_or_else(|| {
            format!("e_{}", req.from.to_lowercase().replace(' ', "_"))
        });
        let t_id = resolve_entity_store(&store, &req.to).await.unwrap_or_else(|| {
            format!("e_{}", req.to.to_lowercase().replace(' ', "_"))
        });
        (f_id, t_id)
    };

    let link_type = req.r#type.as_deref().unwrap_or("relates").parse::<LinkType>().unwrap_or(LinkType::Relates);
    let lid = uid("l");
    let mutations = vec![StoreMutation::CreateLink {
        id: lid.clone(),
        from: from_id.clone(),
        to: to_id.clone(),
        type_: link_type,
        tags: vec![],
        weight: req.weight.unwrap_or(0.5),
    }];

    match state.store.write().await.write_maintenance(mutations).await {
        Ok(()) => (StatusCode::OK, Json(LinkCreateResp {
            id: lid,
            from: from_id,
            to: to_id,
            r#type: req.r#type.unwrap_or_else(|| "relates".into()),
        })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

/// PATCH /links/{id}  — Update link
pub async fn update_link(
    Extension(state): Extension<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<LinkUpdateReq>,
) -> impl IntoResponse {
    let mut store = state.store.write().await;
    let existing = store.get_link(&id).await.unwrap_or(None);
    if existing.is_none() {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "not found", "id": id}))).into_response();
    }

    let mut mutations = Vec::new();

    // Update link type via raw query if provided
    if let Some(link_type) = &req.r#type {
        if let Ok(lt) = link_type.parse::<LinkType>() {
            let query = format!(
                "MATCH ()-[l:LINK {{id: '{}'}}]->() SET l.type = '{}'",
                id.replace('\'', "''"),
                lt.as_str()
            );
            let _ = store.raw_query(&query).await;
        }
    }

    if let Some(weight) = req.weight {
        mutations.push(StoreMutation::UpdateLinkWeight { id: id.clone(), weight });
    }

    if let Some(props) = &req.properties {
        for (k, v) in props {
            mutations.push(StoreMutation::SetProperty {
                owner_id: id.clone(),
                owner_kind: OwnerKind::Link,
                key: k.clone(),
                value: json_to_propvalue(v),
            });
        }
    }

    match store.write_maintenance(mutations).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"status": "ok", "id": id}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

/// DELETE /links/{id}  — Remove a link
pub async fn delete_link(
    Extension(state): Extension<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let mut store = state.store.write().await;
    let existing = store.get_link(&id).await.unwrap_or(None);
    if existing.is_none() {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "not found", "id": id}))).into_response();
    }

    // Delete link properties
    let props = store.get_all_properties(&id).await.unwrap_or_default();
    let mut mutations: Vec<StoreMutation> = props.iter().map(|p| {
        StoreMutation::DeleteProperty { owner_id: id.clone(), key: p.key.clone() }
    }).collect();
    mutations.push(StoreMutation::DeleteLink { id: id.clone() });

    match store.write_maintenance(mutations).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"status": "ok", "deleted": id}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

// ═══════════════════════════════════════════════════════════
// BATCH — Atomic multi-write
// ═══════════════════════════════════════════════════════════

/// POST /batch  — Atomic multi-write (entities + claims + links + turn)
pub async fn batch(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<BatchReq>,
) -> impl IntoResponse {
    let turn_id = uid("t");
    let mut entity_ids = std::collections::HashMap::new();
    let mut mutations = Vec::new();
    let mut entities_created = Vec::new();

    // Turn
    if let Some(turn) = &req.turn {
        let latest_idx = state.store.read().await.find_nodes_by_type(&NodeType::Turn).await
            .unwrap_or_default().len() as u32;
        let label = format!("Turn #{}", latest_idx + 1);
        mutations.push(StoreMutation::CreateNode {
            id: turn_id.clone(), type_: NodeType::Turn, tags: vec![], label, confidence: 1.0,
        });
        if let Some(q) = &turn.query {
            mutations.push(StoreMutation::SetProperty {
                owner_id: turn_id.clone(), owner_kind: OwnerKind::Node, key: "user_text".into(),
                value: PropValue::String(q.clone()),
            });
        }
        if let Some(r) = &turn.response {
            mutations.push(StoreMutation::SetProperty {
                owner_id: turn_id.clone(), owner_kind: OwnerKind::Node, key: "response_text".into(),
                value: PropValue::String(r.clone()),
            });
        }
        if let Some(m) = &turn.model {
            mutations.push(StoreMutation::SetProperty {
                owner_id: turn_id.clone(), owner_kind: OwnerKind::Node, key: "model".into(),
                value: PropValue::String(m.clone()),
            });
        }
        if let Some(ti) = turn.tokens_in {
            mutations.push(StoreMutation::SetProperty {
                owner_id: turn_id.clone(), owner_kind: OwnerKind::Node, key: "tokens_in".into(),
                value: PropValue::Int(ti as i64),
            });
        }
        if let Some(to) = turn.tokens_out {
            mutations.push(StoreMutation::SetProperty {
                owner_id: turn_id.clone(), owner_kind: OwnerKind::Node, key: "tokens_out".into(),
                value: PropValue::Int(to as i64),
            });
        }
        if let Some(d) = turn.duration_ms {
            mutations.push(StoreMutation::SetProperty {
                owner_id: turn_id.clone(), owner_kind: OwnerKind::Node, key: "duration_ms".into(),
                value: PropValue::Int(d as i64),
            });
        }

        // Link to previous turn
        if let Ok(ids) = state.store.read().await.find_nodes_by_type(&NodeType::Turn).await {
            if let Some(prev) = ids.iter().last() {
                let seq_id = uid("seq");
                mutations.push(StoreMutation::CreateLink {
                    id: seq_id, from: prev.id.clone(), to: turn_id.clone(),
                    type_: LinkType::Precedes, tags: vec![], weight: 0.9,
                });
            }
        }
    }

    // Entities
    if let Some(entities) = &req.entities {
        let store = state.store.read().await;
        let (em, ec) = build_entity_mutations(&store, entities, &mut entity_ids).await;
        mutations.extend(em);
        entities_created = ec;
        drop(store);
    }

    // Claims
    let mut claims_created = Vec::new();
    if let Some(claims) = &req.claims {
        let store = state.store.read().await;
        let cm = build_claim_mutations(&store, claims, &mut entity_ids).await;
        for m in &cm {
            if let StoreMutation::CreateNode { id, type_, .. } = m {
                if *type_ == NodeType::Claim {
                    claims_created.push(id.clone());
                }
            }
        }
        mutations.extend(cm);
        drop(store);

        // Link turn to entities referenced by claims
        for eid in entity_ids.values() {
            mutations.push(StoreMutation::CreateLink {
                id: uid("ctx"), from: turn_id.clone(), to: eid.clone(),
                type_: LinkType::Mentions, tags: vec![], weight: 0.5,
            });
        }
    }

    // Links
    let mut links_created = Vec::new();
    if let Some(links) = &req.links {
        for link_req in links {
            let lid = uid("l");
            let lt = link_req.r#type.as_deref().unwrap_or("relates").parse::<LinkType>().unwrap_or(LinkType::Relates);
            mutations.push(StoreMutation::CreateLink {
                id: lid.clone(),
                from: link_req.from.clone(),
                to: link_req.to.clone(),
                type_: lt,
                tags: vec![],
                weight: link_req.weight.unwrap_or(0.5),
            });
            links_created.push(lid);
        }
    }

    // Write, then drop the lock
    {
        let mut store = state.store.write().await;
        if let Err(e) = store.write_maintenance(mutations).await {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
        }
    }

    // Generate embeddings for newly created entities
    if !entities_created.is_empty() {
        if let Some(entities) = &req.entities {
            let labels: Vec<String> = entities.iter().map(|e| e.label.clone()).collect();
            let embeddings: Vec<Option<Vec<f32>>> = tokio::task::spawn_blocking(move || {
                labels.iter().map(|l| mem_arch::embed::embed(l, false)).collect()
            }).await.unwrap_or_default();

            let store = state.store.read().await;
            for (i, eid) in entities_created.iter().enumerate() {
                if i < embeddings.len() {
                    if let Some(emb) = &embeddings[i] {
                        if !emb.is_empty() && emb.iter().any(|x| *x != 0.0) {
                            let emb_str: String = emb.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", ");
                            let _ = store.raw_query(&format!(
                                "MATCH (n:Node {{id: '{}'}}) SET n.embedding = [{}]",
                                eid.replace('\'', "''"), emb_str
                            )).await;
                        }
                    }
                }
            }
            drop(store);
        }
    }

    // Rebuild search index
    if let Ok(nodes) = state.store.read().await.find_nodes_by_type(&NodeType::Entity).await {
        state.search_index.write().await.merge(&nodes);
    }
    let turn_resp = if req.turn.is_some() { Some(turn_id.clone()) } else { None };
    (StatusCode::OK, Json(BatchResp {
        turn_id: turn_resp,
        entities_created,
        claims_created,
        links_created,
    })).into_response()
}

// ═══════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════

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

    let mut counts = serde_json::Map::new();
    counts.insert("entities".into(), serde_json::json!(entities));
    counts.insert("claims".into(), serde_json::json!(claims));
    counts.insert("turns".into(), serde_json::json!(turns));
    counts.insert("links".into(), serde_json::json!(links));

    Json(serde_json::json!({
        "status": if db_ok { "ok" } else { "degraded" },
        "version": "0.1.0",
        "uptime_secs": super::router::START_TIME.elapsed().as_secs(),
        "counts": counts,
    }))
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

/// Resolve entity label to ID (no auto-create)
async fn resolve_entity_store(store: &mem_arch::ladybug::LadybugStore, label: &str) -> Option<String> {
    super::helpers::resolve_entity(store, label).await
}
