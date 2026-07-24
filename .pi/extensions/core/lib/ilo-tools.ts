// ============================================================================
// lib/ilo-tools.ts — LLM-invokable tools for ILO
// ============================================================================
// These tools let the LLM interact with the ILO knowledge graph during
// generation: look up entities, store facts, link concepts, etc.
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { ilo } from './ilo-client';

const asyncExec = promisify(exec);
const GIT_TIMEOUT = 10000;

// Helper to create error responses with type-safe details
function toolError(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], details: {} as any };
}

export function registerIloTools(api: ExtensionAPI): void {
  // ── search: Search memory ───────────────────────────
  api.registerTool({
    name: 'search',
    label: 'Search',
    description: 'Search memory for entities by query, tag, or type. Returns a context block with matching entities and their relationships.',
    parameters: Type.Object({
      query: Type.String({ description: 'What to search for — describe what you need in natural language' }),
      list: Type.Optional(Type.Boolean({ description: 'Set to true for a flat list of matches without showing relationships. Use when you want a catalogue ("list all tasks"). Default: false (shows connections between entities).' })),
      tag: Type.Optional(Type.String({ description: 'Filter by tag — narrow results to a specific category like "project", "task", or "person"' })),
    }),
    execute: async (_id, params) => {
      const res = await ilo.search(params.query, params.list, params.tag);
      if (!res.ok) return { content: [{ type: 'text', text: `Search failed: ${res.error}` }], details: {} as any };
      if (!res.data?.context) return { content: [{ type: 'text', text: 'No results found.' }], details: {} as any };
      return { content: [{ type: 'text', text: res.data.context }], details: { total: res.data.total } };
    },
  });

  // ── store: Store a belief about an entity ──────────
  api.registerTool({
    name: 'store',
    label: 'Store',
    description: 'Store a belief or fact in persistent long-term memory.',
    parameters: Type.Object({
      content: Type.String({ description: 'The belief text' }),
      entity: Type.Optional(Type.String({ description: 'What this belief is about' })),
      confidence: Type.Optional(Type.Number({ description: '0.0 to 1.0 (default 0.5)' })),
    }),
    execute: async (_id, params) => {
      const content = (params.content || '').trim();
      if (!content) return { content: [{ type: 'text', text: 'No content provided.' }], details: {} as any };
      const entity = params.entity || 'general';
      const conf = params.confidence ?? 0.5;

      await ilo.remember({
        query: '',
        response: content,
        entities: [{ label: entity, confidence: conf, tags: [] }],
        claims: [{ content, confidence: conf, provenance: 'user_confirmed', entities: [entity] }],
        turnIndex: Date.now(),
      });

      return { content: [{ type: 'text', text: `Stored belief about ${entity}.` }], details: { entity, confidence: conf } };
    },
  });

  // ── ingest: Ingest external content ─────────────────
  api.registerTool({
    name: 'ingest',
    label: 'Ingest',
    description: 'Save external content (web articles, files, notes) into memory as entities and claims. The content is extracted and linked to the knowledge graph without creating a conversation turn.',
    parameters: Type.Object({
      content: Type.String({ description: 'The full text content to ingest' }),
      source: Type.String({ description: 'A label identifying the source (URL, filename, or description)' }),
      tags: Type.Optional(Type.Array(Type.String(), { description: 'Optional tags for categorization' })),
    }),
    execute: async (_id, params) => {
      const res = await ilo.ingest(params.content, params.source, params.tags);
      if (!res.ok) return { content: [{ type: 'text', text: `Ingest failed: ${res.error}` }], details: {} as any };
      return {
        content: [{ type: 'text', text: `Ingested ${res.data?.entities_created || 0} entities and ${res.data?.claims_created || 0} claims from ${params.source}.` }],
        details: res.data || {},
      };
    },
  });

  // ── connect: Link two entities ─────────────────────
  api.registerTool({
    name: 'connect',
    label: 'Connect',
    description: 'Link two entities in the knowledge graph.',
    parameters: Type.Object({
      from: Type.String({ description: 'Source entity' }),
      to: Type.String({ description: 'Target entity' }),
      link_type: Type.Optional(Type.String({ description: 'Link type: ref, dep, con, evidence' })),
    }),
    execute: async (_id, params) => {
      const res = await ilo.connect(params.from, params.to, params.link_type || 'ref');
      return { content: [{ type: 'text', text: `Linked ${params.from} → ${params.to}.` }], details: res.data || {} };
    },
  });

  // ── forget: Deprecate a stored belief ──────────────
  api.registerTool({
    name: 'forget',
    label: 'Forget',
    description: 'Deprecate or remove a stored belief.',
    parameters: Type.Object({
      content: Type.String({ description: 'The belief text to deprecate' }),
      entity: Type.Optional(Type.String({ description: 'Entity the belief is about' })),
    }),
    execute: async (_id, params) => {
      const entity = params.entity || 'general';
      await ilo.entityUpdate(entity, { forgotten: true });
      return { content: [{ type: 'text', text: `Deprecated belief about ${entity}.` }], details: { entity } };
    },
  });

  // ── project_tree: Live directory structure ──────────
  api.registerTool({
    name: 'project_tree',
    label: 'Project Tree',
    description: 'Show the current project directory tree. Filters out build artifacts and dependencies.',
    parameters: Type.Object({
      depth: Type.Optional(Type.Number({ description: 'Max directory depth (default 3)' })),
    }),
    execute: async (_id, params) => {
      const depth = params.depth ?? 3;
      try {
        const root = process.cwd();
        const { stdout } = await asyncExec(
          `find . -maxdepth ${depth} -not -path '*/target/*' -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/rust-projects/*' | sort`,
          { cwd: root, timeout: 5000 }
        );
        return { content: [{ type: 'text', text: stdout }], details: { depth } };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Failed to get tree: ${err.message}` }], details: {} as any };
      }
    },
  });

  // ── git_snapshot: Current git state ─────────────────
  api.registerTool({
    name: 'git_snapshot',
    label: 'Git Snapshot',
    description: 'Show current git branch, status, and recent commits.',
    parameters: Type.Object({}),
    execute: async (_id, _params) => {
      try {
        const root = process.cwd();
        const [branchRes, statusRes, logRes] = await Promise.all([
          asyncExec('git branch --show-current 2>/dev/null || echo "(no branch)"', { cwd: root, timeout: 5000 }),
          asyncExec('git status --short 2>/dev/null || echo "(not a git repo)"', { cwd: root, timeout: 5000 }),
          asyncExec('git log --oneline -5 2>/dev/null || echo "(no commits)"', { cwd: root, timeout: 5000 }),
        ]);
        const branch = branchRes.stdout.trim();
        const status = statusRes.stdout.trim();
        const log = logRes.stdout.trim();

        const lines = [
          `Branch: ${branch}`,
          '',
          '── Status ──',
          status || '(clean)',
          '',
          '── Recent Commits ──',
          log,
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }], details: { branch } };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Git error: ${err.message}` }], details: {} as any };
      }
    },
  });

  // ── git_commit: Stage + commit with auto message ────
  api.registerTool({
    name: 'git_commit',
    label: 'Git Commit',
    description: 'Stage all changes and commit with a generated message.',
    parameters: Type.Object({
      message: Type.Optional(Type.String({ description: 'Optional override message. If omitted, generated from diff.' })),
    }),
    execute: async (_id, params) => {
      try {
        const root = process.cwd();

        // Stage all
        await asyncExec('git add -A', { cwd: root, timeout: GIT_TIMEOUT });

        // Check if anything to commit
        const { stdout: hasChanges } = await asyncExec('git diff --cached --stat 2>/dev/null', { cwd: root, timeout: 5000 });
        if (!hasChanges.trim()) {
          return { content: [{ type: 'text', text: 'Nothing to commit — working tree clean.' }], details: {} as any };
        }

        // Generate message from diff if not provided
        let message = params.message;
        let fileCount = 0;
        if (!message) {
          const { stdout: diff } = await asyncExec('git diff --cached --no-color | head -100', { cwd: root, timeout: 5000 });
          const files = hasChanges.split('\n').map(l => l.trim()).filter(Boolean);
          const firstFile = files[0]?.split('|')[0]?.trim() || '';
          fileCount = files.length;
          message = `update: ${fileCount} file${fileCount > 1 ? 's' : ''} changed (${firstFile}${fileCount > 1 ? ', ...' : ''})`;
        }

        // Commit
        await asyncExec(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: root, timeout: GIT_TIMEOUT });
        const { stdout: sha } = await asyncExec('git rev-parse --short HEAD', { cwd: root, timeout: 5000 });

        return {
          content: [{ type: 'text', text: `Committed ${sha}: ${message}` }],
          details: { sha, message, files: fileCount } as any,
        };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Commit failed: ${err.message}` }], details: {} as any };
      }
    },
  });
}
