import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("@/lib/services/chat/persona-rotation.service", () => ({
  getActivePersona: vi.fn().mockResolvedValue(null),
  getActivePersonas: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/services/workspace.service", () => ({
  checkMembership: vi.fn().mockResolvedValue("OWNER"),
}));

vi.mock("@/lib/services/logger.service", () => ({
  logActivity: vi.fn(),
  generateSummary: vi.fn().mockReturnValue("test summary"),
}));

import { getPublicChatConfig } from "@/lib/services/chat/chat-config.service";

describe("getPublicChatConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns config for valid workspace with tickets enabled", async () => {
    mockWorkspaceFindUnique.mockResolvedValue({
      id: "ws1",
      name: "Test Workspace",
      chatTitle: "Custom Title",
      chatSubtitle: "Custom Sub",
      chatAccentColor: "#ff0000",
      chatLogoUrl: null,
      chatIdentityMethod: "EMAIL_WITH_NAME",
      chatPersonaRotation: true,
      chatAllowedEmbedOrigins: null,
      chatTimezone: "Europe/Moscow",
      modules: [{ enabled: true }],
    });

    const config = await getPublicChatConfig("test-slug");
    expect(config.workspaceName).toBe("Test Workspace");
    expect(config.chatTitle).toBe("Custom Title");
    expect(config.chatSubtitle).toBe("Custom Sub");
    expect(config.chatAccentColor).toBe("#ff0000");
    expect(config.identityMethod).toBe("EMAIL_WITH_NAME");
  });

  it("uses fallback title when chatTitle is null", async () => {
    mockWorkspaceFindUnique.mockResolvedValue({
      id: "ws2",
      name: "My WS",
      chatTitle: null,
      chatSubtitle: null,
      chatAccentColor: null,
      chatLogoUrl: null,
      chatIdentityMethod: "EMAIL_WITH_NAME",
      chatPersonaRotation: true,
      chatAllowedEmbedOrigins: null,
      chatTimezone: "Europe/Moscow",
      modules: [{ enabled: true }],
    });

    const config = await getPublicChatConfig("my-ws");
    expect(config.chatTitle).toBe("Поддержка My WS");
    expect(config.chatSubtitle).toBe("Мы отвечаем быстро");
    expect(config.chatAccentColor).toBe("#22c55e");
  });

  it("throws 404 when slug not found", async () => {
    mockWorkspaceFindUnique.mockResolvedValue(null);

    await expect(getPublicChatConfig("nonexistent")).rejects.toThrow(
      "Не найдено",
    );
  });

  it("throws 404 when tickets module is disabled", async () => {
    mockWorkspaceFindUnique.mockResolvedValue({
      id: "ws3",
      name: "No Tickets",
      modules: [{ enabled: false }],
    });

    await expect(getPublicChatConfig("no-tickets")).rejects.toThrow(
      "Не найдено",
    );
  });

  it("throws 404 when tickets module is missing", async () => {
    mockWorkspaceFindUnique.mockResolvedValue({
      id: "ws4",
      name: "No Module",
      modules: [],
    });

    await expect(getPublicChatConfig("no-module")).rejects.toThrow(
      "Не найдено",
    );
  });
});
