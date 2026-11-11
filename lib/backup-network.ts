export type BackupNetworkMode = "wifi" | "mobile" | "both";
export type BackupConnection = "wifi" | "mobile" | "other" | "unknown" | "offline";
export class BackupPausedError extends Error {}

export function backupNetworkAllowed(mode: BackupNetworkMode, connection: BackupConnection) {
  return connection !== "offline" && (mode === "both" || mode === connection);
}

export async function backupConnection(): Promise<BackupConnection> {
  if (typeof navigator === "undefined" || !navigator.onLine) return "offline";
  const win = window as unknown as { Capacitor?: { Plugins?: { Backup?: { networkStatus?: () => Promise<{ type: string }> } } } };
  try {
    const native = await win.Capacitor?.Plugins?.Backup?.networkStatus?.();
    if (native && ["wifi", "mobile", "other", "offline"].includes(native.type)) return native.type as BackupConnection;
  } catch { /* older app: use the browser signal, never guess from speed */ }
  const type = (navigator as Navigator & { connection?: { type?: string } }).connection?.type;
  if (type === "wifi") return "wifi";
  if (type === "cellular") return "mobile";
  if (type === "ethernet") return "other";
  return "unknown";
}
