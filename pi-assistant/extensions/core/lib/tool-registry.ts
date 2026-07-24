// ============================================================================
// lib/tool-registry.ts — Central tool definition registry
// ============================================================================
// Each tool module exports a ToolDefinition. index.ts collects them into a
// single ToolRegistry instance, replacing the old TOOL_DEFS hardcoded array
// and registerToolEntities() semantic-discovery seeding.
//
// The registry provides:
//   - getAll() / getByCategory() / getByName() for lookup
//   - seedToDb(db) to persist tool entities in the graph DB
//   - activateAll(api) to bulk-add tools to the active tool set
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { DbLayer } from './db';
import { embed } from './embedding';
import { EMBEDDING_DIM } from './constants';
import * as crypto from 'node:crypto';

// ── Types ────────────────────────────────────────────────

export interface ToolDefinition {
  /** Short snake_case tool name — matches registerTool name */
  name: string;
  /** Human-readable label */
  label: string;
  /** One-line description */
  description: string;
  /** Category grouping (storage, retrieval, ingest, research, tracking) */
  category: string;
  /** Comma-separated alias list for semantic matching */
  aliases: string;
  /** Short prompt snippet for Available tools section */
  promptSnippet: string;
  /** Prompt guideline bullets for Guidelines section */
  promptGuidelines: string[];
  /** Function that calls api.registerTool() for this tool */
  register: (api: ExtensionAPI) => void;
}

// ── Registry ─────────────────────────────────────────────

export class ToolRegistry {
  private _tools: Map<string, ToolDefinition> = new Map();

  /** Register a tool definition. Overwrites if name already exists. */
  add(def: ToolDefinition): void {
    this._tools.set(def.name, def);
  }

  /** Get a tool definition by name */
  get(name: string): ToolDefinition | undefined {
    return this._tools.get(name);
  }

  /** Get all registered tool definitions */
  getAll(): ToolDefinition[] {
    return Array.from(this._tools.values());
  }

  /** Get tool definitions in a given category */
  getByCategory(category: string): ToolDefinition[] {
    return this.getAll().filter(t => t.category === category);
  }

  /** Get all tool names */
  getNames(): string[] {
    return this.getAll().map(t => t.name);
  }

  /** Call register() on every tool definition */
  registerAll(api: ExtensionAPI): void {
    for (const def of this.getAll()) {
      def.register(api);
    }
    // Activate all registered tools
    const currentTools = api.getActiveTools();
    const extensionTools = this.getNames();
    api.setActiveTools([...new Set([...currentTools, ...extensionTools])]);
  }

  /** Seed tool entities into the graph DB for semantic lookup.
   *  Idempotent — skips if any tool entities already exist. */
  async seedToDb(db: DbLayer): Promise<number> {
    const existing = await db.query("MATCH (e:Entity {type: 'tool'}) RETURN e.name LIMIT 1");
    if (existing.length > 0) {
      return 0; // Already seeded
    }

    const defs = this.getAll();
    for (const td of defs) {
      const enrichedDesc = `[${td.category}] ${td.description}`;
      let vectors: (number[] | null)[] | null = null;
      try {
        vectors = await embed([enrichedDesc]);
      } catch {
        // Embedding unavailable — proceed without vector
      }
      const emb = (vectors && vectors.length > 0 && vectors[0]?.length === EMBEDDING_DIM)
        ? vectors[0]
        : null;

      await db.addNode('Entity', {
        id: crypto.randomUUID(),
        name: 'tool_' + td.name,
        type: 'tool',
        confidence: 0.9,
        mention_count: 0,
        momentum: 0,
        aliases: td.aliases,
        embedding: emb,
        created_at: new Date().toISOString(),
      });
    }

    console.log(`[ailo] Seeded ${defs.length} tool entities from registry`);
    return defs.length;
  }
}
