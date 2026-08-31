"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { UfoIcon, OrbitIcon, SignalIcon } from "@/components/icons";

const LINKS = [
  { href: "/monitoring", label: "Monitoring", Icon: SignalIcon },
  { href: "/agents", label: "Agents", Icon: UfoIcon },
  { href: "/workflows", label: "Workflows", Icon: OrbitIcon },
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
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const restoreToggleFocus = useRef(false);

  const closeMenu = () => {
    restoreToggleFocus.current = true;
    setOpen(false);
  };

  // Lock body scroll while the overlay is open.
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    const main = document.querySelector("main");
    if (open && main) {
      main.setAttribute("inert", "");
      main.setAttribute("aria-hidden", "true");
      const firstLink = menuRef.current?.querySelector<HTMLAnchorElement>("a");
      firstLink?.focus();
    }
    return () => {
      document.body.style.overflow = "";
      main?.removeAttribute("inert");
      main?.removeAttribute("aria-hidden");
    };
  }, [open]);

  useEffect(() => {
    if (!open && restoreToggleFocus.current) {
      restoreToggleFocus.current = false;
      toggleRef.current?.focus();
    }
  }, [open]);

  const containMenuFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? []);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const isActive = (href: string) => pathname.startsWith(href);

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-40 flex justify-center px-4 pt-4">
        <nav className="glass glow-edge-pulse flex items-center gap-1 rounded-full px-2 py-1.5 shadow-[0_18px_50px_-28px_rgba(0,0,0,0.95)]">
          <Link
            href="/monitoring?tab=board"
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

          {/* Mobile hamburger */}
          <button
            ref={toggleRef}
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
          ref={menuRef}
          role="dialog"
          aria-modal="true"
          aria-label="Mobile navigation"
          onKeyDown={containMenuFocus}
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
        </nav>
      )}
    </>
  );
}
