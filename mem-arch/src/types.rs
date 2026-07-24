use std::collections::HashMap;

pub type NodeId = String;
pub type LinkId = String;
pub type PropId = String;

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum NodeType {
    Entity, Claim, Turn,
}
impl NodeType {
    pub fn as_str(&self) -> &'static str {
        match self { NodeType::Entity => "entity", NodeType::Claim => "claim", NodeType::Turn => "turn" }
    }
}
impl std::str::FromStr for NodeType {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s { "entity" => Ok(NodeType::Entity), "claim" => Ok(NodeType::Claim), "turn" => Ok(NodeType::Turn), _ => Err(()) }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum LinkType {
    Has, Ref, Dep, Con, Seq, Evidence, Context, Refute,
}
impl LinkType {
    pub fn as_str(&self) -> &'static str {
        match self { LinkType::Has => "has", LinkType::Ref => "ref", LinkType::Dep => "dep", LinkType::Con => "con", LinkType::Seq => "seq", LinkType::Evidence => "evidence", LinkType::Context => "context", LinkType::Refute => "refute" }
    }
}
impl std::str::FromStr for LinkType {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s { "has" => Ok(LinkType::Has), "ref" => Ok(LinkType::Ref), "dep" => Ok(LinkType::Dep), "con" => Ok(LinkType::Con), "seq" => Ok(LinkType::Seq), "evidence" => Ok(LinkType::Evidence), "context" => Ok(LinkType::Context), "refute" => Ok(LinkType::Refute), _ => Err(()) }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum PropKind { String, Float, Int, Bool, Json }
impl PropKind {
    pub fn as_str(&self) -> &'static str {
        match self { PropKind::String => "string", PropKind::Float => "float", PropKind::Int => "int", PropKind::Bool => "bool", PropKind::Json => "json" }
    }
}
impl std::str::FromStr for PropKind {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s { "string" => Ok(PropKind::String), "float" => Ok(PropKind::Float), "int" => Ok(PropKind::Int), "bool" => Ok(PropKind::Bool), "json" => Ok(PropKind::Json), _ => Err(()) }
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum PropValue {
    String(String), Float(f64), Int(i64), Bool(bool), Json(serde_json::Value),
}
impl PropValue {
    pub fn kind(&self) -> PropKind {
        match self { PropValue::String(_) => PropKind::String, PropValue::Float(_) => PropKind::Float, PropValue::Int(_) => PropKind::Int, PropValue::Bool(_) => PropKind::Bool, PropValue::Json(_) => PropKind::Json }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum OwnerKind { Node, Link }
impl OwnerKind {
    pub fn as_str(&self) -> &'static str { match self { OwnerKind::Node => "node", OwnerKind::Link => "link" } }
}
impl std::str::FromStr for OwnerKind {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, Self::Err> { match s { "node" => Ok(OwnerKind::Node), "link" => Ok(OwnerKind::Link), _ => Err(()) } }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NodeRecord {
    pub id: NodeId, pub type_: NodeType, pub tags: Vec<String>, pub label: String,
    pub confidence: f64, pub embedding: Option<Vec<f32>>,
    pub created_at: chrono::NaiveDateTime, pub updated_at: chrono::NaiveDateTime,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PropRecord {
    pub id: PropId, pub owner_id: String, pub owner_kind: OwnerKind, pub key: String,
    pub kind: PropKind, pub value: PropValue,
    pub created_at: chrono::NaiveDateTime, pub updated_at: chrono::NaiveDateTime,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LinkRecord {
    pub id: LinkId, pub from: NodeId, pub to: NodeId, pub type_: LinkType,
    pub tags: Vec<String>, pub weight: f64, pub created_at: chrono::NaiveDateTime,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ActivatedNode {
    pub node_id: NodeId, pub label: String, pub node_type: NodeType,
    pub activation: f64, pub depth: u8, pub path: Vec<NodeId>,
    pub properties: HashMap<String, PropValue>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ContextBlock {
    pub anchor_text: String, pub activated_nodes: Vec<ActivatedNode>, pub char_count: usize,
}

#[derive(Debug, Clone)]
pub struct Seed {
    pub node_id: NodeId, pub match_score: f64, pub label: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TurnRecord {
    pub id: NodeId,
    pub turn_index: u32,
    pub user_text: Option<String>,
    pub response_text: Option<String>,
    pub model: Option<String>,
    pub tokens_in: Option<u32>,
    pub tokens_out: Option<u32>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WriteBatch {
    pub turn: TurnRecord, pub mutations: Vec<StoreMutation>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum StoreMutation {
    CreateNode { id: NodeId, type_: NodeType, tags: Vec<String>, label: String, confidence: f64 },
    SetProperty { owner_id: String, owner_kind: OwnerKind, key: String, value: PropValue },
    DeleteProperty { owner_id: String, key: String },
    CreateLink { id: LinkId, from: NodeId, to: NodeId, type_: LinkType, tags: Vec<String>, weight: f64 },
    UpdateLinkWeight { id: LinkId, weight: f64 },
    DeleteLink { id: LinkId },
    DeleteNode { id: NodeId },
}

#[derive(Debug, Clone)]
pub struct NodeQuery {
    pub type_: Option<NodeType>, pub tags: Vec<String>,
    pub label_contains: Option<String>, pub limit: usize,
}

#[derive(Debug, Clone)]
pub struct TraversalFilter {
    pub type_: Option<LinkType>, pub min_weight: f64, pub max_depth: u8,
}
impl Default for TraversalFilter {
    fn default() -> Self { TraversalFilter { type_: None, min_weight: 0.0, max_depth: 3 } }
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("Database error: {0}")] Database(String),
    #[error("Node not found: {0}")] NodeNotFound(NodeId),
    #[error("Link not found: {0}")] LinkNotFound(LinkId),
    #[error("Type mismatch: expected {expected}, got {got}")] TypeMismatch { expected: String, got: String },
    #[error("Invalid argument: {0}")] InvalidArgument(String),
    #[error("Serialization error: {0}")] Serde(#[from] serde_json::Error),
    #[error("IO error: {0}")] Io(#[from] std::io::Error),
    #[error(transparent)] Other(#[from] Box<dyn std::error::Error + Send + Sync>),
}
impl From<lbug::Error> for StoreError {
    fn from(e: lbug::Error) -> Self { StoreError::Database(e.to_string()) }
}

/// Generate a UUIDv7 string with a prefix.
/// Example: `uid("e")` → `"e_019f915c..."`
pub fn uid(prefix: &str) -> String {
    format!("{}_{}", prefix, uuid::Uuid::new_v7(uuid::Timestamp::now(uuid::NoContext)))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── NodeType ────────────────────────────────────────

    #[test]
    fn test_node_type_roundtrip() {
        for variant in &[NodeType::Entity, NodeType::Claim, NodeType::Turn] {
            let s = variant.as_str();
            let back: Result<NodeType, _> = s.parse();
            assert_eq!(back, Ok(variant.clone()), "roundtrip failed for {variant:?}");
        }
    }

    #[test]
    fn test_node_type_from_str_invalid() {
        assert!("invalid".parse::<NodeType>().is_err());
        assert!("".parse::<NodeType>().is_err());
    }

    #[test]
    fn test_node_type_as_str_values() {
        assert_eq!(NodeType::Entity.as_str(), "entity");
        assert_eq!(NodeType::Claim.as_str(), "claim");
        assert_eq!(NodeType::Turn.as_str(), "turn");
    }

    // ── LinkType ────────────────────────────────────────

    #[test]
    fn test_link_type_roundtrip() {
        for variant in &[LinkType::Has, LinkType::Ref, LinkType::Dep, LinkType::Con,
                         LinkType::Seq, LinkType::Evidence, LinkType::Context, LinkType::Refute] {
            let s = variant.as_str();
            let back: Result<LinkType, _> = s.parse();
            assert_eq!(back, Ok(variant.clone()), "roundtrip failed for {variant:?}");
        }
    }

    #[test]
    fn test_link_type_from_str_invalid() {
        assert!("unknown".parse::<LinkType>().is_err());
        assert!("".parse::<LinkType>().is_err());
    }

    // ── PropKind / PropValue ────────────────────────────

    #[test]
    fn test_prop_kind_roundtrip() {
        for variant in &[PropKind::String, PropKind::Float, PropKind::Int, PropKind::Bool, PropKind::Json] {
            let s = variant.as_str();
            let back: Result<PropKind, _> = s.parse();
            assert_eq!(back, Ok(variant.clone()), "roundtrip failed for {variant:?}");
        }
    }

    #[test]
    fn test_prop_value_kind() {
        assert_eq!(PropValue::String("x".into()).kind(), PropKind::String);
        assert_eq!(PropValue::Float(1.0).kind(), PropKind::Float);
        assert_eq!(PropValue::Int(42).kind(), PropKind::Int);
        assert_eq!(PropValue::Bool(true).kind(), PropKind::Bool);
        assert_eq!(PropValue::Json(serde_json::Value::Null).kind(), PropKind::Json);
    }

    // ── OwnerKind ───────────────────────────────────────

    #[test]
    fn test_owner_kind_roundtrip() {
        assert_eq!(OwnerKind::Node.as_str(), "node");
        assert_eq!(OwnerKind::Link.as_str(), "link");
        assert_eq!("node".parse::<OwnerKind>(), Ok(OwnerKind::Node));
        assert_eq!("link".parse::<OwnerKind>(), Ok(OwnerKind::Link));
        assert!("x".parse::<OwnerKind>().is_err());
    }

    // ── StoreError ──────────────────────────────────────

    #[test]
    fn test_store_error_display() {
        let e = StoreError::Database("corrupt".into());
        assert_eq!(e.to_string(), "Database error: corrupt");

        let e = StoreError::NodeNotFound("e_123".into());
        assert_eq!(e.to_string(), "Node not found: e_123");

        let e = StoreError::LinkNotFound("l_456".into());
        assert_eq!(e.to_string(), "Link not found: l_456");

        let e = StoreError::TypeMismatch { expected: "entity".into(), got: "turn".into() };
        assert_eq!(e.to_string(), "Type mismatch: expected entity, got turn");

        let e = StoreError::InvalidArgument("bad param".into());
        assert_eq!(e.to_string(), "Invalid argument: bad param");
    }

    // ── TraversalFilter ─────────────────────────────────

    #[test]
    fn test_traversal_filter_default() {
        let f = TraversalFilter::default();
        assert_eq!(f.type_, None);
        assert_eq!(f.min_weight, 0.0);
        assert_eq!(f.max_depth, 3);
    }

    // ── NodeQuery ───────────────────────────────────────

    #[test]
    fn test_node_query_fields() {
        let q = NodeQuery {
            type_: Some(NodeType::Entity),
            tags: vec!["project".into()],
            label_contains: Some("Ailo".into()),
            limit: 10,
        };
        assert_eq!(q.type_, Some(NodeType::Entity));
        assert!(q.tags.contains(&"project".to_string()));
        assert_eq!(q.label_contains, Some("Ailo".into()));
        assert_eq!(q.limit, 10);
    }
}
