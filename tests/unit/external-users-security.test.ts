import { describe, it, expect, vi, beforeEach } from "vitest";

// external-users security (P0 #15 + P1): apiKey encrypted at rest, never
// returned plaintext, and NOT reused when the endpoint is swapped (key-theft).

vi.mock("server-only", () => ({}));

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));

// Guard always allows here — authz is covered by workspace-access tests.
vi.mock("@/lib/services/workspace-access", () => ({
  requireWorkspaceAccess: vi.fn(async () => ({})),
  accessCtxFromSession: (s: unknown) => s,
}));

// Transparent, inspectable crypto: ciphertext = "enc:" + plaintext.
vi.mock("@/lib/services/crypto.service", () => ({
  encrypt: (s: string) => (s ? `enc:${s}` : s),
  decrypt: (s: string) => (s?.startsWith("enc:") ? s.slice(4) : s),
}));

const { safeFetchMock, cfgFindUnique, cfgUpsert, cfgUpdate } = vi.hoisted(
  () => ({
    safeFetchMock: vi.fn(),
    cfgFindUnique: vi.fn(),
    cfgUpsert: vi.fn(),
    cfgUpdate: vi.fn(),
  }),
);
vi.mock("@/lib/services/kb/url-validator", () => ({
  safeFetch: safeFetchMock,
}));
vi.mock("@/lib/db", () => ({
  db: {
    externalUsersConfig: {
      findUnique: cfgFindUnique,
      upsert: cfgUpsert,
      update: cfgUpdate,
      deleteMany: vi.fn(),
    },
  },
}));

import {
  POST,
  PATCH,
  GET,
} from "@/app/api/workspaces/[id]/external-users/route";
import { GET as PROXY } from "@/app/api/workspaces/[id]/external-users/proxy/route";

const P = { params: Promise.resolve({ id: "ws-1" }) };
const post = (body: unknown) =>
  POST(
    new Request("http://t", {
      method: "POST",
      body: JSON.stringify(body),
    }) as never,
    P,
  );
const patch = (body: unknown) =>
  PATCH(
    new Request("http://t", {
      method: "PATCH",
      body: JSON.stringify(body),
    }) as never,
    P,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "USER" } });
  safeFetchMock.mockResolvedValue({
    status: 200,
    headers: new Headers(),
    finalUrl: "",
    contentType: "application/json",
    body: "[]",
  });
});

describe("POST — apiKey encrypted at rest", () => {
  it("stores ciphertext, not plaintext", async () => {
    cfgUpsert.mockResolvedValue({ isConnected: true, lastError: null });
    await post({
      apiEndpoint: "https://api.example.com",
      apiKey: "s3cret",
      authType: "bearer",
    });
    expect(cfgUpsert).toHaveBeenCalledOnce();
    const arg = cfgUpsert.mock.calls[0]![0] as {
      create: { apiKey: string };
      update: { apiKey: string };
    };
    expect(arg.create.apiKey).toBe("enc:s3cret");
    expect(arg.update.apiKey).toBe("enc:s3cret");
    // stored value is the ciphertext from encrypt(), never the raw plaintext
    expect(arg.create.apiKey).not.toBe("s3cret");
  });

  it("connection test uses the just-entered plaintext key (bearer header)", async () => {
    cfgUpsert.mockResolvedValue({ isConnected: true, lastError: null });
    await post({
      apiEndpoint: "https://api.example.com",
      apiKey: "s3cret",
      authType: "bearer",
    });
    const opts = safeFetchMock.mock.calls[0]![1] as {
      headers: Record<string, string>;
    };
    expect(opts.headers["Authorization"]).toBe("Bearer s3cret");
  });
});

describe("GET — never returns the apiKey", () => {
  it("config response has no apiKey field", async () => {
    cfgFindUnique.mockResolvedValue({
      id: "c1",
      apiEndpoint: "https://api.example.com",
      authType: "bearer",
      isConnected: true,
      lastSyncAt: null,
      lastError: null,
    });
    const res = await GET(new Request("http://t") as never, P);
    const body = await res.json();
    expect(body.config).toBeDefined();
    expect(body.config).not.toHaveProperty("apiKey");
    // the select used must not request apiKey
    const sel = cfgFindUnique.mock.calls[0]![0] as {
      select: Record<string, boolean>;
    };
    expect(sel.select.apiKey).toBeUndefined();
  });
});

describe("PATCH — key-theft: endpoint swap invalidates the saved key", () => {
  beforeEach(() => {
    cfgFindUnique.mockResolvedValue({
      apiEndpoint: "https://legit.example.com",
      apiKey: "enc:s3cret",
      authType: "bearer",
    });
    cfgUpdate.mockResolvedValue({
      id: "c1",
      apiEndpoint: "x",
      authType: "bearer",
      isConnected: false,
    });
  });

  it("changing endpoint clears apiKey + disconnects (no key reuse on new host)", async () => {
    await patch({ apiEndpoint: "https://attacker.evil.com" });
    const data = cfgUpdate.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(data.data.apiEndpoint).toBe("https://attacker.evil.com");
    expect(data.data.apiKey).toBe("");
    expect(data.data.isConnected).toBe(false);
  });

  it("same endpoint → key is NOT touched (no invalidation)", async () => {
    await patch({ apiEndpoint: "https://legit.example.com" });
    const data = cfgUpdate.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(data.data.apiKey).toBeUndefined();
    expect(data.data.isConnected).toBeUndefined();
  });

  it("authType-only change → key untouched", async () => {
    await patch({ authType: "x-api-key" });
    const data = cfgUpdate.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(data.data.apiKey).toBeUndefined();
  });
});

describe("proxy — decrypts key, sends ONLY to saved endpoint, refuses when invalidated", () => {
  it("sends DECRYPTED key as Bearer to the saved endpoint", async () => {
    cfgFindUnique.mockResolvedValue({
      apiEndpoint: "https://legit.example.com",
      apiKey: "enc:s3cret",
      authType: "bearer",
      isConnected: true,
    });
    const res = await PROXY(
      new Request("http://t/proxy?path=/users") as never,
      P,
    );
    expect(res.status).toBe(200);
    const call = safeFetchMock.mock.calls[0]!;
    const target = call[0] as string;
    const opts = call[1] as { headers: Record<string, string> };
    expect(target.startsWith("https://legit.example.com")).toBe(true);
    expect(opts.headers["Authorization"]).toBe("Bearer s3cret"); // decrypted, not "enc:s3cret"
  });

  it("after endpoint swap (apiKey cleared, disconnected) → 404, no fetch", async () => {
    cfgFindUnique.mockResolvedValue({
      apiEndpoint: "https://attacker.evil.com",
      apiKey: "",
      authType: "bearer",
      isConnected: false,
    });
    const res = await PROXY(
      new Request("http://t/proxy?path=/users") as never,
      P,
    );
    expect(res.status).toBe(404);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});
