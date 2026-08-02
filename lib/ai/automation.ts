import { prisma } from "@/lib/prisma";
import { enqueue } from "@/lib/jobs/queue";
import { streamInclude } from "@/lib/file-stream";
import { runFileTask, isFileAction, type FileAction } from "@/lib/ai/file-tasks";
import { indexFile } from "@/lib/ai/search";

/**
 * Trigger -> steps, run in the background.
 *
 * Kept deliberately small: one event, a handful of step types, and no branching.
 * A rule that fires on upload and summarises, transcribes or files something
 * away covers most of what people actually automate, and every step reuses the
 * same routed AI calls as the manual actions.
 */

export type AutomationTrigger = {
  event: "file.uploaded";
  /** e.g. "image/" — matched against the start of the MIME type. */
  mimePrefix?: string;
  /** Case-insensitive substring of the file name. */
  nameContains?: string;
};

export type AutomationStep =
  | { type: "summarize" | "ocr" | "transcribe" | "caption" }
  | { type: "translate"; language: string }
  | { type: "index" }
  | { type: "move"; folderId: string | null }
  | { type: "favorite" };

export function parseTrigger(raw: unknown): AutomationTrigger | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (t.event !== "file.uploaded") return null;
  return {
    event: "file.uploaded",
    mimePrefix: typeof t.mimePrefix === "string" ? t.mimePrefix : undefined,
    nameContains: typeof t.nameContains === "string" ? t.nameContains : undefined
  };
}

export function parseSteps(raw: unknown): AutomationStep[] {
  if (!Array.isArray(raw)) return [];
  const out: AutomationStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    switch (s.type) {
      case "summarize":
      case "ocr":
      case "transcribe":
      case "caption":
        out.push({ type: s.type });
        break;
      case "translate":
        if (typeof s.language === "string" && s.language.trim()) out.push({ type: "translate", language: s.language });
        break;
      case "index":
        out.push({ type: "index" });
        break;
      case "move":
        out.push({ type: "move", folderId: typeof s.folderId === "string" ? s.folderId : null });
        break;
      case "favorite":
        out.push({ type: "favorite" });
        break;
    }
  }
  return out;
}

function matches(trigger: AutomationTrigger, file: { originalName: string; mimeType: string }) {
  if (trigger.mimePrefix && !(file.mimeType || "").startsWith(trigger.mimePrefix)) return false;
  if (trigger.nameContains && !file.originalName.toLowerCase().includes(trigger.nameContains.toLowerCase())) return false;
  return true;
}

/**
 * Queue every rule that matches a newly stored file.
 *
 * Never throws: an automation failing must not fail the upload that triggered
 * it, which has already succeeded by this point.
 */
export async function onFileUploaded(userId: string, file: { id: string; originalName: string; mimeType: string }) {
  try {
    const rules = await prisma.automation.findMany({ where: { userId, enabled: true } });
    for (const rule of rules) {
      const trigger = parseTrigger(rule.trigger);
      if (!trigger || !matches(trigger, file)) continue;
      await enqueue({
        userId,
        type: "automation",
        payload: { automationId: rule.id, fileId: file.id },
        // Behind anything the user is actively waiting on.
        priority: 200
      });
    }
  } catch (err) {
    console.warn("[automation] could not evaluate rules:", (err as Error).message);
  }
}

export type StepOutcome = { step: string; ok: boolean; detail?: string };

/** Run one rule's steps against one file. Steps are independent: a failure is
 *  recorded and the rest still run. */
export async function runAutomation(userId: string, automationId: string, fileId: string) {
  const rule = await prisma.automation.findFirst({ where: { id: automationId, userId } });
  if (!rule) throw new Error("The automation no longer exists.");

  const steps = parseSteps(rule.steps);
  const outcomes: StepOutcome[] = [];

  for (const step of steps) {
    try {
      if (step.type === "move" || step.type === "favorite") {
        await prisma.file.update({
          where: { id: fileId },
          data: step.type === "move" ? { folderId: step.folderId } : { isFavorite: true }
        });
        outcomes.push({ step: step.type, ok: true });
        continue;
      }

      if (step.type === "index") {
        const res = await indexFile(userId, fileId);
        outcomes.push({ step: "index", ok: true, detail: `${res.indexed} chunks` });
        continue;
      }

      const action: FileAction | null = isFileAction(step.type) ? step.type : null;
      if (!action) {
        outcomes.push({ step: String(step.type), ok: false, detail: "unknown step" });
        continue;
      }

      const file = await prisma.file.findFirst({
        where: { id: fileId, userId, isDeleted: false },
        include: streamInclude
      });
      if (!file) throw new Error("The file no longer exists.");

      const result = await runFileTask({
        userId,
        file,
        action,
        language: step.type === "translate" ? step.language : undefined
      });
      // The generated text is returned in the job result rather than written
      // anywhere: there is no field on a file to hold it yet, and inventing one
      // silently would be worse than handing it back.
      outcomes.push({ step: action, ok: true, detail: result.text.slice(0, 500) });
    } catch (err) {
      outcomes.push({ step: step.type, ok: false, detail: (err as Error).message.slice(0, 300) });
    }
  }

  await prisma.automation.update({
    where: { id: rule.id },
    data: { lastRunAt: new Date(), runCount: { increment: 1 } }
  });

  return { automation: rule.name, outcomes };
}
