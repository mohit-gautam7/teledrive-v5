"use client";

import { useEffect, useState } from "react";
import { Download, File as FileIcon, Folder, Lock, Share2 } from "lucide-react";
import { Button } from "@/components/button";
import { apiFetch, ApiError } from "@/lib/api-client";
import { formatBytes } from "@/lib/utils";

type SharedFile = {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
};

type SharedFolder = {
  id: string;
  name: string;
};

export default function ShareViewer({ token }: { token: string }) {
  const [file, setFile] = useState<SharedFile | null>(null);
  const [folderData, setFolderData] = useState<{ folder: SharedFolder; files: SharedFile[] } | null>(null);
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [error, setError] = useState("");
  // Distinct from `error`: the two used to share one line of text, so a share
  // that was about to fail was indistinguishable from one still arriving.
  const [loading, setLoading] = useState(true);

  async function load(pass?: string) {
    setLoading(true);
    try {
      const data = await apiFetch<{ file?: SharedFile; folder?: SharedFolder; files?: SharedFile[] }>(`/api/share/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: pass })
      });
      if (data.folder) {
        setFolderData({ folder: data.folder, files: data.files ?? [] });
      } else if (data.file) {
        setFile(data.file);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setNeedsPassword(true);
        return;
      }
      setError(error instanceof Error ? error.message : "Share link unavailable");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="grid min-h-screen place-items-center bg-slate-950 px-5 text-white">
      <section className="w-full max-w-lg rounded-lg border border-white/10 bg-white p-6 text-slate-950 shadow-2xl">
        {folderData ? (
          <>
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-md bg-amber-500 text-white shrink-0">
                <Folder className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-xl font-semibold">{folderData.folder.name}</h1>
                <p className="text-sm text-slate-500">{folderData.files.length} file{folderData.files.length !== 1 ? "s" : ""}</p>
              </div>
            </div>
            {folderData.files.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-4">This folder is empty.</p>
            ) : (
              <ul className="divide-y divide-slate-100 max-h-96 overflow-y-auto">
                {folderData.files.map(f => (
                  <li key={f.id} className="flex items-center gap-3 py-3">
                    <FileIcon className="h-5 w-5 shrink-0 text-slate-400" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{f.originalName}</p>
                      <p className="text-xs text-slate-400">{f.mimeType} · {formatBytes(f.size)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-xs text-slate-400 text-center">Share individual files to enable direct downloads.</p>
          </>
        ) : file ? (
          <>
            <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-md bg-sky-600 text-white">
              <Share2 className="h-5 w-5" />
            </div>
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
          <form onSubmit={event => { event.preventDefault(); load(password); }}>
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
        ) : loading ? (
          /* The same shape the file card will take, so nothing jumps when it
             arrives — the icon, the title line and the meta line, in place. */
          <div aria-busy="true" aria-label="Opening share">
            <div className="mb-6 h-12 w-12 animate-pulse rounded-md bg-slate-200" />
            <div className="h-6 w-2/3 animate-pulse rounded bg-slate-200" />
            <div className="mt-3 h-4 w-1/3 animate-pulse rounded bg-slate-200" />
            <div className="mt-6 h-10 w-full animate-pulse rounded-md bg-slate-200" />
          </div>
        ) : (
          <p className="text-sm text-slate-600">{error || "This share link is no longer available."}</p>
        )}
      </section>
    </main>
  );
}
