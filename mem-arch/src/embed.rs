//! Embedding generation via llama.cpp HTTP API.
//!
//! Calls a local llama.cpp server running an embedding model (BGE-base GGUF).
//! Falls back gracefully if the server is unreachable — vector search is simply disabled.
//!
//! Expected server: llama-server --port 1235 --host 127.0.0.1 --embeddings --model <gguf>

use serde_json::Value;

/// Base URL for the embedding server.
const EMBED_URL: &str = "http://127.0.0.1:1235/v1/embeddings";

/// Default embedding dimension (bge-base-en-v1.5).
const DEFAULT_DIM: usize = 768;

/// BGE instruction prefix for queries (improves retrieval quality).
const QUERY_PREFIX: &str = "Represent this sentence for searching relevant passages: ";

/// Embed a single text string, returning a normalized vector.
///
/// For queries, prepends the BGE instruction prefix automatically.
/// For entity labels (is_query = false), embeds the text as-is.
/// Returns None if the server is unreachable or returns an error.
pub fn embed(text: &str, is_query: bool) -> Option<Vec<f32>> {
    let input = if is_query {
        format!("{}{}", QUERY_PREFIX, text)
    } else {
        text.to_string()
    };

    let body = serde_json::json!({
        "model": "default",
        "input": [input],
    });

    let body_str = serde_json::to_string(&body).ok()?;

    let resp = ureq::post(EMBED_URL)
        .content_type("application/json")
        .send(body_str)
        .ok()?;

    let raw = resp.into_body().read_to_string().ok()?;
    let data: Value = serde_json::from_str(&raw).ok()?;
    let embedding = data["data"][0]["embedding"].as_array()?;

    Some(embedding.iter().map(|v| v.as_f64().unwrap_or(0.0) as f32).collect())
}

/// Embed multiple texts in batch.
/// Returns None if the server is unreachable or returns an error.
pub fn embed_batch(texts: &[&str], is_query: bool) -> Option<Vec<Vec<f32>>> {
    let inputs: Vec<String> = if is_query {
        texts.iter().map(|t| format!("{}{}", QUERY_PREFIX, t)).collect()
    } else {
        texts.iter().map(|t| t.to_string()).collect()
    };

    let body = serde_json::json!({
        "model": "default",
        "input": inputs,
    });

    let body_str = serde_json::to_string(&body).ok()?;

    let resp = ureq::post(EMBED_URL)
        .content_type("application/json")
        .send(body_str)
        .ok()?;

    let raw = resp.into_body().read_to_string().ok()?;
    let data: Value = serde_json::from_str(&raw).ok()?;
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
    DEFAULT_DIM
}

/// Check if the embedding server is reachable.
pub fn is_loaded() -> bool {
    embed("ping", false).is_some()
}

/// Warmup — check if the embedding server is available at startup.
/// Logs a warning if unreachable so vector search is expected to be disabled.
pub fn warmup() {
    match ureq::get("http://127.0.0.1:1235/").call() {
        Ok(_) => tracing::info!("Embedding server reachable at 127.0.0.1:1235"),
        Err(e) => tracing::warn!("Embedding server unreachable at 127.0.0.1:1235: {e} — vector search disabled"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_embed_single() {
        let emb = embed("Ailo", false);
        if let Some(v) = emb {
            assert_eq!(v.len(), DEFAULT_DIM);
            let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            assert!((norm - 1.0).abs() < 0.01);
        } else {
            eprintln!("note: embed test skipped — embedding server not available");
        }
    }

    #[test]
    fn test_embed_query_prefix() {
        let q = embed("What is Ailo?", true);
        let doc = embed("Ailo", false);
        if let (Some(qv), Some(docv)) = (q, doc) {
            assert_eq!(qv.len(), DEFAULT_DIM);
            assert_eq!(docv.len(), DEFAULT_DIM);
        } else {
            eprintln!("note: embed test skipped — embedding server not available");
        }
    }

    #[test]
    fn test_embed_batch() {
        let texts = vec!["Ailo", "Rust", "Python"];
        let results = embed_batch(&texts, false);
        if let Some(embeddings) = results {
            assert_eq!(embeddings.len(), 3);
            for emb in &embeddings {
                assert_eq!(emb.len(), DEFAULT_DIM);
                let norm: f32 = emb.iter().map(|x| x * x).sum::<f32>().sqrt();
                assert!((norm - 1.0).abs() < 0.01);
            }
        } else {
            eprintln!("note: embed_batch test skipped — embedding server not available");
        }
    }

    #[test]
    fn test_empty_text() {
        let emb = embed("", false);
        if let Some(v) = emb {
            assert_eq!(v.len(), DEFAULT_DIM);
        } else {
            eprintln!("note: empty text test skipped — embedding server not available");
        }
    }
}
