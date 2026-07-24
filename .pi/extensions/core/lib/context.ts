// ============================================================================
// lib/context.ts — Context retrieval engine
// ============================================================================
// Extracts entities from user prompt, deduces mode, retrieves beliefs,
// optionally discovers relevant tools, and composes context blocks.
//
// Architecture:
//   1. Extract entities from prompt (cached regex patterns)
//   2. Deduce mode from entities + keyword fallback
//   3. Query beliefs for mode rules + entity knowledge
//   4. Optionally query semantic tool recommendations
//   5. Compose context blocks with budget awareness
// ============================================================================

import { getDb } from './engine';
import { embed, getStatus } from './embedding';

// ── Types ────────────────────────────────────────────────

export interface ContextBlock {
  /** Heading label for the block (used in composition) */
  label: string;
  /** Formatted text content */
  content: string;
  /** Approximate character length */
  length: number;
  /** Priority tier: 0=highest (mode rules), 1=mid (entity knowledge), 2=lowest (tool recs) */
  priority: 0 | 1 | 2;
}

export interface ContextOptions {
  /** Current context usage ratio (0.0-1.0) from ctx.getContextUsage() */
  ctxUsage?: number;
  /** Override max chars from Config (default 2000) */
  maxChars?: number;
  /** Override budget warning threshold (default 0.75) */
  budgetWarning?: number;
  /** Override budget critical threshold (default 0.90) */
  budgetCritical?: number;
  /** Override max anchors (default 3) */
  maxAnchors?: number;
  /** Override max beliefs per entity (default 5) */
  maxBeliefs?: number;
  /** System prompt options from Pi's before_agent_start event */
  systemPromptOptions?: {
    selectedTools?: string[];
    skills?: Array<{ name: string }>;
  };
}

export interface DetectedMode {
  mode: 'coding' | 'tutoring' | 'planning' | 'general' | 'job-hunt' | string;
  confidence: number;
  entityName: string;
}

// ═══════════════════════════════════════════════════════════
// Entity extraction cache
// ═══════════════════════════════════════════════════════════

const CACHE_KEY = '__ailo_entity_cache__';

interface EntityCache {
  patterns: Array<{ name: string; regex: RegExp }>;
  turnCount: number;
}

function getEntityCache(): EntityCache | null {
  return (globalThis as any)[CACHE_KEY] ?? null;
}

function setEntityCache(cache: EntityCache | null): void {
  (globalThis as any)[CACHE_KEY] = cache;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Get compiled regex for word-boundary matching of entity names + aliases.
 * Cached on globalThis, refreshed every `ttl` turns.
 * NOTE: turnCount is incremented by turn.ts, NOT by this function —
 * extractEntities may be called multiple times per turn.
 */
async function getEntityPatterns(ttl: number = 10): Promise<EntityCache> {
  const cached = getEntityCache();
  
  // Use cache if it exists and hasn't expired
  if (cached && cached.turnCount < ttl) {
    return cached;
  }
  
  // Refresh from DB
  const db = getDb();
  const rows = await db.query(
    'MATCH (e:Entity) RETURN e.name AS name, e.aliases AS aliases'
  );
  
  const patterns: Array<{ name: string; regex: RegExp }> = [];
  
  for (const row of rows) {
    if (!row.name) continue;
    
    // Add the entity name itself
    patterns.push({
      name: row.name,
      regex: new RegExp('\\b' + escapeRegex(row.name) + '\\b', 'i'),
    });
    
    // Add aliases if present
    if (row.aliases && typeof row.aliases === 'string') {
      for (const alias of row.aliases.split(',').map((s: string) => s.trim()).filter(Boolean)) {
        patterns.push({
          name: row.name,  // reference the canonical name
          regex: new RegExp('\\b' + escapeRegex(alias) + '\\b', 'i'),
        });
      }
    }
  }
  
  const cache: EntityCache = { patterns, turnCount: 0 };
  setEntityCache(cache);
  return cache;
}

/**
 * Increment the entity cache turn counter.
 * Called once per turn from turn.ts, not from extractEntities().
 */
export function advanceEntityCacheTurn(): void {
  const cached = getEntityCache();
  if (cached) {
    cached.turnCount++;
  }
}

/** Force refresh the entity cache (called after entity creation/deletion). */
export function invalidateEntityCache(): void {
  setEntityCache(null);
}

// ═══════════════════════════════════════════════════════════
// Stop words (common English words excluded from entity match)
// ═══════════════════════════════════════════════════════════

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'been', 'before', 'being', 'could',
  'does', 'done', 'each', 'else', 'every', 'from', 'have', 'help', 'here',
  'into', 'just', 'like', 'more', 'much', 'must', 'need', 'next', 'none',
  'only', 'other', 'over', 'same', 'some', 'such', 'than', 'that', 'them',
  'then', 'there', 'these', 'they', 'this', 'upon', 'very', 'want', 'well',
  'what', 'when', 'where', 'which', 'while', 'will', 'with', 'would', 'your',
  'tell', 'know', 'think', 'work', 'show', 'make', 'take', 'look', 'give',
  'use', 'find', 'ask', 'try', 'leave', 'call', 'keep', 'let', 'begin',
  'might', 'shall', 'should', 'write', 'read', 'run', 'set', 'put', 'get',
  'say', 'see', 'come', 'made', 'going', 'thing', 'stuff', 'yes', 'no', 'ok',
]);

// ═══════════════════════════════════════════════════════════
// 1. Entity extraction
// ═══════════════════════════════════════════════════════════

/**
 * Extract entity names from a user prompt using cached regex patterns.
 * Returns canonical entity names (not aliases).
 */
export async function extractEntities(prompt: string, ttl?: number): Promise<string[]> {
  if (!prompt || prompt.trim().length === 0) return [];
  
  const cache = await getEntityPatterns(ttl);
  const matched = new Set<string>();
  
  for (const pattern of cache.patterns) {
    // Skip stop words
    if (STOP_WORDS.has(pattern.name.toLowerCase())) continue;
    if (STOP_WORDS.has(pattern.regex.source.replace(/\\b|\^|\\i/g, '').toLowerCase())) continue;
    
    if (pattern.regex.test(prompt)) {
      matched.add(pattern.name);
    }
  }
  
  return [...matched];
}

/**
 * Semantic fallback: embed the prompt and query vector index for entities + tools.
 * Returns both matched entities and the embedding vector for reuse.
 */
async function semanticSearch(
  prompt: string,
  maxResults: number = 3
): Promise<{ entities: string[]; tools: string[]; embedding: number[] | null }> {
  const result: { entities: string[]; tools: string[]; embedding: number[] | null } = { entities: [], tools: [], embedding: null as number[] | null };
  
  const embedStatus = getStatus();
  if (embedStatus !== 'healthy') return result;
  
  const vectors = await embed([prompt.substring(0, 1000)]);
  if (!vectors || vectors.length === 0 || vectors[0].length === 0) return result;
  
  const emb = vectors[0];
  result.embedding = emb;
  
  try {
    const db = getDb();
    
    // Query entities
    const entityRows = await db.query(
      'CALL QUERY_VECTOR_INDEX(\'Entity\', \'idx_entity_emb\', $1, $2) WITH node, distance RETURN node.name AS name, distance ORDER BY distance',
      { '1': emb, '2': maxResults }
    );
    result.entities = (entityRows || []).map((r: any) => r.name).filter(Boolean);
    
    // Query tools (same embedding, separate vector query)
    const toolRows = await db.query(
      'CALL QUERY_VECTOR_INDEX(\'Entity\', \'idx_entity_emb\', $1, 5) WITH node, distance WHERE node.type = \'tool\' RETURN node.name AS name, distance ORDER BY distance LIMIT 3',
      { '1': emb }
    );
    result.tools = (toolRows || [])
      .map((r: any) => r.name)
      .filter(Boolean)
      .map((name: string) => name.replace(/^tool_/, ''));
  } catch {
    // Index may not exist — graceful degradation
  }
  
  return result;
}

// ═══════════════════════════════════════════════════════════
// 2. Mode deduction
// ═══════════════════════════════════════════════════════════

const MODE_KEYWORDS: Record<string, RegExp> = {
  coding: /\b(write|implement|fix|bug|code|refactor|function|api|class|test|implement|build|create|add feature)\b/i,
  tutoring: /\b(teach|explain|learn|understand|what is|how does|means|tutorial|guide|help me understand)\b/i,
  planning: /\b(plan|design|architecture|decide|should I|trade.?off|alternatives|compare)\b/i,
  'job-hunt': /\b(job|cv|cover letter|recruiter|role|career|apply|hiring|salary|interview|resume)\b/i,
};

/**
 * Deduce the current mode from matched entities and prompt text.
 */
export function deduceMode(prompt: string, matchedEntities: string[], entityTypes?: Map<string, string>): DetectedMode {
  // Priority 1: Entity type-based detection
  if (entityTypes) {
    for (const entity of matchedEntities) {
      const type = entityTypes.get(entity);
      if (type === 'course') return { mode: 'tutoring', confidence: 0.9, entityName: 'ailo:mode:tutoring' };
      if (type === 'project') return { mode: 'planning', confidence: 0.8, entityName: 'ailo:mode:planning' };
      if (type === 'behavior') {
        // Extract mode from entity name: ailo:mode:coding → coding
        const mode = entity.replace('ailo:mode:', '');
        if (isValidMode(mode)) return { mode, confidence: 0.95, entityName: entity };
      }
    }
  }
  
  // Priority 2: Check if any matched entity is a known mode entity (by name pattern)
  for (const entity of matchedEntities) {
    if (entity.startsWith('ailo:mode:')) {
      const mode = entity.replace('ailo:mode:', '') as DetectedMode['mode'];
      if (isValidMode(mode)) return { mode, confidence: 0.9, entityName: entity };
    }
  }
  
  // Priority 3: Keyword fallback
  for (const [mode, regex] of Object.entries(MODE_KEYWORDS)) {
    if (regex.test(prompt)) {
      return { mode: mode as DetectedMode['mode'], confidence: 0.65, entityName: `ailo:mode:${mode}` };
    }
  }
  
  // Default
  return { mode: 'general', confidence: 0.5, entityName: 'ailo:mode:general' };
}

function isValidMode(mode: string): mode is DetectedMode['mode'] {
  return ['coding', 'tutoring', 'planning', 'general'].includes(mode);
}

// ═══════════════════════════════════════════════════════════
// 3. Belief retrieval
// ═══════════════════════════════════════════════════════════

interface BeliefResult {
  content: string;
  confidence: number;
  provenance?: string;
}

async function queryEntityBeliefs(entityName: string, max: number = 5, minConf: number = 0.3): Promise<BeliefResult[]> {
  try {
    const db = getDb();
    const rows = await db.query(
      'MATCH (e:Entity {name: $name})-[:HAS_BELIEF]->(b:Belief) WHERE b.confidence >= $minConf RETURN b.content AS content, b.confidence AS confidence, b.provenance AS provenance ORDER BY b.confidence DESC LIMIT $max',
      { name: entityName, minConf, max }
    );
    return (rows || []).map((r: any) => ({ content: r.content || '', confidence: r.confidence || 0, provenance: r.provenance || undefined }));
  } catch {
    return [];
  }
}

async function getEntityTypes(entities: string[]): Promise<Map<string, string>> {
  if (entities.length === 0) return new Map();
  
  try {
    const db = getDb();
    const typeMap = new Map<string, string>();
    
    for (const entity of entities) {
      const rows = await db.query(
        'MATCH (e:Entity {name: $name}) RETURN e.type AS type',
        { name: entity }
      );
      if (rows.length > 0) {
        typeMap.set(entity, rows[0].type || '');
      }
    }
    return typeMap;
  } catch {
    return new Map();
  }
}

// ═══════════════════════════════════════════════════════════
// 5. Budget management
// ═══════════════════════════════════════════════════════════

async function getConfigValue(key: string, defaultValue: string): Promise<string> {
  try {
    const db = getDb();
    const rows = await db.query(
      'MATCH (c:Config {key: $key}) RETURN c.value AS value ORDER BY c.version DESC LIMIT 1',
      { key }
    );
    return rows.length > 0 ? rows[0].value : defaultValue;
  } catch {
    return defaultValue;
  }
}

interface Budget {
  maxChars: number;
  available: number;
  warning: boolean;
  critical: boolean;
}

async function getBudget(options?: ContextOptions): Promise<Budget> {
  const maxChars = options?.maxChars ?? parseInt(
    await getConfigValue('context.injection.max_chars', '2000'), 10
  );
  const warningThreshold = options?.budgetWarning ?? parseFloat(
    await getConfigValue('context.injection.budget_warning', '0.75')
  );
  const criticalThreshold = options?.budgetCritical ?? parseFloat(
    await getConfigValue('context.injection.budget_critical', '0.90')
  );
  
  const usage = options?.ctxUsage ?? 0;
  const critical = usage >= criticalThreshold;
  const warning = usage >= warningThreshold && !critical;
  
  // Reduce available chars based on how close we are to the limit
  let available = maxChars;
  if (critical) available = 0;          // Skip ALL injection if critical
  else if (warning) available = Math.floor(maxChars * 0.5);  // 50% budget if warning
  
  return { maxChars, available, warning, critical };
}

// ═══════════════════════════════════════════════════════════
// 6. Context composition
// ═══════════════════════════════════════════════════════════

const PROVENANCE_PREFIX: Record<string, string> = {
  course_material: '[course]',
  user_written:    '[note]',
  web_research:    '[research]',
  user_confirmed:  '[confirmed]',
  user_supplied:   '[user]',
};

function formatBeliefBlock(label: string, beliefs: BeliefResult[]): ContextBlock | null {
  if (beliefs.length === 0) return null;
  
  const lines = beliefs.map(b => {
    const prefix = PROVENANCE_PREFIX[b.provenance || ''] || '';
    return prefix ? `${prefix} ${b.content}` : `- ${b.content}`;
  });
  
  const content = `### ${label}\n${lines.join('\n')}`;
  return { label, content, length: content.length, priority: 1 };
}

function formatModeBlock(mode: string, beliefs: BeliefResult[]): ContextBlock | null {
  if (beliefs.length === 0) return null;
  
  const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
  const lines = beliefs.map(b => `- ${b.content}`);
  
  const content = `## Mode: ${modeLabel}\n${lines.join('\n')}`;
  return { label: `mode:${mode}`, content, length: content.length, priority: 0 };
}

function formatToolBlock(tools: string[]): ContextBlock | null {
  if (tools.length === 0) return null;
  
  const content = `## Recommended tools\n${tools.map(t => `- ${t}`).join('\n')}`;
  return { label: 'tools', content, length: content.length, priority: 2 };
}

// ═══════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════

/**
 * Build context blocks for LLM injection.
 * Called from before_agent_start handler.
 *
 * @param prompt - The user's current prompt text
 * @param options - Budget overrides, system prompt options
 * @returns Array of context blocks, or empty array if nothing to inject
 */
export async function buildContext(prompt: string, options?: ContextOptions): Promise<ContextBlock[]> {
  // Phase 0: Budget check
  const budget = await getBudget(options);
  if (budget.critical) return [];  // No injection if context window is near full
  
  const blocks: ContextBlock[] = [];
  let remaining = budget.available;
  
  // Phase 1: Entity extraction
  const matchedEntities = await extractEntities(prompt);
  
  // Phase 1b: Semantic fallback if no entity match and budget allows
  const usedSemantic = matchedEntities.length === 0 && !budget.warning;
  let semanticResult: { entities: string[]; tools: string[]; embedding: number[] | null } | null = null;
  
  if (usedSemantic) {
    semanticResult = await semanticSearch(prompt, options?.maxAnchors ?? 3);
    if (semanticResult.entities.length > 0) {
      matchedEntities.push(...semanticResult.entities);
    }
  }
  
  // Phase 2: Get entity types for mode deduction
  const entityTypes = await getEntityTypes(matchedEntities);
  
  // Phase 3: Mode deduction
  const mode = deduceMode(prompt, matchedEntities, entityTypes);
  
  // Phase 4: Query mode rules (Tier 2)
  const modeBeliefs = await queryEntityBeliefs(
    mode.entityName,
    10,  // Get all mode beliefs
    0.5  // Only high-confidence mode rules
  );
  
  const modeBlock = formatModeBlock(mode.mode, modeBeliefs);
  if (modeBlock && modeBlock.length <= remaining) {
    blocks.push(modeBlock);
    remaining -= modeBlock.length;
  }
  
  // Phase 5: Query entity knowledge (Tier 3) — budget-gated
  if (remaining > 100) {
    const maxBeliefs = options?.maxBeliefs ?? parseInt(
      await getConfigValue('entity.extraction.max_beliefs', '5'), 10
    );
    const maxAnchors = options?.maxAnchors ?? parseInt(
      await getConfigValue('entity.extraction.max_anchors', '3'), 10
    );
    
    for (const entity of matchedEntities.slice(0, maxAnchors)) {
      if (remaining <= 50) break;
      
      const beliefs = await queryEntityBeliefs(entity, maxBeliefs, 0.3);
      if (beliefs.length === 0) continue;
      
      const block = formatBeliefBlock(entity, beliefs);
      if (block && block.length <= remaining) {
        blocks.push(block);
        remaining -= block.length;
      }
    }
  }
  
  // Phase 6: Semantic tool discovery (only if embed was already called)
  if (semanticResult && semanticResult.tools.length > 0 && remaining > 100) {
    const toolBlock = formatToolBlock(semanticResult.tools);
    if (toolBlock && toolBlock.length <= remaining) {
      blocks.push(toolBlock);
    }
  }
  
  return blocks;
}

/**
 * Build formatted context string from context blocks.
 * Concatenates blocks in priority order (highest first).
 */
export function composeContextString(blocks: ContextBlock[]): string {
  if (blocks.length === 0) return '';
  return '\n\n' + blocks.map(b => b.content).join('\n\n');
}

// ═══════════════════════════════════════════════════════════
// Config reader helper (exported for use by other modules)
// ═══════════════════════════════════════════════════════════

export async function readConfig(key: string, defaultValue: string): Promise<string> {
  return getConfigValue(key, defaultValue);
}