# ILO Interaction Loop — Design

## Overview

The interaction loop bridges ILO (Rust memory sidecar) with the pi coding agent
(Node.js extension). It runs once per user turn and orchestrates the full cognitive
pipeline: extract → embed → recall → generate → learn → remember.

```
User prompt
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│               PI EXTENSION (TypeScript)                   │
│                                                          │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐             │
│  │ Extract  │──▶│  Embed   │──▶│  Recall  │             │
│  │ entities │   │  query   │   │  context │             │
│  └──────────┘   └──────────┘   └────┬─────┘             │
│                                      │                   │
│  ┌───────────────────────────────────▼─────────────────┐ │
│  │         LLM generates response with context          │ │
│  │         Agent may call ILO tools during generation  │ │
│  └───────────────────────────────────┬─────────────────┘ │
│                                      │                   │
│  ┌──────────┐   ┌──────────┐   ┌────▼─────┐             │
│  │ Remember │◀──│  Learn   │◀──│ Extract  │             │
│  │ store    │   │ feedback │   │ from     │             │
│  │ turn     │   │ weights  │   │ response │             │
│  └──────────┘   └──────────┘   └──────────┘             │
│                                                          │
│              ┌──────────────────┐                        │
│              │ ILO Client Module │◀──── HTTP/UDS ────────│
│              └──────────────────┘                        │
└──────────────────────────────────────────────────────────┘
                                │
                                ▼
              ┌──────────────────────────────────────┐
              │        ILO (Rust sidecar)             │
              │  /extract  /recall  /learn  /remember │
              │  /entity/lookup  /connect  /update    │
              └──────────────────────────────────────┘
```

---

## Module: `ilo-client.ts`

A thin HTTP client that communicates with ILO over the Unix domain socket.

```typescript
// lib/ilo-client.ts — ILO HTTP client

import { createConnection } from 'node:net';

const ILO_SOCKET = process.env.ILO_SOCKET || '/tmp/ilo.sock';

interface IloResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

class IloClient {
  private socketPath: string;

  constructor(socketPath?: string) {
    this.socketPath = socketPath || ILO_SOCKET;
  }

  private async request<T>(method: string, path: string, body?: any): Promise<IloResponse<T>> {
    return new Promise((resolve) => {
      const payload = body ? JSON.stringify(body) : '';
      const req = `POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`;

      const sock = createConnection(this.socketPath);
      let data = '';

      sock.on('connect', () => sock.write(req));
      sock.on('data', (chunk) => { data += chunk; });
      sock.on('end', () => {
        const [_headers, _body] = data.split('\r\n\r\n');
        if (_body) {
          try { resolve({ ok: true, data: JSON.parse(_body) }); }
          catch { resolve({ ok: false, error: 'parse error' }); }
        } else {
          resolve({ ok: false, error: 'no response' });
        }
      });
      sock.on('error', (err) => resolve({ ok: false, error: err.message }));
      sock.end();
    });
  }

  // ── API methods ────────────────────────────────────

  async status() {
    return this.request('/status', 'GET');
  }

  async extract(text: string) {
    return this.request<{ entities: any[]; claims: any[] }>('/extract', { text });
  }

  async recall(query: string, queryEmbedding?: number[]) {
    return this.request<{ context: string; nodes: number }>('/recall', {
      query,
      query_embedding: queryEmbedding,
    });
  }

  async remember(params: {
    query: string;
    response: string;
    entities: any[];
    claims: any[];
    sessionId: string;
    turnIndex: number;
  }) {
    return this.request('/remember', {
      session_id: params.sessionId,
      turn_index: params.turnIndex,
      query: params.query,
      response: params.response,
      entities: params.entities,
      claims: params.claims,
    });
  }

  async learn(params: {
    query: string;
    responseText: string;
    usedLabels: string[];
    retrievedLabels: string[];
    quality?: number;
  }) {
    return this.request('/learn', {
      query: params.query,
      response_text: params.responseText,
      used_labels: params.usedLabels,
      retrieved_labels: params.retrievedLabels,
      quality: params.quality ?? 0.8,
    });
  }

  // ── LLM-invokable tools ────────────────────────────

  async entityLookup(name: string) {
    return this.request('/entity/lookup', { name });
  }

  async connect(from: string, to: string, linkType: string) {
    return this.request('/connect', { from, to, link_type: linkType });
  }

  async entityUpdate(name: string, properties: Record<string, any>) {
    return this.request('/entity/update', { name, properties });
  }
}

export const ilo = new IloClient();
```

---

## Hook: `before_agent_start` (context injection)

This runs before every LLM call. It replaces the current `context.ts` logic.

```typescript
// events/context.ts — simplified with ILO

import { ilo } from '../lib/ilo-client';

pi.on('before_agent_start', async (ctx) => {
  const userText = getState().lastUserText;

  // Step 1: Quick check — should we recall?
  if (userText.length < 10) return;  // skip for short messages

  // Step 2: Extract entities from the prompt
  const extract = await ilo.extract(userText);

  // Step 3: Recall context from ILO
  const recall = await ilo.recall(userText);

  // Step 4: Inject context into system prompt
  if (recall.data?.context) {
    ctx.addSystemPrompt(recall.data.context);
  }
});
```

---

## Hook: `turn_end` (learning + storage)

This runs after every LLM call. It replaces the current `turn.ts` logic.

```typescript
// events/turn.ts — simplified with ILO

import { ilo } from '../lib/ilo-client';

pi.on('turn_end', async ({ session, turn }) => {
  const state = getState();

  // Step 1: Extract entities and claims from the full conversation
  const fullText = `${state.lastUserText}\n${turn.response}`;
  const extract = await ilo.extract(fullText);

  // Step 2: Determine which retrieved entities were actually used
  // (This is the learning signal — the LLM knows best, but as fallback
  //  we use overlap detection)
  const usedLabels = extract.entities
    .filter(e => turn.response.includes(e.name))
    .map(e => e.name);

  // Step 3: Signal learning
  await ilo.learn({
    query: state.lastUserText,
    responseText: turn.response,
    usedLabels,
    retrievedLabels: [],  // empty = use overlap detection
  });

  // Step 4: Store the turn with entities and claims
  await ilo.remember({
    query: state.lastUserText,
    response: turn.response,
    entities: extract.entities,
    claims: extract.claims,
    sessionId: getState().sessionId,
    turnIndex: state.turnCount++,
  });
});
```

---

## LLM Tool Registration

The LLM can invoke ILO tools directly during generation. These replace the
current `store.ts` and `search2.ts` tools.

```typescript
// tools/ilo.ts — register ILO tools for the LLM

import { ilo } from '../lib/ilo-client';

export function registerIloTools(api: ExtensionAPI) {
  // Replace the old 'store' tool
  api.registerTool({
    name: 'store',
    description: 'Store a fact in long-term memory',
    parameters: {
      content: { type: 'string' },
      entity: { type: 'string' },
      confidence: { type: 'number' },
    },
    execute: async (params) => {
      // Store creates an entity + claim in ILO
      await ilo.remember({
        query: '',
        response: params.content,
        entities: [{ label: params.entity, confidence: params.confidence }],
        claims: [{ content: params.content, confidence: params.confidence }],
        sessionId: 'tool_store',
        turnIndex: Date.now(),
      });
      return `Stored belief about ${params.entity}`;
    },
  });

  // New tools specific to ILO
  api.registerTool({
    name: 'entity_lookup',
    description: 'Look up a known entity in the graph',
    parameters: { name: { type: 'string' } },
    execute: async (params) => {
      const result = await ilo.entityLookup(params.name);
      return JSON.stringify(result.data);
    },
  });

  api.registerTool({
    name: 'connect',
    description: 'Link two entities in the knowledge graph',
    parameters: {
      from: { type: 'string' },
      to: { type: 'string' },
      link_type: { type: 'string', enum: ['ref', 'dep', 'con', 'evidence'] },
    },
    execute: async (params) => {
      const result = await ilo.connect(params.from, params.to, params.link_type);
      return result.data?.status || 'connected';
    },
  });
}
```

---

## Integration Points Summary

| Pi Event | Current handler | New handler | What changes |
|----------|----------------|-------------|-------------|
| `session_start` | Reset state, restore counters | Same, but via ILO `/status` | Minimal |
| `input` | Store user text for later | Same | Unchanged |
| `before_agent_start` | `context.ts` — manual DB queries + mode detection | Call ILO `/extract` + `/recall`, inject context | **Major** — replaces manual DB logic |
| `turn_end` | `turn.ts` — manual DB writes + consolidation | Call ILO `/learn` + `/remember` | **Major** — replaces manual DB writes |
| Tool calls | `store.ts`, `search2.ts`, `forget.ts` | ILO tools + `/entity/lookup`, `/connect` | Tools redirect to ILO |

---

## Embedding the query

The query needs to be embedded for vector search. Two options:

| Option | Pros | Cons |
|--------|------|------|
| **Xenova in Node.js** | Already in ailo's package.json, no extra deps | Different model than ILO's Candle (embedding dimensions must match) |
| **New `/embed` endpoint** | Same model as ILO, consistent vectors | Adds latency (IPC call + 20ms inference) |
| **Embed on `/recall`** | `/recall` embeds the query internally before vector search | Clean API but modifies `/recall` to be blocking |

**Recommendation:** Add `/embed` to ILO (one handler, ~5 lines) so the pi extension can:

```typescript
const emb = await ilo.request('/embed', { text: userPrompt, is_query: true });
const recall = await ilo.recall(userPrompt, emb.data);
```

Or simplify: make `/recall` embed the query internally when no `query_embedding` is provided but the search index has vectors. This means `/recall` becomes a synchronous CPU-bound call (embeds + searches + traverses), handled via `spawn_blocking`.

---

## Entity extraction strategy

The `/extract` endpoint already handles this. It returns:

```json
{
  "entities": [{"name": "Alice", "confidence": 0.9, "in_graph": true, "tags": ["person"]}],
  "claims": [{"subject": "Alice", "link_type": "ref", "object": "ILO", "confidence": 0.5}]
}
```

The pi extension uses these in two places:
1. **Before LLM** — to extract what the user is asking about (for recency boost)
2. **After LLM** — to extract what the LLM mentioned (for learning signal)

---

## Decisions (2026-07-23)

| # | Decision | Choice |
|:-:|----------|:------:|
| 1 | **Query embedding source** | ILO `/embed` endpoint — Candle in Rust, same model as entity embeddings |
| 2 | **Learning signal** | Both — prefer explicit labels from LLM tools, fall back to overlap detection |
| 3 | **When to recall** | Every turn — context is always injected |
| 4 | **Old tools** | Keep as aliases that redirect to ILO — backward compatible |
| 5 | **Startup** | Pi extension spawns ILO on init — simplest for the user |
