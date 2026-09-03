import type { Metadata } from "next";
import { Syne, Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { ServiceWorkerRegister } from "@/components/sw-register";
import "./globals.css";

// Syne carries the brand voice in headlines; Inter does the reading work; the
// mono face is reserved for sizes, counts and other metadata.
const syne = Syne({ subsets: ["latin"], weight: ["600", "700", "800"], variable: "--font-display", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "TeleDrive — your personal cloud on Telegram",
  description: "A private cloud drive that stores every file in your own Telegram account.",
  manifest: "/manifest.json",
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
