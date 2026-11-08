import type { Metadata } from "next";
import localFont from "next/font/local";
import { Toaster } from "sonner";
import { ServiceWorkerRegister } from "@/components/sw-register";
import "./globals.css";

// Syne carries the brand voice in headlines; Inter does the reading work; the
// mono face is reserved for sizes, counts and other metadata.
//
// Self-hosted rather than `next/font/google`, because that loader fetches the
// stylesheet from Google at *build* time and parses a woff2 URL out of it.
// Google serves woff2 only to a user agent it recognises, and when it decides
// it does not recognise Next's, it answers with TTF instead — at which point
// the loader's match returns null and the whole build dies with
// `TypeError: Cannot read properties of null (reading '1')`, nowhere near
// anything you changed. A build should not depend on a third party's user
// agent sniffing, so the files live here.
//
// Variable faces, latin and latin-ext only: the full set is mostly Cyrillic,
// Greek and Vietnamese, which this UI never renders. 232 KB for all three.
const syne = localFont({
  src: [
    { path: "./fonts/Syne-latin.woff2", style: "normal" },
    { path: "./fonts/Syne-latin-ext.woff2", style: "normal" }
  ],
  weight: "400 800",
  variable: "--font-display",
  display: "swap",
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"]
});
const inter = localFont({
  src: [
    { path: "./fonts/Inter-latin.woff2", style: "normal" },
    { path: "./fonts/Inter-latin-ext.woff2", style: "normal" }
  ],
  weight: "100 900",
  variable: "--font-sans",
  display: "swap",
  fallback: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"]
});
const jetbrainsMono = localFont({
  src: [
    { path: "./fonts/JetBrainsMono-latin.woff2", style: "normal" },
    { path: "./fonts/JetBrainsMono-latin-ext.woff2", style: "normal" }
  ],
  weight: "100 800",
  variable: "--font-mono",
  display: "swap",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"]
});

export const metadata: Metadata = {
  title: "TeleDrive — your personal cloud on Telegram",
  description: "A private cloud drive that stores every file in your own Telegram account.",
  manifest: "/manifest.json",
  // iOS ignores the manifest's icons entirely and reads apple-touch-icon, so
  // without this the home-screen icon is a screenshot of the page.
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { url: "/icon.svg", type: "image/svg+xml" }
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }]
  },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "TeleDrive" }
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  // Pinch-zoom stays available — capping it is an accessibility failure.
  viewportFit: "cover" as const,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#08090d" },
    { media: "(prefers-color-scheme: light)", color: "#fbfcfe" }
  ]
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`dark ${syne.variable} ${inter.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        {/* Theme and accent before first paint, so neither flashes. The
            palette is duplicated here on purpose: this runs before any module
            loads, and the alternative is a visible repaint on every visit.
            lib/preferences.ts holds the copy everything else reads. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var p={};try{p=JSON.parse(localStorage.getItem('teledrive:prefs'))||{}}catch(e){}var t=p.theme||localStorage.getItem('teledrive-theme')||'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);var A={"cyan":{"dark":["#22d3ee","#818cf8"],"light":["#0891b2","#6366f1"]},"violet":{"dark":["#a78bfa","#f472b6"],"light":["#7c3aed","#db2777"]},"emerald":{"dark":["#34d399","#22d3ee"],"light":["#059669","#0891b2"]},"amber":{"dark":["#fbbf24","#fb7185"],"light":["#d97706","#e11d48"]},"rose":{"dark":["#fb7185","#a78bfa"],"light":["#e11d48","#7c3aed"]},"blue":{"dark":["#60a5fa","#22d3ee"],"light":["#2563eb","#0891b2"]}};var c=(A[p.accent]||A.cyan)[d?'dark':'light'];var r=document.documentElement.style;r.setProperty('--accent',c[0]);r.setProperty('--accent-2',c[1]);r.setProperty('--accent-dim','color-mix(in srgb, '+c[0]+' 10%, transparent)');r.setProperty('--accent-border','color-mix(in srgb, '+c[0]+' 25%, transparent)');r.setProperty('--accent-grad','linear-gradient(135deg, '+c[0]+' 0%, '+c[1]+' 100%)');if(p.reduceMotion)document.documentElement.setAttribute('data-reduce-motion','1');}catch(e){}})();`
          }}
        />
      </head>
      <body>
        {children}
        <Toaster richColors position="top-center" toastOptions={{ duration: 4000 }} />
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
