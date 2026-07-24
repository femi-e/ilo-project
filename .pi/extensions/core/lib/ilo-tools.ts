// ============================================================================
// lib/ilo-tools.ts — LLM-invokable tools for ILO
// ============================================================================
// These tools let the LLM interact with the ILO knowledge graph during
// generation: look up entities, store facts, link concepts, etc.
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { execSync } from 'node:child_process';
import { ilo } from './ilo-client';

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
      if (!res.ok) return { content: [{ type: 'text', text: `Search failed: ${res.error}` }], details: {} };
      if (!res.data?.context) return { content: [{ type: 'text', text: 'No results found.' }], details: {} };
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
      if (!content) return { content: [{ type: 'text', text: 'No content provided.' }], details: {} };
      const entity = params.entity || 'general';
      const conf = params.confidence ?? 0.5;

      await ilo.remember({
        query: '',
        response: content,
        entities: [{ label: entity, confidence: conf, tags: [] }],
        claims: [{ content, confidence: conf, provenance: 'user_confirmed', entities: [entity] }],
        sessionId: 'tool_store',
        turnIndex: Date.now(),
      });

      return { content: [{ type: 'text', text: `Stored belief about ${entity}.` }], details: { entity, confidence: conf } };
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
        const tree = execSync(`find . -maxdepth ${depth} -not -path '*/target/*' -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/rust-projects/*' | sort`, {
          cwd: root,
          encoding: 'utf-8',
          timeout: 5000,
        });
        return { content: [{ type: 'text', text: tree }], details: { depth } };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Failed to get tree: ${err.message}` }], details: {} };
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
        const opts = { cwd: root, encoding: 'utf-8' as const, timeout: 5000 };
        const branch = execSync('git branch --show-current 2>/dev/null || echo "(no branch)"', opts).trim();
        const status = execSync('git status --short 2>/dev/null || echo "(not a git repo)"', opts).trim();
        const log = execSync('git log --oneline -5 2>/dev/null || echo "(no commits)"', opts).trim();

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
        return { content: [{ type: 'text', text: `Git error: ${err.message}` }], details: {} };
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
        const opts = { cwd: root, encoding: 'utf-8' as const, timeout: 10000 };

        // Stage all
        execSync('git add -A', opts);

        // Check if anything to commit
        const hasChanges = execSync('git diff --cached --stat 2>/dev/null', opts).trim();
        if (!hasChanges) {
          return { content: [{ type: 'text', text: 'Nothing to commit — working tree clean.' }], details: {} };
        }

        // Generate message from diff if not provided
        let message = params.message;
        if (!message) {
          const diff = execSync('git diff --cached --no-color | head -100', opts);
          const files = hasChanges.split('\n').map(l => l.trim()).filter(Boolean);
          const firstFile = files[0]?.split('|')[0]?.trim() || '';
          const fileCount = files.length;
          message = `update: ${fileCount} file${fileCount > 1 ? 's' : ''} changed (${firstFile}${fileCount > 1 ? ', ...' : ''})`;
        }

        // Commit
        execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, opts);
        const sha = execSync('git rev-parse --short HEAD', opts).trim();

        return {
          content: [{ type: 'text', text: `Committed ${sha}: ${message}` }],
          details: { sha, message, files: fileCount },
        };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Commit failed: ${err.message}` }], details: {} };
      }
    },
  });
}
