// ============================================================================
// lib/ilo-client.ts — HTTP/UDS client for ILO cognitive memory runtime
// ============================================================================
// Communicates with the ILO Rust sidecar over a Unix domain socket.
// All methods return Promises — call with await.
//
// Usage:
//   import { ilo } from '../lib/ilo-client';
//   const status = await ilo.status();
//   const ctx = await ilo.recall("What is Ailo?");
// ============================================================================

import * as net from 'node:net';

const ILO_SOCKET = process.env.ILO_SOCKET || '/tmp/ilo.sock';
const ILO_TIMEOUT = parseInt(process.env.ILO_TIMEOUT || '10000', 10);

interface IloResponse<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
}

class IloClient {
  private socketPath: string;
  private timeout: number;

  constructor(socketPath?: string, timeout?: number) {
    this.socketPath = socketPath || ILO_SOCKET;
    this.timeout = timeout || ILO_TIMEOUT;
  }

  private request<T>(method: 'GET' | 'POST', path: string, body?: any): Promise<IloResponse<T>> {
    return new Promise((resolve) => {
      const payload = body ? JSON.stringify(body) : '';
      const req = [
        `${method} ${path} HTTP/1.1`,
        'Host: localhost',
        'Content-Type: application/json',
        `Content-Length: ${payload.length}`,
        '',
        payload,
      ].join('\r\n');

      const sock = net.createConnection(this.socketPath);
      let data = '';
      let timer = setTimeout(() => {
        sock.destroy();
        resolve({ ok: false, error: 'timeout' });
      }, this.timeout);

      sock.on('connect', () => sock.write(req));
      sock.on('data', (chunk) => { data += chunk; });
      sock.on('end', () => {
        clearTimeout(timer);
        const parts = data.split('\r\n\r\n');
        const bodyStr = parts[1] || '';
        if (!bodyStr) return resolve({ ok: false, error: 'empty response' });
        try {
          const parsed = JSON.parse(bodyStr);
          resolve({ ok: true, data: parsed });
        } catch {
          resolve({ ok: false, error: 'parse error' });
        }
      });
      sock.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: err.message });
      });
    });
  }

  // ── Core API ────────────────────────────────────────

  /** Health check — returns version and DB status. */
  async status() {
    return this.request<{ status: string; version: string; db_connected: boolean }>('GET', '/status');
  }

  /** Extract entities and claims from raw text. */
  async extract(text: string) {
    return this.request<{ text: string; entities: any[]; claims: any[]; n_entities: number; n_claims: number }>(
      'POST', '/extract', { text }
    );
  }

  /** Embed text into a 768-dim vector using Candle/BGE. */
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

  /** Store a turn with entities, claims, and response. */
  async remember(params: {
    query: string;
    response: string;
    entities: any[];
    claims: any[];
    sessionId: string;
    turnIndex: number;
  }) {
    return this.request('POST', '/remember', {
      session_id: params.sessionId,
      turn_index: params.turnIndex,
      query: params.query,
      response: params.response,
      entities: params.entities,
      claims: params.claims,
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

  /** Look up an entity by name. */
  async entityLookup(name: string) {
    return this.request<{ found: boolean; id?: string; name?: string; confidence?: number; tags?: string[]; properties?: any }>(
      'POST', '/entity/lookup', { name }
    );
  }

  /** Create a link between two entities. */
  async connect(from: string, to: string, linkType: string) {
    return this.request('POST', '/connect', { from, to, link_type: linkType });
  }

  /** Update an entity's properties. */
  async entityUpdate(name: string, properties: Record<string, any>) {
    return this.request('POST', '/entity/update', { name, properties });
  }
}

export const ilo = new IloClient();
export { IloClient };
