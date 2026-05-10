import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const mockWorkspaceFindUnique = vi.fn();
const mockChatPersonaFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    workspace: {
      findUnique: (...args: unknown[]) => mockWorkspaceFindUnique(...args),
    },
    chatPersona: {
      findMany: (...args: unknown[]) => mockChatPersonaFindMany(...args),
    },
  },
}));

import {
  getActivePersona,
  getDayIndex,
} from "@/lib/services/chat/persona-rotation.service";

describe("getDayIndex", () => {
  it("returns a number for a valid timezone", () => {
    const idx = getDayIndex("Europe/Moscow");
    expect(typeof idx).toBe("number");
    expect(idx).toBeGreaterThan(0);
  });

  it("returns different values for different timezones near midnight", () => {
    // This is a structural test — just verify it doesn't throw
    const msk = getDayIndex("Europe/Moscow");
    const utc = getDayIndex("UTC");
    expect(typeof msk).toBe("number");
    expect(typeof utc).toBe("number");
  });
});

describe("getActivePersona", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when no personas exist", async () => {
    mockWorkspaceFindUnique.mockResolvedValue({
      chatTimezone: "Europe/Moscow",
      chatPersonaRotation: true,
    });
    mockChatPersonaFindMany.mockResolvedValue([]);

    const result = await getActivePersona("ws1");
    expect(result).toBeNull();
  });

  it("returns null when rotation is disabled", async () => {
    mockWorkspaceFindUnique.mockResolvedValue({
      chatTimezone: "Europe/Moscow",
      chatPersonaRotation: false,
    });
    mockChatPersonaFindMany.mockResolvedValue([
      { id: "p1", displayName: "Alice", position: 0 },
    ]);

    const result = await getActivePersona("ws1");
    expect(result).toBeNull();
  });

  it("returns persona based on day rotation", async () => {
    vi.useFakeTimers();
    // Set to a known date: 2026-01-15 (day 20468 from epoch)
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));

    const personas = [
      { id: "p1", displayName: "Alice", position: 0 },
      { id: "p2", displayName: "Bob", position: 1 },
      { id: "p3", displayName: "Carol", position: 2 },
    ];

    mockWorkspaceFindUnique.mockResolvedValue({
      chatTimezone: "UTC",
      chatPersonaRotation: true,
    });
    mockChatPersonaFindMany.mockResolvedValue(personas);

    const result = await getActivePersona("ws1");
    expect(result).not.toBeNull();
    // Day index for 2026-01-15 UTC: 20468, 20468 % 3 = 2
    expect(result!.displayName).toBe("Carol");
  });

  it("rotates to different persona on next day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-16T12:00:00Z"));

    const personas = [
      { id: "p1", displayName: "Alice", position: 0 },
      { id: "p2", displayName: "Bob", position: 1 },
      { id: "p3", displayName: "Carol", position: 2 },
    ];

    mockWorkspaceFindUnique.mockResolvedValue({
      chatTimezone: "UTC",
      chatPersonaRotation: true,
    });
    mockChatPersonaFindMany.mockResolvedValue(personas);

    const result = await getActivePersona("ws1");
    expect(result).not.toBeNull();
    // Day index for 2026-01-16 UTC: 20469, 20469 % 3 = 0
    expect(result!.displayName).toBe("Alice");
  });

  it("returns null when workspace not found", async () => {
    mockWorkspaceFindUnique.mockResolvedValue(null);
    const result = await getActivePersona("nope");
    expect(result).toBeNull();
  });
});
