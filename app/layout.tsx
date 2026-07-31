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
        {/* Apply the saved theme before first paint so there is no flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('teledrive-theme')||'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`
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
