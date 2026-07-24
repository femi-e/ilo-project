// ============================================================================
// tools/search2.ts — Hybrid search v2: BM25 + vector + RRF + reranker
// ============================================================================
// Runs BM25 (FTS) and vector search in parallel, fuses via RRF,
// deduplicates by content, then reranks with MiniLM cross-encoder.
//
// Reranker is loaded once (lazy singleton) and cached across calls.
//
// Use: swap searchToolDef for search2ToolDef in index.ts
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import * as crypto from 'node:crypto';
import { getDb } from '../lib/engine';
import { embed, getStatus } from '../lib/embedding';
import type { ToolDefinition } from '../lib/tool-registry';

// ── Constants ──────────────────────────────────────────

const RRF_K = 60;
const CANDIDATES = 50;
const RERANK_WINDOW = 30;

// ── Lazy reranker singleton ────────────────────────────

let _reranker: any = null;

async function getReranker(): Promise<any> {
  if (!_reranker) {
    const { pipeline } = await import('@huggingface/transformers');
    _reranker = await pipeline('text-classification', 'Xenova/ms-marco-MiniLM-L-6-v2', { device: 'cpu' });
  }
  return _reranker;
}

// ── Provenance & tiers ─────────────────────────────────

const PROVENANCE_LABELS: Record<string, string> = {
  course_material: 'course', user_written: 'note', web_research: 'research',
  user_confirmed: 'confirmed', user_supplied: 'user', system_inferred: 'inferred',
  system_extracted: 'extracted', system_bootstrap: 'bootstrap', ingested: 'ingested', task: 'task',
};

const TIERS = [
  { min: 0.80, label: 'fact', icon: '✅ ' },
  { min: 0.60, label: 'likely', icon: '🔶 ' },
  { min: 0.40, label: 'possible', icon: '◽ ' },
  { min: 0.00, label: 'weak', icon: '⚪ ' },
];

function getTier(confidence: number) {
  return TIERS.find(t => confidence >= t.min) ?? TIERS[TIERS.length - 1];
}

// ── Dedup helper ───────────────────────────────────────

function contentKey(text: string): string {
  // Strip the [Title] prefix before hashing to compare section content, not document context
  const stripped = text.replace(/^\[.+?\]\n*/, '');
  return crypto.createHash('sha256').update(stripped).digest('hex').slice(0, 16);
}

// ── Query builder ──────────────────────────────────────

const SEARCH_COLS = `node.id AS id, node.content AS content,
  node.confidence AS confidence, node.provenance AS provenance, node.entity AS ent`;

async function searchFts(db: any, query: string, entity: string | undefined, limit: number) {
  try {
    if (entity) {
      return await db.query(
        `CALL QUERY_FTS_INDEX('Belief', 'idx_belief_content', $q) WITH node, score
         MATCH (e:Entity)-[:HAS_BELIEF]->(node) WHERE e.name = $entity
         RETURN ${SEARCH_COLS} LIMIT $limit`,
        { q: query, entity, limit }
      );
    }
    return await db.query(
      `CALL QUERY_FTS_INDEX('Belief', 'idx_belief_content', $q) WITH node, score
       RETURN ${SEARCH_COLS} LIMIT $limit`,
      { q: query, limit }
    );
  } catch (e: any) {
    console.warn('[search2] FTS error:', e.message);
    return [];
  }
}

async function searchVector(db: any, vec: number[], entity: string | undefined, limit: number) {
  try {
    if (entity) {
      return await db.query(
        `CALL QUERY_VECTOR_INDEX('Belief', 'idx_belief_emb', $vec, $limit) WITH node, distance
         MATCH (e:Entity)-[:HAS_BELIEF]->(node) WHERE e.name = $entity
         RETURN ${SEARCH_COLS}, distance LIMIT $limit`,
        { vec, entity, limit }
      );
    }
    return await db.query(
      `CALL QUERY_VECTOR_INDEX('Belief', 'idx_belief_emb', $vec, $limit) WITH node, distance
       RETURN ${SEARCH_COLS}, distance LIMIT $limit`,
      { vec, limit }
    );
  } catch (e: any) {
    console.warn('[search2] vector error:', e.message);
    return [];
  }
}

// ── ScoredDoc shape ────────────────────────────────────

interface ScoredDoc {
  id: string;
  content: string;
  confidence: number;
  provenance: string;
  entity: string;
  bm25Rank: number;
  vecRank: number;
  vecDistance: number | null;
  rrfScore: number;
  rerankScore: number;
}

// ── RRF ingestion ──────────────────────────────────────

function ingestResults(map: Map<string, ScoredDoc>, rows: any[], isVector: boolean): void {
  for (let idx = 0; idx < rows.length; idx++) {
    const r = rows[idx];
    const id = r.id || '';
    const existing = map.get(id);
    if (existing) {
      if (isVector) { existing.vecRank = idx + 1; existing.vecDistance = r.distance ?? null; }
      else existing.bm25Rank = idx + 1;
    } else {
      map.set(id, {
        id, content: r.content || '', confidence: r.confidence ?? 0.5,
        provenance: r.provenance || 'unknown', entity: r.ent || '',
        bm25Rank: isVector ? 0 : idx + 1,
        vecRank: isVector ? idx + 1 : 0,
        vecDistance: isVector ? (r.distance ?? null) : null,
        rrfScore: 0, rerankScore: 0,
      });
    }
  }
}

// ── Tool definition ────────────────────────────────────

export const search2ToolDef: ToolDefinition = {
  name: 'search2',
  label: 'Search v2',
  description: 'Hybrid search combining BM25 keywords + vector meaning + reranking',
  category: 'retrieval',
  aliases: 'search, find, hybrid',
  promptSnippet: 'Search stored knowledge with hybrid BM25+vector+reranking',
  promptGuidelines: [
    'Use search2 for more accurate results — it runs BM25 + vector + reranker.',
    'Faster and cheaper than web; always try search first.',
  ],
  register: registerSearch2Tool,
};

// ── Registration ───────────────────────────────────────

export function registerSearch2Tool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'search2',
    label: 'Search v2',
    description: 'Hybrid search combining BM25 + vector meaning + reranking.',
    promptSnippet: search2ToolDef.promptSnippet,
    promptGuidelines: search2ToolDef.promptGuidelines,
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
      entity: Type.Optional(Type.String({ description: 'Filter results to beliefs about this entity' })),
      limit: Type.Optional(Type.Number({ description: 'Max results (default 5)' })),
    }),
    async execute(_toolCallId: string, params: any, _signal?: AbortSignal): Promise<any> {
      const query = (params.query || '').trim();
      if (!query) return { content: [{ type: 'text', text: 'No query provided.' }], details: {} };

      const limit = Math.min(params.limit || 5, 20);
      const entityFilter = params.entity?.trim();
      const db = getDb();

      // ── 1. Embed query ───────────────────────────────
      let queryVector: number[] | null = null;
      try {
        const embedStatus = getStatus();
        if (embedStatus === 'healthy') {
          const vectors = await embed([query.substring(0, 1000)]);
          if (vectors?.length > 0) queryVector = vectors[0];
        }
      } catch (e: any) {
        console.warn('[search2] embed error:', e.message);
      }

      // ── 2. Parallel search ────────────────────────────
      const [ftsRows, vecRows] = await Promise.all([
        searchFts(db, query, entityFilter, CANDIDATES),
        queryVector ? searchVector(db, queryVector, entityFilter, CANDIDATES) : Promise.resolve([]),
      ]);

      if (ftsRows.length === 0 && vecRows.length === 0) {
        return { content: [{ type: 'text', text: 'No results found.' }], details: {} };
      }

      // ── 3. RRF fusion ────────────────────────────────
      const docMap = new Map<string, ScoredDoc>();
      ingestResults(docMap, ftsRows, false);
      ingestResults(docMap, vecRows, true);

      for (const doc of docMap.values()) {
        let s = 0;
        if (doc.bm25Rank > 0) s += 1 / (RRF_K + doc.bm25Rank);
        if (doc.vecRank > 0) s += 1 / (RRF_K + doc.vecRank);
        doc.rrfScore = s;
      }

      const rrfRanked = [...docMap.values()]
        .sort((a, b) => b.rrfScore - a.rrfScore)
        .slice(0, RERANK_WINDOW);

      // ── 4. Dedup ─────────────────────────────────────
      const seen = new Set<string>();
      const deduped: ScoredDoc[] = [];
      for (const d of rrfRanked) {
        const key = contentKey(d.content);
        if (!seen.has(key)) { seen.add(key); deduped.push(d); }
      }

      // ── 5. Reranker ──────────────────────────────────
      try {
        const reranker = await getReranker();
        const pairs: string[][] = deduped.map(d => [query, d.content]);
        const scores: { score: number }[] = await reranker(pairs);
        for (let i = 0; i < deduped.length; i++) {
          deduped[i].rerankScore = scores[i]?.score ?? 0;
        }
      } catch (e: any) {
        console.warn('[search2] reranker error:', e.message);
        for (const d of deduped) d.rerankScore = d.rrfScore;
      }

      // ── 6. Final ─────────────────────────────────────
      const final = deduped.sort((a, b) => b.rerankScore - a.rerankScore).slice(0, limit);
      if (final.length === 0) {
        return { content: [{ type: 'text', text: 'No results found.' }], details: {} };
      }

      // ── 7. Display ───────────────────────────────────
      const lines = final.map((d, i) => {
        const snippet = d.content.substring(0, 200).replace(/\n/g, ' ');
        const provenance = PROVENANCE_LABELS[d.provenance] || d.provenance;
        const tier = getTier(d.confidence);
        const matchPct = d.vecDistance !== null
          ? ` (match: ${Math.round((1 - d.vecDistance) * 100)}%)`
          : '';
        const tag = `${tier.icon}${provenance}, ${tier.label}${matchPct}`;
        const src = d.entity ? `\n   Source: ${d.entity}` : '';
        return `  ${i + 1}. "${snippet}" [${tag}]${src}`;
      });

      // ── 8. Boost references ──────────────────────────
      const now = new Date().toISOString();
      queueMicrotask(async () => {
        for (const d of final) {
          try { await db.exec('MATCH (b:Belief {id: $id}) SET b.last_referenced = $ts', { id: d.id, ts: now }); } catch {}
        }
      });

      return {
        content: [{ type: 'text', text: `Found ${final.length} result(s):\n${lines.join('\n')}` }],
        details: {},
      };
    },
  });
}
