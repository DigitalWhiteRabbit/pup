import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SLA cron endpoint (P1-B): replaces the in-process setInterval. CRON_SECRET
// timing-safe gate, mirrors content-autopublish.

vi.mock("server-only", () => ({}));

const { checkSlaBreaches } = vi.hoisted(() => ({
  checkSlaBreaches: vi.fn(),
}));
vi.mock("@/lib/services/tickets/sla-check.service", () => ({
  checkSlaBreaches,
}));

import { POST } from "@/app/api/cron/sla-check/route";

const req = (auth?: string) =>
  new Request("http://t/api/cron/sla-check", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  }) as never;

const ORIG = process.env.CRON_SECRET;
beforeEach(() => {
  vi.clearAllMocks();
  checkSlaBreaches.mockResolvedValue({ checked: 3, breached: 1 });
});
afterEach(() => {
  if (ORIG === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIG;
});

describe("POST /api/cron/sla-check", () => {
  it("CRON_SECRET not set → 503, does not run", async () => {
    delete process.env.CRON_SECRET;
    const res = await POST(req("Bearer whatever"));
    expect(res.status).toBe(503);
    expect(checkSlaBreaches).not.toHaveBeenCalled();
  });

  it("wrong secret → 403, does not run", async () => {
    process.env.CRON_SECRET = "right";
    const res = await POST(req("Bearer wrong"));
    expect(res.status).toBe(403);
    expect(checkSlaBreaches).not.toHaveBeenCalled();
  });

  it("missing Authorization → 403", async () => {
    process.env.CRON_SECRET = "right";
    const res = await POST(req());
    expect(res.status).toBe(403);
  });

  it("correct secret → 200 + summary, runs the check", async () => {
    process.env.CRON_SECRET = "right";
    const res = await POST(req("Bearer right"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checked: 3, breached: 1 });
    expect(checkSlaBreaches).toHaveBeenCalledOnce();
  });

  it("check throws → 500", async () => {
    process.env.CRON_SECRET = "right";
    checkSlaBreaches.mockRejectedValue(new Error("db down"));
    const res = await POST(req("Bearer right"));
    expect(res.status).toBe(500);
  });
});
