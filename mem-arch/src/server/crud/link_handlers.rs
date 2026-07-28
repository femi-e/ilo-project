use std::sync::Arc;
use axum::{Json, Extension, extract::Path, http::StatusCode, response::IntoResponse};
use mem_arch::store::Store;
use mem_arch::types::*;
use super::super::AppState;
use super::super::helpers::json_to_propvalue;
use super::super::types::{LinkCreateReq, LinkUpdateReq, LinkCreateResp};
use super::parse_link_type;

/// POST /links  — Create a link
pub async fn create_link(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<LinkCreateReq>,
) -> impl IntoResponse {
    let (from_id, to_id) = {
        let store = state.store.read().await;
        let f_id = super::super::helpers::resolve_entity(&store, &req.from).await;
        let t_id = super::super::helpers::resolve_entity(&store, &req.to).await;
        (f_id, t_id)
    };

    // Create missing entities so the link doesn't point to a phantom node
    let mut mutations = Vec::new();
    let from_id = from_id.unwrap_or_else(|| {
        let eid = uid("e");
        mutations.push(StoreMutation::CreateNode {
            id: eid.clone(), type_: NodeType::Entity,
            tags: vec![], label: req.from.clone(), confidence: 0.3,
        });
        eid
    });
    let to_id = to_id.unwrap_or_else(|| {
        let eid = uid("e");
        mutations.push(StoreMutation::CreateNode {
            id: eid.clone(), type_: NodeType::Entity,
            tags: vec![], label: req.to.clone(), confidence: 0.3,
        });
        eid
    });

    let lt = parse_link_type(req.r#type.as_deref());
    let rel_str = req.r#type.clone().unwrap_or_else(|| "relates".into());
    let lid = uid("l");
    mutations.push(StoreMutation::CreateLink {
        id: lid.clone(),
        from: from_id.clone(),
        to: to_id.clone(),
        type_: lt,
        rel: rel_str,
        tags: vec![],
        weight: req.weight.unwrap_or(0.5),
        confidence: req.weight.unwrap_or(0.5),
    });

    match state.store.write().await.write_maintenance(mutations).await {
        Ok(()) => (StatusCode::OK, Json(LinkCreateResp {
            id: lid,
            from: from_id,
            to: to_id,
            r#type: req.r#type.unwrap_or_else(|| "relates".into()),
        })).into_response(),
        Err(e) => {
            tracing::error!("create_link write failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

/// PATCH /links/{id}  — Update link
pub async fn update_link(
    Extension(state): Extension<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<LinkUpdateReq>,
) -> impl IntoResponse {
    if !id.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid id format"}))).into_response();
    }

    let mut store = state.store.write().await;
    let existing = store.get_link(&id).await.unwrap_or(None);
    if existing.is_none() {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "not found", "id": id}))).into_response();
    }

    // Update link type if provided
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

    let mut mutations = Vec::new();
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
        Err(e) => {
            tracing::error!("update_link write failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
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

    let props = store.get_all_properties(&id).await.unwrap_or_default();
    let mut mutations: Vec<StoreMutation> = props.iter().map(|p| {
        StoreMutation::DeleteProperty { owner_id: id.clone(), key: p.key.clone() }
    }).collect();
    mutations.push(StoreMutation::DeleteLink { id: id.clone() });

    match store.write_maintenance(mutations).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"status": "ok", "deleted": id}))).into_response(),
        Err(e) => {
            tracing::error!("delete_link write failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}
