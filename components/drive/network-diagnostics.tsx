"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, ArrowUpRight, CheckCircle2, Loader2, WifiOff } from "lucide-react";
import { FILE_ORIGIN } from "@/lib/file-origin";
import { browserLinked, checkDirectConnection } from "@/lib/direct-upload";

type Result = { name: string; ok: boolean; detail: string };
export function NetworkDiagnostics({ user }: { user: string }) {
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function run() {
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true); setResults([]);
    const probe = async (name: string, origin: string): Promise<Result> => {
      const start = performance.now();
      const request = new AbortController();
      const cancel = () => request.abort();
      controller.signal.addEventListener("abort", cancel, { once: true });
      const timeout = window.setTimeout(cancel, 15_000);
      try {
        const response = await fetch(`${origin}/api/network`, { cache: "no-store", credentials: "omit",
          signal: request.signal });
        const body = await response.json();
        if (!response.ok || body.service !== "teledrive") throw new Error();
        return { name, ok: true, detail: `Reachable · ${Math.round(performance.now() - start)} ms` };
      } catch { return { name, ok: false, detail: "Unreachable, waking up, or blocked by network/CORS. Try again after a minute." }; }
      finally { window.clearTimeout(timeout); controller.signal.removeEventListener("abort", cancel); }
    };
    try {
      const rows = await Promise.all([probe("Website", ""), ...(FILE_ORIGIN ? [probe("File server", FILE_ORIGIN)] : [])]);
      if (!controller.signal.aborted) setResults(rows);
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section className="panel p-5">
    <h2 className="display t-h2 flex items-center gap-2"><Activity className="h-5 w-5" /> Connection health</h2>
    <p className="t-sm mt-2 leading-relaxed" style={{ color: "var(--text-2)" }}>
      Test this device’s route to the website and file server. Useful when the drive opens but previews, downloads, or background backup do not.
    </p>
    <div className="mt-4 flex flex-wrap gap-2">
      <button className="btn btn-accent" disabled={busy} onClick={() => void run()}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />} {busy ? "Checking…" : "Check this network"}
      </button>
      <button className="btn btn-ghost" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          if (!browserLinked(user)) throw new Error("Connect this device under Direct upload first.");
          const name = await checkDirectConnection(user);
          setResults(previous => [...previous.filter(row => row.name !== "Direct Telegram"), { name: "Direct Telegram", ok: true, detail: `Connected as ${name}` }]);
        } catch (error) {
          setResults(previous => [...previous.filter(row => row.name !== "Direct Telegram"), { name: "Direct Telegram", ok: false, detail: (error as Error).message }]);
        } finally { setBusy(false); }
      }}>Test direct Telegram <ArrowUpRight className="h-4 w-4" /></button>
    </div>
    <div className="mt-3 space-y-2" role="status">
      {results.map(row => <div key={row.name} className="flex items-start gap-2 rounded-lg p-3" style={{ background: "var(--surface)" }}>
        {row.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--emerald)" }} /> : <WifiOff className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--amber)" }} />}
        <div><p className="t-sm font-medium">{row.name}</p><p className="t-xs mt-1" style={{ color: "var(--text-2)" }}>{row.detail}</p></div>
      </div>)}
    </div>
    <p className="t-xs mt-3" style={{ color: "var(--text-2)" }}>
      Direct uploads and direct album backup do not need the file server. Previews and downloads still do.
      A custom domain changes the address; it cannot guarantee access through a college firewall.
    </p>
  </section>;
}
