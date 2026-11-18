"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ExternalLink, Loader2, QrCode, Smartphone } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api-client";
import { PhoneInput } from "@/components/phone-input";

const QR_POLL_MS = 4_000;
const QR_GIVE_UP_MS = 3 * 60_000;
const QR_MAX_FAILURES = 5;

type StepResult = {
  status?: string;
  state?: string;
  delivery?: string;
  qrUrl?: string;
  premium?: boolean;
  name?: string;
  user?: { username: string | null; name: string };
  /** The two-step password typed during this sign-in, if any. Kept in memory
   *  only, so the device connection that follows can reuse it. */
  password?: string;
};

/**
 * Connect this browser to Telegram right after a sign-in, with no second scan.
 * Never throws; says what happened in a toast.
 */
export async function connectThisDevice(user: string, password?: string): Promise<void> {
  try {
    const { autoConnectBrowser } = await import("@/lib/direct-upload");
    const outcome = await autoConnectBrowser(user, password);
    if (outcome === "connected") toast.success("This device is connected — uploads, downloads and previews go straight to Telegram.");
  } catch (error) {
    toast.error((error as Error)?.message || "Could not connect this device. Use Connect under Direct upload.");
  }
}

/**
 * Sign a Telegram account in on the server by QR or phone code.
 *
 * Shared by the login page (`/api/auth/telegram-account`, which also signs in
 * to TeleDrive) and the "Your Telegram account" card (`/api/telegram/link`).
 * Both endpoints take the same actions and answer in the same shape.
 */
export function TelegramLoginFlow({
  endpoint,
  onDone,
  primaryLabel = "Link with QR",
  phoneFirst = false
}: {
  endpoint: string;
  onDone: (result: StepResult) => void;
  primaryLabel?: string;
  phoneFirst?: boolean;
}) {
  const [mode, setMode] = useState<"idle" | "qr" | "phone">(phoneFirst ? "phone" : "idle");
  const [qrUrl, setQrUrl] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"start" | "code" | "password">("start");
  const [busy, setBusy] = useState(false);
  const [qrError, setQrError] = useState("");
  const [qrState, setQrState] = useState<"waiting" | "migrating">("waiting");
  const [delivery, setDelivery] = useState("");

  const post = useCallback(
    (body: Record<string, unknown>) =>
      apiFetch<StepResult>(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }),
    [endpoint]
  );

  const finish = useCallback(
    (result: StepResult) => {
      setMode("idle");
      setQrUrl("");
      onDone({ ...result, password: password || undefined });
    },
    [onDone, password]
  );

  // Every poll asks Telegram for the current token, and Telegram issues a new
  // one each time, so the QR on screen is redrawn from each answer.
  useEffect(() => {
    if (mode !== "qr") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const startedAt = Date.now();

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - startedAt > QR_GIVE_UP_MS) {
        setQrError("This QR code expired. Start again, or use your phone number.");
        return;
      }
      try {
        const result = await post({ action: "qr-poll" });
        if (cancelled) return;
        failures = 0;
        setQrError("");
        if (result.state === "migrating" || result.state === "waiting") setQrState(result.state);
        if (result.status === "linked") return finish(result);
        if (result.status === "password") {
          setStep("password");
          setMode("phone");
          setQrUrl("");
          toast.info("Two-step verification is on — enter your cloud password.");
          return;
        }
        if (result.qrUrl) setQrUrl(result.qrUrl);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 409) {
          setQrError("This login attempt expired. Start again.");
          return;
        }
        failures += 1;
        if (failures >= QR_MAX_FAILURES) {
          setQrError(err instanceof Error ? err.message : "Lost contact with the server. Start again.");
          return;
        }
      }
      timer = setTimeout(tick, failures ? Math.min(QR_POLL_MS * 2 ** failures, 15_000) : QR_POLL_MS);
    };

    timer = setTimeout(tick, QR_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, post, finish]);

  async function startQr() {
    setBusy(true);
    try {
      const result = await post({ action: "qr-start" });
      setQrUrl(result.qrUrl || "");
      setQrError("");
      setMode("qr");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start QR login.");
    } finally {
      setBusy(false);
    }
  }

  async function run(body: Record<string, unknown>, fallback: string) {
    setBusy(true);
    try {
      const result = await post(body);
      if (result.status === "password") {
        setStep("password");
        toast.info("Two-step verification is on — enter your cloud password.");
      } else {
        finish(result);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  if (mode === "idle") {
    return (
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={busy} onClick={() => { setMode("phone"); setStep("start"); }}>
          <Smartphone className="h-4 w-4" /> Use phone number
        </button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => void startQr()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />} {primaryLabel}
        </button>
      </div>
    );
  }

  if (mode === "qr") {
    return (
      <div className="mt-4">
        <p className="t-sm" style={{ color: "var(--text-2)" }}>
          On another device: Telegram <b>Settings → Devices → Link Desktop Device</b>, then scan this. On this phone, tap
          Open in Telegram and confirm.
        </p>
        <div className="mt-3 inline-block rounded-xl bg-white p-3">
          <QrCanvas value={qrUrl} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {qrUrl ? (
            <a className="btn btn-accent" href={qrUrl}>
              <ExternalLink className="h-3.5 w-3.5" /> Open in Telegram
            </a>
          ) : null}
          <button className="btn btn-ghost" onClick={() => { setMode("phone"); setStep("start"); setQrUrl(""); }}>
            <Smartphone className="h-3.5 w-3.5" /> Use phone number instead
          </button>
        </div>
        {qrError ? (
          <p className="t-sm mt-3 rounded-xl px-3.5 py-3 leading-relaxed"
             style={{ background: "var(--danger-dim)", border: "1px solid var(--danger-border)", color: "var(--danger)" }}>
            {qrError}
          </p>
        ) : (
          <p className="t-xs mt-2 flex items-center gap-2" style={{ color: "var(--text-3)" }}>
            <Loader2 className="h-3 w-3 animate-spin" />
            {qrState === "migrating"
              ? "Scanned — moving your session to your account's data centre…"
              : "Waiting for confirmation — the code refreshes itself."}
          </p>
        )}
        <div className="mt-3 flex gap-2">
          <button className="btn btn-ghost" onClick={() => { setMode("idle"); setQrUrl(""); setQrError(""); }}>
            {qrError ? "Back" : "Cancel"}
          </button>
          {qrError ? (
            <button className="btn btn-primary" disabled={busy} onClick={() => void startQr()}>Try again</button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      {step === "start" ? (
        <>
          <PhoneInput onChange={setPhone} disabled={busy} autoFocus />
          <div className="flex gap-2">
            <button className="btn btn-ghost" onClick={() => setMode("idle")}>Back</button>
            <button
              className="btn btn-primary"
              disabled={busy || !/^\+[1-9]\d{6,14}$/.test(phone)}
              onClick={async () => {
                setBusy(true);
                try {
                  const sent = await post({ action: "phone-start", phone: phone.replace(/\s/g, "") });
                  setDelivery(sent.delivery || "");
                  setStep("code");
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Could not send a code.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Send code
            </button>
          </div>
        </>
      ) : step === "code" ? (
        <>
          <p className="t-sm leading-relaxed" style={{ color: "var(--text-2)" }}>
            {delivery === "sms" ? (
              <>Telegram sent the code by <b>SMS</b> to that number.</>
            ) : delivery === "call" ? (
              <>Telegram is <b>calling</b> that number and will read the code aloud.</>
            ) : (
              <>Telegram sent the code to your <b>Telegram app</b> — look for the message from <b>Telegram</b>.</>
            )}
          </p>
          <input value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} placeholder="Login code"
                 className="field mono w-full" inputMode="numeric" autoComplete="one-time-code" aria-label="Telegram login code" />
          <button className="btn btn-primary" disabled={busy || code.length < 3}
                  onClick={() => void run({ action: "phone-code", code }, "That code didn't work.")}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Confirm
          </button>
        </>
      ) : (
        <>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Cloud password"
                 className="field w-full" aria-label="Telegram cloud password" />
          <button className="btn btn-primary" disabled={busy || !password}
                  onClick={() => void run({ action: "password", password }, "Password rejected.")}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Confirm
          </button>
        </>
      )}
    </div>
  );
}

/** Renders a tg:// login URL. The encoder loads lazily, only when a QR is shown. */
export function QrCanvas({ value }: { value: string }) {
  const [dataUrl, setDataUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!value) return;
    let cancelled = false;
    import("qrcode")
      .then(mod => mod.toDataURL(value, { margin: 0, width: 208, errorCorrectionLevel: "L" }))
      .then(url => { if (!cancelled) setDataUrl(url); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [value]);

  if (failed) return <a href={value} className="t-xs break-all" style={{ color: "#000" }}>{value}</a>;
  if (!dataUrl) {
    return (
      <div style={{ width: 208, height: 208, display: "grid", placeItems: "center" }}>
        <Loader2 className="h-5 w-5 animate-spin" style={{ color: "#000" }} />
      </div>
    );
  }
  return <img src={dataUrl} width={208} height={208} alt="Telegram login QR code" />;
}
