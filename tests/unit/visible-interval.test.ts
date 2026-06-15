import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startVisibleInterval,
  type VisibilityDoc,
} from "@/lib/hooks/use-visible-interval";

// P1-C: manual background polling must pause while the tab is hidden.

function fakeDoc(initial: DocumentVisibilityState = "visible") {
  let handler: (() => void) | null = null;
  const doc: VisibilityDoc & {
    _fire: () => void;
    visibilityState: DocumentVisibilityState;
  } = {
    visibilityState: initial,
    addEventListener: (_t, cb) => {
      handler = cb;
    },
    removeEventListener: () => {
      handler = null;
    },
    _fire: () => handler?.(),
  };
  return doc;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startVisibleInterval", () => {
  it("visible tab → polls on each interval", () => {
    const doc = fakeDoc("visible");
    const cb = vi.fn();
    const stop = startVisibleInterval(doc, cb, 1000);
    vi.advanceTimersByTime(3000);
    expect(cb).toHaveBeenCalledTimes(3);
    stop();
  });

  it("hidden tab → does NOT poll (no requests)", () => {
    const doc = fakeDoc("hidden");
    const cb = vi.fn();
    const stop = startVisibleInterval(doc, cb, 1000);
    vi.advanceTimersByTime(5000);
    expect(cb).not.toHaveBeenCalled(); // never started while hidden
    stop();
  });

  it("hiding mid-run pauses; becoming visible resumes (and fires once)", () => {
    const doc = fakeDoc("visible");
    const cb = vi.fn();
    const stop = startVisibleInterval(doc, cb, 1000);
    vi.advanceTimersByTime(2000); // 2 polls
    expect(cb).toHaveBeenCalledTimes(2);

    // tab hidden → pause
    doc.visibilityState = "hidden";
    doc._fire();
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(2); // no polls while hidden

    // tab visible again → immediate catch-up + resume
    doc.visibilityState = "visible";
    doc._fire();
    expect(cb).toHaveBeenCalledTimes(3); // runOnVisible
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(4); // interval resumed
    stop();
  });

  it("runOnVisible:false → no immediate fire on resume", () => {
    const doc = fakeDoc("hidden");
    const cb = vi.fn();
    const stop = startVisibleInterval(doc, cb, 1000, { runOnVisible: false });
    doc.visibilityState = "visible";
    doc._fire();
    expect(cb).not.toHaveBeenCalled(); // no immediate fire
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
  });

  it("cleanup stops the interval", () => {
    const doc = fakeDoc("visible");
    const cb = vi.fn();
    const stop = startVisibleInterval(doc, cb, 1000);
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(1); // no more after cleanup
  });
});
