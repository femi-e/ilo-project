// ============================================================================
// lib/embedding.ts — ONNX Runtime CPU embedding (via Transformers.js)
// ============================================================================
// Switched from node-llama-cpp to @huggingface/transformers (ONNX Runtime)
// for CPU inference. Benchmark results on i7-12800H:
//
//                  node-llama-cpp   Transformers.js (ONNX)   Speedup
//   Load time      241ms            822ms                    0.3x
//   Search (80ch)  92.9ms           18.2ms                   5.1x
//   Chunk (800ch)  566.0ms          46.9ms                   12.1x
//   Burst 10×      5.58s            489ms                    11.4x
//   Memory         19MB             22MB                     similar
//
// Key advantages:
//   1. ONNX Runtime uses Intel MKL-DNN/oneDNN — optimized CPU kernels
//   2. Native batch inference — pipe(texts[]) processes batch in one pass
//   3. No internal lock serialization (unlike node-llama-cpp)
//   4. Built-in pooling ('mean', 'cls') and normalization
//   5. Automatic model downloading + caching
// ============================================================================

import { EMBEDDING_DIM } from './constants';

export type EmbedStatus = 'stopped' | 'loading' | 'healthy' | 'degraded';

let _status: EmbedStatus = 'stopped';
let _pipe: any = null;
let _loadPromise: Promise<boolean> | null = null;
let _modelId: string | null = null;

// ── Config ────────────────────────────────────────────────

/** Hugging Face model ID for the embedding model */
const MODEL_ID = 'BAAI/bge-base-en-v1.5';

/** Pooling strategy: 'mean' averages all tokens, 'cls' uses [CLS] token */
const POOLING = 'mean' as const;

/** Whether to L2-normalize output vectors */
const NORMALIZE = true;

/**
 * Read the current GPU enabled config from the DB.
 * Only called once during first load.
 */
async function readGpuConfig(): Promise<boolean> {
  try {
    const { getDb } = await import('./engine');
    const db = getDb();
    const rows = await db.query(
      "MATCH (c:Config {key: 'embedding.gpu.enabled'}) RETURN c.value AS value ORDER BY c.version DESC LIMIT 1"
    );
    if (rows.length > 0) {
      return rows[0].value === 'true';
    }
  } catch {
    // DB not available yet — use default
  }
  return false;
}

async function ensureLoaded(gpuOverride?: boolean): Promise<boolean> {
  if (_status === 'healthy') return true;
  if (_loadPromise) return _loadPromise;

  _status = 'loading';
  const timer = setTimeout(() => { _status = 'degraded'; }, 180000);

  _loadPromise = (async () => {
    try {
      const useGpu = gpuOverride ?? await readGpuConfig();

      const device: 'cpu' | 'gpu' = useGpu ? 'gpu' : 'cpu';
      console.log(`[embed] Device: ${device}, model: ${MODEL_ID}`);

      const { pipeline } = await import('@huggingface/transformers');

      _pipe = await pipeline('feature-extraction', MODEL_ID, {
        device,
      } as any);

      // Warmup + dimension check
      const test = await _pipe('ping', { pooling: POOLING, normalize: NORMALIZE });
      const dims = test.tolist()[0].length;
      if (dims !== EMBEDDING_DIM) {
        throw new Error(`Expected ${EMBEDDING_DIM}d, model outputs ${dims}d`);
      }

      _modelId = MODEL_ID;
      _status = 'healthy';
      return true;
    } catch (err: any) {
      console.warn('[embed] ' + err.message);
      _status = 'degraded';
      _loadPromise = null;
      _pipe = null;
      return false;
    } finally {
      clearTimeout(timer);
    }
  })();

  return _loadPromise;
}

// ── Public API ──────────────────────────────────────────

export function getStatus(): EmbedStatus { return _status; }

/** Get the Hugging Face model ID currently in use. */
export function getModelId(): string | null { return _modelId; }

/** Whether GPU is currently being used for embedding. */
export function isGpuEnabled(): boolean {
  try {
    return _pipe?.config?.device === 'gpu';
  } catch {
    return false;
  }
}

/**
 * Start (or lazily load) the embedding model.
 * @param gpu - Optional override: true=GPU, false=CPU, undefined=read config
 */
export async function start(gpu?: boolean): Promise<boolean> {
  return ensureLoaded(gpu);
}

/**
 * Restart the embedding model with a new configuration.
 * Stops the current model (if running) and reloads.
 * @param gpu - true=GPU, false=CPU, undefined=read from config
 */
export async function restart(gpu?: boolean): Promise<boolean> {
  await stop();
  return start(gpu);
}

/**
 * Embed an array of texts, returning vectors.
 *
 * Uses ONNX Runtime's native batch inference:
 *   - Single text:  1 forward pass
 *   - Multiple texts: batch inference (one forward pass for all)
 *
 * No internal batching needed — ONNX Runtime handles it.
 * No lock serialization issue — Transformers.js doesn't have this.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  if (!await ensureLoaded()) return [];

  try {
    // Trim each text to 1000 chars (model max ≈ 512 tokens)
    const trimmed = texts.map(t => t.substring(0, 1000));

    // Single text fast path
    if (trimmed.length === 1) {
      const result = await _pipe(trimmed[0], { pooling: POOLING, normalize: NORMALIZE });
      return [Array.from(result.tolist()[0])];
    }

    // Batch inference — send all texts at once
    const outputs = await _pipe(trimmed, { pooling: POOLING, normalize: NORMALIZE });

    // Transformers.js returns a single tensor with batch dimension
    // Shape: [batch_size, embedding_dim]
    const vectors: number[][] = [];
    if (Array.isArray(outputs)) {
      // Multiple tensors (one per text)
      for (const out of outputs) {
        vectors.push(Array.from(out.tolist()[0]));
      }
    } else if (outputs.tolist) {
      // Single batched tensor: [batch, dims]
      const data = outputs.tolist();
      for (const row of data) {
        vectors.push(Array.from(row));
      }
    }
    return vectors;
  } catch (err: any) {
    console.warn('[embed] ' + err.message);
    return [];
  }
}

/**
 * Stop the embedding model and release resources.
 */
export async function stop(): Promise<void> {
  _status = 'stopped';
  _pipe = null;
  _modelId = null;
  _loadPromise = null;
}