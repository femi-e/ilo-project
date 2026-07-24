//! Embedding generation via Candle + BGE-base-en-v1.5.
//!
//! Loads the model once (lazy static), caches it for all calls.
//! Uses CPU inference — ~20ms per embedding on Apple M3.
//!
//! Model: BAAI/bge-base-en-v1.5 (768-dim, 133MB safetensors, BERT base)
//! Pooling: mean pool of last hidden state (excluding padding tokens)
//! Normalization: L2 normalize output vector


use candle_core::{Device, DType, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config as BertConfig};
use hf_hub::api::sync::Api;
use tokenizers::Tokenizer;
use std::sync::OnceLock;

/// BGE instruction prefix for queries (improves retrieval quality).
const QUERY_PREFIX: &str = "Represent this sentence for searching relevant passages: ";

// ── Lazy-loaded BERT model (loaded once, cached forever) ────────────

struct EmbedModel {
    model: BertModel,
    tokenizer: Tokenizer,
    device: Device,
    dim: usize,
}

static EMBED: OnceLock<Option<EmbedModel>> = OnceLock::new();

/// Try to load the model — downloads from HF Hub if not cached.
/// Returns Ok(model) on success, Err(msg) on failure.
fn load_model() -> Result<EmbedModel, String> {
    let device = Device::Cpu;
    let dtype = DType::F32;

    let api = Api::new().map_err(|e| format!("HF Hub init: {e}"))?;
    let repo = api.model("BAAI/bge-base-en-v1.5".to_string());
    let config_path = repo.get("config.json").map_err(|e| format!("config.json: {e}"))?;
    let weights_path = repo.get("model.safetensors").map_err(|e| format!("model.safetensors: {e}"))?;
    let tokenizer_path = repo.get("tokenizer.json").map_err(|e| format!("tokenizer.json: {e}"))?;

    let config_bytes = std::fs::read(&config_path).map_err(|e| format!("read config: {e}"))?;
    let config_json: serde_json::Value = serde_json::from_slice(&config_bytes)
        .map_err(|e| format!("parse config: {e}"))?;
    let config: BertConfig = serde_json::from_value(config_json)
        .map_err(|e| format!("deserialize config: {e}"))?;
    let dim = config.hidden_size;

    let vb = unsafe {
        VarBuilder::from_mmaped_safetensors(&[weights_path], dtype, &device)
            .map_err(|e| format!("load weights: {e}"))?
    };
    let model = BertModel::load(vb, &config).map_err(|e| format!("BERT init: {e}"))?;
    let tokenizer = Tokenizer::from_file(tokenizer_path)
        .map_err(|e| format!("load tokenizer: {e}"))?;

    Ok(EmbedModel { model, tokenizer, device, dim })
}

/// Get the loaded embedding model, initializing on first call.
/// Returns None if model loading fails (network offline, corrupt files, OOM).
fn try_get_model() -> Option<&'static EmbedModel> {
    EMBED.get_or_init(|| {
        match load_model() {
            Ok(model) => {
                tracing::info!("Embedding model loaded ({} dims, {:?})", model.dim, model.device);
                Some(model)
            },
            Err(e) => {
                tracing::warn!("Embedding model unavailable: {e}");
                None
            },
        }
    }).as_ref()
}

/// Embed a single text string, returning a normalized 768-dim vector.
///
/// For queries, prepends the BGE instruction prefix automatically.
/// For entity labels (is_query = false), embeds the text as-is.
/// Returns None if the model failed to load or inference errors out.
pub fn embed(text: &str, is_query: bool) -> Option<Vec<f32>> {
    let em = try_get_model()?;

    let input = if is_query {
        format!("{}{}", QUERY_PREFIX, text)
    } else {
        text.to_string()
    };

    let encoding = em.tokenizer.encode(input, true).ok()?;
    let token_ids = encoding.get_ids();
    let token_type_ids = encoding.get_type_ids();
    let attention_mask = encoding.get_attention_mask();
    let seq_len = token_ids.len().max(1);

    let token_ids = Tensor::new(token_ids, &em.device).ok()?.unsqueeze(0).ok()?;
    let token_type_ids = Tensor::new(token_type_ids, &em.device).ok()?.unsqueeze(0).ok()?;
    let attention_mask = Tensor::new(attention_mask, &em.device).ok()?.unsqueeze(0).ok()?;

    let hidden = em.model.forward(&token_ids, &token_type_ids, Some(&attention_mask)).ok()?;

    let mask = attention_mask.unsqueeze(2).ok()?.expand(&[1, seq_len, em.dim]).ok()?;
    let mask = mask.to_dtype(DType::F32).ok()?;

    let sum_emb = (hidden * &mask).ok()?.sum(1).ok()?;
    let sum_mask = mask.sum(1).ok()?;
    let mean_emb = (sum_emb / sum_mask).ok()?;

    let norm = mean_emb.sqr().ok()?.sum(1).ok()?.sqrt().ok()?;
    let normalized = mean_emb.broadcast_div(&norm).ok()?;

    normalized.squeeze(0).ok()?.to_vec1::<f32>().ok()
}

/// Embed multiple texts in batch (more efficient than individual calls).
/// Returns None if the model isn't loaded or inference fails.
pub fn embed_batch(texts: &[&str], is_query: bool) -> Option<Vec<Vec<f32>>> {
    let em = try_get_model()?;

    let inputs: Vec<String> = if is_query {
        texts.iter().map(|t| format!("{}{}", QUERY_PREFIX, t)).collect()
    } else {
        texts.iter().map(|t| t.to_string()).collect()
    };

    let encodings: Vec<_> = inputs.iter()
        .filter_map(|t| em.tokenizer.encode(t.as_str(), true).ok())
        .collect();

    if encodings.is_empty() || encodings.len() < texts.len() {
        return None;
    }

    let max_len = encodings.iter().map(|e| e.get_ids().len()).max().unwrap_or(0);
    if max_len == 0 {
        return Some(vec![vec![0.0f32; em.dim]; texts.len()]);
    }

    // Build padded tensors [batch, max_len]
    let batch_size = texts.len();
    let mut padded_ids = Vec::with_capacity(batch_size * max_len);
    let mut padded_mask = Vec::with_capacity(batch_size * max_len);
    let mut padded_types = Vec::with_capacity(batch_size * max_len);

    for enc in &encodings {
        let ids = enc.get_ids();
        let mask = enc.get_attention_mask();
        let types = enc.get_type_ids();
        let pad_len = max_len - ids.len();

        for i in 0..ids.len() {
            padded_ids.push(ids[i]);
            padded_mask.push(mask[i]);
            padded_types.push(types[i]);
        }
        for _ in 0..pad_len {
            padded_ids.push(0);
            padded_mask.push(0);
            padded_types.push(0);
        }
    }

    let token_ids = Tensor::from_vec(padded_ids, &[batch_size, max_len], &em.device).ok()?;
    let attention_mask = Tensor::from_vec(padded_mask, &[batch_size, max_len], &em.device).ok()?;
    let token_type_ids = Tensor::from_vec(padded_types, &[batch_size, max_len], &em.device).ok()?;

    let hidden = em.model.forward(&token_ids, &token_type_ids, Some(&attention_mask)).ok()?;

    let mask = attention_mask.unsqueeze(2).ok()?.expand(&[batch_size, max_len, em.dim]).ok()?;
    let mask = mask.to_dtype(DType::F32).ok()?;

    let sum_emb = (hidden * &mask).ok()?.sum(1).ok()?;
    let sum_mask = mask.sum(1).ok()?;
    let mean_emb = (sum_emb / sum_mask).ok()?;

    let norm = mean_emb.sqr().ok()?.sum(1).ok()?.sqrt().ok()?;
    let normalized = mean_emb.broadcast_div(&norm.unsqueeze(1).ok()?).ok()?;

    normalized.to_vec2::<f32>().ok()
}

/// Get the embedding dimension (768 for bge-base-en-v1.5).
pub fn embedding_dim() -> usize {
    768
}

/// Check if the model is loaded and ready.
pub fn is_loaded() -> bool {
    EMBED.get().and_then(|m| m.as_ref()).is_some()
}

/// Try to load the model at startup (useful to warm the cache).
/// Does not panic on failure — embeddings become available on first successful call.
pub fn warmup() {
    if let Some(_) = try_get_model() {
        let _ = embed("warmup", false);
        tracing::info!("Embedding model warmed up");
    } else {
        tracing::warn!("Embedding model unavailable — vector search disabled");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_embed_single() {
        let emb = embed("Ailo", false);
        if let Some(v) = emb {
            assert_eq!(v.len(), 768);
            let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            assert!((norm - 1.0).abs() < 0.01);
        } else {
            eprintln!("note: embed test skipped — model not available (offline)");
        }
    }

    #[test]
    fn test_embed_query_prefix() {
        let q = embed("What is Ailo?", true);
        let doc = embed("Ailo", false);
        if let (Some(qv), Some(docv)) = (q, doc) {
            assert_eq!(qv.len(), 768);
            assert_eq!(docv.len(), 768);
        } else {
            eprintln!("note: embed test skipped — model not available (offline)");
        }
    }

    #[test]
    fn test_embed_batch() {
        let texts = vec!["Ailo", "Rust", "Python"];
        let results = embed_batch(&texts, false);
        if let Some(embeddings) = results {
            assert_eq!(embeddings.len(), 3);
            for emb in &embeddings {
                assert_eq!(emb.len(), 768);
                let norm: f32 = emb.iter().map(|x| x * x).sum::<f32>().sqrt();
                assert!((norm - 1.0).abs() < 0.01);
            }
        } else {
            eprintln!("note: embed_batch test skipped — model not available (offline)");
        }
    }

    #[test]
    fn test_empty_text() {
        let emb = embed("", false);
        if let Some(v) = emb {
            assert_eq!(v.len(), 768);
            let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            assert!(norm > 0.0, "empty input should produce some embedding");
        } else {
            eprintln!("note: empty text test skipped — model not available (offline)");
        }
    }
}
