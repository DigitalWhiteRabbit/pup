import { describe, it, expect } from "vitest";
import { computeReorderedIds } from "@/lib/services/task-order";

// CRM reorder math (P1-B): the deterministic recompute that — run inside a
// transaction — keeps concurrent drag-drops from corrupting column order.

const noDupes = (a: string[]) => new Set(a).size === a.length;

describe("computeReorderedIds", () => {
  it("moves a task forward to the target index", () => {
    expect(computeReorderedIds(["a", "b", "c", "d"], "a", 2)).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("moves a task backward to the target index", () => {
    expect(computeReorderedIds(["a", "b", "c", "d"], "d", 1)).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("clamps an out-of-range index to the end", () => {
    expect(computeReorderedIds(["a", "b", "c"], "a", 99)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("clamps a negative index to the front", () => {
    expect(computeReorderedIds(["a", "b", "c"], "c", -5)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("inserts a task new to the column at the target index", () => {
    // cross-column move: task X not yet in this column's list
    expect(computeReorderedIds(["a", "b"], "x", 1)).toEqual(["a", "x", "b"]);
  });

  it("never produces duplicates or gaps; result is a permutation", () => {
    const col = ["a", "b", "c", "d", "e"];
    for (let i = -1; i <= col.length + 1; i++) {
      const out = computeReorderedIds(col, "c", i);
      expect(out.length).toBe(col.length);
      expect(noDupes(out)).toBe(true);
      expect([...out].sort()).toEqual([...col].sort());
    }
  });

  it("two SEQUENTIAL reorders (as a transaction serializes them) stay consistent", () => {
    // Simulates the race resolved by the transaction: each op recomputes from
    // the current order, so the final order is gap-free with no duplicates.
    let order = ["a", "b", "c"];
    order = computeReorderedIds(order, "a", 1); // A→1
    order = computeReorderedIds(order, "c", 0); // C→0
    expect(noDupes(order)).toBe(true);
    expect([...order].sort()).toEqual(["a", "b", "c"]);
    expect(order).toEqual(["c", "b", "a"]);
  });
});
