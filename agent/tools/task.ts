// ============================================================================
// tools/task.ts — Unified task management tool
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import * as crypto from 'node:crypto';
import { getDb } from '../lib/engine';
import type { ToolDefinition } from '../lib/tool-registry';

// ── Tool definition (for central registry) ───────────────

export const taskToolDef: ToolDefinition = {
  name: 'task',
  label: 'Task',
  description: 'Create, update, list, or complete tasks and projects with definition of done',
  category: 'tracking',
  aliases: 'todo, plan, project, track',
  promptSnippet: 'Track tasks, projects, and plans',
  promptGuidelines: [
    'Use task to create plans, track progress, and manage multi-session work.',
    'Each task has a "criteria" field — the definition of done.',
    'Tasks progress: pending → active → completed or cancelled.',
  ],
  register: registerTaskTool,
};

// ── Registration function ────────────────────────────────

export function registerTaskTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'task',
    label: 'Task',
    description: 'Create, update, list, or complete tasks and projects.',
    promptSnippet: taskToolDef.promptSnippet,
    promptGuidelines: taskToolDef.promptGuidelines,
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('create'),
        Type.Literal('update'),
        Type.Literal('status'),
        Type.Literal('list'),
        Type.Literal('delete'),
      ], { description: 'Action to perform' }),
      title: Type.Optional(Type.String({ description: 'Task title (for create)' })),
      description: Type.Optional(Type.String({ description: 'Task description' })),
      criteria: Type.Optional(Type.String({ description: 'Definition of done' })),
      priority: Type.Optional(Type.Union([
        Type.Literal('low'),
        Type.Literal('medium'),
        Type.Literal('high'),
        Type.Literal('critical'),
      ], { description: 'Priority (default: medium)' })),
      project: Type.Optional(Type.String({ description: 'Project/group label' })),
      parent: Type.Optional(Type.String({ description: 'Parent task ID for subtasks' })),
      goal: Type.Optional(Type.String({ description: 'What outcome this task serves' })),
      task_id: Type.Optional(Type.String({ description: 'Task ID (for update/status/delete)' })),
      updates: Type.Optional(Type.Object({}, { description: 'Fields to update' })),
    }),
    async execute(_toolCallId: string, params: any, _signal?: AbortSignal, onUpdate?: (update: any) => void): Promise<any> {
      const db = getDb();
      const now = new Date().toISOString();

      onUpdate?.({ content: [{ type: 'text', text: `Task: ${params.action}...` }] });

      switch (params.action) {
        case 'create': {
          if (!params.title) return { content: [{ type: 'text', text: 'title is required for create.' }], details: {} };
          const id = crypto.randomUUID();
          await db.addNode('Task', {
            id, title: params.title,
            description: params.description || '',
            criteria: params.criteria || '',
            priority: params.priority || 'medium',
            status: 'pending',
            project: params.project || '',
            parent_id: params.parent || '',
            goal: params.goal || '',
            created_at: now,
            completed_at: null,
          });
          return { content: [{ type: 'text', text: `Created task "${params.title}" (id: ${id.substring(0, 8)}...)` }], details: {} };
        }

        case 'update': {
          if (!params.task_id) return { content: [{ type: 'text', text: 'task_id is required for update.' }], details: {} };
          // Parameterized query — safe from Cypher injection
          const setClause: string[] = [];
          const setParams: any = { id: params.task_id };
          if (params.updates?.status) { setClause.push('status = $status'); setParams.status = params.updates.status; }
          if (params.updates?.priority) { setClause.push('priority = $priority'); setParams.priority = params.updates.priority; }
          if (params.updates?.title) { setClause.push('title = $title'); setParams.title = params.updates.title; }
          if (params.updates?.status === 'completed') { setClause.push('completed_at = $completed_at'); setParams.completed_at = new Date().toISOString(); }
          if (setClause.length === 0) return { content: [{ type: 'text', text: 'No updates provided.' }], details: {} };
          await db.exec(`MATCH (t:Task {id: $id}) SET ${setClause.join(', ')}`, setParams);
          return { content: [{ type: 'text', text: `Updated task ${params.task_id.substring(0, 8)}...` }], details: {} };
        }

        case 'status': {
          if (params.project) {
            const rows = await db.query(
              'MATCH (t:Task) WHERE t.project = $project RETURN t.id AS id, t.title AS title, t.status AS status, t.priority AS priority ORDER BY t.created_at',
              { project: params.project }
            );
            if (!rows?.length) return { content: [{ type: 'text', text: `No tasks found for project "${params.project}".` }], details: {} };
            const lines = rows.map((r: any) => `  [${r.priority}] ${r.title} — ${r.status}`);
            return { content: [{ type: 'text', text: `Project "${params.project}":\n${lines.join('\n')}` }], details: {} };
          }
          if (params.task_id) {
            const rows = await db.query('MATCH (t:Task {id: $id}) RETURN t.title AS title, t.status AS status, t.criteria AS criteria, t.priority AS priority, t.project AS project', { id: params.task_id });
            if (!rows?.length) return { content: [{ type: 'text', text: 'Task not found.' }], details: {} };
            const r = rows[0];
            return { content: [{ type: 'text', text: `Task "${r.title}": ${r.status} (${r.priority})${r.project ? ` | Project: ${r.project}` : ''}${r.criteria ? `\nDone when: ${r.criteria}` : ''}` }], details: {} };
          }
          // List all active
          const all = await db.query("MATCH (t:Task) WHERE t.status IN ['pending', 'active'] RETURN t.id AS id, t.title AS title, t.status AS status, t.priority AS priority, t.project AS project ORDER BY t.created_at DESC LIMIT 20");
          if (!all?.length) return { content: [{ type: 'text', text: 'No active tasks.' }], details: {} };
          const lines = all.map((r: any) => `  [${r.priority}] ${r.title} — ${r.status}${r.project ? ` (${r.project})` : ''}`);
          return { content: [{ type: 'text', text: `${all.length} active task(s):\n${lines.join('\n')}` }], details: {} };
        }

        case 'list': {
          const filter: string[] = [];
          const filterParams: any = {};
          if (params.project) { filter.push('t.project = $project'); filterParams.project = params.project; }
          if (params.status) { filter.push('t.status = $status'); filterParams.status = params.status; }
          const where = filter.length > 0 ? 'WHERE ' + filter.join(' AND ') : '';
          const rows = await db.query(
            `MATCH (t:Task) ${where} RETURN t.title AS title, t.status AS status, t.priority AS priority, t.project AS project, t.id AS id ORDER BY t.created_at DESC LIMIT 20`,
            filterParams
          );
          if (!rows?.length) return { content: [{ type: 'text', text: 'No tasks found.' }], details: {} };
          const lines = rows.map((r: any) => `  [${r.priority}] ${r.title} — ${r.status}${r.project ? ` (${r.project})` : ''} (${r.id.substring(0, 8)}...)`);
          return { content: [{ type: 'text', text: `${rows.length} task(s):\n${lines.join('\n')}` }], details: {} };
        }

        case 'delete': {
          if (!params.task_id) return { content: [{ type: 'text', text: 'task_id is required for delete.' }], details: {} };
          const cancelTs = new Date().toISOString();
          await db.exec("MATCH (t:Task {id: $id}) SET t.status = 'cancelled', t.completed_at = $ts", { id: params.task_id, ts: cancelTs });
          // Cancel subtasks too
          await db.exec("MATCH (t:Task {parent_id: $id}) SET t.status = 'cancelled', t.completed_at = $ts", { id: params.task_id, ts: cancelTs });
          return { content: [{ type: 'text', text: `Cancelled task ${params.task_id.substring(0, 8)}... and its subtasks.` }], details: {} };
        }

        default:
          return { content: [{ type: 'text', text: 'Unknown action. Valid: create, update, status, list, delete.' }], details: {} };
      }
    },
  });
}
