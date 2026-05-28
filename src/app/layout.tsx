import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import { MobileNotice } from "@simple-harmonic/frontend/components/mobile-notice";
import { THEME_INIT_SCRIPT, ThemeProvider } from "@simple-harmonic/frontend/components/theme-provider";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-mono",
  weight: ["300", "400", "500", "600"],
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Simple Harmonic",
  description: "Your company, built by agents, run by agents, managed by agents (with you)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${ibmPlexMono.variable} h-full antialiased`}
      // suppressHydrationWarning: the init script flips the .dark class before
      // React hydrates, intentionally diverging from the SSR markup.
      suppressHydrationWarning
    >
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: theme init must run before paint
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          <MobileNotice />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
