//! Embedding generation via llama.cpp HTTP API.
//!
//! Calls a local llama.cpp server running an embedding model (BGE-base GGUF).
//! Falls back gracefully if the server is unreachable — vector search is simply disabled.
//!
//! Expected server: llama-server --port 1235 --host 127.0.0.1 --embeddings --model <gguf>
//!
//! All public functions are async, using `reqwest` for non-blocking HTTP.
//! No longer requires `spawn_blocking` wrappers at call sites.

use std::sync::OnceLock;
use serde_json::Value;

/// Base URL for the embedding server.
const EMBED_URL: &str = "http://127.0.0.1:1235/v1/embeddings";

// Use the shared embedding dimension from types.rs
use crate::types::EMBEDDING_DIM;

/// Shared reqwest client — created once, reused across all calls.
/// Connection pooling and keep-alive are managed internally by reqwest.
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("reqwest client build should succeed with default settings")
    })
}

/// BGE instruction prefix for queries (improves retrieval quality).
const QUERY_PREFIX: &str = "Represent this sentence for searching relevant passages: ";

/// Embed a single text string, returning a normalized vector.
///
/// For queries, prepends the BGE instruction prefix automatically.
/// For entity labels (is_query = false), embeds the text as-is.
/// Returns None if the server is unreachable or returns an error.
pub async fn embed(text: &str, is_query: bool) -> Option<Vec<f32>> {
    let input = if is_query {
        format!("{}{}", QUERY_PREFIX, text)
    } else {
        text.to_string()
    };

    let body = serde_json::json!({
        "model": "default",
        "input": [input],
    });

    let resp = http_client()
        .post(EMBED_URL)
        .json(&body)
        .send()
        .await
        .ok()?;

    let data: Value = resp.json().await.ok()?;
    let embedding = data["data"][0]["embedding"].as_array()?;

    Some(embedding.iter().map(|v| v.as_f64().unwrap_or(0.0) as f32).collect())
}

/// Embed multiple texts in batch.
/// Returns None if the server is unreachable or returns an error.
pub async fn embed_batch(texts: &[&str], is_query: bool) -> Option<Vec<Vec<f32>>> {
    let inputs: Vec<String> = if is_query {
        texts.iter().map(|t| format!("{}{}", QUERY_PREFIX, t)).collect()
    } else {
        texts.iter().map(|t| t.to_string()).collect()
    };

    let body = serde_json::json!({
        "model": "default",
        "input": inputs,
    });

    let resp = http_client()
        .post(EMBED_URL)
        .json(&body)
        .send()
        .await
        .ok()?;

    let data: Value = resp.json().await.ok()?;
    let data_arr = data["data"].as_array()?;

    let mut results = Vec::with_capacity(data_arr.len());
    for entry in data_arr {
        if let Some(emb) = entry["embedding"].as_array() {
            results.push(emb.iter().map(|v| v.as_f64().unwrap_or(0.0) as f32).collect());
        } else {
            return None;
        }
    }

    Some(results)
}

/// Get the expected embedding dimension.
pub fn embedding_dim() -> usize {
    EMBEDDING_DIM
}

/// Check if the embedding server is reachable.
pub async fn is_loaded() -> bool {
    embed("ping", false).await.is_some()
}

/// Warmup — check if the embedding server is available at startup.
/// Logs a warning if unreachable so vector search is expected to be disabled.
pub async fn warmup() {
    match http_client().get("http://127.0.0.1:1235/").send().await {
        Ok(_) => tracing::info!("Embedding server reachable at 127.0.0.1:1235"),
        Err(e) => tracing::warn!("Embedding server unreachable at 127.0.0.1:1235: {e} — vector search disabled"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_embed_single() {
        let emb = embed("Ailo", false).await;
        if let Some(v) = emb {
            assert_eq!(v.len(), EMBEDDING_DIM);
            let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            assert!((norm - 1.0).abs() < 0.01);
        } else {
            eprintln!("note: embed test skipped — embedding server not available");
        }
    }

    #[tokio::test]
    async fn test_embed_query_prefix() {
        let q = embed("What is Ailo?", true).await;
        let doc = embed("Ailo", false).await;
        if let (Some(qv), Some(docv)) = (q, doc) {
            assert_eq!(qv.len(), EMBEDDING_DIM);
            assert_eq!(docv.len(), EMBEDDING_DIM);
        } else {
            eprintln!("note: embed test skipped — embedding server not available");
        }
    }

    #[tokio::test]
    async fn test_embed_batch() {
        let texts = vec!["Ailo", "Rust", "Python"];
        let results = embed_batch(&texts, false).await;
        if let Some(embeddings) = results {
            assert_eq!(embeddings.len(), 3);
            for emb in &embeddings {
                assert_eq!(emb.len(), EMBEDDING_DIM);
                let norm: f32 = emb.iter().map(|x| x * x).sum::<f32>().sqrt();
                assert!((norm - 1.0).abs() < 0.01);
            }
        } else {
            eprintln!("note: embed_batch test skipped — embedding server not available");
        }
    }

    #[tokio::test]
    async fn test_empty_text() {
        let emb = embed("", false).await;
        if let Some(v) = emb {
            assert_eq!(v.len(), EMBEDDING_DIM);
        } else {
            eprintln!("note: empty text test skipped — embedding server not available");
        }
    }
}
