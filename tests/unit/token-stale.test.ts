import { describe, it, expect } from "vitest";

// The JWT password-epoch gate (P1-A) — pure helper, no NextAuth needed.
import { isTokenPasswordStale } from "@/lib/auth-token";

describe("isTokenPasswordStale", () => {
  it("token issued before the DB password change → stale", () => {
    expect(isTokenPasswordStale(1000, 2000)).toBe(true); // changed after this token
    expect(isTokenPasswordStale(2000, 2000)).toBe(false); // same epoch (re-issued)
    expect(isTokenPasswordStale(3000, 2000)).toBe(false); // token newer than change
    expect(isTokenPasswordStale(undefined, 0)).toBe(false); // never changed
    expect(isTokenPasswordStale(undefined, 5000)).toBe(true); // legacy token, pw changed
  });
});
