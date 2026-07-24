//! Request and response types for all ILO API endpoints.
//! Shared between handlers.rs and the ILO client.

use serde::{Deserialize, Serialize};

// ─── Request types ──────────────────────────────────────────

#[derive(Deserialize)]
pub struct RememberReq {
    pub turn_id: Option<String>,
    pub turn_index: Option<u32>,
    pub query: Option<String>,
    pub entities: Option<Vec<EntityInput>>,
    pub response: Option<String>,
    pub model: Option<String>,
    pub tokens_in: Option<u32>,
    pub tokens_out: Option<u32>,
    pub duration_ms: Option<u64>,
    pub claims: Option<Vec<ClaimInput>>,
    pub all_entities: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct IngestReq {
    pub content: String,
    pub source: String,
    pub tags: Option<Vec<String>>,
    pub entities: Option<Vec<EntityInput>>,
    pub claims: Option<Vec<ClaimInput>>,
}

#[derive(Deserialize)]
pub struct EntityInput {
    pub label: String,
    pub tags: Option<Vec<String>>,
    pub confidence: Option<f64>,
    pub properties: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Deserialize)]
pub struct ClaimInput {
    pub content: String,
    pub confidence: Option<f64>,
    pub provenance: Option<String>,
    pub entities: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct RecallReq {
    pub query: String,
    pub query_embedding: Option<Vec<f32>>,
}

#[derive(Deserialize)]
pub struct ExtractReq {
    pub text: String,
}

#[derive(Deserialize)]
pub struct EmbedReq {
    pub text: String,
    pub is_query: Option<bool>,
}

#[derive(Deserialize)]
pub struct LearnReq {
    pub query: Option<String>,
    pub response_text: Option<String>,
    pub used_labels: Option<Vec<String>>,
    pub retrieved_labels: Option<Vec<String>>,
    pub turn_id: Option<String>,
    pub quality: Option<f64>,
}

#[derive(Deserialize)]
pub struct EntityLookupReq {
    pub name: String,
}

#[derive(Deserialize)]
pub struct ConnectReq {
    pub from: String,
    pub to: String,
    pub link_type: String,
    pub confidence: Option<f64>,
}

#[derive(Deserialize)]
pub struct SearchReq {
    pub query: String,
    pub max_hops: Option<u8>,
    pub tag: Option<String>,
}

#[derive(Deserialize)]
pub struct EntityUpdateReq {
    pub name: String,
    pub properties: serde_json::Map<String, serde_json::Value>,
    pub confidence: Option<f64>,
    pub tags: Option<Vec<String>>,
}

// ─── Response types ─────────────────────────────────────────

#[derive(Serialize)]
pub struct RememberResp {
    pub status: String,
    pub turn_id: String,
    pub phase: String,
    pub entities_created: usize,
}

#[derive(Serialize)]
pub struct RecallResp {
    pub context: String,
    pub nodes: usize,
    pub chars: usize,
}

#[derive(Serialize)]
pub struct ExtractResp {
    pub text: String,
    pub entities: Vec<mem_arch::extract::ExtractedEntity>,
    pub claims: Vec<mem_arch::extract::ExtractedClaim>,
    pub n_entities: usize,
    pub n_claims: usize,
}

#[derive(Serialize)]
pub struct LearnResp {
    pub status: String,
    pub edges_updated: usize,
    pub message: String,
}

#[derive(Serialize)]
pub struct EntityLookupResp {
    pub found: bool,
    pub id: Option<String>,
    pub name: Option<String>,
    pub confidence: Option<f64>,
    pub tags: Option<Vec<String>>,
    pub properties: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Serialize)]
pub struct ConnectResp {
    pub status: String,
    pub link_id: String,
    pub entities_affected: Vec<String>,
}

#[derive(Serialize)]
pub struct SearchedNode {
    pub id: String,
    pub label: String,
    pub node_type: String,
    pub confidence: f64,
    pub relevance: f64,
    pub tags: Vec<String>,
}

#[derive(Serialize)]
pub struct EntityUpdateResp {
    pub status: String,
    pub created: bool,
    pub entities_affected: Vec<String>,
}
