import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "../workspace.service";
import { logActivity, generateSummary } from "../logger.service";
import type { TicketMessageAuthorType } from "@prisma/client";

// ─── Agent config CRUD ──────────────────────────────────────────────────────

export type AgentConfigView = {
  id: string;
  enabled: boolean;
  mode: string;
  model: string;
  temperature: number;
  systemPrompt: string | null;
  greeting: string | null;
  guardrails: string | null;
  handoffThreshold: number;
  autoResolve: boolean;
  autoFaq: boolean;
  autoContactNotes: boolean;
};

export type ScenarioView = {
  id: string;
  title: string;
  description: string;
  instruction: string;
  enabled: boolean;
  position: number;
};

export async function getAgentConfig(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<AgentConfigView | null> {
  const m = await checkMembership(workspaceId, userId);
  if (m !== "OWNER" && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const cfg = await db.agentConfig.findUnique({ where: { workspaceId } });
  if (!cfg) return null;

  return {
    id: cfg.id,
    enabled: cfg.enabled,
    mode: cfg.mode,
    model: cfg.model,
    temperature: cfg.temperature,
    systemPrompt: cfg.systemPrompt,
    greeting: cfg.greeting,
    guardrails: cfg.guardrails,
    handoffThreshold: cfg.handoffThreshold,
    autoResolve: cfg.autoResolve,
    autoFaq: cfg.autoFaq,
    autoContactNotes: cfg.autoContactNotes,
  };
}

export async function updateAgentConfig(
  workspaceId: string,
  data: Partial<Omit<AgentConfigView, "id">>,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<void> {
  const m = await checkMembership(workspaceId, userId);
  if (m !== "OWNER" && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  await db.agentConfig.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      enabled: data.enabled ?? false,
      mode: data.mode ?? "copilot",
      model: data.model ?? "gpt-4o-mini",
      temperature: data.temperature ?? 0.3,
      systemPrompt: data.systemPrompt ?? null,
      greeting: data.greeting ?? null,
      guardrails: data.guardrails ?? null,
      handoffThreshold: data.handoffThreshold ?? 0.7,
      autoResolve: data.autoResolve ?? false,
      autoFaq: data.autoFaq ?? false,
      autoContactNotes: data.autoContactNotes ?? false,
    },
    update: data,
  });

  void logActivity({
    workspaceId,
    actorId: userId,
    action: "AGENT_CONFIG_UPDATED",
    entityType: "AgentConfig",
    summary: generateSummary("AGENT_CONFIG_UPDATED", {}),
    metadata: { enabled: data.enabled, mode: data.mode },
  });
}

// ─── Scenarios CRUD ─────────────────────────────────────────────────────────

export async function listScenarios(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<ScenarioView[]> {
  const m = await checkMembership(workspaceId, userId);
  if (!m && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const cfg = await db.agentConfig.findUnique({
    where: { workspaceId },
    select: { id: true },
  });
  if (!cfg) return [];

  return db.agentScenario.findMany({
    where: { agentId: cfg.id },
    orderBy: { position: "asc" },
  });
}

export async function createScenario(
  workspaceId: string,
  input: { title: string; description: string; instruction: string },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<ScenarioView> {
  const m = await checkMembership(workspaceId, userId);
  if (m !== "OWNER" && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  let cfg = await db.agentConfig.findUnique({
    where: { workspaceId },
    select: { id: true },
  });
  if (!cfg) {
    cfg = await db.agentConfig.create({
      data: { workspaceId },
      select: { id: true },
    });
  }

  const maxPos = await db.agentScenario.findFirst({
    where: { agentId: cfg.id },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const scenario = await db.agentScenario.create({
    data: {
      agentId: cfg.id,
      title: input.title,
      description: input.description,
      instruction: input.instruction,
      position: (maxPos?.position ?? -1) + 1,
    },
  });

  void logActivity({
    workspaceId,
    actorId: userId,
    action: "AGENT_SCENARIO_CREATED",
    entityType: "AgentScenario",
    entityId: scenario.id,
    summary: generateSummary("AGENT_SCENARIO_CREATED", {
      kbArticleTitle: scenario.title,
    }),
    metadata: { title: scenario.title },
  });

  return scenario;
}

export async function deleteScenario(
  scenarioId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<void> {
  const scenario = await db.agentScenario.findUnique({
    where: { id: scenarioId },
    include: { agent: { select: { workspaceId: true } } },
  });
  if (!scenario) throw new ApiError("Сценарий не найден", "NOT_FOUND", 404);

  const m = await checkMembership(scenario.agent.workspaceId, userId);
  if (m !== "OWNER" && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  await db.agentScenario.delete({ where: { id: scenarioId } });

  void logActivity({
    workspaceId: scenario.agent.workspaceId,
    actorId: userId,
    action: "AGENT_SCENARIO_DELETED",
    entityType: "AgentScenario",
    entityId: scenarioId,
    summary: generateSummary("AGENT_SCENARIO_DELETED", {
      kbArticleTitle: scenario.title,
    }),
    metadata: {},
  });
}

// ─── AI Generation (Anthropic Claude) ───────────────────────────────────────

function getAnthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    throw new ApiError(
      "ANTHROPIC_API_KEY не настроен",
      "AI_NOT_CONFIGURED",
      500,
    );
  return new Anthropic({ apiKey });
}

type TicketMsg = { authorType: string; content: string };

function toClaudeMessages(msgs: TicketMsg[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];
  for (const m of msgs) {
    const role = m.authorType === "CUSTOMER" ? "user" : "assistant";
    // Claude requires alternating roles — merge consecutive same-role
    const last = result[result.length - 1];
    if (last && last.role === role) {
      last.content += "\n" + m.content;
    } else {
      result.push({ role, content: m.content });
    }
  }
  // Claude requires first message to be user
  if (result.length > 0 && result[0]?.role === "assistant") {
    result.unshift({ role: "user", content: "(начало диалога)" });
  }
  return result;
}

/**
 * Copilot: предложить ответ менеджеру.
 */
export async function suggestReply(
  ticketId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<{ suggestion: string; confidence: number }> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        select: { authorType: true, content: true },
      },
    },
  });
  if (!ticket) throw new ApiError("Тикет не найден", "NOT_FOUND", 404);

  const m = await checkMembership(ticket.workspaceId, userId);
  if (!m && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const cfg = await db.agentConfig.findUnique({
    where: { workspaceId: ticket.workspaceId },
    include: {
      scenarios: { where: { enabled: true }, orderBy: { position: "asc" } },
    },
  });
  if (!cfg?.enabled)
    throw new ApiError("AI-агент не активирован", "AI_DISABLED", 400);

  const anthropic = getAnthropic();
  const systemPrompt = buildSystemPrompt(
    cfg.systemPrompt,
    cfg.guardrails,
    cfg.scenarios,
  );

  const response = await anthropic.messages.create({
    model: cfg.model,
    max_tokens: 1000,
    temperature: cfg.temperature,
    system: systemPrompt,
    messages: toClaudeMessages(ticket.messages),
  });

  const suggestion =
    response.content[0]?.type === "text" ? response.content[0].text : "";
  const confidence = suggestion.length > 20 ? 0.8 : 0.4;

  return { suggestion, confidence };
}

/**
 * Autopilot: автоматически ответить на сообщение клиента.
 */
export async function autoRespond(
  ticketId: string,
  workspaceId: string,
): Promise<{ responded: boolean; handoff: boolean }> {
  const cfg = await db.agentConfig.findUnique({
    where: { workspaceId },
    include: {
      scenarios: { where: { enabled: true }, orderBy: { position: "asc" } },
    },
  });
  if (!cfg?.enabled || cfg.mode !== "autopilot") {
    return { responded: false, handoff: false };
  }

  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        select: { authorType: true, content: true },
      },
    },
  });
  if (!ticket) return { responded: false, handoff: false };

  const anthropic = getAnthropic();
  const systemPrompt = buildSystemPrompt(
    cfg.systemPrompt,
    cfg.guardrails,
    cfg.scenarios,
  );

  const response = await anthropic.messages.create({
    model: cfg.model,
    max_tokens: 1000,
    temperature: cfg.temperature,
    system: systemPrompt,
    messages: toClaudeMessages(ticket.messages),
  });

  const reply =
    response.content[0]?.type === "text" ? response.content[0].text : "";
  if (!reply) return { responded: false, handoff: true };

  // Check for handoff markers
  const handoffMarkers = [
    "не могу помочь",
    "передаю менеджеру",
    "свяжу с специалистом",
    "[HANDOFF]",
  ];
  const needsHandoff = handoffMarkers.some((marker) =>
    reply.toLowerCase().includes(marker),
  );

  if (needsHandoff) {
    await db.ticket.update({
      where: { id: ticketId },
      data: {
        needsHumanHelp: true,
        helpRequestedAt: new Date(),
        agentConfidence: 0.3,
      },
    });
    return { responded: false, handoff: true };
  }

  await db.ticketMessage.create({
    data: {
      ticketId,
      authorType: "AGENT" as TicketMessageAuthorType,
      content: reply,
    },
  });

  void logActivity({
    workspaceId,
    actorId: null,
    action: "AGENT_RESPONSE_GENERATED",
    entityType: "Ticket",
    entityId: ticketId,
    summary: generateSummary("AGENT_RESPONSE_GENERATED", {
      kbArticleTitle: `#${ticket.number} ${ticket.title}`,
    }),
    metadata: {},
  });

  return { responded: true, handoff: false };
}

/**
 * Суммировать диалог тикета.
 */
export async function summarizeTicket(
  ticketId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<string> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        select: { authorType: true, content: true },
      },
    },
  });
  if (!ticket) throw new ApiError("Тикет не найден", "NOT_FOUND", 404);

  const m = await checkMembership(ticket.workspaceId, userId);
  if (!m && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const anthropic = getAnthropic();
  const conversation = ticket.messages
    .map((msg) => `${msg.authorType}: ${msg.content}`)
    .join("\n");

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    temperature: 0.2,
    system:
      "Ты суммируешь диалоги поддержки. Выдай краткое резюме на русском: суть проблемы, что было сделано, текущий статус. 3-5 предложений максимум.",
    messages: [{ role: "user", content: conversation }],
  });

  return response.content[0]?.type === "text"
    ? response.content[0].text
    : "Не удалось суммировать.";
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildSystemPrompt(
  customPrompt: string | null,
  guardrails: string | null,
  scenarios: Array<{ title: string; description: string; instruction: string }>,
): string {
  const parts: string[] = [];

  parts.push(
    customPrompt ??
      "Ты — AI-помощник поддержки. Отвечай вежливо, точно и по делу на русском языке. Если не знаешь ответа, скажи что передашь вопрос менеджеру.",
  );

  if (guardrails) {
    try {
      const rules = JSON.parse(guardrails) as string[];
      if (rules.length > 0) {
        parts.push("\nОГРАНИЧЕНИЯ (НИКОГДА не нарушай):");
        rules.forEach((r) => parts.push(`- ${r}`));
      }
    } catch {
      /* invalid guardrails JSON */
    }
  }

  if (scenarios.length > 0) {
    parts.push("\nСЦЕНАРИИ:");
    scenarios.forEach((s) => {
      parts.push(
        `\n### ${s.title}\n${s.description}\nИнструкция: ${s.instruction}`,
      );
    });
  }

  parts.push(
    "\nЕсли ты не уверен в ответе или вопрос выходит за рамки сценариев, ответь: «Передаю ваш вопрос менеджеру для более точного ответа.» с пометкой [HANDOFF].",
  );

  return parts.join("\n");
}
