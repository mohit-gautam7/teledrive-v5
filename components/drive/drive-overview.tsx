"use client";

import { ArrowUpRight, CloudUpload, Settings2 } from "lucide-react";
import { CloudSculpture } from "./cloud-sculpture";
import { formatBytes } from "@/lib/utils";
import type { Insights } from "./types";

export function DriveOverview({ insights, active, onUpload, onSettings }: {
  insights: Insights | null; active: number; onUpload: () => void; onSettings: () => void;
}) {
  return <section className="drive-overview mb-6" aria-label="Drive overview">
    <div className="overview-copy">
      <p className="eyebrow flex items-center gap-2"><span className="overview-dot" /> YOUR PERSONAL CLOUD</p>
      <h2 className="overview-title mt-3">A home for<br /><span className="brand-text">everything you keep.</span></h2>
      <p className="t-sm mt-3 max-w-[40ch]" style={{ color: "var(--text-2)" }}>Photos, ideas, and the files that matter. All together, in your Telegram.</p>
      <div className="mt-5 flex flex-wrap gap-2">
        <button className="btn btn-accent" onClick={onUpload}><CloudUpload className="h-4 w-4" /> Upload files <ArrowUpRight className="h-4 w-4" /></button>
        <button className="btn btn-ghost" onClick={onSettings}><Settings2 className="h-4 w-4" /> Backup & connections</button>
      </div>
    </div>
    <CloudSculpture />
    <dl className="overview-metrics">
      <div><dt>Files saved</dt><dd>{insights?.count?.toLocaleString() ?? "—"}</dd></div>
      <div><dt>Stored in Telegram</dt><dd>{insights ? formatBytes(insights.totalSize) : "—"}</dd></div>
      <div><dt>Upload queue</dt><dd>{active ? `${active} active` : "Ready"}</dd></div>
    </dl>
  </section>;
}
