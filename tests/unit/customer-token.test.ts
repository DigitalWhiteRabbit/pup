import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Set env before importing
process.env.NEXTAUTH_SECRET = "test-secret-for-unit-tests";

import {
  issueCustomerToken,
  verifyCustomerToken,
} from "@/lib/services/chat/customer-token.service";

describe("customer-token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues and verifies a valid token (roundtrip)", async () => {
    const token = await issueCustomerToken("cust-123", "ws-456");
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);

    const result = await verifyCustomerToken(token);
    expect(result).not.toBeNull();
    expect(result!.customerId).toBe("cust-123");
    expect(result!.workspaceId).toBe("ws-456");
  });

  it("embeds and verifies csrf claim", async () => {
    const token = await issueCustomerToken("cust-1", "ws-1", "csrf-abc");
    const result = await verifyCustomerToken(token);
    expect(result).not.toBeNull();
    expect(result!.csrf).toBe("csrf-abc");
  });

  it("returns null for invalid token", async () => {
    const result = await verifyCustomerToken("invalid.token.here");
    expect(result).toBeNull();
  });

  it("returns null for tampered token", async () => {
    const token = await issueCustomerToken("cust-1", "ws-1");
    const parts = token.split(".");
    parts[1] = parts[1] + "x";
    const tampered = parts.join(".");

    const result = await verifyCustomerToken(tampered);
    expect(result).toBeNull();
  });

  it("returns null for completely random string", async () => {
    const result = await verifyCustomerToken("just-a-random-string");
    expect(result).toBeNull();
  });
});
