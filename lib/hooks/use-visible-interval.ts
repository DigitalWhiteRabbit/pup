"use client";
import { useEffect, useRef } from "react";

/** Minimal slice of `document` this needs (also lets us unit-test in node). */
export type VisibilityDoc = {
  visibilityState: DocumentVisibilityState;
  addEventListener: (type: "visibilitychange", cb: () => void) => void;
  removeEventListener: (type: "visibilitychange", cb: () => void) => void;
};

/**
 * Start an interval that PAUSES while `doc` is hidden and resumes when visible
 * (firing once immediately on resume if runOnVisible). Returns a cleanup fn.
 * Pure (no React/globals) → unit-testable.
 */
export function startVisibleInterval(
  doc: VisibilityDoc,
  callback: () => void,
  intervalMs: number,
  opts: { runOnVisible?: boolean } = {},
): () => void {
  const { runOnVisible = true } = opts;
  let timer: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    if (timer == null) timer = setInterval(callback, intervalMs);
  };
  const stop = () => {
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const onVisibility = () => {
    if (doc.visibilityState === "visible") {
      if (runOnVisible) callback();
      start();
    } else {
      stop();
    }
  };
  if (doc.visibilityState === "visible") start();
  doc.addEventListener("visibilitychange", onVisibility);
  return () => {
    stop();
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * setInterval that PAUSES while the browser tab is hidden, so a backgrounded
 * tab doesn't keep hitting the server. For MANUAL background polling.
 * (React Query's refetchInterval already pauses on hidden.) Do NOT use for
 * active-realtime keepalives like voice/WebRTC heartbeats — pausing those would
 * drop the user from a live session.
 */
export function useVisibleInterval(
  callback: () => void,
  intervalMs: number,
  opts: { enabled?: boolean; runOnVisible?: boolean } = {},
): void {
  const { enabled = true, runOnVisible = true } = opts;
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;
    if (typeof document === "undefined") return;
    return startVisibleInterval(document, () => cbRef.current(), intervalMs, {
      runOnVisible,
    });
  }, [enabled, intervalMs, runOnVisible]);
}
