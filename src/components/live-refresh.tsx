"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { parseStateEvent } from "@/lib/state-events";

/**
 * Re-fetches the authoritative Server Component snapshot after a state-stream
 * wake-up. The stream has no replay contract, so opening and reconnecting are
 * also explicit snapshot boundaries.
 */
export function LiveRefresh() {
  const router = useRouter();

  useEffect(() => {
    const stream = new EventSource("/api/state-stream");
    const refreshSnapshot = () => router.refresh();
    const onState = (event: MessageEvent<string>) => {
      try {
        if (parseStateEvent(JSON.parse(event.data))) refreshSnapshot();
      } catch {
        // Invalid stream data cannot change client state or authorize a write.
      }
    };

    stream.addEventListener("open", refreshSnapshot);
    stream.addEventListener("state", onState as EventListener);

    return () => {
      stream.removeEventListener("open", refreshSnapshot);
      stream.removeEventListener("state", onState as EventListener);
      stream.close();
    };
  }, [router]);

  return null;
}
