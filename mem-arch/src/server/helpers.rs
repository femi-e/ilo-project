//! Helper functions for entity resolution, mutation building, and value conversion.
//! Used by all handlers to interact with the store.

use mem_arch::store::Store;
use mem_arch::types::*;
use super::types::{EntityInput, ClaimInput};

/// Resolve entity label to existing node ID, or None if not found.
pub async fn resolve_entity(store: &mem_arch::ladybug::LadybugStore, label: &str) -> Option<String> {
    store.find_nodes(&NodeQuery {
        type_: Some(NodeType::Entity),
        tags: vec![],
        label_contains: Some(label.to_lowercase()),
        limit: 1,
    }).await.ok()?.into_iter().next().map(|n| n.id)
}

/// Build entity mutations: resolve against graph, create if new.
/// Returns (mutations, resolved_id_by_label_lower)
pub async fn build_entity_mutations(
    store: &mem_arch::ladybug::LadybugStore,
    entities: &[EntityInput],
    existing_ids: &mut std::collections::HashMap<String, String>,
) -> (Vec<StoreMutation>, Vec<String>) {
    let mut mutations = Vec::new();
    let mut created_ids = Vec::new();

    for ent in entities {
        let label_lower = ent.label.to_lowercase();
        if existing_ids.contains_key(&label_lower) { continue; }

        let (eid, is_new) = match resolve_entity(store, &ent.label).await {
            Some(existing_id) => (existing_id, false),
            None => {
                let new_id = format!("e_{}", label_lower.replace(' ', "_"));
                (new_id, true)
            },
        };

        existing_ids.insert(label_lower, eid.clone());

        let tags = ent.tags.clone().unwrap_or_default();
        let conf = ent.confidence.unwrap_or(0.7);

        if is_new {
            mutations.push(StoreMutation::CreateNode {
                id: eid.clone(), type_: NodeType::Entity, tags: tags.clone(),
                label: ent.label.clone(), confidence: conf,
            });
        }

        if let Some(props) = &ent.properties {
            for (k, v) in props {
                let pv = json_to_propvalue(v);
                mutations.push(StoreMutation::SetProperty {
                    owner_id: eid.clone(), owner_kind: OwnerKind::Node, key: k.clone(), value: pv,
                });
            }
        }

        if is_new { created_ids.push(eid); }
    }

    (mutations, created_ids)
}

/// Build claim mutations and Evidence links.
/// Resolves entity references against the graph to avoid creating duplicate nodes.
pub async fn build_claim_mutations(
    store: &mem_arch::ladybug::LadybugStore,
    claims: &[ClaimInput],
    entity_ids: &mut std::collections::HashMap<String, String>,
) -> Vec<StoreMutation> {
    let mut mutations = Vec::new();
    for claim in claims {
        let cid = uid("c");
        let conf = claim.confidence.unwrap_or(0.6);
        mutations.push(StoreMutation::CreateNode {
            id: cid.clone(), type_: NodeType::Claim, tags: vec![],
            label: claim.content.clone(), confidence: conf,
        });
        if let Some(prov) = &claim.provenance {
            mutations.push(StoreMutation::SetProperty {
                owner_id: cid.clone(), owner_kind: OwnerKind::Node, key: "provenance".into(),
                value: PropValue::String(prov.clone()),
            });
        }
        if let Some(ent_refs) = &claim.entities {
            for ref_label in ent_refs {
                let ref_lower = ref_label.to_lowercase();
                if !entity_ids.contains_key(&ref_lower) {
                    // Resolve against the graph before creating a new entity
                    match resolve_entity(store, ref_label).await {
                        Some(existing_id) => {
                            entity_ids.insert(ref_lower.clone(), existing_id);
                        },
                        None => {
                            let new_eid = format!("e_{}", ref_lower.replace(' ', "_"));
                            entity_ids.insert(ref_lower.clone(), new_eid.clone());
                            mutations.push(StoreMutation::CreateNode {
                                id: new_eid.clone(), type_: NodeType::Entity,
                                tags: vec![], label: ref_label.clone(),
                                confidence: 0.3,
                            });
                        },
                    }
                }
                let target_id = entity_ids.get(&ref_lower).cloned()
                    .expect("claim entity reference was just inserted or resolved, so it must exist");
                let link_id = uid("ev");
                mutations.push(StoreMutation::CreateLink {
                    id: link_id, from: cid.clone(), to: target_id,
                    type_: LinkType::Relates, relationship: String::new(),
                    tags: vec![], weight: conf, confidence: conf,
                });
            }
        }
    }
    mutations
}

/// Convert a serde_json::Value to PropValue for storage.
pub fn json_to_propvalue(v: &serde_json::Value) -> PropValue {
    match v {
        serde_json::Value::String(s) => PropValue::String(s.clone()),
        serde_json::Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                if f.fract() == 0.0 && f <= i64::MAX as f64 && f >= i64::MIN as f64 {
                    PropValue::Int(f as i64)
                } else { PropValue::Float(f) }
            } else { PropValue::String(n.to_string()) }
        }
        serde_json::Value::Bool(b) => PropValue::Bool(*b),
        serde_json::Value::Array(a) => PropValue::Json(serde_json::Value::Array(a.clone())),
        serde_json::Value::Object(o) => PropValue::Json(serde_json::Value::Object(o.clone())),
        serde_json::Value::Null => PropValue::String(String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── json_to_propvalue tests ─────────────────────────

    #[test]
    fn test_json_to_propvalue_string() {
        let v = serde_json::Value::String("hello".into());
        assert_eq!(json_to_propvalue(&v), PropValue::String("hello".into()));
    }

    #[test]
    fn test_json_to_propvalue_integer() {
        let v = serde_json::Value::Number(42.into());
        assert_eq!(json_to_propvalue(&v), PropValue::Int(42));
    }

    #[test]
    fn test_json_to_propvalue_float() {
        let v = serde_json::Value::Number(serde_json::Number::from_f64(1.23).unwrap());
        match json_to_propvalue(&v) {
            PropValue::Float(f) => assert!((f - 1.23).abs() < 0.01),
            _ => panic!("expected Float"),
        }
    }

    #[test]
    fn test_json_to_propvalue_bool() {
        assert_eq!(json_to_propvalue(&serde_json::Value::Bool(true)), PropValue::Bool(true));
        assert_eq!(json_to_propvalue(&serde_json::Value::Bool(false)), PropValue::Bool(false));
    }

    #[test]
    fn test_json_to_propvalue_array() {
        let v = serde_json::Value::Array(vec![serde_json::Value::String("a".into())]);
        match json_to_propvalue(&v) {
            PropValue::Json(_) => {},
            _ => panic!("expected Json"),
        }
    }

    #[test]
    fn test_json_to_propvalue_null() {
        assert_eq!(json_to_propvalue(&serde_json::Value::Null), PropValue::String(String::new()));
    }

    #[test]
    fn test_json_to_propvalue_large_integer_as_float() {
        let large = serde_json::Number::from_f64(1e20).unwrap();
        let v = serde_json::Value::Number(large);
        // 1e20 > i64::MAX, so it should become Float, not Int
        match json_to_propvalue(&v) {
            PropValue::Float(_) => {},
            other => panic!("expected Float for large number, got {other:?}"),
        }
    }

    // ── build_entity_mutations edge cases ──────────────

    // build_entity_mutations is async and needs a store, so it's tested
    // via the integration tests in adversarial_test.rs
}
