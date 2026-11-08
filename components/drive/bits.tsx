"use client";

/**
 * The two pieces of `panels.tsx` that the shell needs on first paint.
 *
 * Everything else in that file — Settings, Insights, Shares, About and the
 * whole AI configuration UI — is behind a sidebar click, so `drive-app.tsx`
 * loads it lazily. That only pays off if nothing eager imports the module:
 * one static import of `EmptyState` would pull all 2,000 lines back into the
 * first chunk. Hence this file.
 */

import { AlertCircle, Check, Loader2 } from "lucide-react";

export function EmptyState({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="panel flex flex-col items-center px-6 py-14 text-center">
      <span className="mb-5 grid h-14 w-14 place-items-center rounded-2xl" style={{ background: "var(--accent-dim)", border: "1px solid var(--accent-border)" }}>
        {icon}
      </span>
      <p className="display t-h2">{title}</p>
      <p className="t-sm mt-2 max-w-[42ch] leading-relaxed" style={{ color: "var(--text-3)" }}>{body}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function AuthBadge({ status }: { status: "connected" | "pending" | "failed" }) {
  if (status === "pending") return <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: "var(--accent)" }} />;
  if (status === "failed") return <AlertCircle className="h-3.5 w-3.5" style={{ color: "var(--danger)" }} />;
  return <Check className="h-3.5 w-3.5" style={{ color: "var(--emerald)" }} />;
}

/**
 * Shown while a lazily-loaded panel's chunk is in flight. Same shape as the
 * skeleton the panels use for their own data, so a cold open and a warm one
 * differ in timing rather than in layout.
 */
export function PanelFallback({ rows = 2 }: { rows?: number }) {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-24 w-full rounded-xl" />
      ))}
    </div>
  );
}
