"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { Activity, FlaskConical, LayoutDashboard, ListChecks, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/queue", label: "Queue", icon: ListChecks },
  { href: "/evaluation", label: "Evaluation", icon: FlaskConical },
] as const;

export function SideNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5 p-3">
      {LINKS.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "interactive relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {/* Razorpay marks the active item with a flush left rule. */}
            {active && (
              <span
                aria-hidden
                className="animate-sweep absolute top-1.5 bottom-1.5 -left-3 w-0.5 rounded-r bg-[var(--sidebar-primary)]"
              />
            )}
            <Icon className="size-4 shrink-0" strokeWidth={2} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <button
      type="button"
      // Read the theme at click time, not render time. Nothing about this
      // button's markup depends on the theme, so there is no hydration mismatch
      // to guard against and no mount flag to track.
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      aria-label="Toggle colour theme"
      className="interactive flex size-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {/* Both icons render; CSS picks one off the .dark class the provider sets. */}
      <Moon className="size-4 dark:hidden" strokeWidth={2} />
      <Sun className="hidden size-4 dark:block" strokeWidth={2} />
    </button>
  );
}

/** Small heartbeat so the surface reads as connected to a live account. */
export function LiveDot({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border bg-card px-2.5 py-1 text-xs text-muted-foreground">
      <span className="animate-live-ring size-1.5 rounded-full bg-[var(--positive)]" />
      <Activity className="size-3" strokeWidth={2} />
      {label}
    </span>
  );
}
