import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "../workspace.service";
import { logActivity, generateSummary } from "../logger.service";
import { sendTelegramNotification } from "../telegram/sender";
import type { TicketMessageAuthorType } from "@prisma/client";
import { searchArticles } from "@/lib/services/kb/search.service";

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
  useKnowledgeBase: boolean;
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
    useKnowledgeBase: cfg.useKnowledgeBase,
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
      model: data.model ?? "claude-sonnet-4-20250514",
      temperature: data.temperature ?? 0.3,
      systemPrompt: data.systemPrompt ?? null,
      greeting: data.greeting ?? null,
      guardrails: data.guardrails ?? null,
      handoffThreshold: data.handoffThreshold ?? 0.7,
      autoResolve: data.autoResolve ?? false,
      autoFaq: data.autoFaq ?? false,
      autoContactNotes: data.autoContactNotes ?? false,
      useKnowledgeBase: data.useKnowledgeBase ?? true,
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

// ─── Knowledge Base context retrieval ───────────────────────────────────────

/**
 * Search KB articles + files for content relevant to the customer query.
 * Returns a formatted knowledge context string for the system prompt.
 */
async function fetchKnowledgeContext(
  workspaceId: string,
  customerMessages: TicketMsg[],
): Promise<string> {
  // Take the last customer message as the search query
  const lastCustomerMsg = customerMessages
    .filter((m) => m.authorType === "CUSTOMER")
    .pop();
  if (!lastCustomerMsg) return "";

  const queryText = lastCustomerMsg.content.slice(0, 200);
  const parts: string[] = [];

  // 1. Search KB articles via the existing search service
  try {
    const kbResults = await searchArticles(
      workspaceId,
      // Use a system-level call — no user auth check needed for internal agent use
      "system",
      "ADMIN",
      { text: queryText, pageSize: 3 },
    );
    if (kbResults.data.length > 0) {
      for (const article of kbResults.data) {
        parts.push(`## ${article.title}\n${article.contentPreview}`);
      }
    }
  } catch {
    // KB search failure should not block the agent response
  }

  // 2. Search KB files with extracted text
  try {
    // Split query into meaningful search terms (words >= 3 chars)
    const searchTerms = queryText
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 3);

    if (searchTerms.length > 0) {
      // Search for files where extractedText contains any of the search terms
      const kbFiles = await db.kbFile.findMany({
        where: {
          workspaceId,
          extractedText: { not: null },
          OR: searchTerms.slice(0, 5).map((term) => ({
            extractedText: { contains: term },
          })),
        },
        take: 2,
        select: { originalName: true, extractedText: true },
      });

      for (const file of kbFiles) {
        if (file.extractedText) {
          // Find the most relevant chunk around the search term
          const excerpt = extractRelevantChunk(
            file.extractedText,
            searchTerms,
            1500,
          );
          parts.push(`## Документ: ${file.originalName}\n${excerpt}`);
        }
      }
    }
  } catch {
    // File search failure should not block the agent response
  }

  if (parts.length === 0) return "";

  return (
    "\n\n<knowledge_base>\n" + parts.join("\n\n---\n\n") + "\n</knowledge_base>"
  );
}

/**
 * Extract a relevant chunk from a long text around the first occurrence
 * of any search term, with a window of `maxLen` characters.
 */
function extractRelevantChunk(
  text: string,
  terms: string[],
  maxLen: number,
): string {
  if (text.length <= maxLen) return text;

  const lowerText = text.toLowerCase();
  let bestIndex = -1;

  for (const term of terms) {
    const idx = lowerText.indexOf(term);
    if (idx !== -1) {
      bestIndex = idx;
      break;
    }
  }

  if (bestIndex === -1) {
    // No term found — return the beginning
    return text.slice(0, maxLen) + "...";
  }

  // Center the window around the found term
  const halfWindow = Math.floor(maxLen / 2);
  const start = Math.max(0, bestIndex - halfWindow);
  const end = Math.min(text.length, start + maxLen);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";

  return prefix + text.slice(start, end) + suffix;
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

  // Fetch KB context if enabled
  let knowledgeContext = "";
  if (cfg.useKnowledgeBase) {
    knowledgeContext = await fetchKnowledgeContext(
      ticket.workspaceId,
      ticket.messages,
    );
  }

  const anthropic = getAnthropic();
  const systemPrompt = buildSystemPrompt(
    cfg.systemPrompt,
    cfg.guardrails,
    cfg.scenarios,
    knowledgeContext,
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

  // Fetch KB context if enabled
  let knowledgeContext = "";
  if (cfg.useKnowledgeBase) {
    knowledgeContext = await fetchKnowledgeContext(
      workspaceId,
      ticket.messages,
    );
  }

  const anthropic = getAnthropic();
  const systemPrompt = buildSystemPrompt(
    cfg.systemPrompt,
    cfg.guardrails,
    cfg.scenarios,
    knowledgeContext,
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
 * Autopilot with typing indicators visible to customer.
 * Self-contained: checks config, shows typing stages, generates reply.
 */
export async function autoRespondWithTyping(
  ticketId: string,
  workspaceId: string,
): Promise<void> {
  const cfg = await db.agentConfig.findUnique({
    where: { workspaceId },
    include: {
      scenarios: { where: { enabled: true }, orderBy: { position: "asc" } },
    },
  });
  if (!cfg?.enabled || cfg.mode !== "autopilot") return;

  // Determine if this is the first agent response in the conversation
  const agentMsgCount = await db.ticketMessage.count({
    where: { ticketId, authorType: { in: ["AGENT", "MANAGER"] } },
  });
  const isFirstResponse = agentMsgCount === 0;

  // Typing stages — different text for first vs follow-up
  const typingStages = isFirstResponse
    ? [
        "Менеджер подключился к диалогу",
        "Менеджер изучает ваш вопрос...",
        "Менеджер готовит ответ...",
      ]
    : [
        "Менеджер читает сообщение...",
        "Менеджер думает...",
        "Менеджер готовит ответ...",
      ];

  for (const text of typingStages) {
    // Remove previous typing stages
    await db.ticketMessage.deleteMany({
      where: { ticketId, systemAction: "TYPING_STAGE" },
    });
    await db.ticketMessage.create({
      data: {
        ticketId,
        authorType: "SYSTEM",
        content: text,
        systemAction: "TYPING_STAGE",
      },
    });
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Load ticket messages (excluding SYSTEM typing messages)
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    include: {
      messages: {
        where: { systemAction: null },
        orderBy: { createdAt: "asc" },
        select: { authorType: true, content: true },
      },
    },
  });
  if (!ticket) {
    await db.ticketMessage.deleteMany({
      where: { ticketId, systemAction: "TYPING_STAGE" },
    });
    return;
  }

  try {
    // Fetch KB context if enabled
    let knowledgeContext = "";
    if (cfg.useKnowledgeBase) {
      knowledgeContext = await fetchKnowledgeContext(
        workspaceId,
        ticket.messages,
      );
    }

    const anthropic = getAnthropic();
    const systemPrompt = buildSystemPrompt(
      cfg.systemPrompt,
      cfg.guardrails,
      cfg.scenarios,
      knowledgeContext,
    );

    const response = await anthropic.messages.create({
      model: cfg.model,
      max_tokens: 1000,
      temperature: cfg.temperature,
      system: systemPrompt,
      messages: toClaudeMessages(ticket.messages),
    });

    const rawReply =
      response.content[0]?.type === "text" ? response.content[0].text : "";

    // Remove all typing indicators
    await db.ticketMessage.deleteMany({
      where: { ticketId, systemAction: "TYPING_STAGE" },
    });

    if (!rawReply) {
      await db.ticket.update({
        where: { id: ticketId },
        data: {
          needsHumanHelp: true,
          helpRequestedAt: new Date(),
          agentConfidence: 0.3,
        },
      });
      return;
    }

    const parsed = parseAgentResponse(rawReply);

    // Save visible reply to customer
    if (parsed.reply) {
      await db.ticketMessage.create({
        data: {
          ticketId,
          authorType: "AGENT" as TicketMessageAuthorType,
          content: parsed.reply,
        },
      });
    }

    // If needs human — assign manager, set flag, notify
    if (parsed.needsHuman) {
      // Auto-assign: pick manager with fewest active tickets (round-robin)
      const assigneeId = await pickAvailableManager(workspaceId);

      await db.ticket.update({
        where: { id: ticketId },
        data: {
          needsHumanHelp: true,
          helpRequestedAt: new Date(),
          agentConfidence: 0.3,
          assigneeId,
          assignedAt: assigneeId ? new Date() : undefined,
          status: "IN_PROGRESS",
        },
      });

      // Visible status for customer
      await db.ticketMessage.create({
        data: {
          ticketId,
          authorType: "SYSTEM",
          content:
            "Менеджер проверяет информацию в системе. Ожидайте, это займёт некоторое время.",
          systemAction: "HANDOFF_STATUS",
        },
      });

      // Internal summary for managers (hidden from customer)
      if (parsed.summary) {
        await db.ticketMessage.create({
          data: {
            ticketId,
            authorType: "SYSTEM",
            content: `📋 Сводка для менеджера: ${parsed.summary}`,
            systemAction: "AGENT_SUMMARY",
          },
        });
      }

      // Telegram notification to assigned manager
      if (assigneeId) {
        void notifyHandoff(
          assigneeId,
          ticket.number,
          ticket.title,
          parsed.summary,
        );
      }
    }

    void logActivity({
      workspaceId,
      actorId: null,
      action: "AGENT_RESPONSE_GENERATED",
      entityType: "Ticket",
      entityId: ticketId,
      summary: generateSummary("AGENT_RESPONSE_GENERATED", {
        kbArticleTitle: `#${ticket.number} ${ticket.title}`,
      }),
      metadata: { needsHuman: parsed.needsHuman },
    });
  } catch (err) {
    // Remove typing on error
    await db.ticketMessage
      .deleteMany({ where: { ticketId, systemAction: "TYPING_STAGE" } })
      .catch(() => {});
    await db.ticketMessage.create({
      data: {
        ticketId,
        authorType: "SYSTEM",
        content: "Менеджер изучает ваш вопрос. Мы ответим в ближайшее время.",
        systemAction: "HANDOFF",
      },
    });
    console.error("[autoRespondWithTyping] AI error:", err);
  }
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

/**
 * Pick manager with fewest active tickets (round-robin by load).
 * Falls back to workspace owner.
 */
async function pickAvailableManager(
  workspaceId: string,
): Promise<string | null> {
  const members = await db.workspaceMember.findMany({
    where: { workspaceId },
    include: {
      user: { select: { id: true, isActive: true } },
    },
  });

  const active = members.filter((m) => m.user.isActive);
  if (active.length === 0) return null;
  if (active.length === 1) return active[0]!.userId;

  const counts = await Promise.all(
    active.map(async (m) => {
      const count = await db.ticket.count({
        where: {
          workspaceId,
          assigneeId: m.userId,
          status: { notIn: ["CLOSED", "RESOLVED"] },
        },
      });
      return { userId: m.userId, count };
    }),
  );

  counts.sort((a, b) => a.count - b.count);
  return counts[0]!.userId;
}

/**
 * Telegram notification to assigned manager about handoff.
 */
async function notifyHandoff(
  assigneeId: string,
  ticketNumber: number,
  ticketTitle: string,
  summary: string | null,
): Promise<void> {
  try {
    const user = await db.user.findUnique({
      where: { id: assigneeId },
      select: { telegramChatId: true, tgNotifyTicketAssigned: true },
    });

    if (user?.telegramChatId && user.tgNotifyTicketAssigned) {
      const summaryText = summary ? `\n\n📋 ${summary}` : "";
      const msg = [
        `<b>🤖 AI передал вам тикет</b>`,
        `<i>#${ticketNumber} ${ticketTitle}</i>`,
        `AI-агент собрал данные и передал тикет вам.${summaryText}`,
      ].join("\n");
      void sendTelegramNotification(user.telegramChatId, msg);
    }
  } catch {
    /* fire-and-forget */
  }
}

function buildSystemPrompt(
  customPrompt: string | null,
  guardrails: string | null,
  scenarios: Array<{ title: string; description: string; instruction: string }>,
  knowledgeContext: string = "",
): string {
  const parts: string[] = [];

  parts.push(
    customPrompt ??
      "Ты — AI-помощник поддержки. Отвечай вежливо, точно и по делу на русском языке.",
  );

  // Insert knowledge base context if available
  if (knowledgeContext) {
    parts.push(
      "\nИспользуй следующую базу знаний для ответов. Если информация есть в базе знаний — используй её. Если нет — отвечай на основе контекста разговора." +
        knowledgeContext,
    );
  }

  parts.push(`
ВАЖНЫЕ ПРАВИЛА ПОВЕДЕНИЯ:
1. Ты общаешься от имени менеджера поддержки. Клиент НЕ знает что ты AI.
2. Сначала собери ВСЮ необходимую информацию от клиента: задавай уточняющие вопросы один за другим.
3. НЕ советуй клиенту "обратиться к менеджеру" или "передать менеджеру" — ты и есть менеджер для клиента.
4. НЕ пиши [HANDOFF], не упоминай "передачу менеджеру" в тексте ответа.
5. НЕ проси клиента "сообщить менеджеру" какие-то данные — спрашивай их сам.
6. Если вопрос требует доступа к внутренним системам, скажи: "Сейчас проверю, подождите пожалуйста."

ФОРМАТ ОТВЕТА:
Всегда отвечай в формате JSON:
{"reply": "Текст ответа клиенту", "needsHuman": false, "summary": null}

Когда ты собрал всю информацию и понимаешь что для решения нужен доступ к внутренним системам:
{"reply": "Спасибо за информацию! Я сейчас проверю всё в системе, это займёт немного времени.", "needsHuman": true, "summary": "Клиент сообщает что...  ID: 678, ID партнёра: 1956. Нужно проверить реферальную связь."}

Поле summary — это краткая сводка для менеджера с собранными данными. Клиент её НЕ видит.`);

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

  return parts.join("\n");
}

type AgentResponse = {
  reply: string;
  needsHuman: boolean;
  summary: string | null;
};

function parseAgentResponse(raw: string): AgentResponse {
  // Try parsing as JSON first
  try {
    const trimmed = raw.trim();
    // Handle markdown code blocks
    const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1]!.trim() : trimmed;
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    return {
      reply: (parsed.reply as string) ?? raw,
      needsHuman: (parsed.needsHuman as boolean) ?? false,
      summary: (parsed.summary as string) ?? null,
    };
  } catch {
    // Fallback: use raw text as reply, check for old handoff markers
    const hasHandoff = [
      "[HANDOFF]",
      "передаю менеджеру",
      "передам менеджеру",
    ].some((m) => raw.toLowerCase().includes(m));
    // Strip [HANDOFF] from visible text
    const cleanReply = raw.replace(/\[HANDOFF\]/gi, "").trim();
    return {
      reply: cleanReply,
      needsHuman: hasHandoff,
      summary: hasHandoff
        ? `Агент решил передать менеджеру. Контекст диалога доступен в сообщениях.`
        : null,
    };
  }
}
