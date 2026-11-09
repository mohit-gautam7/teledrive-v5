/**
 * The Android app's background backup, as seen from the web page.
 *
 * TeleDrive's Android build is this same site inside a native shell, so the
 * settings for a feature only the shell can provide still have to be rendered
 * by the site. The shell injects `window.Capacitor` with a `Backup` plugin;
 * everywhere else that object simply does not exist and the UI stays hidden.
 *
 * Deliberately no `@capacitor/core` import. Depending on it would add a package
 * to the web build — and a server-render hazard — for an object that is handed
 * to us at runtime anyway. Feature detection costs one optional chain and keeps
 * the website a website.
 *
 * The native side is mobile/android/.../backup/BackupPlugin.kt; this file is
 * the other half of that contract and the two have to be changed together.
 */

export type NativeBackupStatus = {
  available: boolean;
  enabled: boolean;
  mediaPermission: boolean;
  notificationPermission: boolean;
  batteryExempt: boolean;
  /** Build.MANUFACTURER, lowercased — picks the right battery advice. */
  vendor: string;
  /** This ROM has a vendor autostart screen we know how to open. */
  needsStartupPermission: boolean;
  /** Items waiting, or -1 when it cannot be counted without permission. */
  pending: number;
  running: boolean;
  wifiOnly: boolean;
  chargingOnly: boolean;
  includeNonCamera: boolean;
  folderId: string | null;
  lastRunAt: number;
  lastResult: string;
  uploadedTotal: number;
};

export type NativeBackupOptions = {
  wifiOnly?: boolean;
  chargingOnly?: boolean;
  includeNonCamera?: boolean;
  folderId?: string | null;
};

type BackupPlugin = {
  status(): Promise<NativeBackupStatus>;
  enable(): Promise<NativeBackupStatus>;
  disable(): Promise<NativeBackupStatus>;
  runNow(): Promise<NativeBackupStatus>;
  rescanAll(): Promise<NativeBackupStatus>;
  setOptions(options: NativeBackupOptions): Promise<NativeBackupStatus>;
  requestNotificationPermission(): Promise<NativeBackupStatus>;
  requestBatteryExemption(): Promise<NativeBackupStatus>;
  openStartupSettings(): Promise<{ opened: boolean; vendor: string }>;
};

function plugin(): BackupPlugin | null {
  if (typeof window === "undefined") return null;
  const capacitor = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
  return (capacitor?.Plugins?.Backup as BackupPlugin | undefined) ?? null;
}

/** True only inside the Android app. Every card here is hidden otherwise. */
export function nativeBackupAvailable(): boolean {
  return plugin() !== null;
}

/**
 * Each call returns the whole status, so the UI never has to guess what a
 * change did — it re-renders from what the native side reports afterwards.
 * A rejected call returns null rather than throwing: a permission the user
 * declined is an answer, not an error, and the caller shows the status either
 * way.
 */
async function call<K extends keyof BackupPlugin>(
  method: K,
  ...args: Parameters<BackupPlugin[K]>
): Promise<Awaited<ReturnType<BackupPlugin[K]>> | null> {
  const api = plugin();
  if (!api) return null;
  try {
    const fn = api[method] as (...a: unknown[]) => Promise<unknown>;
    return (await fn.apply(api, args)) as Awaited<ReturnType<BackupPlugin[K]>>;
  } catch (error) {
    console.warn(`[native-backup] ${String(method)} failed:`, (error as Error)?.message);
    return null;
  }
}

export const nativeBackup = {
  status: () => call("status"),
  enable: () => call("enable"),
  disable: () => call("disable"),
  runNow: () => call("runNow"),
  rescanAll: () => call("rescanAll"),
  setOptions: (options: NativeBackupOptions) => call("setOptions", options),
  requestNotificationPermission: () => call("requestNotificationPermission"),
  requestBatteryExemption: () => call("requestBatteryExemption"),
  openStartupSettings: () => call("openStartupSettings")
};

/**
 * What this phone's manufacturer does to background apps, and what to do.
 *
 * Not decoration. On these ROMs the standard battery exemption is not enough:
 * a separate vendor list decides whether the system may start the app at all,
 * and backup silently never runs until the app is on it. There is no API to
 * read that setting, so the only honest thing is to name the screen.
 */
export function vendorAdvice(vendor: string): { label: string; steps: string[] } | null {
  const v = vendor.toLowerCase();
  if (v === "oppo" || v === "realme" || v === "oneplus") {
    return {
      label: v === "oneplus" ? "OnePlus / OxygenOS" : "ColorOS / realme UI",
      steps: [
        // Measured on realme UI 16: the auto-launch list refuses to open for
        // any app, and for adb, because it is guarded by a privileged
        // permission. Searching Settings is the one route that works, and it
        // keeps working when the next firmware moves the screen again.
        "Open Settings, search for “auto-launch” (also called Auto-start or Startup manager), and turn it on for TeleDrive. This ROM blocks apps from opening that screen for you.",
        "In App info → Battery usage, choose Allow background activity or Don’t optimise."
      ]
    };
  }
  if (v === "xiaomi" || v === "redmi" || v === "poco") {
    return {
      label: "MIUI / HyperOS",
      steps: [
        "Turn on Autostart for TeleDrive.",
        "In App info → Battery saver, choose No restrictions.",
        "Lock TeleDrive in the recents screen so swiping away does not kill it."
      ]
    };
  }
  if (v === "vivo") {
    return {
      label: "Funtouch OS",
      steps: ["Allow background running (High background power consumption) for TeleDrive."]
    };
  }
  if (v === "samsung") {
    return {
      label: "One UI",
      steps: [
        "Add TeleDrive to Never sleeping apps.",
        "Make sure it is not listed under Sleeping or Deep sleeping apps."
      ]
    };
  }
  if (v === "huawei" || v === "honor") {
    return { label: "EMUI", steps: ["Set TeleDrive's launch to Manage manually and enable all three switches."] };
  }
  return null;
}
