import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// Tickets security regression (P0): inbound-secret timing-safe verify, rating
// IDOR + unverified-session scoping, customer-token emailVerified claim, CORS.

vi.mock("server-only", () => ({}));
vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn() } }));

const { ticketFindUnique, emailCfgFindUnique } = vi.hoisted(() => ({
  ticketFindUnique: vi.fn(),
  emailCfgFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    ticket: { findUnique: ticketFindUnique },
    ticketRating: {
      findUnique: vi.fn(async () => ({
        id: "r1",
        ticketId: "t1",
        score: 5,
        comment: null,
        createdAt: new Date(),
      })),
    },
    workspaceEmailConfig: { findUnique: emailCfgFindUnique },
  },
}));
// Identity crypto: make encrypt/decrypt a no-op so we test the verify LOGIC
// (the real AES round-trip is the same primitive proven in the marketing wave).
vi.mock("@/lib/services/crypto.service", () => ({
  encrypt: (s: string) => s,
  decrypt: (s: string) => s,
}));
vi.mock("@/lib/services/workspace.service", () => ({
  checkMembership: vi.fn(),
}));
vi.mock("@/lib/services/logger.service", () => ({
  logActivity: vi.fn(),
  generateSummary: vi.fn(() => ""),
}));
vi.mock("@/lib/services/tickets/customer.service", () => ({
  findOrCreateCustomer: vi.fn(),
}));

beforeAll(() => {
  process.env.CHAT_JWT_SECRET = "test-chat-secret";
});

import {
  getTicketRating,
  rateTicket,
} from "@/lib/services/tickets/rating.service";
import { verifyInboundSecret } from "@/lib/services/email/email.service";
import {
  issueCustomerToken,
  verifyCustomerToken,
} from "@/lib/services/chat/customer-token.service";
import { corsHeaders } from "@/lib/services/chat/cors";

beforeEach(() => vi.clearAllMocks());

describe("inbound webhook — verifyInboundSecret (constant-time, decrypted)", () => {
  it("enabled + correct secret → ok", async () => {
    emailCfgFindUnique.mockResolvedValue({
      enabled: true,
      inboundSecret: "s3cr3t",
    });
    expect(await verifyInboundSecret("ws", "s3cr3t")).toEqual({
      enabled: true,
      ok: true,
    });
  });
  it("wrong secret → not ok", async () => {
    emailCfgFindUnique.mockResolvedValue({
      enabled: true,
      inboundSecret: "s3cr3t",
    });
    expect(await verifyInboundSecret("ws", "nope")).toEqual({
      enabled: true,
      ok: false,
    });
  });
  it("disabled config → not ok (no ticket created)", async () => {
    emailCfgFindUnique.mockResolvedValue({
      enabled: false,
      inboundSecret: "s3cr3t",
    });
    expect((await verifyInboundSecret("ws", "s3cr3t")).ok).toBe(false);
  });
  it("missing presented secret → not ok", async () => {
    emailCfgFindUnique.mockResolvedValue({
      enabled: true,
      inboundSecret: "s3cr3t",
    });
    expect((await verifyInboundSecret("ws", null)).ok).toBe(false);
  });
  it("no config → not ok", async () => {
    emailCfgFindUnique.mockResolvedValue(null);
    expect((await verifyInboundSecret("ws", "x")).ok).toBe(false);
  });
});

describe("rating GET — IDOR + unverified-session scoping", () => {
  it("owner → returns rating", async () => {
    ticketFindUnique.mockResolvedValue({
      customerId: "c1",
      createdAt: new Date("2020-01-01"),
    });
    await expect(getTicketRating("t1", "c1")).resolves.toMatchObject({
      id: "r1",
    });
  });
  it("NON-owner → 403 (IDOR blocked)", async () => {
    ticketFindUnique.mockResolvedValue({
      customerId: "c1",
      createdAt: new Date("2020-01-01"),
    });
    await expect(getTicketRating("t1", "attacker")).rejects.toMatchObject({
      status: 403,
    });
  });
  it("owner but unverified session + ticket older than session floor → 403", async () => {
    ticketFindUnique.mockResolvedValue({
      customerId: "c1",
      createdAt: new Date("2020-01-01"),
    });
    await expect(
      getTicketRating("t1", "c1", new Date("2024-01-01")),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("missing ticket → 404", async () => {
    ticketFindUnique.mockResolvedValue(null);
    await expect(getTicketRating("t1", "c1")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("rateTicket POST: unverified session cannot rate a prior ticket → 403", async () => {
    ticketFindUnique.mockResolvedValue({
      customerId: "c1",
      status: "CLOSED",
      createdAt: new Date("2020-01-01"),
      number: 1,
      title: "x",
      workspaceId: "ws",
    });
    await expect(
      rateTicket("t1", "c1", 5, "nice", new Date("2024-01-01")),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rateTicket POST: non-owner → 403", async () => {
    ticketFindUnique.mockResolvedValue({
      customerId: "c1",
      status: "CLOSED",
      createdAt: new Date("2020-01-01"),
      number: 1,
      title: "x",
      workspaceId: "ws",
    });
    await expect(rateTicket("t1", "attacker", 5)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("customer-token — emailVerified claim", () => {
  it("ev=false issued → verify reports emailVerified false + issuedAt", async () => {
    const tok = await issueCustomerToken("c1", "ws1", "csrf", false);
    const p = await verifyCustomerToken(tok);
    expect(p?.emailVerified).toBe(false);
    expect(typeof p?.issuedAt).toBe("number");
  });
  it("default (verified) → emailVerified true", async () => {
    const tok = await issueCustomerToken("c1", "ws1", "csrf");
    expect((await verifyCustomerToken(tok))?.emailVerified).toBe(true);
  });
  it("tampered token → null", async () => {
    const tok = await issueCustomerToken("c1", "ws1");
    expect(await verifyCustomerToken(tok + "x")).toBeNull();
  });
});

describe("CORS — no arbitrary-origin reflection", () => {
  it("does NOT echo the caller origin; returns static wildcard, no credentials", () => {
    const h = corsHeaders("https://evil.example");
    expect(h["Access-Control-Allow-Origin"]).toBe("*");
    expect(h["Access-Control-Allow-Credentials"]).toBeUndefined();
  });
});
