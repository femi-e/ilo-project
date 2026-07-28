use crate::types::*;
use std::collections::HashMap;

pub trait Store: Send + Sync {
    async fn write_batch(&mut self, batch: WriteBatch) -> Result<(), StoreError>;
    async fn write_maintenance(&mut self, mutations: Vec<StoreMutation>) -> Result<(), StoreError>;
    async fn get_node(&self, id: &NodeId) -> Result<Option<NodeRecord>, StoreError>;
    async fn find_nodes(&self, query: &NodeQuery) -> Result<Vec<NodeRecord>, StoreError>;
    async fn find_nodes_by_type(&self, type_: &NodeType) -> Result<Vec<NodeRecord>, StoreError>;
    async fn find_nodes_by_tag(&self, subtype: &str) -> Result<Vec<NodeRecord>, StoreError>;
    async fn get_property(&self, owner_id: &str, key: &str) -> Result<Option<PropRecord>, StoreError>;
    async fn get_all_properties(&self, owner_id: &str) -> Result<Vec<PropRecord>, StoreError>;
    async fn get_link(&self, id: &LinkId) -> Result<Option<LinkRecord>, StoreError>;
    async fn find_links(&self, from: &NodeId, type_: Option<&str>) -> Result<Vec<LinkRecord>, StoreError>;
    async fn find_links_to(&self, to: &NodeId, type_: Option<&str>) -> Result<Vec<LinkRecord>, StoreError>;
    async fn get_all_links(&self) -> Result<Vec<LinkRecord>, StoreError>;
    async fn traverse(&self, from: &NodeId, filter: &TraversalFilter) -> Result<Vec<(LinkRecord, NodeRecord)>, StoreError>;
    async fn get_tag_index(&self) -> Result<HashMap<String, Vec<NodeId>>, StoreError>;
}
