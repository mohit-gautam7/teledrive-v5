"use client";

import { useEffect, useState } from "react";
import { Download, Lock, Share2 } from "lucide-react";
import { Button } from "@/components/button";
import { apiFetch, ApiError } from "@/lib/api-client";
import { formatBytes } from "@/lib/utils";

type SharedFile = {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
};

export default function ShareViewer({ token }: { token: string }) {
  const [file, setFile] = useState<SharedFile | null>(null);
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [error, setError] = useState("");

  async function load(pass?: string) {
    try {
      const data = await apiFetch<{ file: SharedFile }>(`/api/share/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: pass })
      });
      setFile(data.file);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setNeedsPassword(true);
        return;
      }
      setError(error instanceof Error ? error.message : "Share link unavailable");
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <main className="grid min-h-screen place-items-center bg-slate-950 px-5 text-white">
      <section className="w-full max-w-md rounded-lg border border-white/10 bg-white p-6 text-slate-950 shadow-2xl">
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-md bg-sky-600 text-white">
          <Share2 className="h-5 w-5" />
        </div>
        {file ? (
          <>
            <h1 className="truncate text-xl font-semibold">{file.originalName}</h1>
            <p className="mt-2 text-sm text-slate-500">{file.mimeType} · {formatBytes(file.size)}</p>
            {file.mimeType.startsWith("video/") ? (
              <video className="mt-5 w-full rounded-md" controls src={`/api/public/stream/${token}`} />
            ) : null}
            <a href={`/api/public/download/${token}`} className="mt-6 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-sky-600 text-sm font-medium text-white hover:bg-sky-700">
              <Download className="h-4 w-4" />
              Download
            </a>
          </>
        ) : needsPassword ? (
          <form
            onSubmit={event => {
              event.preventDefault();
              load(password);
            }}
          >
            <Lock className="mb-4 h-6 w-6 text-slate-500" />
            <h1 className="text-xl font-semibold">Password required</h1>
            <input
              value={password}
              onChange={event => setPassword(event.target.value)}
              type="password"
              className="mt-5 h-10 w-full rounded-md border px-3 outline-none focus:border-sky-500"
              placeholder="Enter password"
            />
            <Button className="mt-4 w-full">Open share</Button>
          </form>
        ) : (
          <p className="text-sm text-slate-600">{error || "Loading share..."}</p>
        )}
      </section>
    </main>
  );
}
