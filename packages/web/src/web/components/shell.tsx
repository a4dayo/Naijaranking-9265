import { Link } from "wouter";
import { useEffect, useState } from "react";
import { useMe } from "../queries/identity";

/** Wordmark. The stacked bars read as a leaderboard at any size. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <span className="flex h-7 w-7 items-end gap-[3px] rounded-md bg-primary px-[5px] pb-[6px]">
        <span className="h-[7px] w-[3px] rounded-sm bg-primary-foreground/70" />
        <span className="h-[13px] w-[3px] rounded-sm bg-primary-foreground" />
        <span className="h-[10px] w-[3px] rounded-sm bg-accent" />
      </span>
      <span className="font-display text-[19px] leading-none font-extrabold tracking-tight">
        Naija<span className="text-primary">Rank</span>
      </span>
    </span>
  );
}

function useTheme() {
  const [dark, setDark] = useState(() => {
    try {
      const stored = localStorage.getItem("nr_theme");
      if (stored) return stored === "dark";
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("nr_theme", dark ? "dark" : "light");
    } catch {
      /* private mode */
    }
  }, [dark]);

  return [dark, () => setDark((d) => !d)] as const;
}

export function Header() {
  const [dark, toggleTheme] = useTheme();
  const { data } = useMe();
  const verified = data?.voter?.verified;

  return (
    <header className="sticky top-0 z-50 border-b border-border/70 bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
        <Link href="/" className="shrink-0">
          <Logo />
        </Link>
        <div className="flex items-center gap-1.5">
          {data?.voter ? (
            <span
              className={[
                "hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold sm:inline-flex",
                verified
                  ? "border-primary/25 bg-primary/10 text-primary"
                  : "border-border bg-muted text-muted-foreground",
              ].join(" ")}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${verified ? "bg-primary" : "bg-muted-foreground"}`}
              />
              {verified ? "Verified · full 1.0" : "Unverified · 0.25"}
            </span>
          ) : null}
          <button
            type="button"
            onClick={toggleTheme}
            aria-label="Toggle dark mode"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {dark ? (
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                <path d="M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="mt-16 border-t border-border/70 bg-card/40">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1.5">
          <Logo className="opacity-90" />
          <p className="max-w-md text-[13px] leading-relaxed">
            Crowdsourced rankings, decided by Nigerians. Counts are live, methodology is public,
            nothing here is an editorial opinion.
          </p>
        </div>
        <nav className="flex flex-wrap gap-x-5 gap-y-2 text-[13px] font-medium">
          <Link href="/legal/privacy" className="transition-colors hover:text-foreground">
            Privacy
          </Link>
          <Link href="/legal/terms" className="transition-colors hover:text-foreground">
            Terms
          </Link>
          <Link href="/legal/how-voting-works" className="transition-colors hover:text-foreground">
            How voting works
          </Link>
          <Link href="/admin" className="transition-colors hover:text-foreground">
            Operators
          </Link>
        </nav>
      </div>
    </footer>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}
