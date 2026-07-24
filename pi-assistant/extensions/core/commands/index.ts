// ============================================================================
// commands/index.ts — Slash commands for user-initiated actions
// ============================================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { getDb, hasEngine } from "../lib/engine";
import { getStatus } from "../lib/embedding";
import { ingestFile } from "../tools/ingest";
import { searchWeb } from "../lib/web-lib";
import {
  runDiagnostics,
  formatDiagReport,
  pingDb,
  quickHealth,
} from "../lib/diagnostics";
import {
  restart as restartEmbedding,
  isGpuEnabled,
} from "../lib/embedding";
import { readConfig } from "../lib/context";
import { SCRATCHPAD_PATH } from "../lib/constants";
import { syncCourses } from "../lib/canvas";

// ═══════════════════════════════════════════════════════════
// Scratchpad helpers
// ═══════════════════════════════════════════════════════════

interface ScratchNote {
  id: string;
  content: string;
  created_at: string;
}

function loadScratchpad(): ScratchNote[] {
  try {
    const dir = path.dirname(SCRATCHPAD_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(SCRATCHPAD_PATH)) return [];
    return JSON.parse(fs.readFileSync(SCRATCHPAD_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function saveScratchpad(notes: ScratchNote[]): void {
  const dir = path.dirname(SCRATCHPAD_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Atomic write via tmp file
  const tmp = SCRATCHPAD_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(notes, null, 2), "utf-8");
  fs.renameSync(tmp, SCRATCHPAD_PATH);
}

function formatNotesList(notes: ScratchNote[]): string {
  if (notes.length === 0) return "No scratchpad notes.";
  return notes
    .map(
      (n, i) =>
        `  ${i + 1}. [${n.id.substring(0, 8)}] ${n.content.substring(0, 120)}`,
    )
    .join("\n");
}

// ═══════════════════════════════════════════════════════════
// Register all commands
// ═══════════════════════════════════════════════════════════

export function registerCommands(pi: ExtensionAPI): void {
  // ── /focus — Set/clear operation mode ─────────────────
  pi.registerCommand("focus", {
    description:
      "Set or clear the current operation mode. Usage: /focus <mode> | /focus auto | /focus",
    handler: async (args: string, ctx: any) => {
      if (!hasEngine()) {
        ctx.ui.notify("Database not available.", "error");
        return;
      }
      const db = getDb();
      const mode = (args || "").trim().toLowerCase();

      if (!mode) {
        const rows = await db.query(
          "MATCH (c:Config {key: 'mode.override'}) RETURN c.value AS value ORDER BY c.version DESC LIMIT 1",
        );
        const current = rows.length > 0 ? rows[0].value : "auto (no override)";
        ctx.ui.notify(`Current mode: ${current || "auto"}`, "info");
        return;
      }

      if (mode === "auto" || mode === "off") {
        await db.exec("MATCH (c:Config {key: 'mode.override'}) DELETE c");
        ctx.ui.notify(
          "Mode override cleared. Back to automatic detection.",
          "info",
        );
        return;
      }

      // Upsert mode override
      await db.addNode("Config", {
        id: crypto.randomUUID(),
        key: "mode.override",
        value: mode,
        version: Date.now(),
        scope: "core",
        mutable: "flexible",
        updated_at: new Date().toISOString(),
      });
      ctx.ui.notify(`Focus set to: ${mode}`, "success");
    },
  });

  // ── /status — System health check ─────────────────────
  pi.registerCommand("status", {
    description: "Show system status: DB, embedding, focus, tasks, scratchpad.",
    handler: async (_args: string, ctx: any) => {
      const parts: string[] = [];

      // DB status
      if (!hasEngine()) {
        parts.push("DB: disconnected");
      } else {
        const db = getDb();

        // Embedding
        const embedStatus = getStatus();
        parts.push(`Embedding: ${embedStatus}`);

        // Quick health
        try {
          const health = await quickHealth();
          parts.push(health);
        } catch {
          parts.push("DB: connected");
        }

        // Mode
        const configRows = await db.query(
          "MATCH (c:Config {key: 'mode.override'}) RETURN c.value AS value ORDER BY c.version DESC LIMIT 1",
        );
        const mode = configRows.length > 0 ? configRows[0].value : "auto";
        parts.push(`Focus: ${mode}`);

        // Tasks
        const taskRows = await db.query(
          "MATCH (t:Task) WHERE t.status IN ['pending', 'active'] RETURN count(*) AS cnt",
        );
        const taskCount = taskRows.length > 0 ? taskRows[0].cnt : 0;
        parts.push(`Active tasks: ${taskCount}`);

        // Scratchpad
        const scratchNotes = loadScratchpad();
        parts.push(`Scratch notes: ${scratchNotes.length}`);
      }

      ctx.ui.notify(parts.join(" | "), "info");
    },
  });

  // ── /forget — Find and deprecate beliefs ──────────────
  pi.registerCommand("forget", {
    description:
      "Find beliefs about a topic and let you deprecate them. Usage: /forget <topic>",
    handler: async (args: string, ctx: any) => {
      if (!hasEngine()) {
        ctx.ui.notify("Database not available.", "error");
        return;
      }
      const topic = args.trim();
      if (!topic) {
        ctx.ui.notify("Provide a topic to forget.", "warn");
        return;
      }

      const db = getDb();
      const rows = await db.query(
        "MATCH (b:Belief) WHERE b.content CONTAINS $q AND b.confidence > 0.2 RETURN b.id AS id, b.content AS content, b.confidence AS conf LIMIT 10",
        { q: topic },
      );

      if (!rows || rows.length === 0) {
        ctx.ui.notify(`No beliefs found about "${topic}".`, "info");
        return;
      }

      const list = rows
        .map(
          (r: any, i: number) =>
            `${i + 1}. [${r.conf.toFixed(2)}] ${(r.content || "").substring(0, 80)}... (${r.id.substring(0, 8)})`,
        )
        .join("\n");

      ctx.ui.notify(
        `Found ${rows.length} beliefs about "${topic}":\n${list}\n\nUse "forget {id}" with a belief ID to deprecate it.`,
        "info",
      );
    },
  });

  // ── /plan — Create or manage task plans ───────────────
  pi.registerCommand("plan", {
    description:
      "Create, list, or manage task plans. Usage: /plan <goal> | /plan list | /plan edit <id> <field> <value> | /plan complete <id>",
    handler: async (args: string, ctx: any) => {
      if (!hasEngine()) {
        ctx.ui.notify("Database not available.", "error");
        return;
      }
      const db = getDb();
      const input = args.trim();

      if (!input) {
        // List active plans
        const rows = await db.query(
          "MATCH (t:Task) WHERE t.status IN ['pending', 'active'] AND (t.parent_id IS NULL OR t.parent_id = '') RETURN t.title AS title, t.status AS status, t.id AS id ORDER BY t.created_at DESC LIMIT 10",
        );
        if (!rows?.length) {
          ctx.ui.notify(
            "No active plans. Use /plan <goal> to create one.",
            "info",
          );
          return;
        }
        const lines = rows.map(
          (r: any) => `  [${r.id.substring(0, 8)}] ${r.title} — ${r.status}`,
        );
        ctx.ui.notify(`Active plans:\n${lines.join("\n")}`, "info");
        return;
      }

      // Parse subcommands
      const parts = input.split(/\s+/);
      const cmd = parts[0].toLowerCase();

      if (cmd === "list") {
        const rows = await db.query(
          "MATCH (t:Task) WHERE t.status IN ['pending', 'active'] RETURN t.title AS title, t.status AS status, t.priority AS priority, t.project AS project, t.id AS id ORDER BY t.created_at DESC LIMIT 20",
        );
        if (!rows?.length) {
          ctx.ui.notify("No active tasks.", "info");
          return;
        }
        const lines = rows.map(
          (r: any) =>
            `  [${r.priority}] ${r.title} — ${r.status}${r.project ? ` (${r.project})` : ""}`,
        );
        ctx.ui.notify(`${rows.length} task(s):\n${lines.join("\n")}`, "info");
        return;
      }

      if (cmd === "edit" && parts.length >= 4) {
        const taskId = parts[1];
        const field = parts[2];
        const value = parts.slice(3).join(" ");
        try {
          await db.exec(
            `MATCH (t:Task {id: $id}) SET t.\`${field}\` = $value`,
            { id: taskId, value },
          );
          ctx.ui.notify(
            `Updated task ${taskId.substring(0, 8)}: ${field} = "${value.substring(0, 50)}"`,
            "success",
          );
        } catch (e: any) {
          ctx.ui.notify(`Update failed: ${e.message}`, "error");
        }
        return;
      }

      if (cmd === "complete") {
        const taskId = parts[1];
        if (!taskId) {
          ctx.ui.notify("Provide a task ID.", "warn");
          return;
        }
        await db.exec(
          "MATCH (t:Task {id: $id}) SET t.status = 'completed', t.completed_at = $ts",
          { id: taskId, ts: new Date().toISOString() },
        );
        ctx.ui.notify(`Completed task ${taskId.substring(0, 8)}.`, "success");
        return;
      }

      // Default: create a plan task
      const id = crypto.randomUUID();
      await db.addNode("Task", {
        id,
        title: input,
        description: "",
        criteria: "",
        priority: "medium",
        status: "pending",
        project: "",
        parent_id: "",
        goal: "",
        created_at: new Date().toISOString(),
        completed_at: "",
      });
      ctx.ui.notify(
        `Created plan: "${input}" (id: ${id.substring(0, 8)}...)`,
        "success",
      );
    },
  });

  // ── /learn — Auto-discover and ingest content ────────
  pi.registerCommand("learn", {
    description:
      "Scan and ingest new/modified content. Usage: /learn | /learn course | /learn notes | /learn cv",
    handler: async (args: string, ctx: any) => {
      if (!hasEngine()) {
        ctx.ui.notify("Database not available.", "error");
        return;
      }

      const target = args.trim().toLowerCase();

      // Known content directories: path → kind
      const knownDirs: Record<
        string,
        { dir: string; kind: string; label: string }
      > = {
        course: { dir: "course", kind: "raw_course", label: "Course files" },
        notes: { dir: "notes", kind: "personal_note", label: "Personal notes" },
        cv: { dir: "cv", kind: "cv_document", label: "CV documents" },
      };

      const dirsToScan = target
        ? knownDirs[target]
          ? [target]
          : []
        : Object.keys(knownDirs);
      if (dirsToScan.length === 0) {
        ctx.ui.notify(
          `Unknown target "${target}". Try: course, notes, cv`,
          "warn",
        );
        return;
      }

      let totalNew = 0;
      let totalChunks = 0;
      const reports: string[] = [];

      for (const key of dirsToScan) {
        const config = knownDirs[key];
        if (!fs.existsSync(config.dir)) {
          reports.push(`${config.label}: directory not found`);
          continue;
        }

        const files = walkDirSync(config.dir);
        if (files.length === 0) {
          reports.push(`${config.label}: 0 files found`);
          continue;
        }

        let dirNew = 0;
        let dirChunks = 0;

        for (const file of files) {
          try {
            const result = await ingestFile(file, config.kind);
            if (result.ingested) {
              dirNew++;
              dirChunks += result.chunks;
            }
          } catch (e: any) {
            console.warn(`[learn] Failed to ingest ${file}: ${e.message}`);
          }
        }

        totalNew += dirNew;
        totalChunks += dirChunks;
        reports.push(`${config.label}: ${dirNew} new, ${dirChunks} chunks`);
      }

      ctx.ui.notify(
        `Learn complete:\n${reports.join("\n")}`,
        totalNew > 0 ? "success" : "info",
      );
    },
  });

  // ── /tutor — Socratic tutor commands ─────────────────
  pi.registerCommand("tutor", {
    description:
      "Tutor commands: explain, assignment, track, status. Usage: /tutor <subcommand> [args]",
    handler: async (args: string, ctx: any) => {
      if (!hasEngine()) {
        ctx.ui.notify("Database not available.", "error");
        return;
      }
      const db = getDb();
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || "").toLowerCase();

      if (!sub) {
        ctx.ui.notify(
          "Usage: /tutor explain <topic> | /tutor assignment <N> | /tutor track <topic> [note] | /tutor status",
          "info",
        );
        return;
      }

      if (sub === "explain") {
        const topic = parts.slice(1).join(" ");
        if (!topic) {
          ctx.ui.notify("What topic do you want to explore?", "info");
          return;
        }
        // Set focus to tutoring mode and inject topic context
        await db.exec("MATCH (c:Config {key: 'mode.override'}) DELETE c");
        await db.addNode("Config", {
          id: crypto.randomUUID(),
          key: "mode.override",
          value: "tutoring",
          version: Date.now(),
          scope: "core",
          mutable: "flexible",
          updated_at: new Date().toISOString(),
        });
        ctx.ui.notify(
          `Tutor mode set. Let's explore "${topic}" together — what do you already know about it?`,
          "info",
        );
        return;
      }

      if (sub === "assignment") {
        const num = parts[1];
        if (!num) {
          ctx.ui.notify(
            "Which assignment number? Usage: /tutor assignment 3",
            "info",
          );
          return;
        }
        // Find assignment file in course/assignments/
        const assignDir = "course/assignments";
        if (!fs.existsSync(assignDir)) {
          ctx.ui.notify("No assignments directory found.", "warn");
          return;
        }
        const files = walkDirSync(assignDir).filter((f) =>
          path.basename(f).toLowerCase().includes(`activity ${num}`),
        );
        if (files.length === 0) {
          ctx.ui.notify(`No assignment ${num} found.`, "warn");
          return;
        }
        // Ingest it if not already
        const result = await ingestFile(files[0]);
        if (result.ingested) {
          ctx.ui.notify(
            `Found and ingested assignment ${num}. Let me know what part you want to work through.`,
            "success",
          );
        } else {
          ctx.ui.notify(
            `Found assignment ${num}. What section are you working on?`,
            "info",
          );
        }
        return;
      }

      if (sub === "track") {
        const topic = parts.slice(1).join(" ");
        if (!topic) {
          ctx.ui.notify(
            "What do you want to track? Usage: /tutor track pandas merge — I was confused about how=left",
            "info",
          );
          return;
        }
        // Store as a user-identified gap
        await db.addNode("Belief", {
          id: crypto.randomUUID(),
          content: `User identified gap: ${topic}`,
          confidence: 0.7,
          entity: "learner:gap",
          provenance: "user.identified",
          last_referenced: new Date().toISOString(),
          created_at: new Date().toISOString(),
        });
        ctx.ui.notify(
          `Noted: "${topic}". I'll keep this in mind for future sessions.`,
          "success",
        );
        return;
      }

      if (sub === "status") {
        const gapRows = await db.query(
          "MATCH (b:Belief {entity: 'learner:gap'}) WHERE b.confidence > 0.3 RETURN b.content AS content, b.created_at AS created ORDER BY b.created_at DESC LIMIT 10",
        );
        const topicRows = await db.query(
          "MATCH (b:Belief {entity: 'learner:voice'}) RETURN b.content AS content, b.confidence AS conf ORDER BY b.confidence DESC LIMIT 5",
        );
        const parts_list: string[] = ["## Tutor Status"];
        if (gapRows?.length > 0) {
          parts_list.push("Gaps identified:");
          for (const r of gapRows)
            parts_list.push(`  - ${(r.content || "").substring(0, 100)}`);
        } else {
          parts_list.push("No gaps tracked yet.");
        }
        if (topicRows?.length > 0) {
          parts_list.push("Voice observations:");
          for (const r of topicRows)
            parts_list.push(`  - ${(r.content || "").substring(0, 100)}`);
        }
        ctx.ui.notify(parts_list.join("\n"), "info");
        return;
      }

      ctx.ui.notify(
        `Unknown subcommand "${sub}". Try: explain, assignment, track, status`,
        "warn",
      );
    },
  });

  // ── /jobs — Job-hunting commands ─────────────────────
  pi.registerCommand("jobs", {
    description:
      "Job commands: cv, cover-letter, find-roles, status. Usage: /jobs <subcommand> [args]",
    handler: async (args: string, ctx: any) => {
      if (!hasEngine()) {
        ctx.ui.notify("Database not available.", "error");
        return;
      }
      const db = getDb();
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || "").toLowerCase();

      if (!sub) {
        ctx.ui.notify(
          "Usage: /jobs cv | /jobs cover-letter <job> | /jobs find-roles | /jobs status",
          "info",
        );
        return;
      }

      if (sub === "cv") {
        // Check if CV already exists
        const existing = await db.query(
          "MATCH (e:Entity {kind: 'cv_document'}) RETURN e.name AS name LIMIT 5",
        );
        if (existing.length > 0) {
          ctx.ui.notify(
            `I already have your CV (${existing.length} section(s)). Use /jobs cv build to start fresh or /jobs status to see current state.`,
            "info",
          );
          return;
        }
        // Set mode to job-hunt for guided Q&A
        await db.exec("MATCH (c:Config {key: 'mode.override'}) DELETE c");
        await db.addNode("Config", {
          id: crypto.randomUUID(),
          key: "mode.override",
          value: "job-hunt",
          version: Date.now(),
          scope: "core",
          mutable: "flexible",
          updated_at: new Date().toISOString(),
        });
        ctx.ui.notify(
          "CV builder started. Let us build your CV section by section.\n\nFirst: your professional summary. In one or two sentences, how would you describe yourself as a data analyst?",
          "info",
        );
        return;
      }

      if (sub === "cover-letter") {
        const jobName = parts.slice(1).join(" ");
        if (!jobName) {
          ctx.ui.notify(
            "Which role? Usage: /jobs cover-letter Hilton Data Analyst",
            "info",
          );
          return;
        }
        // Set mode to job-hunt
        await db.exec("MATCH (c:Config {key: 'mode.override'}) DELETE c");
        await db.addNode("Config", {
          id: crypto.randomUUID(),
          key: "mode.override",
          value: "job-hunt",
          version: Date.now(),
          scope: "core",
          mutable: "flexible",
          updated_at: new Date().toISOString(),
        });
        ctx.ui.notify(
          `Cover letter for "${jobName}". I can see the role requires... What aspect of this role interests you most?`,
          "info",
        );
        return;
      }

      if (sub === "find-roles" || sub === "find") {
        ctx.ui.notify(
          "Searching for data analyst roles in hospitality (min £32k)... This may take a moment.",
          "info",
        );
        try {
          const results = await searchWeb(
            "hospitality data analyst London job",
            8,
          );
          if (results.length === 0) {
            ctx.ui.notify(
              "No roles found. Try broadening your search.",
              "info",
            );
          } else {
            const jobPlatforms = [
              "linkedin.com",
              "indeed.com",
              "reed.co.uk",
              "glassdoor.co.uk",
              "totaljobs.com",
              "simplyhired.co.uk",
              "roberthalf.com",
              "cityjobs.com",
            ];
            const lines = results.map((r: any, i: number) => {
              const isJob = jobPlatforms.some((p) => r.url.includes(p));
              return (
                i + 1 + ". " + (r.title || "Untitled") + (isJob ? " ✅" : "")
              );
            });
            ctx.ui.notify(
              "Found " +
                results.length +
                " results:\n" +
                lines.join("\n") +
                "\n\nUse /jobs cover-letter <role> when you find one you like.",
              "info",
            );
          }
        } catch (e: any) {
          ctx.ui.notify("Search failed: " + e.message, "error");
        }
        return;
      }

      if (sub === "status") {
        const cvSections = await db.query(
          "MATCH (e:Entity {kind: 'cv_document'}) RETURN count(*) AS cnt",
        );
        const savedJobs = await db.query(
          "MATCH (e:Entity {kind: 'job_listing'}) RETURN count(*) AS cnt",
        );
        const applications = await db.query(
          "MATCH (t:Task) WHERE t.project = 'job-hunt' OR t.project = 'job_hunt' RETURN t.status AS status, count(*) AS cnt GROUP BY t.status",
        );
        const parts_list: string[] = ["## Jobs Status"];
        parts_list.push(`CV sections: ${cvSections?.[0]?.cnt || 0}`);
        parts_list.push(`Saved jobs: ${savedJobs?.[0]?.cnt || 0}`);
        if (applications?.length > 0) {
          parts_list.push("Applications:");
          for (const r of applications)
            parts_list.push(`  - ${r.status}: ${r.cnt}`);
        }
        parts_list.push(
          "",
          "Default criteria: data analyst, hospitality, min £32k",
        );
        ctx.ui.notify(parts_list.join("\n"), "info");
        return;
      }

      ctx.ui.notify(
        `Unknown subcommand "${sub}". Try: cv, cover-letter, find-roles, status`,
        "warn",
      );
    },
  });

  // ── /diagnose — System health diagnostics ────────────
  pi.registerCommand("diagnose", {
    description:
      "Run full system diagnostics: DB health, embedding, WAL, schema, storage. Usage: /diagnose | /diagnose quick | /diagnose ping",
    handler: async (args: string, ctx: any) => {
      if (!hasEngine()) {
        ctx.ui.notify("Database not available.", "error");
        return;
      }

      const cmd = args.trim().toLowerCase();

      if (cmd === "ping") {
        const ok = await pingDb();
        ctx.ui.notify(
          ok ? "✅ DB ping OK" : "❌ DB ping failed",
          ok ? "success" : "error",
        );
        return;
      }

      if (cmd === "quick") {
        const health = await quickHealth();
        ctx.ui.notify(health, "info");
        return;
      }

      // Full diagnostics
      try {
        const report = await runDiagnostics();
        const formatted = formatDiagReport(report);
        ctx.ui.notify(formatted, "info");
      } catch (err: any) {
        ctx.ui.notify("Diagnostics failed: " + err.message, "error");
      }
    },
  });

  // ── /gpu — Toggle GPU acceleration for embedding ────
  pi.registerCommand("gpu", {
    description:
      "View or toggle GPU acceleration for embedding models. Usage: /gpu | /gpu on | /gpu off | /gpu status",
    handler: async (args: string, ctx: any) => {
      if (!hasEngine()) {
        ctx.ui.notify("Database not available.", "error");
        return;
      }

      const cmd = args.trim().toLowerCase();
      const db = getDb();
      const currentGpu = isGpuEnabled();

      if (cmd === "status" || cmd === "") {
        const hasGpuAccess = currentGpu;
        let msg = `GPU acceleration: ${currentGpu ? "✅ ON" : "❌ OFF"}`;
        if (currentGpu) {
          msg += `\nGPU device: ONNX Runtime (device: ${currentGpu ? 'gpu' : 'cpu'})`;
        }
        msg += `\nEmbedding status: ${getStatus()}`;
        msg += `\n\nUse /gpu on or /gpu off to toggle.`;
        msg += `\nUse /gpu force to reload the model.`;
        ctx.ui.notify(msg, "info");
        return;
      }

      if (cmd === "on" || cmd === "enable") {
        if (currentGpu) {
          ctx.ui.notify("GPU is already enabled.", "info");
          return;
        }
        await db.addNode("Config", {
          id: crypto.randomUUID(),
          key: "embedding.gpu.enabled",
          value: "true",
          version: Date.now(),
          scope: "core",
          mutable: "flexible",
          updated_at: new Date().toISOString(),
        });
        ctx.ui.notify("Restarting embedding model with GPU...", "info");
        const ok = await restartEmbedding(true);
        ctx.ui.notify(
          ok ? "✅ GPU acceleration enabled" : "❌ GPU failed, check /diagnose",
          ok ? "success" : "error",
        );
        return;
      }

      if (cmd === "off" || cmd === "disable") {
        if (!currentGpu) {
          ctx.ui.notify("GPU is already disabled (CPU mode).", "info");
          return;
        }
        await db.addNode("Config", {
          id: crypto.randomUUID(),
          key: "embedding.gpu.enabled",
          value: "false",
          version: Date.now(),
          scope: "core",
          mutable: "flexible",
          updated_at: new Date().toISOString(),
        });
        ctx.ui.notify("Restarting embedding model in CPU mode...", "info");
        const ok = await restartEmbedding(false);
        ctx.ui.notify(
          ok ? "✅ Switched to CPU mode (battery saver)" : "❌ Restart failed",
          ok ? "success" : "error",
        );
        return;
      }

      if (cmd === "force" || cmd === "reload") {
        ctx.ui.notify("Force-reloading embedding model...", "info");
        const ok = await restartEmbedding();
        ctx.ui.notify(
          ok ? "✅ Model reloaded" : "❌ Reload failed",
          ok ? "success" : "error",
        );
        return;
      }

      ctx.ui.notify(
        "Unknown option. Usage: /gpu [status|on|off|force]",
        "warn",
      );
    },
  });

  // ── /scratch — Quick notes ────────────────────────────
  pi.registerCommand("scratch", {
    description:
      "Manage scratchpad notes. Usage: /scratch <text> | /scratch | /scratch search <term> | /scratch clear | /scratch forget <id>",
    handler: async (args: string, ctx: any) => {
      const input = args.trim();

      if (!input) {
        // List all
        const notes = loadScratchpad();
        ctx.ui.notify(formatNotesList(notes), "info");
        return;
      }

      const parts = input.split(/\s+/);
      const cmd = parts[0].toLowerCase();

      if (cmd === "search") {
        const term = parts.slice(1).join(" ").toLowerCase();
        const notes = loadScratchpad().filter((n) =>
          n.content.toLowerCase().includes(term),
        );
        ctx.ui.notify(formatNotesList(notes), "info");
        return;
      }

      if (cmd === "clear") {
        saveScratchpad([]);
        ctx.ui.notify("All scratchpad notes cleared.", "info");
        return;
      }

      if (cmd === "forget" && parts.length >= 2) {
        const id = parts[1];
        const notes = loadScratchpad().filter((n) => !n.id.startsWith(id));
        saveScratchpad(notes);
        ctx.ui.notify("Note removed.", "info");
        return;
      }

      // Default: add a scratch note
      const notes = loadScratchpad();
      notes.push({
        id: crypto.randomUUID(),
        content: input,
        created_at: new Date().toISOString(),
      });
      saveScratchpad(notes);
      ctx.ui.notify(`Scratch note added (${notes.length} total).`, "success");
    },
  });

  // ── /canvas — Canvas LMS course sync ──────────────────
  pi.registerCommand("canvas", {
    description:
      "Sync courses from Canvas. Usage: /canvas | /canvas sync | /canvas sync <courseId> | /canvas ingest | /canvas ingest <courseId>",
    examples: [
      { cmd: "/canvas sync 1065", desc: "Sync only course 3 (LSE_DA301)" },
      { cmd: "/canvas ingest 1065", desc: "Ingest downloaded course 3 files" },
    ],
    handler: async (args: string, ctx: any) => {
      if (!hasEngine()) {
        ctx.ui.notify("Database not available.", "error");
        return;
      }

      const input = args.trim().toLowerCase();
      const parts = input.split(/\s+/);
      const sub = parts[0] || "";

      if (sub === "ingest") {
        // Ingest already-downloaded course files
        const db = getDb();
        const target = parts[1] || "";
        const knownDirs: Record<string, { dir: string; kind: string; label: string }> = {
          "997":  { dir: "course/course-1", kind: "raw_course", label: "LSE_DA101" },
          "1027": { dir: "course/course-2", kind: "raw_course", label: "LSE_DA201" },
          "1065": { dir: "course/course-3", kind: "raw_course", label: "LSE_DA301" },
        };

        const targets = target ? [target] : Object.keys(knownDirs);
        let totalNew = 0;
        let totalChunks = 0;
        const reports: string[] = [];

        for (const cid of targets) {
          const config = knownDirs[cid];
          if (!config || !fs.existsSync(config.dir)) {
            reports.push(`${config?.label || cid}: no files found`);
            continue;
          }

          const files = walkDirSync(config.dir);
          let dirNew = 0;
          let dirChunks = 0;

          for (const file of files) {
            try {
              const result = await ingestFile(file, config.kind);
              if (result.ingested) {
                dirNew++;
                dirChunks += result.chunks;
              }
            } catch (e: any) {
              console.warn(`[canvas] Failed to ingest ${file}: ${e.message}`);
            }
          }

          totalNew += dirNew;
          totalChunks += dirChunks;
          reports.push(`${config.label}: ${dirNew} new, ${dirChunks} chunks`);
        }

        ctx.ui.notify(
          `Canvas ingest complete:\n${reports.join("\n")}`,
          totalNew > 0 ? "success" : "info",
        );
        return;
      }

      // Sync courses from Canvas (requires Playwright + manual login)
      ctx.ui.notify(
        "Opening Canvas in browser for manual login...\n" +
        "A Chrome window will open. Log in, then the sync will start automatically.\n" +
        "Already-downloaded content will be skipped (⏭️). Only new pages will be saved.",
        "info",
      );

      try {
        const { chromium } = await import("playwright");
        const browserContext = await chromium.launchPersistentContext(
          "./var/canvas-profile",
          {
            headless: false,
            args: ["--no-sandbox"],
            viewport: { width: 1280, height: 800 },
          },
        );

        const pages = browserContext.pages();
        const page = pages.length > 0 ? pages[0] : await browserContext.newPage();

        await page.goto("https://fourthrev.instructure.com/courses", {
          waitUntil: "networkidle",
          timeout: 15000,
        });

        // Wait for login with progress updates
        ctx.ui.notify("Waiting for you to log in to Canvas...", "info");
        let loggedIn = false;
        for (let i = 0; i < 600; i++) {
          if (!page.url().includes("login")) {
            loggedIn = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
          if (i % 60 === 0 && i > 0) {
            ctx.ui.notify(`Still waiting for login... (${i / 60}m)`, "info");
          }
        }

        if (!loggedIn) {
          ctx.ui.notify("Login timeout after 10 minutes.", "error");
          await browserContext.close();
          return;
        }

        ctx.ui.notify("Logged in! Starting course sync...", "success");

        // Determine which courses to sync
        const specificCourse = parts[1];
        const courseIds = specificCourse
          ? [specificCourse]
          : ["997", "1027", "1065"];

        const results = await syncCourses(page, browserContext, courseIds, (msg) => {
          // Send progress as notification for important updates
          if (msg.includes("✅") || msg.includes("❌") || msg.includes("===")) {
            ctx.ui.notify(msg, "info");
          }
        });

        // Summary
        const totalDownloaded = results.reduce((s, r) => s + r.pagesDownloaded, 0);
        const totalSkipped = results.reduce((s, r) => s + r.pagesSkipped, 0);
        const totalErrors = results.reduce((s, r) => s + r.errors, 0);

        const summary = [
          "Canvas sync complete!",
          ...results.map(
            (r) =>
              `  ${r.courseLabel}: ${r.pagesDownloaded} new, ${r.pagesSkipped} skipped${r.errors > 0 ? ", " + r.errors + " errors" : ""}`,
          ),
          `\nTotal: ${totalDownloaded} downloaded, ${totalSkipped} skipped, ${totalErrors} errors`,
          "\nFiles saved to course/{course-id}/module-*/",
          'Use "/canvas ingest" to ingest into Ailo knowledge base.',
        ].join("\n");

        ctx.ui.notify(summary, totalDownloaded > 0 ? "success" : "info");

        // Keep browser open for inspection (5 min buffer to review output)
        console.log("\nBrowser stays open for 5 min. Close it when done.");
        await new Promise((r) => setTimeout(r, 300000));
        await browserContext.close();
      } catch (err: any) {
        ctx.ui.notify("Canvas sync failed: " + err.message, "error");
      }
    },
  });
}

// ── Helpers ────────────────────────────────────────────────

/** Walk a directory recursively, returning absolute file paths. */
function walkDirSync(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkDirSync(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  } catch {}
  return results;
}
