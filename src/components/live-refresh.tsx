"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export const LIVE_REFRESH_INTERVAL_MS = 4_000;

/**
 * Keeps a server-rendered view current without doing a full page reload.
 * Next merges the refreshed Server Component payload into the existing tree,
 * preserving client state, browser scroll position, and in-progress form input.
 *
 * Hidden tabs do no work. Returning to a visible tab refreshes immediately,
 * then resumes the normal interval so changes made while away appear at once.
 */
export function LiveRefresh({
  intervalMs = LIVE_REFRESH_INTERVAL_MS,
}: {
  intervalMs?: number;
}) {
  const router = useRouter();

  useEffect(() => {
    let intervalId: number | undefined;

    const stop = () => {
      if (intervalId === undefined) return;
      window.clearInterval(intervalId);
      intervalId = undefined;
    };

    const start = () => {
      if (
        intervalId !== undefined ||
        document.visibilityState !== "visible"
      ) {
        return;
      }
      intervalId = window.setInterval(() => {
        router.refresh();
      }, intervalMs);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
        start();
      } else {
        stop();
      }
    };

    start();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [intervalMs, router]);

  return null;
}
