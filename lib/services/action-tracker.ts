"use client";

// ─── Client-side action tracker ─────────────────────────────────────────────
// Buffers user actions and flushes them to the server in batches.
// Lightweight: no React dependencies, pure module-level state.

type ActionEvent = {
  action: string; // "page_view", "button_click", "module_open", etc.
  target: string; // "marketing:leads", "crm:task:create", etc.
  details?: string; // Optional extra info
  timestamp: number;
};

const buffer: ActionEvent[] = [];
const FLUSH_INTERVAL = 10_000; // 10 seconds
const FLUSH_SIZE = 20;

let _flushTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Track a user action. Batched and sent to /api/activity-log.
 *
 * @param action - Action type: "page_view", "button_click", "module_open", etc.
 * @param target - Target identifier: "crm:task:create", pathname, etc.
 * @param details - Optional extra info
 */
export function trackAction(
  action: string,
  target: string,
  details?: string,
): void {
  buffer.push({ action, target, details, timestamp: Date.now() });
  if (buffer.length >= FLUSH_SIZE) {
    void flush();
  }
}

async function flush(): Promise<void> {
  if (buffer.length === 0) return;
  const events = buffer.splice(0, buffer.length);
  try {
    await fetch("/api/activity-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    });
  } catch {
    // Re-add failed events to front of buffer (will retry next flush)
    buffer.unshift(...events);
  }
}

// Auto-flush every 10 seconds + on page unload
if (typeof window !== "undefined") {
  _flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL);

  window.addEventListener("beforeunload", () => {
    // Use sendBeacon for reliable delivery on unload
    if (buffer.length === 0) return;
    const events = buffer.splice(0, buffer.length);
    const blob = new Blob([JSON.stringify({ events })], {
      type: "application/json",
    });
    navigator.sendBeacon("/api/activity-log", blob);
  });

  // Also flush on visibility change (tab switch / minimize)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void flush();
    }
  });
}
