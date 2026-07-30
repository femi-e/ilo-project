use std::collections::HashMap;
use std::sync::Arc;
use axum::{Json, Extension, http::StatusCode, response::IntoResponse};
use ilo::store::Store;
use ilo::types::*;
use super::super::AppState;
use super::super::helpers::{build_entity_mutations, build_claim_mutations};
use super::super::types::{BatchReq, BatchResp};
use super::{store_entity_embeddings, rebuild_search_index};

/// POST /batch  — Atomic multi-write (entities + claims + links + turn)
pub async fn batch(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<BatchReq>,
) -> impl IntoResponse {
    let turn_id = uid("t");
    let mut entity_ids = HashMap::new();
    let mut mutations = Vec::new();
    let mut entities_created = Vec::new();

    // ── Turn ──
    if let Some(turn) = &req.turn {
        let latest_idx = state.store.read().await.find_nodes_by_type(&NodeType::Turn).await
            .unwrap_or_default().len() as u32;
        let label = format!("Turn #{}", latest_idx + 1);
        mutations.push(StoreMutation::CreateNode {
            id: turn_id.clone(), type_: NodeType::Turn, tags: vec![], label, confidence: 1.0,
        });

        // Push turn properties (each optional)
        for (key, value) in [
            ("user_text", turn.query.as_ref().map(|q| PropValue::String(q.clone()))),
            ("response_text", turn.response.as_ref().map(|r| PropValue::String(r.clone()))),
            ("model", turn.model.as_ref().map(|m| PropValue::String(m.clone()))),
            ("tokens_in", turn.tokens_in.map(|v| PropValue::Int(v as i64))),
            ("tokens_out", turn.tokens_out.map(|v| PropValue::Int(v as i64))),
            ("duration_ms", turn.duration_ms.map(|d| PropValue::Int(d as i64))),
        ] {
            if let Some(val) = value {
                mutations.push(StoreMutation::SetProperty {
                    owner_id: turn_id.clone(), owner_kind: OwnerKind::Node,
                    key: key.into(), value: val,
                });
            }
        }

        // Link to previous turn (sorted by created_at for chronological ordering)
        if let Ok(mut turns) = state.store.read().await.find_nodes_by_type(&NodeType::Turn).await {
            turns.sort_by_key(|a| a.created_at);
            if let Some(prev) = turns.last() {
                mutations.push(StoreMutation::CreateLink {
                    id: uid("seq"), from: prev.id.clone(), to: turn_id.clone(),
                    type_: LinkType::Precedes, rel: String::new(),
                    tags: vec![], weight: 0.9, confidence: 1.0,
                });
            }
        }
    }

    // ── Entities ──
    if let Some(entities) = &req.entities {
        let store = state.store.read().await;
        let (em, ec) = build_entity_mutations(&store, entities, &mut entity_ids).await;
        mutations.extend(em);
        entities_created = ec;
        drop(store);
    }

    // ── Claims ──
    let mut claims_created = Vec::new();
    if let Some(claims) = &req.claims {
        let store = state.store.read().await;
        let cm = build_claim_mutations(&store, claims, &mut entity_ids).await;
        for m in &cm {
            if let StoreMutation::CreateNode { id, type_, .. } = m {
                if *type_ == NodeType::Claim { claims_created.push(id.clone()); }
            }
        }
        mutations.extend(cm);
        drop(store);

        for eid in entity_ids.values() {
            mutations.push(StoreMutation::CreateLink {
                id: uid("ctx"), from: turn_id.clone(), to: eid.clone(),
                type_: LinkType::References, rel: String::new(),
                tags: vec![], weight: 0.5, confidence: 0.5,
            });
        }
    }

    // ── Links ──
    let mut links_created = Vec::new();
    if let Some(links) = &req.links {
        for link_req in links {
            let lid = uid("l");
            let lt = link_req.r#type.as_deref()
                .and_then(|t| t.parse::<LinkType>().ok())
                .unwrap_or(LinkType::Relates);
            let rel_str = link_req.r#type.clone().unwrap_or_else(|| "relates".into());
            mutations.push(StoreMutation::CreateLink {
                id: lid.clone(),
                from: link_req.from.clone(),
                to: link_req.to.clone(),
                type_: lt,
                rel: rel_str,
                tags: vec![],
                weight: link_req.weight.unwrap_or(0.5),
                confidence: link_req.weight.unwrap_or(0.5),
            });
            links_created.push(lid);
        }
    }

    // ── Write ──
    if let Err(e) = state.store.write().await.write_maintenance(mutations).await {
        tracing::error!("batch write failed: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
    }

    // ── Post-process ──
    store_entity_embeddings(&state, &entities_created, req.entities.as_deref().unwrap_or_default()).await;
    rebuild_search_index(&state).await;

    let turn_resp = if req.turn.is_some() { Some(turn_id) } else { None };
    (StatusCode::OK, Json(BatchResp {
        turn_id: turn_resp,
        entities_created,
        claims_created,
        links_created,
    })).into_response()
}
