"use client";

import { motion } from "framer-motion";
import { Cloud, HardDrive, Lock, ShieldCheck, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/button";
import { apiFetch } from "@/lib/api-client";

declare global {
  interface Window {
    onTelegramAuth?: (user: unknown) => void;
  }
}

const features = [
  { icon: Upload, label: "Bot channel for files up to 50MB" },
  { icon: Cloud, label: "Saved Messages for large media" },
  { icon: Lock, label: "HTTP-only JWT sessions" }
];

export default function Login() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [isLocalhost, setIsLocalhost] = useState(false);

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
      } catch (error) {
        setError(error instanceof Error ? error.message : "Telegram login failed. Check BOT_TOKEN and domain settings.");
      }
    };
    if (!mountRef.current || mountRef.current.dataset.loaded) return;
    mountRef.current.dataset.loaded = "true";
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.async = true;
    script.setAttribute("data-telegram-login", process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "YourBotUsername");
    script.setAttribute("data-size", "large");
    script.setAttribute("data-userpic", "true");
    script.setAttribute("data-onauth", "onTelegramAuth(user)");
    script.setAttribute("data-request-access", "write");
    mountRef.current.appendChild(script);
  }, []);

  async function devLogin() {
    try {
      await apiFetch("/api/auth/dev-login", { method: "POST" });
      window.location.href = "/drive";
    } catch (error) {
      setError(error instanceof Error ? error.message : "Local dev login is unavailable in this environment.");
    }
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-slate-950 text-white">
      {/* Floating background orbs */}
      <div className="orb orb-1" />
      <div className="orb orb-2" />
      <div className="orb orb-3" />

      {/* Subtle grid overlay */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.025)_1px,transparent_1px)] bg-[size:48px_48px]" />

      <div className="relative mx-auto grid min-h-screen max-w-6xl content-center gap-12 px-5 py-10 md:grid-cols-[1.1fr_0.9fr]">

        {/* ── Left: Hero section ── */}
        <motion.section
          className="space-y-8"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: "easeOut" }}
        >
          {/* Badge */}
          <motion.div
            className="inline-flex items-center gap-2 rounded-full border border-sky-500/25 bg-sky-500/10 px-4 py-2 text-sm text-sky-300"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <ShieldCheck className="h-4 w-4" />
            Server-side secrets, Telegram-backed storage
          </motion.div>

          {/* Logo + wordmark */}
          <motion.div
            className="flex items-center gap-3"
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.15 }}
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 shadow-lg shadow-sky-500/30">
              <HardDrive className="h-5 w-5 text-white" />
            </div>
            <span className="text-sm font-semibold tracking-widest text-slate-400 uppercase">TeleDrive</span>
          </motion.div>

          {/* Headline */}
          <div className="space-y-4">
            <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl md:text-[4.25rem] md:leading-[1.1] bg-gradient-to-br from-white via-slate-100 to-slate-400 bg-clip-text text-transparent">
              Your Personal Cloud Drive
            </h1>
            <p className="max-w-xl text-base leading-relaxed text-slate-400 sm:text-lg">
              A private, mobile-ready cloud drive with Telegram login, folder browsing, uploads,
              previews, downloads, and share links.
            </p>
          </div>

          {/* Feature cards */}
          <div className="grid max-w-2xl gap-3 grid-cols-1 sm:grid-cols-3">
            {features.map(({ icon: Icon, label }, i) => (
              <motion.div
                key={label}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.22 + i * 0.09, ease: "easeOut" }}
                whileHover={{ y: -4, scale: 1.02 }}
                className="group rounded-xl border border-white/8 bg-white/[0.04] p-4 text-sm text-slate-300 backdrop-blur-sm transition-colors duration-300 hover:border-sky-500/30 hover:bg-sky-500/8"
              >
                <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10 transition-colors duration-300 group-hover:bg-sky-500/20">
                  <Icon className="h-4 w-4 text-sky-400" />
                </div>
                {label}
              </motion.div>
            ))}
          </div>
        </motion.section>

        {/* ── Right: Login card ── */}
        <motion.section
          className="self-center"
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.55, delay: 0.18, ease: "easeOut" }}
        >
          <div className="relative rounded-2xl border border-white/10 bg-white/[0.055] p-6 shadow-2xl shadow-black/50 backdrop-blur-2xl">
            {/* Subtle glow ring */}
            <div className="pointer-events-none absolute -inset-px rounded-2xl bg-gradient-to-br from-sky-500/15 via-transparent to-blue-500/15" />

            {/* Traffic-light dots */}
            <div className="mb-5 flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-full bg-red-400/50" />
              <span className="h-3 w-3 rounded-full bg-yellow-400/50" />
              <span className="h-3 w-3 rounded-full bg-emerald-400/50" />
            </div>

            <h2 className="text-xl font-semibold text-white">Sign in with Telegram</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              After clicking the button below, confirm the login request in your Telegram app.
            </p>

            <div className="mt-6 min-h-12" ref={mountRef} />

            {error ? (
              <motion.p
                className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-400"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
              >
                {error}
              </motion.p>
            ) : null}

            {isLocalhost ? (
              <Button className="mt-5 w-full bg-sky-600 hover:bg-sky-500 shadow-lg shadow-sky-700/30" onClick={devLogin}>
                Continue locally
              </Button>
            ) : null}

            <Button
              className="mt-3 w-full border border-white/10 bg-white/8 text-slate-300 hover:bg-white/12"
              onClick={() => window.location.reload()}
            >
              Reload widget
            </Button>
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
    } catch (error) {
      lastError = error;
      await new Promise(resolve => window.setTimeout(resolve, 350 * 2 ** attempt));
    }
  }
  throw lastError;
}
