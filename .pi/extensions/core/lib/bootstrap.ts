// ============================================================================
// lib/bootstrap.ts — First-run data seeding
// ============================================================================
// Seeds Config defaults, mode entities, and universal rules into the DB.
// Called at every session_start. Idempotent — safe to call repeatedly.
// Checks if data exists before creating. On /reload, existing data is preserved.
// ============================================================================

import type { DbLayer } from './db';

// ═══════════════════════════════════════════════════════════
// Config defaults
// ═══════════════════════════════════════════════════════════

interface ConfigSeed {
  key: string;
  value: string;
  scope: string;
  mutable: string;
}

const CONFIG_DEFAULTS: ConfigSeed[] = [
  { key: 'context.injection.max_chars',          value: '2000', scope: 'core',     mutable: 'flexible' },
  { key: 'context.injection.budget_warning',      value: '0.75', scope: 'core',     mutable: 'flexible' },
  { key: 'context.injection.budget_critical',     value: '0.90', scope: 'core',     mutable: 'flexible' },
  { key: 'context.injection.entity_cache_ttl',    value: '10',   scope: 'core',     mutable: 'flexible' },
  { key: 'entity.extraction.max_anchors',         value: '3',    scope: 'core',     mutable: 'flexible' },
  { key: 'entity.extraction.max_beliefs',         value: '5',    scope: 'core',     mutable: 'flexible' },
  { key: 'tool.offload.threshold_chars',          value: '500',  scope: 'core',     mutable: 'flexible' },
  { key: 'feedback.keyword.enabled',              value: 'true', scope: 'adaptive', mutable: 'flexible' },
  { key: 'feedback.semantic.enabled',             value: 'true', scope: 'adaptive', mutable: 'flexible' },
  { key: 'feedback.semantic.similarity_threshold',value: '0.5',  scope: 'adaptive', mutable: 'flexible' },
  { key: 'consolidation.turn_counter',            value: '0',    scope: 'core',     mutable: 'flexible' },
  // ── Phase 2a: Web + ingest + mode configs
  { key: 'mode.override',                   value: '',     scope: 'core',     mutable: 'flexible' },
  { key: 'web.request_timeout',             value: '15000', scope: 'core',     mutable: 'flexible' },
  { key: 'web.searxng_port',                value: '8888',  scope: 'core',     mutable: 'flexible' },
  { key: 'crawl.max_pages',                 value: '100',   scope: 'core',     mutable: 'flexible' },
  { key: 'crawl.max_depth',                 value: '3',     scope: 'core',     mutable: 'flexible' },
  { key: 'ingest.confidence_default',       value: '0.7',   scope: 'adaptive', mutable: 'flexible' },
  // ── Embedding / GPU configs
  { key: 'embedding.gpu.enabled',            value: 'false', scope: 'core',     mutable: 'flexible' },
];

async function seedConfigDefaults(db: DbLayer): Promise<void> {
  for (const cfg of CONFIG_DEFAULTS) {
    // Check if this Config key already exists
    const existing = await db.query(
      'MATCH (c:Config {key: $key}) RETURN c.key LIMIT 1',
      { key: cfg.key }
    );
    if (existing.length > 0) continue;

    await db.addNode('Config', {
      key: cfg.key,
      value: cfg.value,
      version: 1,
      scope: cfg.scope,
      mutable: cfg.mutable,
      updated_at: new Date().toISOString(),
    });
  }
}

// ═══════════════════════════════════════════════════════════
// Mode entity + universal rules bootstrap
// ═══════════════════════════════════════════════════════════

interface ModeSeed {
  entityName: string;
  entityType: string;
  beliefs: Array<{ content: string; confidence: number }>;
}

const MODE_SEEDS: ModeSeed[] = [
  {
    entityName: 'ailo:core',
    entityType: 'behavior',
    beliefs: [
      { content: 'I have persistent long-term memory across sessions via a LadybugDB knowledge base.', confidence: 1.0 },
      { content: 'I cite sources when making claims from stored beliefs.', confidence: 0.95 },
      { content: 'I respect confidence labels: >0.80 = fact, 0.60-0.80 = likely, <0.60 = possible, <0.40 = not injected.', confidence: 0.95 },
      { content: 'I never run destructive commands (rm -rf, DROP TABLE, etc.) without user confirmation.', confidence: 0.95 },
      { content: 'I adapt my behavior based on what the user is asking me to do — coding, teaching, planning, etc.', confidence: 0.90 },
    ],
  },
  {
    entityName: 'ailo:mode:coding',
    entityType: 'behavior',
    beliefs: [
      { content: 'Use strict TypeScript with explicit return types.', confidence: 0.90 },
      { content: 'Follow existing project naming conventions.', confidence: 0.85 },
      { content: 'Write JSDoc for all public APIs and exported types.', confidence: 0.85 },
      { content: 'Handle errors explicitly — no silent catch blocks.', confidence: 0.90 },
      { content: 'Write tests for new functionality.', confidence: 0.80 },
    ],
  },
  {
    entityName: 'ailo:mode:tutoring',
    entityType: 'behavior',
    beliefs: [
      { content: 'SOCRATIC METHOD: Never give direct answers or write code for the user.', confidence: 0.95 },
      { content: 'When asked about a concept: ask what the user already knows first.', confidence: 0.95 },
      { content: 'For assignments: provide skeleton structure ONLY — section headings, guiding questions, module references. Do NOT fill in content or write code.', confidence: 0.95 },
      { content: 'Reference course material by module: "Module 2.1 covers this — how does it apply here?"', confidence: 0.85 },
      { content: 'If the user asks "just write it for me," say: "Let us work through it together. What is your first step?"', confidence: 0.90 },
      { content: 'Validate understanding before advancing to harder topics.', confidence: 0.80 },
    ],
  },
  {
    entityName: 'ailo:mode:planning',
    entityType: 'behavior',
    beliefs: [
      { content: 'Consider tradeoffs explicitly before choosing an approach.', confidence: 0.90 },
      { content: 'List at least two alternatives with pros and cons.', confidence: 0.85 },
      { content: 'Identify risks, unknowns, and dependencies.', confidence: 0.85 },
    ],
  },
  {
    entityName: 'ailo:mode:general',
    entityType: 'behavior',
    beliefs: [
      { content: 'Be helpful and concise in responses.', confidence: 0.90 },
      { content: 'Use the retrieve tool to check stored knowledge before answering.', confidence: 0.85 },
      { content: 'Help the user articulate their own understanding rather than imposing templates.', confidence: 0.80 },
    ],
  },
  {
    entityName: 'ailo:mode:job-hunt',
    entityType: 'behavior',
    beliefs: [
      { content: 'CV building: interactive guided Q&A, never templates. Ask one section at a time.', confidence: 0.95 },
      { content: 'Cover letters: co-author by asking about the user experience. Never write for them.', confidence: 0.95 },
      { content: 'Role finding: only search when asked. Use saved criteria: data analyst, hospitality industry, minimum £32k.', confidence: 0.90 },
      { content: 'Help the user articulate their experience in their own words.', confidence: 0.85 },
      { content: 'Suggest structure (STAR, bullet format) but never fill in the content.', confidence: 0.85 },
    ],
  },
];

async function seedModeEntities(db: DbLayer): Promise<void> {
  for (const seed of MODE_SEEDS) {
    // Check if this entity already exists
    const existing = await db.query(
      'MATCH (e:Entity {name: $name}) RETURN e.name LIMIT 1',
      { name: seed.entityName }
    );
    if (existing.length > 0) continue;

    // Create the entity
    const entityId = await db.addNode('Entity', {
      name: seed.entityName,
      type: seed.entityType,
      confidence: 1.0,
      mention_count: 0,
      momentum: 0,
      created_at: new Date().toISOString(),
    });

    // Create each belief and link via HAS_BELIEF
    for (const b of seed.beliefs) {
      const beliefId = await db.addNode('Belief', {
        content: b.content,
        confidence: b.confidence,
        entity: seed.entityName,
        provenance: 'system.bootstrap',
        last_referenced: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });

      await db.addEdge('Entity', 'id', entityId, 'Belief', 'id', beliefId, 'HAS_BELIEF');
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════

/**
 * Seed all default data into the database.
 * Called at session_start after schema is applied.
 * Idempotent — safe to call on every startup.
 */
export async function seedDefaults(db: DbLayer): Promise<void> {
  await seedConfigDefaults(db);
  await seedModeEntities(db);
}