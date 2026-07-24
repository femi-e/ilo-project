// ============================================================================
// tools/search.ts — Unified search tool with decoupled ranking + display
// ============================================================================
// Scoring:     (1 - cosine_distance) × confidence  (for ranking only)
// Display:     provenance, tier_label (match: XX%)  — raw confidence tier
//              is shown so the AI uses the tier rules, not the combined score
// Feedback:    Updates last_referenced on retrieval for consolidation/pruning
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { getDb } from '../lib/engine';
import { embed, getStatus } from '../lib/embedding';
import type { ToolDefinition } from '../lib/tool-registry';

// ── RRF k constant ───────────────────────────────────
const RRF_K = 60;

// ── Provenance → display label mapping ──────────────────

const PROVENANCE_LABELS: Record<string, string> = {
  course_material: 'course',
  user_written:    'note',
  web_research:    'research',
  user_confirmed:  'confirmed',
  user_supplied:   'user',
  system_inferred: 'inferred',
  system_extracted:'extracted',
  system_bootstrap:'bootstrap',
  ingested:        'ingested',
  task:            'task',
};

// ── Confidence tier system (matches the AI's behavior rules) ──

const TIERS = [
  { min: 0.80, label: 'fact',     icon: '✅ ' },
  { min: 0.60, label: 'likely',   icon: '🔶 ' },
  { min: 0.40, label: 'possible', icon: '◽ ' },
  { min: 0.00, label: 'weak',     icon: '⚪ ' },
];

function getTier(confidence: number): { label: string; icon: string } {
  for (const t of TIERS) {
    if (confidence >= t.min) return { label: t.label, icon: t.icon };
  }
  return { label: 'weak', icon: '⚪ ' };
}

// ── Result item with both raw and computed fields ───────

interface SearchResultItem {
  content: string;
  /** Combined score for ranking: (1-d) × confidence */
  score: number;
  /** Raw confidence from DB (stable, trustworthiness) */
  rawConfidence: number;
  /** Cosine distance from vector search (null if FTS/text search) */
  distance: number | null;
  provenance: string;
  entity: string;
  /** Belief ID for reference boost updates */
  id?: string;
}

// ── Tool definition (for central registry) ───────────────

export const searchToolDef: ToolDefinition = {
  name: 'search',
  label: 'Search',
  description: 'Find stored information across beliefs and tasks using keywords or meaning',
  category: 'retrieval',
  aliases: 'find, query, look up, retrieve',
  promptSnippet: 'Search stored knowledge by keyword and meaning',
  promptGuidelines: [
    'Use search as your DEFAULT knowledge lookup. It searches beliefs AND tasks.',
    'Faster and cheaper than web; always try search first.',
  ],
  register: registerSearchTool,
};

// ── Registration function ────────────────────────────────

export function registerSearchTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'search',
    label: 'Search',
    description: 'Unified search across stored beliefs and tasks by keyword and meaning.',
    promptSnippet: searchToolDef.promptSnippet,
    promptGuidelines: searchToolDef.promptGuidelines,
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
      entity: Type.Optional(Type.String({ description: 'Filter results to beliefs about this entity' })),
      limit: Type.Optional(Type.Number({ description: 'Max results (default 5)' })),
    }),
    async execute(_toolCallId: string, params: any, _signal?: AbortSignal, onUpdate?: (update: any) => void): Promise<any> {
      const query = (params.query || '').trim();
      if (!query) return { content: [{ type: 'text', text: 'No query provided.' }], details: {} };
      const limit = params.limit || 5;
      const entity = params.entity?.toLowerCase().trim();
      const db = getDb();
      const now = new Date().toISOString();

      onUpdate?.({ content: [{ type: 'text', text: `Searching for "${query.substring(0, 50)}"...` }] });

      // Try embedding
      let queryVector: number[] | null = null;
      const embedStatus = getStatus();
      if (embedStatus === 'healthy') {
        const vectors = await embed([query.substring(0, 1000)]);
        if (vectors?.length > 0) queryVector = vectors[0];
      }

      const results: SearchResultItem[] = [];

      // ── Search Beliefs ──────────────────────────────
      try {
        let rows: any[] = [];
        if (queryVector && entity) {
          rows = await db.query(
            'CALL QUERY_VECTOR_INDEX(\'Belief\', \'idx_belief_emb\', $vec, $limit) WITH node, distance MATCH (e:Entity)-[:HAS_BELIEF]->(node) WHERE e.name = $entity RETURN node.id AS id, node.content AS content, node.confidence AS confidence, node.provenance AS provenance, node.entity AS ent, distance',
            { vec: queryVector, limit: limit * 3, entity }
          );
        } else if (queryVector) {
          rows = await db.query(
            'CALL QUERY_VECTOR_INDEX(\'Belief\', \'idx_belief_emb\', $vec, $limit) WITH node, distance RETURN node.id AS id, node.content AS content, node.confidence AS confidence, node.provenance AS provenance, node.entity AS ent, distance',
            { vec: queryVector, limit: limit * 3 }
          );
        } else if (entity) {
          rows = await db.query(
            'MATCH (b:Belief) WHERE b.entity = $entity AND b.content CONTAINS $q RETURN b.id AS id, b.content AS content, b.confidence AS confidence, b.provenance AS provenance, b.entity AS ent',
            { entity, q: query }
          );
        } else {
          rows = await db.query(
            "CALL QUERY_FTS_INDEX('Belief', 'idx_belief_content', $q) WITH node, score RETURN node.id AS id, node.content AS content, node.confidence AS confidence, node.provenance AS provenance, node.entity AS ent LIMIT $limit",
            { q: query, limit: limit * 3 }
          );
        }
        for (const r of rows || []) {
          const rawConf = r.confidence ?? 0.5;
          const dist = r.distance !== undefined ? r.distance : null;
          const score = dist !== null ? (1 - dist) * rawConf : rawConf;
          results.push({
            content: r.content || '',
            score,
            rawConfidence: rawConf,
            distance: dist,
            provenance: r.provenance || 'unknown',
            entity: r.ent || '',
            id: r.id || undefined,
          });
        }
      } catch (e: any) {
        console.warn('[search] Belief search error:', e.message);
      }

      // ── Search Tasks ────────────────────────────────
      try {
        const taskRows = await db.query(
          "MATCH (t:Task) WHERE t.status IN ['pending', 'active'] AND (t.title CONTAINS $q OR t.description CONTAINS $q) RETURN t.title AS title, t.description AS desc, t.status AS status",
          { q: query }
        );
        for (const r of taskRows || []) {
          const text = `${r.title}: ${(r.desc || '').substring(0, 100)}`;
          results.push({
            content: text,
            score: 0.5,
            rawConfidence: 0.5,
            distance: null,
            provenance: 'task',
            entity: r.status || '',
          });
        }
      } catch {}

      // ── Sort and deduplicate ────────────────────────
      results.sort((a, b) => b.score - a.score);
      const seen = new Set<string>();
      const deduped = results.filter(r => {
        const key = r.content.substring(0, 50);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const top = deduped.slice(0, limit);
      if (top.length === 0) return { content: [{ type: 'text', text: 'No results found.' }], details: {} };

      // ── Format display lines ────────────────────────
      const lines = top.map((r, i) => {
        const snippet = r.content.substring(0, 200).replace(/\n/g, ' ');
        const provenance = PROVENANCE_LABELS[r.provenance] || r.provenance || 'stated';
        const tier = getTier(r.rawConfidence);

        let tag: string;
        if (r.distance !== null) {
          // Vector search: show tier + match percentage
          const matchPct = Math.round((1 - r.distance) * 100);
          tag = `${tier.icon}${provenance}, ${tier.label} (match: ${matchPct}%)`;
        } else if (r.provenance === 'task') {
          // Task results: no confidence display
          tag = `📋 task`;
        } else {
          // FTS / text search: show tier only (no distance available)
          tag = `${tier.icon}${provenance}, ${tier.label} (conf: ${r.rawConfidence.toFixed(2)})`;
        }

        const source = r.entity ? `\n   Source: ${r.entity}` : '';
        return `  ${i + 1}. "${snippet}" [${tag}]${source}`;
      });

      // ── Fire-and-forget: boost last_referenced for top results ──
      // This prevents consolidation from pruning frequently-used beliefs
      boostReferences(db, top, now);

      return { content: [{ type: 'text', text: `Found ${top.length} result(s):\n${lines.join('\n')}` }], details: {} };
    },
  });
}

// ═══════════════════════════════════════════════════════════
// Reference boosting (fire-and-forget)
// ═══════════════════════════════════════════════════════════

/**
 * Update last_referenced for the top search results so they survive
 * consolidation pruning. Fire-and-forget — never blocks the response.
 */
function boostReferences(db: any, results: SearchResultItem[], now: string): void {
  // Use a microtask to avoid delaying the search response
  queueMicrotask(async () => {
    for (const r of results) {
      if (!r.id) continue;
      try {
        await db.exec(
          'MATCH (b:Belief {id: $id}) SET b.last_referenced = $ts',
          { id: r.id, ts: now }
        );
      } catch {
        // Best-effort — failures don't affect the user
      }
    }
  });
}