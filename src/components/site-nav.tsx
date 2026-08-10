"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { UfoIcon, AlienIcon, StarIcon, CometIcon } from "@/components/icons";

const LINKS = [
  { href: "/", label: "Tickets", Icon: StarIcon },
  { href: "/frontier", label: "Frontier", Icon: CometIcon },
  { href: "/agents", label: "Agents", Icon: UfoIcon },
  { href: "/labels", label: "Labels", Icon: AlienIcon },
];

/**
 * Floating glass "island" nav, detached from the top edge. On small screens it
 * collapses to a hamburger whose two lines morph into an X, revealing a
 * full-screen glass overlay with staggered link reveals. The active route gets
 * an alien-teal underline glow.
 */
export function SiteNav() {
  const pathname = usePathname();

  // Layouts persist across navigation. Keying the stateful subtree by the
  // current route gives each route a closed menu without an effect-driven
  // state reset (and also handles browser back/forward navigation).
  return <RouteSiteNav key={pathname} pathname={pathname} />;
}

function RouteSiteNav({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);

  // Lock body scroll while the overlay is open.
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-40 flex justify-center px-4 pt-4">
        <nav className="glass glow-edge-pulse flex items-center gap-1 rounded-full px-2 py-1.5 shadow-[0_18px_50px_-28px_rgba(0,0,0,0.95)]">
          <Link
            href="/"
            className="group mr-1 flex items-center gap-2 rounded-full px-3 py-1.5"
          >
            <span className="animate-ufo-float flex h-7 w-7 items-center justify-center rounded-full bg-[--accent]/15 text-[--accent] ring-1 ring-[--accent]/40 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:rotate-[18deg]">
              <UfoIcon className="h-4 w-4" />
            </span>
            <span className="text-sm font-semibold tracking-tight text-[--foreground]">
              OrbitFactory
            </span>
          </Link>

          {/* Desktop links */}
          <div className="hidden items-center gap-1 md:flex">
            {LINKS.map(({ href, label, Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "group flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors duration-300",
                  isActive(href)
                    ? "text-[--foreground]"
                    : "text-[--foreground-muted] hover:text-[--foreground]",
                )}
              >
                <Icon className="h-3.5 w-3.5 transition-colors duration-300 group-hover:text-[--accent]" />
                {label}
                {isActive(href) && (
                  <span className="ml-0.5 h-1 w-1 rounded-full bg-[--accent] shadow-[0_0_8px_rgba(var(--glow),0.9)]" />
                )}
              </Link>
            ))}
          </div>

          <Link
            href="/new"
            className="group ml-1 hidden items-center gap-2 rounded-full bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-[#04121a] ring-1 ring-[color-mix(in_srgb,var(--accent)_55%,transparent)] transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-[var(--accent-hover)] active:scale-[0.97] md:inline-flex"
          >
            New
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#04121a]/15 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-px">
              <CometIcon className="h-3 w-3" />
            </span>
          </Link>

          {/* Mobile hamburger */}
          <button
            type="button"
            aria-label="Toggle menu"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="ml-1 flex h-9 w-9 items-center justify-center rounded-full text-[--foreground] hover:bg-[--surface-hover] md:hidden"
          >
            <span className={cn("hamburger", open && "open")} />
          </button>
        </nav>
      </header>

      {/*
       * Do not merely hide this menu with opacity: its links would stay in the
       * accessibility tree and Tab sequence. Mounting it only while open
       * makes the visual and keyboard states agree.
       */}
      {open && (
        <nav
          aria-label="Mobile navigation"
          className="fixed inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-[--background]/80 backdrop-blur-3xl md:hidden"
        >
          {LINKS.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-2xl px-6 py-3 text-2xl font-medium transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]",
                isActive(href) ? "text-[--accent]" : "text-[--foreground]",
              )}
            >
              <Icon className="h-5 w-5" />
              {label}
            </Link>
          ))}
          <Link
            href="/new"
            className="mt-4 flex items-center gap-2 rounded-full bg-[var(--accent)] px-6 py-3 text-lg font-medium text-[#04121a] ring-1 ring-[color-mix(in_srgb,var(--accent)_55%,transparent)] transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]"
          >
            New ticket
            <CometIcon className="h-4 w-4" />
          </Link>
        </nav>
      )}
    </>
  );
}
