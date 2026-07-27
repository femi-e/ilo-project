use crate::types::*;
use async_trait::async_trait;
use std::collections::HashMap;

#[async_trait]
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

#[async_trait]
impl<T: Store + ?Sized> Store for Box<T> {
    async fn write_batch(&mut self, b: WriteBatch) -> Result<(), StoreError> { (**self).write_batch(b).await }
    async fn write_maintenance(&mut self, m: Vec<StoreMutation>) -> Result<(), StoreError> { (**self).write_maintenance(m).await }
    async fn get_node(&self, id: &NodeId) -> Result<Option<NodeRecord>, StoreError> { (**self).get_node(id).await }
    async fn find_nodes(&self, q: &NodeQuery) -> Result<Vec<NodeRecord>, StoreError> { (**self).find_nodes(q).await }
    async fn find_nodes_by_type(&self, t: &NodeType) -> Result<Vec<NodeRecord>, StoreError> { (**self).find_nodes_by_type(t).await }
    async fn find_nodes_by_tag(&self, s: &str) -> Result<Vec<NodeRecord>, StoreError> { (**self).find_nodes_by_tag(s).await }
    async fn get_property(&self, o: &str, k: &str) -> Result<Option<PropRecord>, StoreError> { (**self).get_property(o, k).await }
    async fn get_all_properties(&self, o: &str) -> Result<Vec<PropRecord>, StoreError> { (**self).get_all_properties(o).await }
    async fn get_link(&self, id: &LinkId) -> Result<Option<LinkRecord>, StoreError> { (**self).get_link(id).await }
    async fn find_links(&self, f: &NodeId, t: Option<&str>) -> Result<Vec<LinkRecord>, StoreError> { (**self).find_links(f, t).await }
    async fn find_links_to(&self, t: &NodeId, typ: Option<&str>) -> Result<Vec<LinkRecord>, StoreError> { (**self).find_links_to(t, typ).await }
    async fn get_all_links(&self) -> Result<Vec<LinkRecord>, StoreError> { (**self).get_all_links().await }
    async fn traverse(&self, f: &NodeId, fl: &TraversalFilter) -> Result<Vec<(LinkRecord, NodeRecord)>, StoreError> { (**self).traverse(f, fl).await }
    async fn get_tag_index(&self) -> Result<HashMap<String, Vec<NodeId>>, StoreError> { (**self).get_tag_index().await }
}
