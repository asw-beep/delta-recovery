"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { FlaskConical, LayoutDashboard, ListChecks, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/queue", label: "Queue", icon: ListChecks },
  { href: "/evaluation", label: "Evaluation", icon: FlaskConical },
] as const;

export function SideNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-px p-3">
      <p className="px-2 pt-1 pb-2 text-[0.6875rem] font-medium tracking-[0.09em] text-muted-foreground uppercase">
        Recovery
      </p>
      {LINKS.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "interactive relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[0.8125rem]",
              active
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon
              className={cn("size-[15px] shrink-0", active ? "opacity-100" : "opacity-70")}
              strokeWidth={2}
            />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function ThemeToggle() {
  const { setTheme } = useTheme();

  return (
    <button
      type="button"
      // The updater form reads the theme next-themes actually holds at click
      // time. Comparing a value captured during render is wrong: `resolvedTheme`
      // is undefined on the first client render, so the very first click
      // compared against undefined and re-set the theme it was already on.
      //
      // Nothing about this button's markup depends on the theme, so there is
      // still no hydration mismatch to guard and no mount flag to track.
      onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
      aria-label="Toggle colour theme"
      className="interactive flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {/* Both icons render; CSS picks one off the .dark class the provider sets. */}
      <Moon className="size-[15px] dark:hidden" strokeWidth={2} />
      <Sun className="hidden size-[15px] dark:block" strokeWidth={2} />
    </button>
  );
}

/** Mode indicator. Quiet by default — it only shouts if something is wrong. */
export function LiveDot({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[0.75rem] text-muted-foreground">
      <span className="animate-live-ring size-1.5 rounded-full bg-[var(--positive)]" />
      {label}
    </span>
  );
}
