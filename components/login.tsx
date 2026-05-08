"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Cloud, HardDrive, Lock, MessageCircle, ShieldCheck, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/button";
import { apiFetch } from "@/lib/api-client";

declare global {
  interface Window {
    onTelegramAuth?: (user: unknown) => void;
  }
}

const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "YourBotUsername";

const features = [
  { icon: Upload, label: "Files up to 50 MB via bot channel" },
  { icon: Cloud, label: "Large media via Saved Messages" },
  { icon: Lock, label: "HTTP-only JWT sessions" }
];

export default function Login() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [isLocalhost, setIsLocalhost] = useState(false);

  // Bot code login state
  const [botCode, setBotCode] = useState("");
  const [botLoading, setBotLoading] = useState(false);

  // Telegram widget tab vs bot code tab
  const [tab, setTab] = useState<"widget" | "bot">("bot");

  // Owner key fallback
  const [showOwner, setShowOwner] = useState(false);
  const [ownerKey, setOwnerKey] = useState("");
  const [ownerLoading, setOwnerLoading] = useState(false);

  useEffect(() => {
    setIsLocalhost(["localhost", "127.0.0.1"].includes(window.location.hostname));
    window.onTelegramAuth = async (telegramUser: unknown) => {
      setError("");
      try {
        await authRequestWithRetry("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(telegramUser)
        });
        window.location.href = "/drive";
      } catch (err) {
        setError(err instanceof Error ? err.message : "Login failed. Check BOT_TOKEN and BotFather domain.");
      }
    };
  }, []);

  useEffect(() => {
    if (tab !== "widget") return;
    if (!mountRef.current || mountRef.current.dataset.loaded) return;
    mountRef.current.dataset.loaded = "true";
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.async = true;
    script.setAttribute("data-telegram-login", BOT_USERNAME);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-userpic", "true");
    script.setAttribute("data-onauth", "onTelegramAuth(user)");
    script.setAttribute("data-request-access", "write");
    mountRef.current.appendChild(script);
  }, [tab]);

  async function handleBotLogin(e: React.FormEvent) {
    e.preventDefault();
    setBotLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/bot-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: botCode.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed");
      window.location.href = "/drive";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setBotLoading(false);
    }
  }

  async function handleOwnerLogin(e: React.FormEvent) {
    e.preventDefault();
    setOwnerLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/owner-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: ownerKey })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Invalid key");
      window.location.href = "/drive";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid key");
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

  return (
    <main
      className="relative min-h-screen overflow-hidden text-white"
      style={{ background: "linear-gradient(135deg, #020617 0%, #0c1a3a 50%, #020617 100%)" }}
    >
      {/* Animated orbs */}
      <div style={{ position:"absolute", borderRadius:"50%", pointerEvents:"none", width:600, height:600, top:-180, right:-60, background:"radial-gradient(circle, rgba(56,189,248,0.45) 0%, rgba(56,189,248,0.1) 50%, transparent 70%)", filter:"blur(80px)", animation:"orb-float 9s ease-in-out infinite" }} />
      <div style={{ position:"absolute", borderRadius:"50%", pointerEvents:"none", width:500, height:500, bottom:-100, left:-60, background:"radial-gradient(circle, rgba(99,102,241,0.4) 0%, rgba(99,102,241,0.08) 50%, transparent 70%)", filter:"blur(80px)", animation:"orb-float-reverse 11s ease-in-out infinite" }} />
      <div style={{ position:"absolute", borderRadius:"50%", pointerEvents:"none", width:380, height:380, top:"50%", left:"42%", transform:"translate(-50%,-50%)", background:"radial-gradient(circle, rgba(14,165,233,0.3) 0%, rgba(14,165,233,0.05) 50%, transparent 70%)", filter:"blur(70px)", animation:"orb-pulse 7s ease-in-out infinite" }} />
      <div style={{ position:"absolute", inset:0, pointerEvents:"none", backgroundImage:"radial-gradient(rgba(148,163,184,0.07) 1px, transparent 1px)", backgroundSize:"32px 32px" }} />

      <div className="relative mx-auto grid min-h-screen max-w-6xl content-center gap-12 px-5 py-10 md:grid-cols-[1.1fr_0.9fr]">

        {/* ── Left: Hero ── */}
        <motion.section className="space-y-8" initial={{ opacity:0, y:30 }} animate={{ opacity:1, y:0 }} transition={{ duration:0.6, ease:"easeOut" }}>
          <motion.div initial={{ opacity:0, y:10 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.2 }} style={{ display:"inline-flex", alignItems:"center", gap:8, borderRadius:999, border:"1px solid rgba(56,189,248,0.3)", background:"rgba(56,189,248,0.1)", padding:"6px 16px", fontSize:13, color:"#7dd3fc" }}>
            <ShieldCheck style={{ width:15, height:15 }} />
            Server-side secrets · Telegram-backed storage
          </motion.div>

          <motion.div className="flex items-center gap-3" initial={{ opacity:0, x:-16 }} animate={{ opacity:1, x:0 }} transition={{ delay:0.25 }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"center", width:46, height:46, borderRadius:14, background:"linear-gradient(135deg, #38bdf8, #2563eb)", boxShadow:"0 8px 24px rgba(56,189,248,0.35)" }}>
              <HardDrive style={{ width:22, height:22, color:"#fff" }} />
            </div>
            <span style={{ fontSize:12, fontWeight:600, letterSpacing:"0.15em", color:"#94a3b8", textTransform:"uppercase" }}>TeleDrive Personal</span>
          </motion.div>

          <motion.div initial={{ opacity:0, y:20 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.3 }}>
            <h1 className="max-w-3xl font-bold tracking-tight" style={{ fontSize:"clamp(2.2rem, 6vw, 4.4rem)", lineHeight:1.1, background:"linear-gradient(135deg, #ffffff 0%, #cbd5e1 60%, #64748b 100%)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", backgroundClip:"text" }}>
              Your Personal Cloud Drive
            </h1>
            <p className="mt-4 max-w-xl text-base leading-relaxed sm:text-lg" style={{ color:"#94a3b8" }}>
              A private cloud drive with Telegram login, folder browsing, uploads, previews, and share links.
            </p>
          </motion.div>

          <div className="grid max-w-2xl gap-3 grid-cols-1 sm:grid-cols-3">
            {features.map(({ icon: Icon, label }, i) => (
              <motion.div key={label} initial={{ opacity:0, y:20 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.38 + i * 0.1 }} whileHover={{ y:-5, scale:1.03 }} style={{ borderRadius:14, border:"1px solid rgba(255,255,255,0.1)", background:"rgba(255,255,255,0.04)", padding:16, fontSize:13, color:"#94a3b8", backdropFilter:"blur(12px)" }}>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"center", width:34, height:34, borderRadius:9, background:"rgba(56,189,248,0.12)", marginBottom:12 }}>
                  <Icon style={{ width:16, height:16, color:"#38bdf8" }} />
                </div>
                {label}
              </motion.div>
            ))}
          </div>
        </motion.section>

        {/* ── Right: Login card ── */}
        <motion.section className="self-center" initial={{ opacity:0, y:32, scale:0.96 }} animate={{ opacity:1, y:0, scale:1 }} transition={{ duration:0.6, delay:0.2, ease:"easeOut" }}>
          <div style={{ position:"relative", borderRadius:20, border:"1px solid rgba(255,255,255,0.12)", background:"rgba(255,255,255,0.05)", backdropFilter:"blur(28px)", WebkitBackdropFilter:"blur(28px)", padding:28, boxShadow:"0 32px 80px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.08)" }}>
            <div style={{ position:"absolute", inset:-1, borderRadius:21, pointerEvents:"none", background:"linear-gradient(135deg, rgba(56,189,248,0.18) 0%, transparent 50%, rgba(99,102,241,0.12) 100%)" }} />

            {/* Traffic lights */}
            <div className="flex gap-1.5 mb-5">
              <span style={{ width:12, height:12, borderRadius:"50%", background:"rgba(248,113,113,0.6)", display:"block" }} />
              <span style={{ width:12, height:12, borderRadius:"50%", background:"rgba(251,191,36,0.6)", display:"block" }} />
              <span style={{ width:12, height:12, borderRadius:"50%", background:"rgba(52,211,153,0.6)", display:"block" }} />
            </div>

            {/* Tabs */}
            <div className="flex gap-2 mb-5" style={{ borderBottom:"1px solid rgba(255,255,255,0.08)", paddingBottom:12 }}>
              {([["bot","Via Bot Code"],["widget","Telegram Widget"]] as const).map(([id, label]) => (
                <button key={id} onClick={() => { setTab(id); setError(""); }} style={{ flex:1, padding:"7px 0", borderRadius:9, border:"none", fontSize:13, fontWeight:600, cursor:"pointer", background: tab === id ? "rgba(56,189,248,0.15)" : "transparent", color: tab === id ? "#38bdf8" : "#475569", borderBottom: tab === id ? "2px solid #38bdf8" : "2px solid transparent", transition:"all 0.2s" }}>
                  {label}
                </button>
              ))}
            </div>

            <AnimatePresence mode="wait">
              {tab === "bot" ? (
                <motion.div key="bot" initial={{ opacity:0, y:8 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-8 }} transition={{ duration:0.2 }}>
                  {/* Step instructions */}
                  <div className="space-y-3 mb-5">
                    {[
                      ["1", `Open Telegram → message @${BOT_USERNAME}`],
                      ["2", "Send any message (e.g. hi)"],
                      ["3", "Bot replies with a 6-digit code"],
                      ["4", "Paste it below and press Login"]
                    ].map(([n, text]) => (
                      <div key={n} className="flex items-start gap-3">
                        <span style={{ minWidth:22, height:22, borderRadius:"50%", background:"rgba(56,189,248,0.15)", border:"1px solid rgba(56,189,248,0.3)", color:"#38bdf8", fontSize:11, fontWeight:700, display:"flex", alignItems:"center", justifyContent:"center" }}>{n}</span>
                        <span style={{ fontSize:13, color:"#94a3b8", lineHeight:1.5 }}>{text}</span>
                      </div>
                    ))}
                  </div>

                  {/* Open bot button */}
                  <a href={`https://t.me/${BOT_USERNAME}`} target="_blank" rel="noopener noreferrer" style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8, width:"100%", padding:"10px 0", borderRadius:11, background:"linear-gradient(135deg, rgba(56,189,248,0.2), rgba(37,99,235,0.2))", border:"1px solid rgba(56,189,248,0.3)", color:"#7dd3fc", fontSize:14, fontWeight:600, textDecoration:"none", marginBottom:14 }}>
                    <MessageCircle style={{ width:16, height:16 }} />
                    Open @{BOT_USERNAME}
                  </a>

                  {/* Code input */}
                  <form onSubmit={handleBotLogin} className="flex gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      placeholder="6-digit code"
                      value={botCode}
                      onChange={e => setBotCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      required
                      style={{ flex:1, borderRadius:10, border:"1px solid rgba(255,255,255,0.12)", background:"rgba(255,255,255,0.06)", color:"#e2e8f0", padding:"10px 14px", fontSize:18, fontWeight:700, letterSpacing:"0.3em", outline:"none", textAlign:"center" }}
                    />
                    <button type="submit" disabled={botLoading || botCode.length < 6} style={{ borderRadius:10, border:"none", background: botCode.length === 6 ? "#0284c7" : "rgba(255,255,255,0.08)", color: botCode.length === 6 ? "#fff" : "#475569", padding:"10px 20px", fontSize:14, fontWeight:700, cursor: botCode.length === 6 ? "pointer" : "not-allowed", transition:"all 0.2s", minWidth:70 }}>
                      {botLoading ? "…" : "Login"}
                    </button>
                  </form>
                </motion.div>
              ) : (
                <motion.div key="widget" initial={{ opacity:0, y:8 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-8 }} transition={{ duration:0.2 }}>
                  <p className="text-sm mb-4 leading-relaxed" style={{ color:"#64748b" }}>
                    Click the button → enter your phone → confirm in your Telegram app.
                  </p>
                  <div className="min-h-12" ref={mountRef} />
                  <Button className="mt-3 w-full" style={{ background:"rgba(255,255,255,0.07)", color:"#94a3b8", border:"1px solid rgba(255,255,255,0.1)" }} onClick={() => window.location.reload()}>
                    Reload widget
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Shared error */}
            {error ? (
              <motion.p className="mt-4 rounded-xl text-sm px-3 py-2.5" style={{ background:"rgba(239,68,68,0.1)", border:"1px solid rgba(239,68,68,0.25)", color:"#fca5a5" }} initial={{ opacity:0, y:4 }} animate={{ opacity:1, y:0 }}>
                {error}
              </motion.p>
            ) : null}

            {isLocalhost ? (
              <Button className="mt-4 w-full" style={{ background:"#0284c7", color:"#fff", border:"none" }} onClick={devLogin}>
                Continue locally
              </Button>
            ) : null}

            {/* Owner key fallback */}
            <div className="mt-5" style={{ borderTop:"1px solid rgba(255,255,255,0.07)", paddingTop:14 }}>
              <button type="button" onClick={() => setShowOwner(v => !v)} style={{ background:"none", border:"none", padding:0, cursor:"pointer", fontSize:12, color:"#334155", width:"100%", textAlign:"center" }}>
                {showOwner ? "▲ hide" : "Use owner key instead →"}
              </button>
              {showOwner && (
                <motion.form onSubmit={handleOwnerLogin} className="mt-3 flex gap-2" initial={{ opacity:0, y:-6 }} animate={{ opacity:1, y:0 }}>
                  <input type="password" placeholder="Owner key…" value={ownerKey} onChange={e => setOwnerKey(e.target.value)} required style={{ flex:1, borderRadius:10, border:"1px solid rgba(255,255,255,0.12)", background:"rgba(255,255,255,0.06)", color:"#e2e8f0", padding:"8px 12px", fontSize:14, outline:"none" }} />
                  <button type="submit" disabled={ownerLoading} style={{ borderRadius:10, border:"none", background:"#0284c7", color:"#fff", padding:"8px 16px", fontSize:14, fontWeight:600, cursor:ownerLoading ? "not-allowed" : "pointer", opacity:ownerLoading ? 0.6 : 1 }}>
                    {ownerLoading ? "…" : "Go"}
                  </button>
                </motion.form>
              )}
            </div>
          </div>
        </motion.section>
      </div>
    </main>
  );
}

async function authRequestWithRetry(input: RequestInfo | URL, init: RequestInit, attempts = 3) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await apiFetch(input, init);
    } catch (err) {
      lastError = err;
      await new Promise(resolve => window.setTimeout(resolve, 350 * 2 ** attempt));
    }
  }
  throw lastError;
}
