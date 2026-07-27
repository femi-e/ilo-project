//! LadybugStore — per-operation connection pool pattern.
use crate::store::Store;
use crate::types::*;
use async_trait::async_trait;
use lbug::{Connection, Database, LogicalType, SystemConfig, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Lock a Mutex, recovering from poisoning (a previous panic inside the lock).
macro_rules! lock_or_recover {
    ($mu:expr) => {
        match $mu.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                tracing::warn!("mutex poisoned, recovering");
                poisoned.into_inner()
            }
        }
    };
}

pub struct LadybugStore {
    db: Arc<Database>,
    node_cache: Mutex<HashMap<NodeId, NodeRecord>>,
    link_cache: Mutex<HashMap<LinkId, LinkRecord>>,
    tag_index: Mutex<HashMap<String, Vec<NodeId>>>,
}

impl LadybugStore {
    pub fn new<P: AsRef<Path>>(path: P) -> Result<Self, StoreError> {
        // Try to open the database; if the WAL is corrupted, delete both
        // .lbug and .wal files and start fresh. This recovers from crashes
        // that left the WAL in an inconsistent checksum state.
        let db_result = Database::new(path.as_ref(), SystemConfig::default());
        let db = match db_result {
            Ok(db) => Arc::new(db),
            Err(ref e) if e.to_string().contains("Checksum verification failed") => {
                tracing::warn!("WAL corrupted at {:?}, rebuilding...", path.as_ref());
                // Remove the corrupted files
                let _ = std::fs::remove_file(path.as_ref());
                let wal_path = format!("{}.wal", path.as_ref().display());
                let _ = std::fs::remove_file(&wal_path);
                // Retry with a fresh database
                Arc::new(Database::new(path.as_ref(), SystemConfig::default())?)
            },
            Err(e) => return Err(StoreError::Database(e.to_string())),
        };
        let s = Self { db, node_cache: Mutex::new(HashMap::new()), link_cache: Mutex::new(HashMap::new()), tag_index: Mutex::new(HashMap::new()) };
        s.init_schema()?;
        Ok(s)
    }

    /// Checkpoint the WAL to the main database file.
    /// Called on graceful shutdown to prevent WAL corruption.
    pub fn checkpoint(&self) {
        tracing::info!("Checkpointing WAL...");
        match Connection::new(self.db.as_ref()) {
            Ok(c) => {
                match c.query("CHECKPOINT") {
                    Ok(_) => tracing::info!("WAL checkpoint complete"),
                    Err(e) => tracing::error!("WAL checkpoint failed: {e}"),
                }
            },
            Err(e) => tracing::error!("Cannot connect for checkpoint: {e}"),
        }
    }

    /// Warm the in-memory cache from the database.
    /// Called in the background after server starts.
    pub fn warm_cache(&self) -> Result<(), StoreError> {
        self._warm_cache()
    }

    fn init_schema(&self) -> Result<(), StoreError> {
        let c = Connection::new(self.db.as_ref())?;
        // Install and load extensions (non-fatal if unavailable)
        // Silenced: extensions only work with brew shared library, not static linking
        let _ = c.query("INSTALL fts");
        let _ = c.query("LOAD fts");
        let _ = c.query("INSTALL vector");
        let _ = c.query("LOAD vector");
        c.query("CREATE NODE TABLE IF NOT EXISTS Node (id STRING PRIMARY KEY, type STRING, tags STRING[], label STRING, embedding FLOAT[768], confidence DOUBLE DEFAULT 0.0, created_at TIMESTAMP DEFAULT current_timestamp(), updated_at TIMESTAMP DEFAULT current_timestamp())")?;
        c.query("CREATE NODE TABLE IF NOT EXISTS Prop (id STRING PRIMARY KEY, owner_id STRING, owner_kind STRING, key STRING, kind STRING, val_str STRING, val_float DOUBLE, val_int INT64, val_bool BOOLEAN, val_json JSON, created_at TIMESTAMP DEFAULT current_timestamp(), updated_at TIMESTAMP DEFAULT current_timestamp())")?;
        c.query("CREATE REL TABLE IF NOT EXISTS LINK (FROM Node TO Node, id STRING PRIMARY KEY, type STRING, rel STRING DEFAULT '', tags STRING[], weight DOUBLE DEFAULT 0.0, confidence DOUBLE DEFAULT 0.0, created_at TIMESTAMP DEFAULT current_timestamp())")?;
        for i in &["idx_node_type","idx_prop_owner","idx_prop_owner_key","idx_link_type","idx_link_from","idx_link_to"] {
            let t = if i.starts_with("idx_node"){"Node"}else if i.starts_with("idx_prop"){"Prop"}else{"LINK"};
            let col = match *i{"idx_node_type"=>"type","idx_prop_owner"=>"owner_id","idx_prop_owner_key"=>"owner_id,key","idx_link_type"=>"type","idx_link_from"=>"from","idx_link_to"=>"to",_=>""};
            let _ = c.query(&format!("CALL CREATE_HASH_INDEX('{}','{}','{}')",t,i,col));
        }
        Ok(())
    }

    /// Sync in-memory caches after mutations are written to the database.
    fn sync_cache(&self, mutations: &[StoreMutation]) {
        let mut nc = lock_or_recover!(self.node_cache);
        let mut lc = lock_or_recover!(self.link_cache);
        let mut ti = lock_or_recover!(self.tag_index);
        for m in mutations {
            match m {
                StoreMutation::CreateNode { id, type_, tags, label, confidence } => {
                    let node = NodeRecord {
                        id: id.clone(), type_: type_.clone(), tags: tags.clone(),
                        label: label.clone(), confidence: *confidence, embedding: None,
                        created_at: chrono::Utc::now().naive_utc(),
                        updated_at: chrono::Utc::now().naive_utc(),
                    };
                    for tag in tags { ti.entry(tag.clone()).or_default().push(id.clone()); }
                    nc.insert(id.clone(), node);
                },
                StoreMutation::UpdateLinkWeight { id, weight } => {
                    if let Some(link) = lc.get_mut(id) { link.weight = *weight; }
                },
                StoreMutation::CreateLink { id, from, to, type_, rel, tags, weight, confidence } => {
                    lc.insert(id.clone(), LinkRecord {
                        id: id.clone(), from: from.clone(), to: to.clone(),
                        type_: type_.clone(), rel: rel.clone(),
                        tags: tags.clone(), weight: *weight, confidence: *confidence,
                        created_at: chrono::Utc::now().naive_utc(),
                    });
                },
                StoreMutation::SetProperty { .. } => {
                    // Properties not cached — fetched from DB on demand
                },
                StoreMutation::DeleteProperty { .. } => {
                    // Properties not cached — no-op
                },
                StoreMutation::DeleteLink { id } => {
                    lc.remove(id);
                },
                StoreMutation::DeleteNode { id } => {
                    // Remove from node cache
                    nc.remove(id);
                    // Remove from tag index (search all tag entries for this ID)
                    ti.retain(|_, ids| {
                        ids.retain(|nid| nid != id);
                        !ids.is_empty()
                    });
                },
            }
        }
    }

    /// Execute a raw Cypher query (for direct DB ops like setting embeddings).
    pub async fn raw_query(&self, cypher: &str) -> Result<(), StoreError> {
        let c = Connection::new(self.db.as_ref())?;
        c.query(cypher)?;
        Ok(())
    }

    fn _warm_cache(&self) -> Result<(), StoreError> {
        let c = Connection::new(self.db.as_ref())?;
        let mut node_q = c.query("MATCH (n:Node) RETURN n.id, n.type, n.tags, n.label, n.confidence, n.created_at, n.updated_at, n.embedding")?;
        {
            let mut nc = match self.node_cache.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            let mut ti = match self.tag_index.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            for row in &mut node_q { if let Some(node) = row_to_node(&row) {
                for tag in &node.tags { ti.entry(tag.clone()).or_default().push(node.id.clone()); }
                nc.insert(node.id.clone(), node);
            } }
        }
        let mut link_q = c.query("MATCH (a:Node)-[l:LINK]->(b:Node) RETURN l.id, a.id, b.id, l.type, l.rel, l.weight, l.confidence, l.created_at")?;
        {
            let mut lc = match self.link_cache.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            for row in &mut link_q { if let Some(link) = row_to_link(&row) { lc.insert(link.id.clone(), link); } }
        }
        Ok(())
    }
}

/// Format a Vec<String> of tags into Cypher array syntax.
/// Convert Vec<String> tags into a LadybugDB Value::List for parameterized queries.
fn tags_to_value(tags: &[String]) -> Value {
    Value::List(
        LogicalType::String,
        tags.iter().map(|t| Value::String(t.clone())).collect(),
    )
}

fn pv(v: &PropValue) -> (String, Value) {
    match v {
        PropValue::String(s) => ("str".into(), Value::String(s.clone())),
        PropValue::Float(f) => ("float".into(), Value::Double(*f)),
        PropValue::Int(i) => ("int".into(), Value::Int64(*i)),
        PropValue::Bool(b) => ("bool".into(), Value::Bool(*b)),
        PropValue::Json(j) => ("json".into(), Value::String(j.to_string())),
    }
}

/// Execute a parameterized Cypher query using prepare + execute.
fn exec_params(c: &Connection, query: &str, params: Vec<(&str, Value)>) -> Result<(), StoreError> {
    let mut stmt = c.prepare(query)?;
    c.execute(&mut stmt, params)?;
    Ok(())
}

fn apply(c: &Connection, m: &StoreMutation) -> Result<(), StoreError> {
    match m {
        StoreMutation::CreateNode { id, type_, tags, label, confidence } => {
            exec_params(c, "CREATE (:Node {id: $id, type: $type, tags: $tags, label: $label, confidence: $confidence})", vec![
                ("id", Value::String(id.clone())),
                ("type", Value::String(type_.as_str().into())),
                ("tags", tags_to_value(tags)),
                ("label", Value::String(label.clone())),
                ("confidence", Value::Double(*confidence)),
            ])?;
        }
        StoreMutation::SetProperty { owner_id, owner_kind, key, value } => {
            let pid = format!("{}::{}", owner_id, key);
            let (kind, val) = pv(value);
            let col = match kind.as_str() {
                "str" => "val_str",
                "float" => "val_float",
                "int" => "val_int",
                "bool" => "val_bool",
                "json" => "val_json",
                _ => "val_str",
            };
            exec_params(
                c,
                &format!("MERGE (p:Prop {{id: $pid}}) SET p.owner_id = $owner_id, p.owner_kind = $owner_kind, p.key = $key, p.kind = $kind, p.{} = $val", col),
                vec![
                    ("pid", Value::String(pid)),
                    ("owner_id", Value::String(owner_id.clone())),
                    ("owner_kind", Value::String(owner_kind.as_str().into())),
                    ("key", Value::String(key.clone())),
                    ("kind", Value::String(kind)),
                    ("val", val),
                ],
            )?;
        }
        StoreMutation::DeleteProperty { owner_id, key } => {
            exec_params(c, "MATCH (p:Prop) WHERE p.owner_id = $owner_id AND p.key = $key DELETE p", vec![
                ("owner_id", Value::String(owner_id.clone())),
                ("key", Value::String(key.clone())),
            ])?;
        }
        StoreMutation::CreateLink { id, from, to, type_, rel, tags, weight, confidence } => {
            exec_params(c, "MATCH (a:Node {id: $from}), (b:Node {id: $to}) CREATE (a)-[:LINK {id: $lid, type: $type, rel: $rel, tags: $tags, weight: $weight, confidence: $confidence}]->(b)", vec![
                ("from", Value::String(from.clone())),
                ("to", Value::String(to.clone())),
                ("lid", Value::String(id.clone())),
                ("type", Value::String(type_.as_str().into())),
                ("rel", Value::String(rel.clone())),
                ("tags", tags_to_value(tags)),
                ("weight", Value::Double(*weight)),
                ("confidence", Value::Double(*confidence)),
            ])?;
        }
        StoreMutation::UpdateLinkWeight { id, weight } => {
            exec_params(c, "MATCH ()-[l:LINK {id: $id}]->() SET l.weight = $weight", vec![
                ("id", Value::String(id.clone())),
                ("weight", Value::Double(*weight)),
            ])?;
        }
        StoreMutation::DeleteLink { id } => {
            exec_params(c, "MATCH ()-[l:LINK {id: $id}]->() DELETE l", vec![
                ("id", Value::String(id.clone())),
            ])?;
        }
        StoreMutation::DeleteNode { id } => {
            exec_params(c, "MATCH (p:Prop) WHERE p.owner_id = $owner_id DELETE p", vec![
                ("owner_id", Value::String(id.clone())),
            ])?;
            exec_params(c, "MATCH (n:Node {id: $id}) DETACH DELETE n", vec![
                ("id", Value::String(id.clone())),
            ])?;
        }
    }
    Ok(())
}

fn ts_from_value(v: &Value) -> chrono::NaiveDateTime {
    match v {
        Value::String(s) => {
            // LadybugDB TIMESTAMP format: "2026-07-23 04:30:00"
            chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
                .unwrap_or_else(|_| chrono::Utc::now().naive_utc())
        },
        _ => chrono::Utc::now().naive_utc(),
    }
}

fn row_to_node(row: &[Value]) -> Option<NodeRecord> {
    if row.len()<8{return None;}
    if let Value::String(id)=&row[0]{if let Value::String(typ)=&row[1]{
        let tags=match &row[2]{Value::List(_,items)=>items.iter().filter_map(|v|if let Value::String(s)=v{Some(s.clone())}else{None}).collect(),_=>vec![]};
        let label=match &row[3]{Value::String(s)=>s.clone(),_=>String::new()};
        let conf=match &row[4]{Value::Double(d)=>*d,_=>0.0};
        let created_at = ts_from_value(&row[5]);
        let updated_at = ts_from_value(&row[6]);
        let embedding = match &row[7] {
            Value::List(_, items) => {
                let v: Vec<f32> = items.iter().filter_map(|x| match x {
                    Value::Double(d) => Some(*d as f32),
                    Value::Float(d) => Some(*d),
                    Value::Int64(n) => Some(*n as f32),
                    _ => None,
                }).collect();
                if v.is_empty() { None } else { Some(v) }
            },
            _ => None,
        };
        Some(NodeRecord{id:id.clone(),type_:typ.parse::<NodeType>().unwrap_or(NodeType::Entity),tags,label,confidence:conf,embedding,created_at,updated_at})
    }else{None}}else{None}
}

fn row_to_link(row: &[Value]) -> Option<LinkRecord> {
    if row.len()<7{return None;}
    if let Value::String(id)=&row[0]{if let Value::String(frm)=&row[1]{if let Value::String(to)=&row[2]{if let Value::String(typ)=&row[3]{
        let rel=match &row[4]{Value::String(s)=>s.clone(),_=>String::new()};
        let w=match &row[5]{Value::Double(d)=>*d,_=>0.0};
        let conf=match &row[6]{Value::Double(d)=>*d,_=>0.0};
        let created_at = ts_from_value(&row[7]);
        Some(LinkRecord{id:id.clone(),from:frm.clone(),to:to.clone(),type_:typ.parse::<LinkType>().unwrap_or(LinkType::Depends),rel,tags:vec![],weight:w,confidence:conf,created_at})
    }else{None}}else{None}}else{None}}else{None}
}

/// Parse a PropRecord from a Cypher result row.
fn parse_prop(row: &[Value]) -> Option<PropRecord> {
    if row.len() < 10 { return None; }
    let id = match &row[0] { Value::String(s) => s.clone(), _ => return None };
    let owner_id = match &row[1] { Value::String(s) => s.clone(), _ => String::new() };
    let owner_kind_str = match &row[2] { Value::String(s) => s.clone(), _ => String::new() };
    let owner_kind = match owner_kind_str.as_str() { "link" => OwnerKind::Link, _ => OwnerKind::Node };
    let key = match &row[3] { Value::String(s) => s.clone(), _ => String::new() };
    let kind_str = match &row[4] { Value::String(s) => s.clone(), _ => String::new() };
    let value = match kind_str.as_str() {
        "str" => { let s = match &row[5] { Value::String(s) => s.clone(), _ => String::new() }; PropValue::String(s) },
        "float" => { let f = match &row[6] { Value::Double(d) => *d, _ => 0.0 }; PropValue::Float(f) },
        "int" => { let i = match &row[7] { Value::Int64(n) => *n, _ => 0i64 }; PropValue::Int(i) },
        "bool" => { let b = match &row[8] { Value::Bool(b) => *b, _ => false }; PropValue::Bool(b) },
        "json" => {
            let j: serde_json::Value = match &row[9] {
                Value::String(s) => serde_json::from_str(s).unwrap_or(serde_json::Value::Null),
                _ => serde_json::Value::Null,
            };
            PropValue::Json(j)
        },
        _ => PropValue::String(String::new()),
    };
    Some(PropRecord {
        id, owner_id, owner_kind, key,
        kind: kind_str.parse::<PropKind>().unwrap_or(PropKind::String),
        value,
        created_at: chrono::Utc::now().naive_utc(),
        updated_at: chrono::Utc::now().naive_utc(),
    })
}

fn collect_props(c: &Connection, oid: &str) -> Result<Vec<PropRecord>, StoreError> {
    let mut stmt = c.prepare("MATCH (p:Prop) WHERE p.owner_id = $owner_id RETURN p.id, p.owner_id, p.owner_kind, p.key, p.kind, p.val_str, p.val_float, p.val_int, p.val_bool, p.val_json")?;
    let mut r = c.execute(&mut stmt, vec![("owner_id", Value::String(oid.to_string()))])?;
    let mut v=Vec::new();
    for row in &mut r {
        if let Some(prop) = parse_prop(&row) {
            v.push(prop);
        }
    }
    Ok(v)
}

impl Drop for LadybugStore {
    fn drop(&mut self) {
        self.checkpoint();
    }
}

#[async_trait]
impl Store for LadybugStore {
    async fn write_batch(&mut self, batch: WriteBatch) -> Result<(), StoreError> {
        let c = Connection::new(self.db.as_ref())?;
        c.query("BEGIN TRANSACTION")?;
        let tid = &batch.turn.id;

        // Only create turn node if response is provided (turn is complete)
        if let Some(ref _resp) = batch.turn.response_text {
            let turn = &batch.turn;
            let label = format!("Turn #{}", turn.turn_index);

            exec_params(&c, "CREATE (:Node {id: $id, type: 'turn', label: $label, confidence: 1.0})", vec![
                ("id", Value::String(tid.clone())),
                ("label", Value::String(label)),
            ])?;

            // Create turn properties (only for fields that have values)
            // turn_index is always present (int)
            exec_params(&c, "CREATE (:Prop {id: $pid, owner_id: $owner_id, owner_kind: 'node', key: 'turn_index', kind: 'int', val_int: $val})", vec![
                ("pid", Value::String(format!("{}::turn_index", tid))),
                ("owner_id", Value::String(tid.clone())),
                ("val", Value::Int64(turn.turn_index as i64)),
            ])?;

            // user_text (string, optional)
            if let Some(ref ut) = turn.user_text {
                exec_params(&c, "CREATE (:Prop {id: $pid, owner_id: $owner_id, owner_kind: 'node', key: 'user_text', kind: 'string', val_str: $val})", vec![
                    ("pid", Value::String(format!("{}::user_text", tid))),
                    ("owner_id", Value::String(tid.clone())),
                    ("val", Value::String(ut.clone())),
                ])?;
            }

            // response_text (string, optional)
            if let Some(ref rt) = turn.response_text {
                exec_params(&c, "CREATE (:Prop {id: $pid, owner_id: $owner_id, owner_kind: 'node', key: 'response_text', kind: 'string', val_str: $val})", vec![
                    ("pid", Value::String(format!("{}::response_text", tid))),
                    ("owner_id", Value::String(tid.clone())),
                    ("val", Value::String(rt.clone())),
                ])?;
            }

            // model (string, optional)
            if let Some(ref m) = turn.model {
                exec_params(&c, "CREATE (:Prop {id: $pid, owner_id: $owner_id, owner_kind: 'node', key: 'model', kind: 'string', val_str: $val})", vec![
                    ("pid", Value::String(format!("{}::model", tid))),
                    ("owner_id", Value::String(tid.clone())),
                    ("val", Value::String(m.clone())),
                ])?;
            }

            // tokens_in (int, optional)
            if let Some(ref ti) = turn.tokens_in {
                exec_params(&c, "CREATE (:Prop {id: $pid, owner_id: $owner_id, owner_kind: 'node', key: 'tokens_in', kind: 'int', val_int: $val})", vec![
                    ("pid", Value::String(format!("{}::tokens_in", tid))),
                    ("owner_id", Value::String(tid.clone())),
                    ("val", Value::Int64(*ti as i64)),
                ])?;
            }

            // tokens_out (int, optional)
            if let Some(ref to) = turn.tokens_out {
                exec_params(&c, "CREATE (:Prop {id: $pid, owner_id: $owner_id, owner_kind: 'node', key: 'tokens_out', kind: 'int', val_int: $val})", vec![
                    ("pid", Value::String(format!("{}::tokens_out", tid))),
                    ("owner_id", Value::String(tid.clone())),
                    ("val", Value::Int64(*to as i64)),
                ])?;
            }

            // duration_ms (int, optional)
            if let Some(ref d) = turn.duration_ms {
                exec_params(&c, "CREATE (:Prop {id: $pid, owner_id: $owner_id, owner_kind: 'node', key: 'duration_ms', kind: 'int', val_int: $val})", vec![
                    ("pid", Value::String(format!("{}::duration_ms", tid))),
                    ("owner_id", Value::String(tid.clone())),
                    ("val", Value::Int64(*d as i64)),
                ])?;
            }

            // Link to previous turn for temporal ordering.
            if let Ok(mut prev) = c.query("MATCH (t:Node {type: 'turn'}) RETURN t.id ORDER BY t.created_at DESC LIMIT 1") {
                if let Some(row) = prev.next() {
                    if let Value::String(prev_id) = &row[0] {
                        let seq_id = uid("seq");
                        exec_params(&c, "MATCH (a:Node {id: $prev}), (b:Node {id: $next}) CREATE (a)-[:LINK {id: $lid, type: 'precedes', weight: 0.9}]->(b)", vec![
                            ("prev", Value::String(prev_id.clone())),
                            ("next", Value::String(tid.clone())),
                            ("lid", Value::String(seq_id)),
                        ])?;
                    }
                }
            }

            // Update cache with turn node
            let mut nc = lock_or_recover!(self.node_cache);
            nc.insert(tid.clone(), NodeRecord {
                id: tid.clone(), type_: NodeType::Turn, tags: vec![],
                label: format!("Turn #{}", turn.turn_index), confidence: 1.0,
                embedding: None, created_at: chrono::Utc::now().naive_utc(),
                updated_at: chrono::Utc::now().naive_utc(),
            });
            drop(nc);
        }

        // Apply entity/claim/link mutations (both phases)
        for m in &batch.mutations { apply(&c, m)?; }
        c.query("COMMIT")?;
        drop(c);

        // Sync in-memory caches
        self.sync_cache(&batch.mutations);
        Ok(())
    }

    async fn write_maintenance(&mut self, mutations: Vec<StoreMutation>) -> Result<(), StoreError> {
        let c = Connection::new(self.db.as_ref())?;
        c.query("BEGIN TRANSACTION")?;
        for m in &mutations { apply(&c, m)?; }
        c.query("COMMIT")?;
        self.sync_cache(&mutations);
        Ok(())
    }

    async fn get_node(&self, id: &NodeId) -> Result<Option<NodeRecord>, StoreError> {
        // Fast path: read from cache
        {
            let cache = lock_or_recover!(self.node_cache);
            if let Some(node) = cache.get(id) {
                return Ok(Some(node.clone()));
            }
        }
        // Cache miss: fall back to DB query (recovers from cache/DB desync)
        let c = Connection::new(self.db.as_ref())?;
        let mut stmt = c.prepare(
            "MATCH (n:Node {id: $id}) RETURN n.id, n.type, n.tags, n.label, n.confidence, n.created_at, n.updated_at, n.embedding"
        )?;
        let mut r = c.execute(&mut stmt, vec![("id", Value::String(id.clone()))])?;
        for row in &mut r {
            if let Some(node) = row_to_node(&row) {
                // Update cache for future reads
                lock_or_recover!(self.node_cache).insert(node.id.clone(), node.clone());
                return Ok(Some(node));
            }
        }
        Ok(None)
    }

    async fn find_nodes(&self, query: &NodeQuery) -> Result<Vec<NodeRecord>, StoreError> {
        let cache = lock_or_recover!(self.node_cache);
        let mut r: Vec<NodeRecord> = cache.values().filter(|n| {
            if let Some(t) = &query.type_ { if n.type_ != *t { return false; } }
            if let Some(l) = &query.label_contains { if !n.label.to_lowercase().contains(&l.to_lowercase()) { return false; } }
            true
        }).cloned().collect();
        r.truncate(query.limit.max(1)); Ok(r)
    }

    async fn find_nodes_by_type(&self, type_: &NodeType) -> Result<Vec<NodeRecord>, StoreError> {
        Ok(lock_or_recover!(self.node_cache).values().filter(|n| n.type_ == *type_).cloned().collect())
    }

    async fn find_nodes_by_tag(&self, subtype: &str) -> Result<Vec<NodeRecord>, StoreError> {
        let idx = lock_or_recover!(self.tag_index);
        let cache = lock_or_recover!(self.node_cache);
        Ok(idx.get(subtype).map(|ids| ids.iter().filter_map(|id| cache.get(id).cloned()).collect()).unwrap_or_default())
    }

    async fn get_property(&self, owner_id: &str, key: &str) -> Result<Option<PropRecord>, StoreError> {
        let c = Connection::new(self.db.as_ref())?;
        let mut stmt = c.prepare("MATCH (p:Prop) WHERE p.owner_id = $owner_id AND p.key = $key RETURN p.id, p.owner_id, p.owner_kind, p.key, p.kind, p.val_str, p.val_float, p.val_int, p.val_bool, p.val_json")?;
        let mut r = c.execute(&mut stmt, vec![
            ("owner_id", Value::String(owner_id.to_string())),
            ("key", Value::String(key.to_string())),
        ])?;
        for row in &mut r {
            let prop = parse_prop(&row);
            if prop.is_some() { return Ok(prop); }
        }
        Ok(None)
    }

    async fn get_all_properties(&self, owner_id: &str) -> Result<Vec<PropRecord>, StoreError> {
        let c = Connection::new(self.db.as_ref())?;
        collect_props(&c, owner_id)
    }

    async fn get_link(&self, id: &LinkId) -> Result<Option<LinkRecord>, StoreError> {
        Ok(lock_or_recover!(self.link_cache).get(id).cloned())
    }

    async fn find_links(&self, from: &NodeId, type_: Option<&str>) -> Result<Vec<LinkRecord>, StoreError> {
        let cache = lock_or_recover!(self.link_cache);
        Ok(cache.values().filter(|l| l.from == *from && (type_.is_none_or(|t| l.type_.as_str() == t))).cloned().collect())
    }

    async fn find_links_to(&self, to: &NodeId, type_: Option<&str>) -> Result<Vec<LinkRecord>, StoreError> {
        let cache = lock_or_recover!(self.link_cache);
        Ok(cache.values().filter(|l| l.to == *to && (type_.is_none_or(|t| l.type_.as_str() == t))).cloned().collect())
    }

    async fn get_all_links(&self) -> Result<Vec<LinkRecord>, StoreError> {
        Ok(lock_or_recover!(self.link_cache).values().cloned().collect())
    }

    async fn traverse(&self, from: &NodeId, filter: &TraversalFilter) -> Result<Vec<(LinkRecord, NodeRecord)>, StoreError> {
        let cache = lock_or_recover!(self.link_cache);
        let nc = lock_or_recover!(self.node_cache);
        let mut res = Vec::new(); let mut vis = std::collections::HashSet::new(); let mut q = std::collections::VecDeque::new(); q.push_back((from.clone(), 0u8));
        while let Some((cur, d)) = q.pop_front() {
            if d >= filter.max_depth { continue; } vis.insert(cur.clone());
            for l in cache.values().filter(|l| l.from == cur) {
                if let Some(t) = &filter.type_ { if l.type_.as_str() != t.as_str() { continue; } }
                if l.weight < filter.min_weight { continue; }
                if let Some(node) = nc.get(&l.to) { res.push((l.clone(), node.clone())); if !vis.contains(&l.to) { q.push_back((l.to.clone(), d+1)); } }
            }
        }
        Ok(res)
    }

    async fn get_tag_index(&self) -> Result<HashMap<String, Vec<NodeId>>, StoreError> {
        Ok(lock_or_recover!(self.tag_index).clone())
    }
}
