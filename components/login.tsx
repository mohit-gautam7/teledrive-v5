"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Check, Infinity as InfinityIcon, KeyRound, Loader2, Lock, MessageCircle, ShieldCheck } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Logo } from "@/components/logo";

declare global {
  interface Window {
    onTelegramAuth?: (user: unknown) => void;
  }
}

const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "";

type Providers = { botCode: boolean; widget: boolean; google: boolean; ownerKey: boolean };
type Tab = "code" | "widget";

const PILLARS = [
  { icon: Lock, title: "Your account, your bytes", body: "Files land in your own Telegram chat. No third-party bucket, nothing to trust but Telegram." },
  { icon: InfinityIcon, title: "Storage that keeps going", body: "Telegram sets the ceiling, not us — up to 2 GB per file, 4 GB with Premium." },
  { icon: ShieldCheck, title: "Secrets stay server-side", body: "Bot tokens never reach the browser. Every byte is proxied, every session is an HTTP-only cookie." }
];

export default function Login() {
  const reduceMotion = useReducedMotion();

  const [providers, setProviders] = useState<Providers | null>(null);
  const [tab, setTab] = useState<Tab>("code");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [linking, setLinking] = useState(false);

  const [code, setCode] = useState("");
  const [codeLoading, setCodeLoading] = useState(false);

  const [showOwner, setShowOwner] = useState(false);
  const [ownerKey, setOwnerKey] = useState("");
  const [ownerLoading, setOwnerLoading] = useState(false);

  const [isLocalhost, setIsLocalhost] = useState(false);
  const [widgetState, setWidgetState] = useState<"idle" | "loading" | "ready" | "blocked">("idle");
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setIsLocalhost(["localhost", "127.0.0.1"].includes(window.location.hostname));
    setOrigin(window.location.origin);

    const params = new URLSearchParams(window.location.search);
    const urlError = params.get("error");
    if (urlError) setError(urlError);
    if (params.get("link") === "google") {
      setLinking(true);
      setNotice("Google verified. Enter a Telegram code once to connect the account that will hold your files.");
    }
    if (urlError || params.get("link")) {
      window.history.replaceState(null, "", window.location.pathname);
    }

    apiFetch<Providers>("/api/auth/providers").then(setProviders).catch(() => {
      setProviders({ botCode: true, widget: Boolean(BOT_USERNAME), google: false, ownerKey: false });
    });
  }, []);

  // The Telegram widget calls this global once the user confirms in their app.
  useEffect(() => {
    window.onTelegramAuth = async (telegramUser: unknown) => {
      setError("");
      try {
        await apiFetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(telegramUser)
        });
        window.location.href = "/drive";
      } catch (err) {
        setError(err instanceof Error ? err.message : "Telegram rejected the sign-in. Check the domain set in BotFather.");
      }
    };
    return () => {
      delete window.onTelegramAuth;
    };
  }, []);

  // Telegram's widget is a <script> that replaces itself with an iframe, so it
  // has to be injected into a live node each time the tab becomes visible.
  //
  // When the bot has no domain registered via BotFather's /setdomain, Telegram
  // refuses to render anything — the iframe simply never appears, and the page
  // used to sit there looking broken. We watch for that and say what to do.
  const mountWidget = useCallback((node: HTMLDivElement | null) => {
    if (!node || node.dataset.loaded === "true" || !BOT_USERNAME) return;
    node.dataset.loaded = "true";
    setWidgetState("loading");

    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.async = true;
    script.setAttribute("data-telegram-login", BOT_USERNAME);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-radius", "12");
    script.setAttribute("data-userpic", "true");
    script.setAttribute("data-request-access", "write");
    script.setAttribute("data-onauth", "onTelegramAuth(user)");
    script.onerror = () => setWidgetState("blocked");
    node.appendChild(script);

    // The iframe appears a beat after the script runs; if it never does, the
    // domain almost certainly isn't registered for this bot.
    let settled = false;
    const observer = new MutationObserver(() => {
      if (node.querySelector("iframe")) {
        settled = true;
        observer.disconnect();
        setWidgetState("ready");
      }
    });
    observer.observe(node, { childList: true, subtree: true });
    window.setTimeout(() => {
      if (settled) return;
      observer.disconnect();
      setWidgetState(node.querySelector("iframe") ? "ready" : "blocked");
    }, 4000);
  }, []);

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    setCodeLoading(true);
    setError("");
    try {
      const result = await apiFetch<{ linked: string | null }>("/api/auth/bot-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim() })
      });
      if (result.linked) setNotice("Account linked. Signing you in…");
      window.location.href = "/drive";
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code didn't work.");
      setCodeLoading(false);
    }
  }

  async function submitOwner(event: React.FormEvent) {
    event.preventDefault();
    setOwnerLoading(true);
    setError("");
    try {
      await apiFetch("/api/auth/owner-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: ownerKey })
      });
      window.location.href = "/drive";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid key.");
      setOwnerLoading(false);
    }
  }

  async function devLogin() {
    try {
      await apiFetch("/api/auth/dev-login", { method: "POST" });
      window.location.href = "/drive";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dev login unavailable.");
    }
  }

  const fade = reduceMotion
    ? {}
    : { initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] as const } };

  return (
    <main className="app-bg grid-overlay relative min-h-[100dvh] w-full overflow-x-hidden">
      <div className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-[1240px] flex-col px-5 py-6 sm:px-8 lg:px-10">
        {/* ── Masthead ── */}
        <motion.header
          className="flex items-center justify-between gap-4"
          {...(reduceMotion ? {} : { initial: { opacity: 0, y: -12 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] as const } })}
        >
          <div className="flex items-center gap-2.5">
            <Logo size={30} />
            <span className="display text-[17px] tracking-tight">TeleDrive</span>
          </div>
          {BOT_USERNAME ? (
            <a href={`https://t.me/${BOT_USERNAME}`} target="_blank" rel="noopener noreferrer" className="link-underline t-sm hidden sm:inline-flex">
              @{BOT_USERNAME}
            </a>
          ) : null}
        </motion.header>

        {/* ── Body ── */}
        <div className="grid flex-1 items-center gap-10 py-8 lg:grid-cols-[1.05fr_minmax(0,410px)] lg:gap-14 lg:py-10">
          {/* Editorial column */}
          <section className="min-w-0">
            <motion.p className="eyebrow" {...fade}>
              Personal cloud · Telegram-backed
            </motion.p>

            <motion.h1
              className="display t-hero mt-5 max-w-[15ch] text-balance"
              {...(reduceMotion ? {} : { initial: { opacity: 0, y: 26 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.7, delay: 0.06, ease: [0.22, 1, 0.36, 1] as const } })}
            >
              Your drive,
              <br />
              <span className="brand-text">in your own</span>
              <br />
              Telegram.
            </motion.h1>

            <motion.p
              className="t-body mt-5 max-w-[46ch] leading-relaxed"
              style={{ color: "var(--text-2)" }}
              {...(reduceMotion ? {} : { initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, delay: 0.14, ease: [0.22, 1, 0.36, 1] as const } })}
            >
              Upload, browse, preview and share from anywhere. Every file is chunked and stored in your
              private chat with the bot — so the storage is yours, and so is the account holding it.
            </motion.p>

            <ul className="mt-8 grid gap-px overflow-hidden rounded-2xl sm:grid-cols-3" style={{ background: "var(--border-dim)" }}>
              {PILLARS.map(({ icon: Icon, title, body }, i) => (
                <motion.li
                  key={title}
                  className="p-5"
                  style={{ background: "var(--bg-0)" }}
                  {...(reduceMotion
                    ? {}
                    : {
                        initial: { opacity: 0, y: 20 },
                        animate: { opacity: 1, y: 0 },
                        transition: { duration: 0.55, delay: 0.24 + i * 0.08, ease: [0.22, 1, 0.36, 1] as const }
                      })}
                >
                  <Icon className="h-4 w-4" style={{ color: "var(--accent)" }} />
                  <p className="t-sm mt-3 font-semibold" style={{ color: "var(--text-1)" }}>{title}</p>
                  <p className="t-xs mt-1.5 leading-relaxed" style={{ color: "var(--text-3)" }}>{body}</p>
                </motion.li>
              ))}
            </ul>
          </section>

          {/* Auth column */}
          <motion.section
            className="w-full min-w-0"
            {...(reduceMotion
              ? {}
              : { initial: { opacity: 0, y: 26, scale: 0.985 }, animate: { opacity: 1, y: 0, scale: 1 }, transition: { duration: 0.65, delay: 0.1, ease: [0.22, 1, 0.36, 1] as const } })}
          >
            <div className="panel overflow-hidden" style={{ boxShadow: "var(--shadow-lg)" }}>
              <div className="p-5 sm:p-7">
                <h2 className="display t-h2">{linking ? "Finish linking" : "Sign in"}</h2>
                <p className="t-sm mt-1.5" style={{ color: "var(--text-3)" }}>
                  {linking ? "One last step to connect your storage." : "No password. Your Telegram account is the key."}
                </p>

                {notice ? (
                  <p className="t-sm mt-4 rounded-xl px-3.5 py-2.5" style={{ background: "var(--accent-dim)", border: "1px solid var(--accent-border)", color: "var(--accent)" }}>
                    {notice}
                  </p>
                ) : null}

                {/* Google — a second way in that maps onto a Telegram identity. */}
                {providers?.google && !linking ? (
                  <>
                    <a href="/api/auth/google/start" className="btn btn-ghost mt-5 w-full" style={{ minHeight: 44 }}>
                      <GoogleMark />
                      Continue with Google
                    </a>
                    <div className="my-5 flex items-center gap-3">
                      <span className="h-px flex-1" style={{ background: "var(--border-dim)" }} />
                      <span className="eyebrow">or</span>
                      <span className="h-px flex-1" style={{ background: "var(--border-dim)" }} />
                    </div>
                  </>
                ) : (
                  <div className="mt-5" />
                )}

                {/* Tabs */}
                {providers?.widget && !linking ? (
                  <div className="mb-5 flex gap-1 rounded-xl p-1" style={{ background: "var(--surface)" }}>
                    {([["code", "Bot code"], ["widget", "One tap"]] as [Tab, string][]).map(([id, label]) => (
                      <button
                        key={id}
                        onClick={() => { setTab(id); setError(""); }}
                        className="t-sm relative flex-1 rounded-lg py-2 font-semibold transition"
                        style={{ color: tab === id ? "var(--text-1)" : "var(--text-3)" }}
                      >
                        {tab === id ? (
                          <motion.span
                            layoutId="auth-tab"
                            className="absolute inset-0 rounded-lg"
                            style={{ background: "var(--surface-hi)" }}
                            transition={{ type: "spring", stiffness: 420, damping: 34 }}
                          />
                        ) : null}
                        <span className="relative">{label}</span>
                      </button>
                    ))}
                  </div>
                ) : null}

                <AnimatePresence mode="wait" initial={false}>
                  {tab === "code" || linking || !providers?.widget ? (
                    <motion.div
                      key="code"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.18 }}
                    >
                      <ol className="mb-5 space-y-2.5">
                        {[
                          BOT_USERNAME ? <>Message <span style={{ color: "var(--accent)" }}>@{BOT_USERNAME}</span> on Telegram</> : "Message the TeleDrive bot on Telegram",
                          "Send anything — it replies with a 6-digit code",
                          "Enter the code below"
                        ].map((step, i) => (
                          <li key={i} className="flex gap-3">
                            <span
                              className="mono grid h-5 w-5 shrink-0 place-items-center rounded-full"
                              style={{ background: "var(--accent-dim)", border: "1px solid var(--accent-border)", color: "var(--accent)", fontSize: 10 }}
                            >
                              {i + 1}
                            </span>
                            <span className="t-sm min-w-0 break-words" style={{ color: "var(--text-2)" }}>{step}</span>
                          </li>
                        ))}
                      </ol>

                      {BOT_USERNAME ? (
                        <a href={`https://t.me/${BOT_USERNAME}`} target="_blank" rel="noopener noreferrer" className="btn btn-accent mb-3 w-full" style={{ minHeight: 42 }}>
                          <MessageCircle className="h-4 w-4" />
                          Open Telegram
                        </a>
                      ) : null}

                      <form onSubmit={submitCode} className="flex gap-2">
                        <input
                          type="text"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          maxLength={6}
                          placeholder="000000"
                          aria-label="6-digit login code"
                          value={code}
                          onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                          required
                          className="field mono flex-1 text-center"
                          style={{ fontSize: 20, letterSpacing: "0.35em", paddingLeft: 0, paddingRight: 0, minHeight: 46 }}
                        />
                        <button type="submit" disabled={codeLoading || code.length < 6} className="btn btn-primary shrink-0 px-5" style={{ minHeight: 46 }}>
                          {codeLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                          <span className="hidden sm:inline">{linking ? "Link" : "Enter"}</span>
                        </button>
                      </form>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="widget"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.18 }}
                    >
                      <p className="t-sm mb-4 leading-relaxed" style={{ color: "var(--text-2)" }}>
                        Authorise with the official Telegram button — confirm on your phone and you&apos;re in.
                      </p>
                      <div ref={mountWidget} className="flex min-h-[48px] justify-center" />

                      {widgetState === "loading" ? (
                        <p className="t-xs mt-4 flex items-center justify-center gap-2" style={{ color: "var(--text-3)" }}>
                          <Loader2 className="h-3 w-3 animate-spin" /> Loading Telegram…
                        </p>
                      ) : null}

                      {widgetState === "blocked" ? (
                        <div
                          className="t-sm mt-4 rounded-xl px-3.5 py-3 leading-relaxed"
                          style={{ background: "var(--danger-dim)", border: "1px solid var(--danger-border)", color: "var(--danger)" }}
                        >
                          <p className="font-semibold">Telegram wouldn&apos;t show the button.</p>
                          <p className="mt-1" style={{ color: "var(--text-2)" }}>
                            This bot has no login domain registered. In Telegram, message{" "}
                            <span className="mono">@BotFather</span> → <span className="mono">/setdomain</span> → pick{" "}
                            <span className="mono">@{BOT_USERNAME}</span> → send{" "}
                            <span className="mono break-all">{origin || "this site's URL"}</span>.
                          </p>
                          <button onClick={() => setTab("code")} className="btn btn-ghost mt-3 w-full">
                            Use a bot code instead
                          </button>
                        </div>
                      ) : null}
                    </motion.div>
                  )}
                </AnimatePresence>

                <AnimatePresence>
                  {error ? (
                    <motion.p
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="t-sm mt-4 overflow-hidden rounded-xl px-3.5 py-2.5"
                      style={{ background: "var(--danger-dim)", border: "1px solid var(--danger-border)", color: "var(--danger)" }}
                    >
                      {error}
                    </motion.p>
                  ) : null}
                </AnimatePresence>

                {isLocalhost ? (
                  <button onClick={devLogin} className="btn btn-ghost mt-4 w-full">
                    <Check className="h-4 w-4" /> Continue as local developer
                  </button>
                ) : null}
              </div>

              {/* Owner key — deliberately quiet. */}
              {providers?.ownerKey ? (
                <div className="px-5 pb-5 sm:px-7 sm:pb-6" style={{ borderTop: "1px solid var(--border-dim)", paddingTop: 14 }}>
                  <button type="button" onClick={() => setShowOwner(v => !v)} className="link-underline t-xs mx-auto flex items-center gap-1.5">
                    <KeyRound className="h-3 w-3" />
                    {showOwner ? "Hide owner key" : "Sign in with owner key"}
                  </button>
                  <AnimatePresence>
                    {showOwner ? (
                      <motion.form
                        onSubmit={submitOwner}
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="flex gap-2 overflow-hidden pt-3"
                      >
                        <input
                          type="password"
                          placeholder="Owner key"
                          aria-label="Owner key"
                          value={ownerKey}
                          onChange={e => setOwnerKey(e.target.value)}
                          required
                          className="field flex-1"
                        />
                        <button type="submit" disabled={ownerLoading} className="btn btn-ghost shrink-0">
                          {ownerLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Go"}
                        </button>
                      </motion.form>
                    ) : null}
                  </AnimatePresence>
                </div>
              ) : null}
            </div>

            <p className="t-xs mt-4 text-center leading-relaxed" style={{ color: "var(--text-3)" }}>
              TeleDrive never sees your Telegram password. Sessions are HTTP-only cookies.
            </p>
          </motion.section>
        </div>
      </div>
    </main>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.77 24c0-1.6.27-3.15.76-4.59l-7.98-6.19A23.94 23.94 0 0 0 0 24c0 3.88.93 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
