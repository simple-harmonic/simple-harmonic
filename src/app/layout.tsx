import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { MobileNotice } from "@/components/mobile-notice";
import { THEME_INIT_SCRIPT, ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
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
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
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
