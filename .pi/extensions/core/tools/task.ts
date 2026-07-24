// ============================================================================
// tools/task.ts — Task management tool
// ============================================================================
// Tasks are Entity nodes with tags: ["task"] and a status property.
// Subtasks are linked via dep edges. This tool enforces the schema.
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ilo } from '../lib/ilo-client';

export function registerTaskTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'task',
    label: 'Task',
    description: 'Manage tasks and subtasks. Tasks are stored in the knowledge graph alongside entities — they appear in search results and memory context automatically.',
    parameters: Type.Object({
      action: Type.Enum({
        create: 'create',
        update: 'update',
        list: 'list',
      }, { description: 'Action to perform' }),
      title: Type.Optional(Type.String({ description: 'Task title (required for create)' })),
      status: Type.Optional(Type.Enum({
        pending: 'pending',
        active: 'active',
        completed: 'completed',
        cancelled: 'cancelled',
      }, { description: 'Task status (default: active)' })),
      priority: Type.Optional(Type.Enum({
        low: 'low',
        medium: 'medium',
        high: 'high',
        critical: 'critical',
      }, { description: 'Task priority' })),
      parent: Type.Optional(Type.String({ description: 'Parent task title for subtask hierarchy' })),
      task: Type.Optional(Type.String({ description: 'Existing task title to update (required for update)' })),
    }),
    execute: async (_id, params) => {
      try {
        switch (params.action) {
          case 'create': return await createTask(params);
          case 'update': return await updateTask(params);
          case 'list': return await listTasks();
          default: return { content: [{ type: 'text', text: 'Unknown action. Use create, update, or list.' }], details: {} };
        }
      } catch (err: any) {
        return { content: [{ type: 'text', text: 'Task failed: ' + err.message }], details: {} };
      }
    },
  });
}

async function createTask(params: any) {
  const title = (params.title || '').trim();
  if (!title) return { content: [{ type: 'text', text: 'Task title is required.' }], details: {} };

  const status = params.status || 'active';
  const tags = ['task'];
  const properties: Record<string, any> = { status };

  if (params.priority) properties.priority = params.priority;
  if (params.description) properties.description = params.description;

  // Create task as an entity with task tag and properties
  await ilo.entityUpdate(title, properties, tags);

  // Link to parent via connect
  if (params.parent) {
    await ilo.connect(title, params.parent, 'dep').catch(() => {});
  }

  const parentNote = params.parent ? ' (under ' + params.parent + ')' : '';
  return {
    content: [{ type: 'text', text: 'Created task: ' + title + ' [' + status + ']' + parentNote }],
    details: { title, status, priority: params.priority, parent: params.parent },
  };
}

async function updateTask(params: any) {
  const taskTitle = (params.task || '').trim();
  if (!taskTitle) return { content: [{ type: 'text', text: 'Task title is required.' }], details: {} };

  const properties: Record<string, any> = {};
  if (params.status) properties.status = params.status;
  if (params.priority) properties.priority = params.priority;

  if (Object.keys(properties).length === 0) {
    return { content: [{ type: 'text', text: 'Nothing to update. Specify status or priority.' }], details: {} };
  }

  await ilo.entityUpdate(taskTitle, properties);

  const changes = Object.entries(properties).map(([k, v]) => k + '=' + v).join(', ');
  return {
    content: [{ type: 'text', text: 'Updated ' + taskTitle + ': ' + changes }],
    details: { task: taskTitle, changes: properties },
  };
}

async function listTasks() {
  const taskRes = await ilo.search('tasks', true);
  if (taskRes.ok && taskRes.data?.context) {
    return { content: [{ type: 'text', text: taskRes.data.context }], details: { total: taskRes.data.total } };
  }
  return { content: [{ type: 'text', text: 'No tasks found.' }], details: {} };
}
