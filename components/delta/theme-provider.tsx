"use client";

import { ThemeProvider as NextThemes } from "next-themes";

/**
 * Light is the default because Delta is meant to read as part of a Razorpay
 * account, and that dashboard is a light surface. Dark is a designed
 * alternative with its own validated chart steps, not an inversion.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemes
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      disableTransitionOnChange
    >
      {children}
    </NextThemes>
  );
}
