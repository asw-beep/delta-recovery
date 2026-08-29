import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/delta/theme-provider";
import "./globals.css";

// Blade specifies Inter for web. Identifiers and money get a mono face so
// columns of digits line up and a payment id never re-wraps mid-token.
const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

const DESCRIPTION =
  "Detects money at risk, decides whether contacting the customer earns an incremental rupee, and measures what was actually recovered.";

// The submission is a link someone else opens — in a chat, a tab, a review
// thread. Without these it unfurls as a bare URL, which reads as unfinished
// next to entries that bothered.
export const metadata: Metadata = {
  title: "Delta — revenue recovery",
  description: DESCRIPTION,
  applicationName: "Delta",
  metadataBase: new URL("https://delta-recovery-aswin-s-projects-c3bce5f6.vercel.app"),
  openGraph: {
    title: "Delta — revenue recovery that skips the money already coming back",
    description: DESCRIPTION,
    siteName: "Delta",
    type: "website",
    locale: "en_IN",
  },
  twitter: {
    card: "summary_large_image",
    title: "Delta — revenue recovery",
    description: DESCRIPTION,
  },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${mono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
