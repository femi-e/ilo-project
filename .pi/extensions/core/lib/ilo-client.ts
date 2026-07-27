// ============================================================================
// lib/ilo-client.ts — HTTP/TCP client for ILO cognitive memory runtime
// ============================================================================
// Communicates with the ILO Rust sidecar over TCP HTTP on localhost:18090.
// All methods return Promises — call with await.
//
// Usage:
//   import { ilo } from '../lib/ilo-client';
//   const status = await ilo.status();
//   const ctx = await ilo.recall("What is Ailo?");
// ============================================================================

const ILO_BASE = `http://127.0.0.1:${process.env.ILO_PORT || '18090'}`;
const ILO_TIMEOUT = parseInt(process.env.ILO_TIMEOUT || '5000', 10);

// ── Shared types ────────────────────────────────────────

export interface EntityInput {
  label: string;
  tags?: string[];
  confidence?: number;
  properties?: Record<string, unknown>;
}

export interface ClaimInput {
  content: string;
  confidence?: number;
  provenance?: string;
  entities?: string[];
}

// ── Rust response types (must match Rust structs) ────────

/** Matches Rust ExtractedEntity. */
export interface ExtractedEntity {
  name: string;
  start: number;
  end: number;
  confidence: number;
  in_graph: boolean;
  graph_id: string | null;
  tags: string[];
}

/** Matches Rust ExtractedClaim. */
export interface ExtractedClaim {
  subject: string;
  link_type: string;
  object: string;
  confidence: number;
}

/** Matches Rust SearchedNode. */
export interface SearchedNode {
  id: string;
  label: string;
  node_type: string;
  confidence: number;
  relevance: number;
  tags: string[];
}

interface IloResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

class IloClient {
  private baseUrl: string;
  private timeout: number;

  constructor(baseUrl?: string, timeout?: number) {
    this.baseUrl = baseUrl || ILO_BASE;
    this.timeout = timeout || ILO_TIMEOUT;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: any,
  ): Promise<IloResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}: ${text}` };
      }

      const data = await res.json();
      return { ok: true, data: data as T };
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        return { ok: false, error: 'timeout' };
      }
      return { ok: false, error: err.message };
    }
  }

  // ── Core API ────────────────────────────────────────

  /** Health check — returns version and DB status. */
  async status() {
    return this.request<{ status: string; version: string; uptime_secs: number; counts: { entities: number; claims: number; turns: number; links: number } }>('GET', '/status');
  }

  /** Extract entities and claims from raw text. */
  async extract(text: string) {
    return this.request<{ text: string; entities: ExtractedEntity[]; claims: ExtractedClaim[]; n_entities: number; n_claims: number }>(
      'POST', '/extract', { text }
    );
  }

  /** Embed text into a vector using mistral.rs embedding server (proxied via ILO). */
  async embed(text: string, isQuery: boolean = true) {
    return this.request<{ embedding: number[]; dim: number }>('POST', '/embed', { text, is_query: isQuery });
  }

  /** Retrieve memory context for a query. Optionally pass query embedding for vector search. */
  async recall(query: string, queryEmbedding?: number[]) {
    return this.request<{ context: string; nodes: number; chars: number }>('POST', '/recall', {
      query,
      query_embedding: queryEmbedding,
    });
  }

  /** Store a conversation turn with entities, claims, and response. */
  async remember(params: {
    query: string;
    response: string;
    entities: EntityInput[];
    claims: ClaimInput[];
    turnIndex: number;
    /** Labels of entities already stored in the graph to link to this turn. */
    allEntities?: string[];
  }) {
    return this.request<{ status: string; turn_id: string; phase: string; entities_created: number }>('POST', '/remember', {
      turn_index: params.turnIndex,
      query: params.query,
      response: params.response,
      entities: params.entities,
      claims: params.claims,
      all_entities: params.allEntities,
    });
  }

  /** Ingest external content as entities + claims without creating a Turn. */
  async ingest(content: string, source: string, tags?: string[]) {
    return this.request<{ status: string; entities_created: number; claims_created: number }>('POST', '/ingest', {
      content, source, tags,
    });
  }

  /** Signal learning feedback — which entities were useful. */
  async learn(params: {
    query: string;
    responseText: string;
    usedLabels: string[];
    retrievedLabels?: string[];
    quality?: number;
  }) {
    return this.request('POST', '/learn', {
      query: params.query,
      response_text: params.responseText,
      used_labels: params.usedLabels,
      retrieved_labels: params.retrievedLabels || [],
      quality: params.quality ?? 0.8,
    });
  }

  // ── LLM-invokable tools ────────────────────────────

  /** Debug — get internal tag index state. */
  async debug() {
    return this.request<{ tag_index_keys: string[] }>('GET', '/debug');
  }

  /** Search memory. Use list=true for flat results without graph expansion. */
  async search(query: string, list?: boolean, tag?: string, queryEmbedding?: number[]) {
    return this.request<{ context: string; nodes: SearchedNode[] | null; total: number }>('POST', '/search', {
      query,
      max_hops: list ? 0 : undefined,
      tag,
      query_embedding: queryEmbedding,
    });
  }

  /** Look up an entity by name. */
  async entityLookup(name: string) {
    return this.request<{ found: boolean; id?: string; name?: string; confidence?: number; tags?: string[]; properties?: Record<string, unknown> }>(
      'POST', '/entity/lookup', { name }
    );
  }

  /** Create a link between two entities. */
  async connect(from: string, to: string, linkType: string) {
    return this.request<{ status: string; link_id: string; entities_affected: string[] }>('POST', '/connect', { from, to, link_type: linkType });
  }

  /** Update an entity's properties and tags. */
  async entityUpdate(name: string, properties: Record<string, unknown>, tags?: string[]) {
    return this.request<{ status: string; created: boolean; entities_affected: string[] }>('POST', '/entity/update', { name, properties, tags });
  }

  // ═════════════════════════════════════════════════════
  // NEW REST CRUD METHODS
  // ═════════════════════════════════════════════════════

  /** Create entities (batch). */
  async createEntities(entities: EntityInput[]) {
    return this.request<{ created: string[]; count: number }>('POST', '/entities', { entities });
  }

  /** List/filter entities. */
  async listEntities(params?: { type?: string; tag?: string; label_contains?: string; limit?: number; offset?: number }) {
    return this.request<{ nodes: any[]; total: number }>('POST', '/entities/search', params || {});
  }

  /** Get entity by ID or label (with properties + links). */
  async getEntity(idOrLabel: string) {
    return this.request<any>('GET', `/entities/${encodeURIComponent(idOrLabel)}`);
  }

  /** Update entity fields. */
  async updateEntity(id: string, fields: { label?: string; tags?: string[]; confidence?: number; properties?: Record<string, unknown> }) {
    return this.request<{ status: string; id: string }>('PATCH', `/entities/${encodeURIComponent(id)}`, fields);
  }

  /** Delete entity (cascade). */
  async deleteEntity(id: string) {
    return this.request<{ status: string; deleted: string }>('DELETE', `/entities/${encodeURIComponent(id)}`);
  }

  /** Quick lookup by label. */
  async lookup(label: string) {
    return this.request<any>('GET', `/lookup/${encodeURIComponent(label)}`);
  }

  /** Create claims. */
  async createClaims(claims: ClaimInput[]) {
    return this.request<{ created: string[]; count: number }>('POST', '/claims', { claims });
  }

  /** Get claim by ID. */
  async getClaim(id: string) {
    return this.request<any>('GET', `/claims/${encodeURIComponent(id)}`);
  }

  /** Update claim. */
  async updateClaim(id: string, fields: { confidence?: number; properties?: Record<string, unknown> }) {
    return this.request<{ status: string; id: string }>('PATCH', `/claims/${encodeURIComponent(id)}`, fields);
  }

  /** Delete claim. */
  async deleteClaim(id: string) {
    return this.request<{ status: string; deleted: string }>('DELETE', `/claims/${encodeURIComponent(id)}`);
  }

  /** Create a link between two nodes. */
  async createLink(from: string, to: string, type?: string, weight?: number) {
    return this.request<{ id: string; from: string; to: string; type: string }>('POST', '/links', { from, to, type, weight });
  }

  /** Update a link. */
  async updateLink(id: string, fields: { type?: string; weight?: number; properties?: Record<string, unknown> }) {
    return this.request<{ status: string; id: string }>('PATCH', `/links/${encodeURIComponent(id)}`, fields);
  }

  /** Delete a link. */
  async deleteLink(id: string) {
    return this.request<{ status: string; deleted: string }>('DELETE', `/links/${encodeURIComponent(id)}`);
  }

  /** Batch atomic write (turn + entities + claims + links). */
  async batch(params: {
    turn?: { query?: string; response?: string; model?: string; tokens_in?: number; tokens_out?: number; duration_ms?: number };
    entities?: EntityInput[];
    claims?: ClaimInput[];
    links?: Array<{ from: string; to: string; type?: string; weight?: number }>;
  }) {
    return this.request<{ turn_id?: string; entities_created: string[]; claims_created: string[]; links_created: string[] }>('POST', '/batch', params);
  }
}

export const ilo = new IloClient();
export { IloClient };
