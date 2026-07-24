// ============================================================================
// tools/session-search.ts — Search past sessions, turns, and tool actions
// ============================================================================
// Lets the AI look back at previous conversation history stored in Turn and
// Action nodes. Without this, all that session data is invisible to the agent.
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { getDb } from '../lib/engine';
import type { ToolDefinition } from '../lib/tool-registry';

// ── Tool definition ──────────────────────────────────────

export const sessionSearchToolDef: ToolDefinition = {
  name: 'session_search',
  label: 'Session Search',
  description: 'Search past sessions, conversation turns, and tool actions by keyword or tool name',
  category: 'retrieval',
  aliases: 'history, past, previous, turn, action, session',
  promptSnippet: 'Search past session history by keyword or tool name',
  promptGuidelines: [
    'Use session_search when you need to recall what happened in a previous conversation turn.',
    'Searches both user text and assistant responses across all stored sessions.',
    'Can filter by tool_name to find specific tool calls (e.g. "store", "search", "scrape").',
    'Faster than grepping raw JSONL session files — queries the LadybugDB directly.',
  ],
  register: registerSessionSearchTool,
};

// ── Registration function ────────────────────────────────

export function registerSessionSearchTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'session_search',
    label: 'Session Search',
    description: 'Search past conversation turns, sessions, and tool actions stored in the knowledge base.',
    promptSnippet: sessionSearchToolDef.promptSnippet,
    promptGuidelines: sessionSearchToolDef.promptGuidelines,
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: 'Text to search for in user text, responses, or tool results' })),
      tool_name: Type.Optional(Type.String({ description: 'Filter by tool name (e.g. "store", "search", "scrape", "bash")' })),
      limit: Type.Optional(Type.Number({ description: 'Max results per section (default 5)' })),
      session_id: Type.Optional(Type.String({ description: 'Narrow to a specific session ID' })),
      entity: Type.Optional(Type.String({ description: 'Show turns/actions related to a specific entity name' })),
    }),
    async execute(_toolCallId: string, params: any, _signal?: AbortSignal): Promise<any> {
      const query = (params.query || '').trim();
      const toolName = (params.tool_name || '').trim().toLowerCase();
      const limit = Math.min(params.limit || 5, 20);
      const sessionId = (params.session_id || '').trim();
      const entity = (params.entity || '').trim().toLowerCase();

      if (!query && !toolName && !entity) {
        // Show recent sessions instead
        return await showRecentSessions(limit);
      }

      const db = getDb();
      const lines: string[] = [];

      // ── Search Turns ────────────────────────────────
      if (query || entity) {
        try {
          let turns: any[] = [];
          if (entity && query) {
            turns = await db.query(
              `MATCH (t:Turn)
               WHERE (t.user_text CONTAINS $q OR t.response_text CONTAINS $q)
               RETURN t.id AS id, t.session_id AS sid, t.turn_index AS idx,
                      t.user_text AS user, t.response_text AS asst, t.timestamp AS ts
               ORDER BY t.timestamp DESC LIMIT $lim`,
              { q: query, lim: limit }
            );
          } else if (query) {
            turns = await db.query(
              `MATCH (t:Turn)
               WHERE t.user_text CONTAINS $q OR t.response_text CONTAINS $q
               RETURN t.id AS id, t.session_id AS sid, t.turn_index AS idx,
                      t.user_text AS user, t.response_text AS asst, t.timestamp AS ts
               ORDER BY t.timestamp DESC LIMIT $lim`,
              { q: query, lim: limit }
            );
          }

          if (turns.length > 0) {
            lines.push(`[session_search]  "${query}"  →  ${turns.length} turn(s)`);
            for (const t of turns) {
              const sessTag = t.sid ? t.sid.substring(0, 8) : '?';
              const userSnippet = (t.user || '').substring(0, 100).replace(/\n/g, ' ');
              const asstSnippet = (t.asst || '').substring(0, 120).replace(/\n/g, ' ');
              const ts = (t.ts || '').substring(0, 19).replace('T', ' ');
              lines.push(`             turn ${t.idx}  ·  ${ts}  ·  session:${sessTag}`);
              if (userSnippet) lines.push(`             user: ${userSnippet}`);
              if (asstSnippet) lines.push(`             asst: ${asstSnippet}`);
              lines.push('');
            }
          }
        } catch (e: any) {
          lines.push(`[session_search]  error querying turns  ·  ${e.message.substring(0, 80)}`);
        }
      }

      // ── Search Actions (tool calls) ────────────────
      if (toolName || query) {
        try {
          let actions: any[] = [];
          if (toolName && query) {
            actions = await db.query(
              `MATCH (a:Action)
               WHERE a.tool_name = $tool AND (a.args CONTAINS $q OR a.result CONTAINS $q)
               RETURN a.id AS id, a.session_id AS sid, a.tool_name AS tool,
                      a.args AS args, a.result AS result, a.status AS status, a.timestamp AS ts
               ORDER BY a.timestamp DESC LIMIT $lim`,
              { tool: toolName, q: query, lim: limit }
            );
          } else if (toolName) {
            actions = await db.query(
              `MATCH (a:Action)
               WHERE a.tool_name = $tool
               RETURN a.id AS id, a.session_id AS sid, a.tool_name AS tool,
                      a.args AS args, a.result AS result, a.status AS status, a.timestamp AS ts
               ORDER BY a.timestamp DESC LIMIT $lim`,
              { tool: toolName, lim: limit }
            );
          } else if (query) {
            actions = await db.query(
              `MATCH (a:Action)
               WHERE a.args CONTAINS $q OR a.result CONTAINS $q
               RETURN a.id AS id, a.session_id AS sid, a.tool_name AS tool,
                      a.args AS args, a.result AS result, a.status AS status, a.timestamp AS ts
               ORDER BY a.timestamp DESC LIMIT $lim`,
              { q: query, lim: limit }
            );
          }

          if (actions.length > 0) {
            const toolLabel = toolName || 'any tool';
            lines.push(`[session_search]  ${toolLabel} actions for "${query || '*'}"  →  ${actions.length} result(s)`);
            for (const a of actions) {
              const statusIcon = a.status === 'success' ? '✓' : a.status === 'error' ? '✗' : '·';
              const argsSnippet = (a.args || '').substring(0, 100).replace(/\n/g, ' ');
              const resultSnippet = (a.result || '').substring(0, 100).replace(/\n/g, ' ');
              const ts = (a.ts || '').substring(0, 19).replace('T', ' ');
              lines.push(`             ${statusIcon} [${a.tool}]  ${ts}`);
              if (argsSnippet) lines.push(`             args: ${argsSnippet}`);
              if (resultSnippet) lines.push(`             result: ${resultSnippet}`);
              lines.push('');
            }
          }
        } catch (e: any) {
          lines.push(`[session_search]  error querying actions  ·  ${e.message.substring(0, 80)}`);
        }
      }

      if (lines.length === 0) {
        const desc = query ? `"${query}"` : toolName ? `tool:${toolName}` : '';
        return { content: [{ type: 'text', text: `[session_search]  ${desc}  →  0 results` }], details: {} };
      }

      return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
    },
  });
}

// ═══════════════════════════════════════════════════════════
// Helper: show recent sessions when no query is given
// ═══════════════════════════════════════════════════════════

async function showRecentSessions(limit: number): Promise<any> {
  const db = getDb();
  try {
    const sessions = await db.query(
      `MATCH (s:Session)
       RETURN s.id AS id, s.display_name AS name, s.turn_count AS turns,
              s.model AS model, s.created_at AS created
       ORDER BY s.created_at DESC LIMIT $lim`,
      { lim: limit }
    );
    if (!sessions || sessions.length === 0) {
      return { content: [{ type: 'text', text: '[session_search]  no sessions found' }], details: {} };
    }
    const lines = sessions.map((s: any, i: number) => {
      const createdAt = (s.created || '').substring(0, 19).replace('T', ' ');
      return `             ${i + 1}  ${s.name || s.id?.substring(0, 12)}  ·  ${s.turns || 0} turns  ·  ${s.model || '?'}  ·  ${createdAt}`;
    });
    return {
      content: [{ type: 'text', text: `[session_search]  ${sessions.length} recent session(s)\n${lines.join('\n')}\n\n             Use session_search with a query or tool_name to search within sessions.` }],
      details: {},
    };
  } catch (e: any) {
    return { content: [{ type: 'text', text: `[session_search]  error  ·  ${e.message.substring(0, 80)}` }], details: {} };
  }
}