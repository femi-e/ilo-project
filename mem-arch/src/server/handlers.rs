//! HTTP handler functions for all ILO API endpoints.
//! Each handler receives the request, processes it via the store,
//! and returns a response.

use axum::{Json, Extension, http::StatusCode, response::IntoResponse};
use std::sync::Arc;

use mem_arch::store::Store;
use mem_arch::types::*;
use mem_arch::config::LearningConfig;
use mem_arch::learning::LearningSignal;

use super::AppState;
use super::types::*;
use super::helpers::{resolve_entity, build_entity_mutations, build_claim_mutations, json_to_propvalue};

// ─── /status ────────────────────────────────────────────

pub async fn status(Extension(state): Extension<Arc<AppState>>) -> Json<serde_json::Value> {
    let db_ok = state.store.read().await.get_tag_index().await.is_ok();
    Json(serde_json::json!({
        "status": if db_ok { "ok" } else { "degraded" },
        "version": "0.1.0",
        "db_connected": db_ok,
        "uptime_secs": super::router::START_TIME.elapsed().as_secs(),
    }))
}

// ─── /remember ──────────────────────────────────────────

pub async fn remember(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<RememberReq>,
) -> impl IntoResponse {
    let turn_id = req.turn_id.clone().unwrap_or_else(|| {
        uid("t")
    });
    let turn_index = req.turn_index.unwrap_or(1);
    let is_phase2 = req.response.is_some();

    let mut entity_ids: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let (entity_mutations, created_entities) = if let Some(ref entities) = req.entities {
        let store_lock = state.store.read().await;
        build_entity_mutations(&store_lock, entities, &mut entity_ids).await
    } else {
        (Vec::new(), Vec::new())
    };

    let mut all_mutations = entity_mutations;

    // Embed new entities
    let entity_embeddings: Vec<Vec<f32>> = if !created_entities.is_empty() {
        if let Some(ref entities) = req.entities {
            let labels: Vec<String> = entities.iter().map(|e| e.label.clone()).collect();
            let count = created_entities.len();
            let result: Vec<Option<Vec<f32>>> = tokio::task::spawn_blocking(move || {
                labels.iter().map(|l| mem_arch::embed::embed(l, false)).collect::<Vec<_>>()
            }).await.unwrap_or_default();
            let successful: Vec<Vec<f32>> = result.into_iter().flatten().collect();
            tracing::info!("Generated embeddings for {}/{} entities", successful.len(), count);
            successful
        } else { vec![] }
    } else { vec![] };

    if is_phase2 {
        if let Some(ref claims) = req.claims {
            let claim_mutations = build_claim_mutations(claims, &mut entity_ids);
            all_mutations.extend(claim_mutations);
        }

        if let Some(ref extra) = req.all_entities {
            let store_lock = state.store.read().await;
            for label in extra {
                let ll = label.to_lowercase();
                if let std::collections::hash_map::Entry::Vacant(e) = entity_ids.entry(ll) {
                    if let Some(eid) = resolve_entity(&store_lock, label).await {
                        e.insert(eid.clone());
                        let ctx = uid("ctx");
                        all_mutations.push(StoreMutation::CreateLink {
                            id: ctx, from: turn_id.clone(), to: eid,
                            type_: LinkType::Context, tags: vec![], weight: 0.5,
                        });
                    }
                }
            }
            drop(store_lock);
        }

        for eid in entity_ids.values() {
            let ctx_link_id = uid("ctx");
            all_mutations.push(StoreMutation::CreateLink {
                id: ctx_link_id, from: turn_id.clone(), to: eid.clone(),
                type_: LinkType::Context, tags: vec![], weight: 0.5,
            });
        }
    }

    // Write to database
    let write_result = {
        let mut store = state.store.write().await;
        let turn = TurnRecord {
            id: turn_id.clone(), turn_index,
            user_text: req.query.clone(), response_text: req.response.clone(),
            model: req.model.clone(), tokens_in: req.tokens_in,
            tokens_out: req.tokens_out, duration_ms: req.duration_ms,
        };
        store.write_batch(WriteBatch { turn, mutations: all_mutations }).await
    };

    let phase_label = if is_phase2 { "complete" } else { "pending" };
    match write_result {
        Ok(()) => {
            // Store embeddings on Node table
            if !entity_embeddings.is_empty() && !created_entities.is_empty() {
                let store = state.store.write().await;
                for (i, eid) in created_entities.iter().enumerate() {
                    if i < entity_embeddings.len() && !entity_embeddings[i].is_empty()
                        && entity_embeddings[i].iter().any(|x| *x != 0.0)
                    {
                        let emb_str: String = entity_embeddings[i].iter()
                            .map(|x| x.to_string()).collect::<Vec<_>>().join(", ");
                        let _ = store.raw_query(&format!(
                            "MATCH (n:Node {{id: '{}'}}) SET n.embedding = [{}]",
                            eid.replace('\'', "''"), emb_str
                        )).await;
                    }
                }
                drop(store);
            }

            // Rebuild search index so new entities are findable via FTS immediately.
            if let Ok(nodes) = state.store.read().await.find_nodes_by_type(&mem_arch::types::NodeType::Entity).await {
                state.search_index.write().await.merge(&nodes);
            }

            (StatusCode::OK, Json(RememberResp {
                status: "ok".into(), turn_id, phase: phase_label.into(), entities_created: created_entities.len(),
            })).into_response()
        },
        Err(e) => {
            tracing::error!("WRITE BATCH ERROR: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(RememberResp {
                status: "error".into(), turn_id, phase: phase_label.into(), entities_created: 0,
            })).into_response()
        }
    }
}

// ─── /ingest ──────────────────────────────────────────────

pub async fn ingest_handler(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<IngestReq>,
) -> Json<serde_json::Value> {
    if req.content.trim().is_empty() && req.entities.is_none() && req.claims.is_none() {
        return Json(serde_json::json!({"status": "error", "error": "content or entities/claims required"}));
    }

    // Parse entities and claims — either from request or via server-side extraction
    let entities: Vec<EntityInput> = req.entities.unwrap_or_default();
    let claims: Vec<ClaimInput> = req.claims.unwrap_or_else(|| {
        let graph = std::collections::HashMap::new();
        let result = mem_arch::extract::extract(&req.content, &graph);
        result.claims.into_iter().map(|c| {
            let subj = c.subject.clone();
            let obj = c.object.clone();
            ClaimInput {
                content: format!("{} {} {}", subj, c.link_type, obj),
                confidence: Some(c.confidence),
                provenance: None,
                entities: Some(vec![subj, obj]),
            }
        }).collect()
    });

    let tags = req.tags.unwrap_or_default();
    let mut entity_ids: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    // Create source entity
    let source_key = req.source.to_lowercase();
    let source_id = format!("e_{}", source_key.replace(|c: char| !c.is_alphanumeric() && c != '_', "_"));
    let mut mutations = vec![StoreMutation::CreateNode {
        id: source_id.clone(), type_: NodeType::Entity,
        tags: vec!["ingested".into()].into_iter().chain(tags.iter().cloned()).collect(),
        label: req.source.clone(), confidence: 0.7,
    }];
    entity_ids.insert(source_key, source_id.clone());

    // Use shared helper for claim + entity-claim evidence links
    let claim_mutations = super::helpers::build_claim_mutations(&claims, &mut entity_ids);
    let claim_ids: Vec<String> = claim_mutations.iter().filter_map(|m| {
        if let StoreMutation::CreateNode { id, type_, .. } = m {
            if *type_ == NodeType::Claim { Some(id.clone()) } else { None }
        } else { None }
    }).collect();
    mutations.extend(claim_mutations);

    // Link each claim to the source entity
    for cid in &claim_ids {
        mutations.push(StoreMutation::CreateLink {
            id: uid("l"), from: source_id.clone(), to: cid.clone(),
            type_: LinkType::Evidence, tags: vec![], weight: 0.7,
        });
    }

    // Write to DB
    let write_result = state.store.write().await.write_maintenance(mutations).await;

    // Rebuild search index to include new entities
    if let Ok(nodes) = state.store.read().await.find_nodes_by_type(&NodeType::Entity).await {
        state.search_index.write().await.merge(&nodes);
    }

    match write_result {
        Ok(()) => Json(serde_json::json!({
            "status": "ok",
            "entities_created": entities.len(),
            "claims_created": claims.len(),
        })),
        Err(e) => Json(serde_json::json!({
            "status": "error",
            "error": format!("{}", e),
        })),
    }
}

// ─── /recall ─────────────────────────────────────────────

pub async fn recall(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<RecallReq>,
) -> Json<RecallResp> {
    let query = req.query;
    let query_emb = req.query_embedding.as_deref();
    let (idx, search_index) = {
        let store = state.store.read().await;
        let si = state.search_index.read().await;
        (store.get_tag_index().await.unwrap_or_default(), si)
    };
    let ctx = {
        let store = state.store.read().await;
        mem_arch::retrieval::retrieve(&query, &*store, &idx, None, Some(&search_index), query_emb, None).await.unwrap_or_default()
    };
    Json(RecallResp { context: ctx.anchor_text, nodes: ctx.activated_nodes.len(), chars: ctx.char_count })
}

// ─── /entity/lookup ──────────────────────────────────────

pub async fn entity_lookup(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<EntityLookupReq>,
) -> Json<EntityLookupResp> {
    let store = state.store.read().await;
    if let Some(id) = resolve_entity(&store, &req.name).await {
        if let Some(node) = store.get_node(&id).await.unwrap_or(None) {
            let props = store.get_all_properties(&id).await.unwrap_or_default();
            let mut prop_map = serde_json::Map::new();
            for p in props { prop_map.insert(p.key, serde_json::to_value(&p.value).unwrap_or_default()); }
            drop(store);
            return Json(EntityLookupResp {
                found: true, id: Some(id), name: Some(node.label),
                confidence: Some(node.confidence), tags: Some(node.tags), properties: Some(prop_map),
            });
        }
    }
    drop(store);
    Json(EntityLookupResp { found: false, id: None, name: None, confidence: None, tags: None, properties: None })
}

// ─── /connect ────────────────────────────────────────────

pub async fn connect(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<ConnectReq>,
) -> Json<ConnectResp> {
    let mut affected = Vec::new();
    let mut mutations = Vec::new();
    let fl = req.from.to_lowercase();
    let from_id = {
        let store = state.store.read().await;
        match resolve_entity(&store, &req.from).await {
            Some(id) => id,
            None => { let eid = format!("e_{}", fl.replace(' ', "_")); affected.push(fl.clone()); eid }
        }
    };
    let tl = req.to.to_lowercase();
    let to_id = {
        let store = state.store.read().await;
        match resolve_entity(&store, &req.to).await {
            Some(id) => id,
            None => { let eid = format!("e_{}", tl.replace(' ', "_")); affected.push(tl.clone()); eid }
        }
    };

    for (label, eid) in &[(fl, from_id.clone()), (tl, to_id.clone())] {
        let store = state.store.read().await;
        let exists = store.get_node(eid).await.unwrap_or(None).is_some();
        drop(store);
        if !exists {
            mutations.push(StoreMutation::CreateNode {
                id: eid.clone(), type_: NodeType::Entity, tags: vec![], label: label.clone(), confidence: 0.3,
            });
        }
    }
    let link_id = uid("l");
    let lt = match req.link_type.as_str() {
        "dep" => LinkType::Dep, "con" => LinkType::Con,
        "evidence" => LinkType::Evidence, "refute" => LinkType::Refute,
        _ => LinkType::Ref,
    };
    mutations.push(StoreMutation::CreateLink {
        id: link_id.clone(), from: from_id, to: to_id, type_: lt, tags: vec![], weight: req.confidence.unwrap_or(0.5),
    });
    { let mut s = state.store.write().await; let _ = s.write_maintenance(mutations).await; }
    Json(ConnectResp { status: "ok".into(), link_id, entities_affected: affected })
}

// ─── /entity/update ──────────────────────────────────────

pub async fn entity_update(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<EntityUpdateReq>,
) -> Json<EntityUpdateResp> {
    let (eid, was_created) = {
        let store = state.store.read().await;
        match resolve_entity(&store, &req.name).await {
            Some(id) => (id, false),
            None => (format!("e_{}", req.name.to_lowercase().replace(' ', "_")), true),
        }
    };
    let mut mutations = Vec::new();
    let tags = req.tags.clone().unwrap_or_default();
    if was_created {
        mutations.push(StoreMutation::CreateNode {
            id: eid.clone(), type_: NodeType::Entity, tags: tags.clone(),
            label: req.name.clone(), confidence: req.confidence.unwrap_or(0.3),
        });
    }
    for (k, v) in &req.properties {
        mutations.push(StoreMutation::SetProperty {
            owner_id: eid.clone(), owner_kind: OwnerKind::Node, key: k.clone(), value: json_to_propvalue(v),
        });
    }
    { let mut s = state.store.write().await; let _ = s.write_maintenance(mutations).await; }
    Json(EntityUpdateResp { status: "ok".into(), created: was_created, entities_affected: vec![req.name.to_lowercase()] })
}

// ─── /extract ────────────────────────────────────────────

pub async fn extract(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<ExtractReq>,
) -> Json<ExtractResp> {
    let store = state.store.read().await;
    let mut graph = std::collections::HashMap::new();
    if let Ok(nodes) = store.find_nodes_by_type(&mem_arch::types::NodeType::Entity).await {
        for node in &nodes {
            graph.insert(node.label.to_lowercase(), (node.confidence, node.tags.clone()));
        }
    }
    drop(store);
    let result = mem_arch::extract::extract(&req.text, &graph);
    Json(ExtractResp {
        text: result.text, entities: result.entities, claims: result.claims,
        n_entities: result.n_entities, n_claims: result.n_claims,
    })
}

// ─── /embed ──────────────────────────────────────────────

pub async fn embed(Json(req): Json<EmbedReq>) -> Json<serde_json::Value> {
    let is_query = req.is_query.unwrap_or(true);
    let result: Option<Vec<f32>> = tokio::task::spawn_blocking(move || {
        mem_arch::embed::embed(&req.text, is_query)
    }).await.unwrap_or(None);
    match result {
        Some(emb) => {
            let dim = emb.len();
            Json(serde_json::json!({"embedding": emb, "dim": dim}))
        },
        None => Json(serde_json::json!({"error": "embedding failed", "embedding": [], "dim": 0})),
    }
}

pub async fn search_handler(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<SearchReq>,
) -> Json<serde_json::Value> {
    let query = req.query.trim().to_string();
    if query.is_empty() {
        return Json(serde_json::json!({"error": "query required", "context": "", "nodes": [], "total": 0}));
    }

    let (idx, search_index) = {
        let store = state.store.read().await;
        let si = state.search_index.read().await;
        (store.get_tag_index().await.unwrap_or_default(), si)
    };

    let ctx = {
        let store = state.store.read().await;
        mem_arch::retrieval::retrieve(&query, &*store, &idx, None, Some(&search_index), None, req.max_hops).await.unwrap_or_default()
    };

    // Apply tag filter: only include nodes with matching tag
    let store = state.store.read().await;
    let tag_filtered: std::collections::HashSet<String> = if let Some(ref tag) = req.tag {
        store.find_nodes_by_tag(tag).await.unwrap_or_default().into_iter().map(|n| n.id).collect()
    } else {
        std::collections::HashSet::new()
    };

    // Build structured node list
    let mut nodes = Vec::with_capacity(ctx.activated_nodes.len());
    for n in &ctx.activated_nodes {
        if !tag_filtered.is_empty() && !tag_filtered.contains(&n.node_id) { continue; }
        let node = store.get_node(&n.node_id).await.unwrap_or(None);
        nodes.push(SearchedNode {
            id: n.node_id.clone(),
            label: n.label.clone(),
            node_type: n.node_type.as_str().to_string(),
            confidence: node.as_ref().map(|n| n.confidence).unwrap_or(0.5),
            relevance: n.activation,
            tags: node.map(|n| n.tags.clone()).unwrap_or_default(),
        });
    }
    drop(store);

    // Only include node details if results are small enough
    let node_details = if nodes.len() <= 10 {
        serde_json::json!(nodes)
    } else {
        serde_json::Value::Null
    };

    Json(serde_json::json!({
        "context": ctx.anchor_text,
        "nodes": node_details,
        "total": nodes.len(),
    }))
}

// ─── /debug ──────────────────────────────────────────────

pub async fn debug_state(Extension(state): Extension<Arc<AppState>>) -> Json<serde_json::Value> {
    let store = state.store.read().await;
    let si = store.get_tag_index().await.unwrap_or_default();
    let keys: Vec<String> = si.keys().cloned().collect();
    Json(serde_json::json!({"tag_index_keys": keys}))
}

// ─── /learn ──────────────────────────────────────────────

pub async fn learn(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<LearnReq>,
) -> Json<LearnResp> {
    let query = req.query.unwrap_or_default();
    let quality = req.quality.unwrap_or(0.0);
    let turn_id = req.turn_id.unwrap_or_else(|| {
        uid("t")
    });

    let signal = if let Some(used_labels) = &req.used_labels {
        let store_lock = state.store.write().await;
        let mut used_ids = Vec::new();
        let mut retrieved_ids = Vec::new();
        if let Some(ret_labels) = &req.retrieved_labels {
            for label in ret_labels {
                if let Some(id) = resolve_entity(&store_lock, label).await {
                    retrieved_ids.push(id);
                }
            }
        }
        for label in used_labels {
            if let Some(id) = resolve_entity(&store_lock, label).await {
                used_ids.push(id.clone());
                if !retrieved_ids.contains(&id) { retrieved_ids.push(id); }
            }
        }
        drop(store_lock);
        if used_ids.is_empty() {
            return Json(LearnResp {
                status: "error".into(), edges_updated: 0,
                message: "None of the provided used_labels resolved to graph entities".into(),
            });
        }
        LearningSignal::from_explicit(turn_id, query, retrieved_ids, used_ids, quality)
    } else if let Some(text) = &req.response_text {
        let store_lock = state.store.write().await;
        let idx = store_lock.get_tag_index().await.unwrap_or_default();
        let ctx = mem_arch::retrieval::retrieve(&query, &*store_lock, &idx, None, None, None, None).await.unwrap_or_default();
        let retrieved_nodes = ctx.activated_nodes;
        drop(store_lock);
        LearningSignal::from_overlap(turn_id, &retrieved_nodes, text)
    } else {
        return Json(LearnResp {
            status: "error".into(), edges_updated: 0,
            message: "Need either used_labels (preferred) or response_text (fallback)".into(),
        });
    };

    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut store = state.store.write().await;
    match mem_arch::learning::learn(&mut *store, &signal, &LearningConfig::default(), now_ms).await {
        Ok(()) => Json(LearnResp {
            status: "ok".into(), edges_updated: signal.co_used_pairs.len(),
            message: format!("processed {} co-used pairs", signal.co_used_pairs.len()),
        }),
        Err(e) => Json(LearnResp {
            status: "error".into(), edges_updated: 0,
            message: format!("Learn failed: {}", e),
        }),
    }
}
