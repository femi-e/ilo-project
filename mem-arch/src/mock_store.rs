//! MockStore for unit testing — implements Store trait without LadybugDB.
//! Only compiled in #[cfg(test)] builds.

use crate::store::Store;
use crate::types::*;
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Mutex;

pub struct MockStore {
    pub nodes: Mutex<HashMap<NodeId, NodeRecord>>,
    pub links: Mutex<HashMap<LinkId, LinkRecord>>,
    pub props: Mutex<HashMap<(NodeId, String), PropValue>>,
}

impl Default for MockStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MockStore {
    pub fn new() -> Self {
        MockStore {
            nodes: Mutex::new(HashMap::new()),
            links: Mutex::new(HashMap::new()),
            props: Mutex::new(HashMap::new()),
        }
    }

    pub fn add_entity(&self, id: &str, label: &str, confidence: f64, tags: Vec<String>) {
        self.nodes.lock().unwrap().insert(id.to_string(), NodeRecord {
            id: id.to_string(), type_: NodeType::Entity, tags,
            label: label.to_string(), confidence, embedding: None,
            created_at: chrono::Utc::now().naive_utc(),
            updated_at: chrono::Utc::now().naive_utc(),
        });
    }

    pub fn add_link(&self, id: &str, from: &str, to: &str, type_: LinkType, weight: f64) {
        self.links.lock().unwrap().insert(id.to_string(), LinkRecord {
            id: id.to_string(), from: from.to_string(), to: to.to_string(),
            type_, tags: vec![], weight,
            created_at: chrono::Utc::now().naive_utc(),
        });
    }
}

#[async_trait]
impl Store for MockStore {
    async fn write_batch(&mut self, _batch: WriteBatch) -> Result<(), StoreError> { Ok(()) }
    async fn write_maintenance(&mut self, _m: Vec<StoreMutation>) -> Result<(), StoreError> { Ok(()) }

    async fn get_node(&self, id: &NodeId) -> Result<Option<NodeRecord>, StoreError> {
        Ok(self.nodes.lock().unwrap().get(id).cloned())
    }

    async fn find_nodes(&self, query: &NodeQuery) -> Result<Vec<NodeRecord>, StoreError> {
        let cache = self.nodes.lock().unwrap();
        Ok(cache.values().filter(|n| {
            if let Some(t) = &query.type_ { if n.type_ != *t { return false; }}
            if let Some(l) = &query.label_contains {
                if !n.label.to_lowercase().contains(&l.to_lowercase()) { return false; }
            }
            true
        }).cloned().collect())
    }

    async fn find_nodes_by_type(&self, type_: &NodeType) -> Result<Vec<NodeRecord>, StoreError> {
        Ok(self.nodes.lock().unwrap().values().filter(|n| n.type_ == *type_).cloned().collect())
    }

    async fn find_nodes_by_tag(&self, _tag: &str) -> Result<Vec<NodeRecord>, StoreError> {
        Ok(vec![])
    }

    async fn get_property(&self, owner_id: &str, key: &str) -> Result<Option<PropRecord>, StoreError> {
        let props = self.props.lock().unwrap();
        Ok(props.get(&(owner_id.to_string(), key.to_string())).map(|pv| PropRecord {
            id: format!("{}::{}", owner_id, key),
            owner_id: owner_id.to_string(),
            owner_kind: OwnerKind::Node,
            key: key.to_string(),
            kind: pv.kind(),
            value: pv.clone(),
            created_at: chrono::Utc::now().naive_utc(),
            updated_at: chrono::Utc::now().naive_utc(),
        }))
    }

    async fn get_all_properties(&self, _owner_id: &str) -> Result<Vec<PropRecord>, StoreError> {
        Ok(vec![])
    }

    async fn get_link(&self, id: &LinkId) -> Result<Option<LinkRecord>, StoreError> {
        Ok(self.links.lock().unwrap().get(id).cloned())
    }

    async fn find_links(&self, from: &NodeId, type_: Option<&LinkType>) -> Result<Vec<LinkRecord>, StoreError> {
        let cache = self.links.lock().unwrap();
        Ok(cache.values().filter(|l| {
            l.from == *from && (type_.is_none_or(|t| l.type_ == *t))
        }).cloned().collect())
    }

    async fn find_links_to(&self, to: &NodeId, type_: Option<&LinkType>) -> Result<Vec<LinkRecord>, StoreError> {
        let cache = self.links.lock().unwrap();
        Ok(cache.values().filter(|l| {
            l.to == *to && (type_.is_none_or(|t| l.type_ == *t))
        }).cloned().collect())
    }

    async fn get_all_links(&self) -> Result<Vec<LinkRecord>, StoreError> {
        Ok(self.links.lock().unwrap().values().cloned().collect())
    }

    async fn traverse(&self, _from: &NodeId, _filter: &TraversalFilter) -> Result<Vec<(LinkRecord, NodeRecord)>, StoreError> {
        Ok(vec![])
    }

    async fn get_tag_index(&self) -> Result<HashMap<String, Vec<NodeId>>, StoreError> {
        Ok(HashMap::new())
    }
}
