"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Captions,
  Check,
  Copy,
  FileText,
  Languages,
  Loader2,
  Mic,
  MessageSquare,
  ScanText,
  Sparkles,
  X
} from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import { formatBytes } from "@/lib/utils";
import { DURATION, EASE, SPRING, fadeIn, fadeUp, stagger } from "@/lib/motion";
import type { AiSearchHit, DriveFile } from "./types";

/**
 * AI on the main page.
 *
 * Everything here is rendered only when the server said AI exists (`ai` on
 * /api/overview). That is a server answer rather than a NEXT_PUBLIC_* constant
 * because the flag has to be flippable with a restart, and a build-time constant
 * would need a rebuild — so with AI_ENABLED unset none of this mounts at all,
 * and no AI route is ever called.
 */

// ── Which actions a file can actually take ───────────────────────────────────

/**
 * Mirrors lib/ai/file-tasks: text actions want text, OCR and caption want an
 * image, transcription wants audio or video. Offering "Transcribe" on a
 * spreadsheet only produces a server-side rejection a moment later, so the menu
 * does the same test the handler does.
 *
 * PDF and DOCX are excluded from the text actions on purpose. The server has no
 * parser for them and says so rather than feeding a model their raw bytes, so
 * they are not offered as if they would work.
 */
const TEXT_LIKE = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript|x-sh|sql|csv))/;

/** readEntireFile refuses more than this, so nothing above it can be run. */
export const AI_FILE_LIMIT = 25 * 1024 * 1024;

export type AiAction = "summarize" | "translate" | "chat" | "ocr" | "caption" | "transcribe";

type ActionSpec = {
  id: AiAction;
  label: string;
  icon: typeof FileText;
  /** What it does, shown under the title in the panel. */
  blurb: string;
  accepts: (mimeType: string) => boolean;
};

const ACTIONS: ActionSpec[] = [
  {
    id: "summarize",
    label: "Summarize",
    icon: FileText,
    blurb: "A faithful summary of the document, with nothing added.",
    accepts: m => TEXT_LIKE.test(m)
  },
  {
    id: "translate",
    label: "Translate",
    icon: Languages,
    blurb: "The same document in another language, structure preserved.",
    accepts: m => TEXT_LIKE.test(m)
  },
  {
    id: "chat",
    label: "Document chat",
    icon: MessageSquare,
    blurb: "Ask a question and get an answer from this document alone.",
    accepts: m => TEXT_LIKE.test(m)
  },
  {
    id: "ocr",
    label: "Image OCR",
    icon: ScanText,
    blurb: "Every piece of text visible in the image, transcribed.",
    accepts: m => m.startsWith("image/")
  },
  {
    id: "caption",
    label: "Image caption",
    icon: Captions,
    blurb: "A short description of what the image shows.",
    accepts: m => m.startsWith("image/")
  },
  {
    id: "transcribe",
    label: "Transcribe",
    icon: Mic,
    blurb: "The spoken words in this audio or video, as text.",
    accepts: m => /^(audio|video)\//.test(m)
  }
];

/** The actions worth offering for one file — never an empty menu of failures. */
export function aiActionsFor(file: DriveFile): ActionSpec[] {
  if (file.unreachable || file.size > AI_FILE_LIMIT) return [];
  return ACTIONS.filter(a => a.accepts(file.mimeType || ""));
}

export function aiActionLabel(action: AiAction) {
  return ACTIONS.find(a => a.id === action)?.label ?? action;
}

// ── Semantic search ──────────────────────────────────────────────────────────

/** The toggle that lives inside the search field. */
export function AiSearchToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.button
      type="button"
      onClick={onToggle}
      whileHover={reduceMotion ? undefined : { scale: 1.04 }}
      whileTap={reduceMotion ? undefined : { scale: 0.94 }}
      transition={{ duration: DURATION.fast, ease: EASE }}
      aria-pressed={on}
      title={on ? "Searching by meaning — click for filename search" : "Search by meaning instead of filename"}
      aria-label={on ? "Switch to filename search" : "Switch to AI semantic search"}
      className="absolute right-1.5 top-1/2 flex h-7 -translate-y-1/2 items-center gap-1 rounded-lg px-2"
      style={{
        background: on ? "var(--accent)" : "transparent",
        border: `1px solid ${on ? "var(--accent)" : "var(--border-med)"}`,
        color: on ? "#04070c" : "var(--text-3)"
      }}
    >
      <Sparkles className="h-3.5 w-3.5" />
      <span className="mono" style={{ fontSize: 11, letterSpacing: "0.04em" }}>AI</span>
    </motion.button>
  );
}

/**
 * Semantic hits, in the place the file grid would be.
 *
 * A meaning-based hit has to explain itself: the filename that comes back often
 * looks nothing like what was typed, and the matching passage is the only thing
 * that makes the result legible. Score is shown for the same reason — a run of
 * 0.2s is a search that found nothing, however many rows it returned.
 */
export function AiSearchResults({
  hits,
  searching,
  query,
  onOpen,
  onAsk
}: {
  hits: AiSearchHit[] | null;
  searching: boolean;
  query: string;
  onOpen: (file: DriveFile) => void;
  onAsk: (file: DriveFile) => void;
}) {
  const reduceMotion = useReducedMotion();

  if (searching) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Searching by meaning">
        {[0, 1, 2].map(i => (
          <div key={i} className="panel p-4">
            <div className="skeleton h-4 w-1/3 rounded" />
            <div className="skeleton mt-2.5 h-3 w-full rounded" />
            <div className="skeleton mt-1.5 h-3 w-4/5 rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (!hits) {
    return (
      <div className="panel p-8 text-center">
        <Sparkles className="mx-auto h-7 w-7" style={{ color: "var(--accent)" }} />
        <p className="t-body mt-3 font-semibold" style={{ color: "var(--text-1)" }}>Search by meaning</p>
        <p className="t-sm mx-auto mt-1.5 max-w-md" style={{ color: "var(--text-3)" }}>
          Describe what you are looking for — “the invoice from the landlord”, “notes about the migration” — and press
          Enter. Only files that have been indexed can match.
        </p>
      </div>
    );
  }

  if (!hits.length) {
    return (
      <div className="panel p-8 text-center">
        <p className="t-body font-semibold" style={{ color: "var(--text-1)" }}>Nothing came close</p>
        <p className="t-sm mx-auto mt-1.5 max-w-md" style={{ color: "var(--text-3)" }}>
          No indexed file matches “{query}”. Index a file from its ⋮ menu, or add an Index rule in Settings → AI, and
          it becomes searchable this way.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {hits.map((hit, index) => (
        <motion.li key={hit.fileId} {...fadeUp(reduceMotion, 8, stagger(index))} className="panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <button onClick={() => onOpen(hit.file)} className="link-underline min-w-0 text-left">
              <span className="t-body block truncate font-semibold" style={{ color: "var(--text-1)" }}>{hit.fileName}</span>
              <span className="mono block" style={{ color: "var(--text-3)" }}>
                {formatBytes(hit.file.size)} · match {hit.score.toFixed(3)}
              </span>
            </button>
            <div className="flex shrink-0 gap-1.5">
              <button onClick={() => onAsk(hit.file)} className="btn btn-ghost" style={{ minHeight: 34, fontSize: 12 }}>
                <Sparkles className="h-3.5 w-3.5" /> Ask AI
              </button>
              <button onClick={() => onOpen(hit.file)} className="btn btn-ghost" style={{ minHeight: 34, fontSize: 12 }}>
                Open
              </button>
            </div>
          </div>
          <p className="t-sm mt-2.5 leading-relaxed" style={{ color: "var(--text-2)" }}>{hit.excerpt}</p>
        </motion.li>
      ))}
    </ul>
  );
}

// ── Ask AI ───────────────────────────────────────────────────────────────────

type RunResult = { action: AiAction; text: string; provider: string; model: string; costMicros?: number | null };

/**
 * Run one AI action against one file, and show what came back.
 *
 * A side sheet rather than a modal: the answer is often long, the file list
 * behind it is the context for reading it, and a sheet can be left open while
 * scrolling that list.
 *
 * The user picks no model. Which key and which model answer is the router's
 * decision, taken from the account's AI mode — asking someone to choose a model
 * before they can summarise a document is a research task, not a feature. What
 * did answer is reported at the bottom, so the choice is visible after the fact.
 */
export function AskAiPanel({
  file,
  initialAction,
  onClose
}: {
  file: DriveFile;
  initialAction?: AiAction;
  onClose: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const actions = useMemo(() => aiActionsFor(file), [file]);
  const [action, setAction] = useState<AiAction>(initialAction ?? actions[0]?.id ?? "summarize");
  const [question, setQuestion] = useState("");
  const [language, setLanguage] = useState("English");
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const spec = actions.find(a => a.id === action) ?? ACTIONS.find(a => a.id === action);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Leaving mid-request would otherwise keep a provider call — and the user's
  // money — running for an answer nobody will read.
  useEffect(() => () => controller.current?.abort(), []);

  const run = useCallback(async () => {
    if (action === "chat" && !question.trim()) {
      setError("Ask a question first.");
      return;
    }
    controller.current?.abort();
    const own = new AbortController();
    controller.current = own;

    setRunning(true);
    setError("");
    setResult(null);
    try {
      const data = await apiFetch<RunResult>(`/api/ai/file/${file.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          ...(action === "chat" ? { question: question.trim() } : {}),
          ...(action === "translate" ? { language: language.trim() || "English" } : {})
        }),
        signal: own.signal
      });
      if (own.signal.aborted) return;
      setResult(data);
    } catch (err) {
      if (own.signal.aborted) return;
      setError(err instanceof Error ? err.message : "The AI request failed.");
    } finally {
      if (controller.current === own) {
        controller.current = null;
        setRunning(false);
      }
    }
  }, [action, question, language, file.id]);

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Could not copy to the clipboard.");
    }
  };

  return (
    <motion.div
      {...fadeIn(reduceMotion)}
      className="fixed inset-0 z-[75] flex justify-end"
      style={{ background: "rgba(3,5,10,0.62)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Ask AI about ${file.originalName}`}
    >
      <motion.aside
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 32 }}
        animate={{ opacity: 1, x: 0 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 32 }}
        transition={reduceMotion ? { duration: DURATION.fast, ease: EASE } : SPRING}
        onClick={e => e.stopPropagation()}
        className="safe-bottom flex h-full w-full flex-col sm:max-w-[520px]"
        style={{ background: "var(--bg-1)", borderLeft: "1px solid var(--border-dim)", boxShadow: "var(--shadow-lg)" }}
      >
        <header className="flex items-start justify-between gap-3 px-5 py-4" style={{ borderBottom: "1px solid var(--border-dim)" }}>
          <div className="min-w-0">
            <p className="eyebrow flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5" style={{ color: "var(--accent)" }} /> Ask AI
            </p>
            <h2 className="t-body mt-1 truncate font-semibold" style={{ color: "var(--text-1)" }}>{file.originalName}</h2>
          </div>
          <button onClick={onClose} className="icon-btn shrink-0" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {actions.length === 0 ? (
            <p className="t-sm" style={{ color: "var(--text-3)" }}>
              {file.size > AI_FILE_LIMIT
                ? `This file is ${formatBytes(file.size)}. AI actions read the whole file into memory, so they stop at ${formatBytes(AI_FILE_LIMIT)}.`
                : `There is no AI action for a ${file.mimeType || "file"} yet. Text, images, audio and video are supported.`}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {actions.map(a => (
                  <button
                    key={a.id}
                    onClick={() => {
                      setAction(a.id);
                      setResult(null);
                      setError("");
                    }}
                    className={action === a.id ? "btn btn-accent" : "btn btn-ghost"}
                    style={{ minHeight: 36, fontSize: 12 }}
                  >
                    <a.icon className="h-3.5 w-3.5" />
                    {a.label}
                  </button>
                ))}
              </div>

              {spec ? (
                <p className="t-xs mt-2.5" style={{ color: "var(--text-3)" }}>{spec.blurb}</p>
              ) : null}

              {action === "chat" ? (
                <input
                  value={question}
                  onChange={e => setQuestion(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && !running) void run();
                  }}
                  placeholder="What would you like to know?"
                  aria-label="Question"
                  className="field mt-3"
                  style={{ minHeight: 44 }}
                />
              ) : null}

              {action === "translate" ? (
                <input
                  value={language}
                  onChange={e => setLanguage(e.target.value)}
                  placeholder="Target language"
                  aria-label="Target language"
                  className="field mt-3"
                  style={{ minHeight: 44 }}
                />
              ) : null}

              <button onClick={() => void run()} disabled={running} className="btn btn-primary mt-3 w-full" style={{ minHeight: 44 }}>
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {running ? "Working…" : `Run ${aiActionLabel(action).toLowerCase()}`}
              </button>

              {running ? (
                <div className="mt-4" aria-busy="true" aria-label="Waiting for the model">
                  <div className="skeleton h-3 w-full rounded" />
                  <div className="skeleton mt-2 h-3 w-11/12 rounded" />
                  <div className="skeleton mt-2 h-3 w-4/5 rounded" />
                  <div className="skeleton mt-2 h-3 w-2/3 rounded" />
                </div>
              ) : null}

              {error && !running ? (
                <p className="t-sm mt-4 rounded-xl p-3" style={{ background: "var(--surface)", color: "var(--danger)" }}>
                  {error}
                </p>
              ) : null}

              {result && !running ? (
                <motion.div {...fadeUp(reduceMotion)} className="mt-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="eyebrow">{aiActionLabel(result.action)}</p>
                    <button onClick={() => void copy()} className="btn btn-ghost" style={{ minHeight: 32, fontSize: 12 }}>
                      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <p
                    className="t-sm mt-2 whitespace-pre-wrap rounded-xl p-3.5 leading-relaxed"
                    style={{ background: "var(--surface)", color: "var(--text-1)" }}
                  >
                    {result.text}
                  </p>
                  <p className="mono mt-2" style={{ color: "var(--text-3)" }}>
                    {result.provider} · {result.model}
                  </p>
                </motion.div>
              ) : null}
            </>
          )}
        </div>
      </motion.aside>
    </motion.div>
  );
}
