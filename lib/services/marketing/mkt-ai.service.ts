"use server";
/* eslint-disable @typescript-eslint/no-explicit-any */

import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

interface MktAiConfig {
  anthropicApiKey: string;
  claudeModel: string;
  claudeModelSummary: string;
  claudeModelComplex: string;
}

export interface PitchResult {
  subject: string | null;
  body: string;
  flag: string | null;
  extracted_price: number | null;
  consultation_question: string | null;
  _critique?: CritiqueResult | null;
  _rewritten?: boolean;
}

export interface CritiqueResult {
  score: number;
  issues: string[];
  needs_rewrite: boolean;
}

export interface QualifyResult {
  suitable: boolean;
  reason: string;
  angle: string;
}

export interface ContentSummary {
  _v: number;
  niche: string;
  content_style: string;
  audience: string;
  tone: string;
  recent_topics: string[];
  engagement_health?: string;
  pitch_hooks: string[];
  red_flags: string[];
  deep?: boolean;
  audience_voice?: string;
  common_questions?: string[];
  objections?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Country Personas
// ═══════════════════════════════════════════════════════════════════════════

const COUNTRY_PERSONAS: Record<string, string> = {
  RU: "Русскоязычная аудитория. Обращайся на «ты», используй неформальный но профессиональный тон. Не используй слишком формальные обороты. Пиши короткими предложениями, будь конкретен. Используй emoji умеренно (1-2 на сообщение). Русские блогеры ценят прямоту и конкретные цифры.",
  UA: "Украиноязычная аудитория. Пиши на русском (большинство блогеров понимают), но учитывай возможную чувствительность. Обращайся на «ты». Будь прямолинеен и конкретен. Украинские креаторы ценят партнёрский подход, а не «мы вам заплатим».",
  US: "English-speaking US audience. Use casual professional tone. Be direct and value-driven. Americans appreciate clear ROI statements and social proof. Use 'you/your' language. Keep it concise — busy creators skim emails.",
  GB: "British English audience. Slightly more formal than US but still friendly. Avoid being too salesy. British creators value authenticity and understated confidence. Use proper spelling (colour, favourite, etc.).",
  DE: "Deutschsprachiges Publikum. Schreibe auf Englisch, es sei denn du bist sicher dass der Creator Deutsch bevorzugt. Deutsche Creator schätzen Professionalität, klare Strukturen und Datenschutz-Bewusstsein. Sei direkt aber höflich.",
  FR: "Public francophone. Écris en anglais sauf indication contraire. Les créateurs français apprécient l'élégance et la clarté. Évite le ton trop commercial. Mentionne des collaborations précédentes si possible.",
  ES: "Público hispanohablante. Escribe en inglés a menos que el creador prefiera español. Los creadores hispanos valoran las relaciones personales y la confianza. Sé amigable y genuino.",
  BR: "Público brasileiro. Escreva em inglês, a menos que o criador prefira português. Criadores brasileiros são calorosos e valorizam relacionamentos. Seja entusiástico mas profissional.",
  IN: "Indian English-speaking audience. Use professional yet warm tone. Indian creators value respect and relationship-building. Mention specific content you enjoyed. Be clear about payment terms upfront.",
  KR: "Korean audience. Write in English unless the creator prefers Korean. Korean creators value professionalism and respect for hierarchy. Be polite and specific about the collaboration terms.",
  JP: "Japanese audience. Write in English unless the creator prefers Japanese. Japanese creators value politeness, respect, and attention to detail. Be formal but warm. Mention specific content appreciation.",
  TR: "Turkish audience. Write in English. Turkish creators are entrepreneurial and value partnerships. Be direct about the opportunity and potential earnings. Show knowledge of their content.",
};

// ═══════════════════════════════════════════════════════════════════════════
// Config + Client
// ═══════════════════════════════════════════════════════════════════════════

async function getAiClient(
  workspaceId: string,
): Promise<{ client: Anthropic; config: MktAiConfig }> {
  const row = await db.mktConfig.findUnique({
    where: { workspaceId },
  });

  if (!row) {
    throw new Error(`MktConfig not found for workspace ${workspaceId}`);
  }

  const apiKey = row.anthropicApiKey;
  if (!apiKey) {
    throw new Error(
      `Anthropic API key not configured for workspace ${workspaceId}`,
    );
  }

  const config: MktAiConfig = {
    anthropicApiKey: apiKey,
    claudeModel: row.claudeModel,
    claudeModelSummary: row.claudeModelSummary,
    claudeModelComplex: row.claudeModelComplex,
  };

  const client = new Anthropic({ apiKey });

  return { client, config };
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      // Check if retryable (rate limit or server error)
      const status =
        err instanceof Error && "status" in err
          ? (err as { status: number }).status
          : 0;
      const isRetryable = status === 429 || status >= 500;

      if (!isRetryable || attempt >= maxRetries) {
        throw err;
      }

      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
      console.warn(
        `[MKT-AI] Retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms (status=${status})`,
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

// ═══════════════════════════════════════════════════════════════════════════
// Sanitization
// ═══════════════════════════════════════════════════════════════════════════

function sanitize(v: unknown, maxLen = 500): string {
  if (v == null) return "";
  const s = String(v).trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "…";
}

function sanitizeLong(v: unknown, maxLen = 3000): string {
  if (v == null) return "";
  const s = String(v).trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "…";
}

// ═══════════════════════════════════════════════════════════════════════════
// System Prompt Builders
// ═══════════════════════════════════════════════════════════════════════════

function buildStaticSystemPart(): string {
  return `Ты — ИИ-агент для B2B-аутрича. Твоя задача: писать холодные сообщения блогерам/креаторам с предложением рекламной интеграции.

КЛЮЧЕВЫЕ ПРАВИЛА:
1. НИКОГДА не начинай с "Здравствуйте" или "Добрый день" — сразу к делу
2. Первое предложение — хук, показывающий что ты знаешь их контент
3. КОРОТКИЕ сообщения: 3-5 предложений максимум для первого контакта
4. Конкретика: цифры, названия видео, специфика канала
5. Один чёткий CTA (call-to-action) в конце
6. Тон: как коллега-профессионал, НЕ как менеджер по продажам
7. НИКОГДА не ври и не приукрашивай — только реальные факты
8. Не используй шаблонные фразы типа "уникальное предложение", "выгодное сотрудничество"
9. Подпись — только имя и должность, БЕЗ "С уважением" и прочего

ANTI-ПАТТЕРНЫ (ЗАПРЕЩЕНО):
- "Мы заметили ваш канал" — все так пишут
- "У нас есть уникальное предложение" — фильтруется как спам
- "Хотели бы обсудить сотрудничество" — слишком общо
- Длинные перечисления достоинств компании
- Множественные CTA — только один
- Формальности и канцеляризм`;
}

function buildAgentPersonaPart(project: any): string {
  if (!project) return "";

  const parts: string[] = [];

  if (project.agentPersona) {
    parts.push(`ПЕРСОНА АГЕНТА:\n${project.agentPersona}`);
  }

  if (project.toneOfVoice) {
    parts.push(`ТОН ОБЩЕНИЯ: ${project.toneOfVoice}`);
  }

  if (project.signature) {
    parts.push(`ПОДПИСЬ:\n${project.signature}`);
  }

  if (project.stopWords) {
    try {
      const words = JSON.parse(project.stopWords);
      if (Array.isArray(words) && words.length > 0) {
        parts.push(`СТОП-СЛОВА (НИКОГДА не используй):\n${words.join(", ")}`);
      }
    } catch {
      // ignore invalid JSON
    }
  }

  return parts.length > 0 ? "\n\n" + parts.join("\n\n") : "";
}

function buildDynamicSystemPart(
  lead: any,
  project: any,
  channel: string,
): string {
  const parts: string[] = [];

  // Channel info
  parts.push("ИНФОРМАЦИЯ О КАНАЛЕ:");
  parts.push(`Название: ${sanitize(lead.channelName)}`);
  if (lead.subscribers)
    parts.push(`Подписчики: ${lead.subscribers.toLocaleString()}`);
  if (lead.avgViews)
    parts.push(`Среднее кол-во просмотров: ${lead.avgViews.toLocaleString()}`);
  if (lead.country) parts.push(`Страна: ${lead.country}`);
  if (lead.mainCategory) parts.push(`Категория: ${lead.mainCategory}`);
  if (lead.channelAboutText) {
    parts.push(`О канале: ${sanitize(lead.channelAboutText, 800)}`);
  }

  // Content summary
  if (lead.contentSummary) {
    parts.push(`\nАНАЛИЗ КОНТЕНТА:\n${sanitizeLong(lead.contentSummary)}`);
  }

  // Recent videos
  if (lead.lastVideosJson) {
    try {
      const videos = JSON.parse(lead.lastVideosJson);
      if (Array.isArray(videos) && videos.length > 0) {
        const topVideos = videos.slice(0, 5);
        const videoList = topVideos
          .map(
            (v: any) =>
              `- "${sanitize(v.title, 100)}" (${(v.views || 0).toLocaleString()} просм.)`,
          )
          .join("\n");
        parts.push(`\nПОСЛЕДНИЕ ВИДЕО:\n${videoList}`);
      }
    } catch {
      // ignore
    }
  }

  // Project info
  if (project) {
    parts.push("\nО ПРОЕКТЕ/ПРОДУКТЕ:");
    parts.push(`Название: ${sanitize(project.name)}`);
    if (project.description)
      parts.push(`Описание: ${sanitize(project.description, 1000)}`);
    if (project.uniqueSellingPoints)
      parts.push(`USP: ${sanitize(project.uniqueSellingPoints, 500)}`);
    if (project.targetAudience)
      parts.push(`Целевая аудитория: ${sanitize(project.targetAudience)}`);
    if (project.valueProp)
      parts.push(`Ценностное предложение: ${sanitize(project.valueProp, 500)}`);
    if (project.proofPoints)
      parts.push(`Доказательства: ${sanitize(project.proofPoints, 500)}`);
    if (project.creatorEconomics)
      parts.push(
        `Условия для креатора: ${sanitize(project.creatorEconomics, 500)}`,
      );

    if (project.budgetMin || project.budgetMax) {
      const budgetStr =
        project.budgetMin && project.budgetMax
          ? `${project.budgetMin.toLocaleString()} — ${project.budgetMax.toLocaleString()}`
          : project.budgetMax
            ? `до ${project.budgetMax.toLocaleString()}`
            : `от ${project.budgetMin.toLocaleString()}`;
      parts.push(`Бюджет: ${budgetStr} ₽`);
    }

    if (project.adFormats) {
      try {
        const formats = JSON.parse(project.adFormats);
        if (Array.isArray(formats) && formats.length > 0) {
          parts.push(`Форматы рекламы: ${formats.join(", ")}`);
        }
      } catch {
        parts.push(`Форматы рекламы: ${project.adFormats}`);
      }
    }

    if (project.ctaText) parts.push(`CTA: ${sanitize(project.ctaText)}`);
    if (project.ctaLink) parts.push(`Ссылка: ${project.ctaLink}`);
  }

  // Country persona
  const country = lead.country?.toUpperCase?.() || "";
  const persona = COUNTRY_PERSONAS[country];
  if (persona) {
    parts.push(`\nКУЛЬТУРНЫЙ КОНТЕКСТ:\n${persona}`);
  }

  // Channel-specific instructions
  if (channel === "telegram") {
    parts.push(
      "\nКАНАЛ ОТПРАВКИ: Telegram\n- Пиши ещё короче (2-3 предложения)\n- Можно использовать emoji чуть больше\n- Не нужна тема письма (subject)\n- Формат: обычное сообщение в чат",
    );
  } else if (channel === "email") {
    parts.push(
      "\nКАНАЛ ОТПРАВКИ: Email\n- Тема письма ОБЯЗАТЕЛЬНА (поле subject)\n- Тема: 5-8 слов, интригующая, без спам-слов\n- Тело: 3-5 коротких абзацев\n- Подпись в конце",
    );
  }

  return parts.join("\n");
}

function buildSummaryContextForPrompt(lead: any): string {
  if (!lead.contentSummary) return "";

  try {
    const summary: ContentSummary = JSON.parse(lead.contentSummary);
    const parts: string[] = [];

    parts.push(`Ниша: ${summary.niche}`);
    parts.push(`Стиль контента: ${summary.content_style}`);
    parts.push(`Аудитория: ${summary.audience}`);
    parts.push(`Тон: ${summary.tone}`);

    if (summary.recent_topics?.length > 0) {
      parts.push(`Последние темы: ${summary.recent_topics.join(", ")}`);
    }
    if (summary.pitch_hooks?.length > 0) {
      parts.push(`Зацепки для питча: ${summary.pitch_hooks.join("; ")}`);
    }
    if (summary.red_flags?.length > 0) {
      parts.push(`Красные флаги: ${summary.red_flags.join("; ")}`);
    }
    if (summary.audience_voice) {
      parts.push(`Голос аудитории: ${summary.audience_voice}`);
    }
    if (summary.common_questions?.length) {
      parts.push(
        `Частые вопросы аудитории: ${summary.common_questions.join("; ")}`,
      );
    }
    if (summary.objections?.length) {
      parts.push(`Возможные возражения: ${summary.objections.join("; ")}`);
    }

    return "\n\nРЕЗЮМЕ КАНАЛА (ИЗ АНАЛИЗА):\n" + parts.join("\n");
  } catch {
    return "\n\nРЕЗЮМЕ КАНАЛА:\n" + sanitizeLong(lead.contentSummary);
  }
}

function buildFewShotPart(project: any): string {
  if (!project?.idealChannelProfile) return "";

  return `\n\nПРИМЕР ИДЕАЛЬНОГО КАНАЛА ДЛЯ ЭТОГО ПРОЕКТА:
${sanitizeLong(project.idealChannelProfile, 2000)}

Используй этот пример как ориентир для стиля и подхода.`;
}

function buildSystemBlocks(
  lead: any,
  project: any,
  channel: string,
  adminDirective: string | null,
  knowledgeContext: string | null,
): Array<{
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}> {
  const blocks: Array<{
    type: "text";
    text: string;
    cache_control?: { type: "ephemeral" };
  }> = [];

  // Block 1: Static system prompt (cacheable)
  const staticPart =
    buildStaticSystemPart() +
    buildAgentPersonaPart(project) +
    buildFewShotPart(project);
  blocks.push({
    type: "text",
    text: staticPart,
    cache_control: { type: "ephemeral" },
  });

  // Block 2: Dynamic context about the lead
  const dynamicPart =
    buildDynamicSystemPart(lead, project, channel) +
    buildSummaryContextForPrompt(lead);
  blocks.push({
    type: "text",
    text: dynamicPart,
  });

  // Block 3: Admin directive (if any)
  if (adminDirective) {
    blocks.push({
      type: "text",
      text: `\nДИРЕКТИВА МЕНЕДЖЕРА:\n${adminDirective}\n\nВыполни указания менеджера с приоритетом выше остальных инструкций.`,
    });
  }

  // Block 4: Knowledge context (RAG)
  // TODO: Implement RAG/knowledge base integration
  if (knowledgeContext) {
    blocks.push({
      type: "text",
      text: `\nКОНТЕКСТ ИЗ БАЗЫ ЗНАНИЙ:\n${knowledgeContext}`,
    });
  }

  return blocks;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Schemas
// ═══════════════════════════════════════════════════════════════════════════

const SEND_REPLY_TOOL: Anthropic.Tool = {
  name: "send_reply",
  description:
    "Формирует ответное сообщение блогеру/креатору. Используй этот инструмент для отправки писем и сообщений.",
  input_schema: {
    type: "object" as const,
    properties: {
      subject: {
        type: "string",
        description:
          "Тема письма (только для email). Для Telegram — null или пустая строка.",
      },
      body: {
        type: "string",
        description:
          "Текст сообщения. Без HTML-тегов. Используй \\n для переносов строк.",
      },
      flag: {
        type: "string",
        enum: [
          "interested",
          "objection",
          "question",
          "price_request",
          "negotiation",
          "needs_human",
          "spam",
          "not_interested",
          "auto_reply",
        ],
        description:
          "Флаг классификации входящего сообщения (если это ответ на входящее).",
      },
      extracted_price: {
        type: "number",
        description: "Если блогер назвал цену — извлеки число. Иначе null.",
      },
      consultation_question: {
        type: "string",
        description:
          "Если нужна консультация менеджера — опиши вопрос. Иначе null.",
      },
    },
    required: ["body"],
  },
};

const QUALIFY_TOOL: Anthropic.Tool = {
  name: "qualify_lead",
  description:
    "Оценивает подходит ли канал/блогер для рекламной интеграции с данным проектом.",
  input_schema: {
    type: "object" as const,
    properties: {
      suitable: {
        type: "boolean",
        description: "true если канал подходит, false если нет.",
      },
      reason: {
        type: "string",
        description:
          "Краткое объяснение почему подходит или не подходит (1-2 предложения).",
      },
      angle: {
        type: "string",
        description:
          "Рекомендуемый угол подхода для питча. Какой аспект проекта зацепит этого блогера?",
      },
    },
    required: ["suitable", "reason", "angle"],
  },
};

const CRITIQUE_TOOL: Anthropic.Tool = {
  name: "critique_pitch",
  description:
    "Критический анализ питча. Оценивает качество и предлагает улучшения.",
  input_schema: {
    type: "object" as const,
    properties: {
      score: {
        type: "number",
        description: "Оценка качества питча от 1 до 10.",
      },
      issues: {
        type: "array",
        items: { type: "string" },
        description:
          "Список проблем/замечаний. Каждый элемент — конкретная проблема.",
      },
      needs_rewrite: {
        type: "boolean",
        description: "true если питч нуждается в полной переделке (score < 6).",
      },
    },
    required: ["score", "issues", "needs_rewrite"],
  },
};

const CHANNEL_SUMMARY_TOOL: Anthropic.Tool = {
  name: "channel_summary",
  description:
    "Структурированное резюме YouTube-канала для внутреннего использования.",
  input_schema: {
    type: "object" as const,
    properties: {
      _v: {
        type: "number",
        description: "Версия формата. Всегда 2.",
      },
      niche: {
        type: "string",
        description: "Основная ниша канала (1-3 слова).",
      },
      content_style: {
        type: "string",
        description:
          "Стиль контента: обзоры, влоги, образовательный, развлекательный, etc.",
      },
      audience: {
        type: "string",
        description: "Описание целевой аудитории канала (1-2 предложения).",
      },
      tone: {
        type: "string",
        description:
          "Тон общения: серьёзный, юмористический, экспертный, дружеский, etc.",
      },
      recent_topics: {
        type: "array",
        items: { type: "string" },
        description: "3-5 основных тем последних видео.",
      },
      engagement_health: {
        type: "string",
        description:
          "Оценка здоровья вовлечённости: high, medium, low, declining.",
      },
      pitch_hooks: {
        type: "array",
        items: { type: "string" },
        description:
          "2-3 конкретные зацепки для питча на основе контента канала.",
      },
      red_flags: {
        type: "array",
        items: { type: "string" },
        description:
          "Потенциальные проблемы: накрутка, неактивность, токсичность, etc.",
      },
    },
    required: [
      "_v",
      "niche",
      "content_style",
      "audience",
      "tone",
      "recent_topics",
      "pitch_hooks",
      "red_flags",
    ],
  },
};

const CHANNEL_DEEP_SUMMARY_TOOL: Anthropic.Tool = {
  name: "channel_deep_summary",
  description: "Углублённый анализ канала с учётом комментариев аудитории.",
  input_schema: {
    type: "object" as const,
    properties: {
      _v: {
        type: "number",
        description: "Версия формата. Всегда 2.",
      },
      niche: {
        type: "string",
        description: "Основная ниша канала.",
      },
      content_style: {
        type: "string",
        description: "Стиль контента.",
      },
      audience: {
        type: "string",
        description: "Описание аудитории с учётом комментариев.",
      },
      tone: {
        type: "string",
        description: "Тон общения.",
      },
      recent_topics: {
        type: "array",
        items: { type: "string" },
        description: "Основные темы.",
      },
      engagement_health: {
        type: "string",
        description: "Здоровье вовлечённости.",
      },
      pitch_hooks: {
        type: "array",
        items: { type: "string" },
        description: "Зацепки для питча.",
      },
      red_flags: {
        type: "array",
        items: { type: "string" },
        description: "Красные флаги.",
      },
      deep: {
        type: "boolean",
        description: "Всегда true для deep summary.",
      },
      audience_voice: {
        type: "string",
        description:
          "Как аудитория общается в комментариях — тон, сленг, настроение.",
      },
      common_questions: {
        type: "array",
        items: { type: "string" },
        description: "Частые вопросы аудитории из комментариев.",
      },
      objections: {
        type: "array",
        items: { type: "string" },
        description:
          "Потенциальные возражения аудитории против рекламных интеграций.",
      },
    },
    required: [
      "_v",
      "niche",
      "content_style",
      "audience",
      "tone",
      "recent_topics",
      "pitch_hooks",
      "red_flags",
      "deep",
      "audience_voice",
      "common_questions",
      "objections",
    ],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Core Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate an initial cold pitch for a lead.
 * Includes an automatic critique pass — if the pitch scores below 6,
 * it rewrites using the critique feedback.
 */
export async function generateInitialPitch(
  workspaceId: string,
  lead: any,
  project: any,
  channel: string = "email",
  angle: string | null = null,
): Promise<PitchResult> {
  const { client, config } = await getAiClient(workspaceId);

  const systemBlocks = buildSystemBlocks(lead, project, channel, null, null);

  let userPrompt =
    "Напиши первое холодное сообщение этому блогеру/креатору с предложением рекламной интеграции.";

  if (angle) {
    userPrompt += `\n\nИспользуй следующий угол подхода: ${angle}`;
  }

  if (channel === "email") {
    userPrompt +=
      "\n\nОбязательно укажи тему письма (subject). Тема должна быть интригующей, 5-8 слов.";
  }

  // TODO: trackUsage — implement usage tracking

  const pitch = await withBackoff(async () => {
    const response = await client.messages.create({
      model: config.claudeModel,
      max_tokens: 1500,
      system: systemBlocks,
      tools: [SEND_REPLY_TOOL],
      tool_choice: { type: "tool", name: "send_reply" },
      messages: [{ role: "user", content: userPrompt }],
    });

    return extractPitchFromResponse(response);
  });

  // Critique pass
  const critique = await critiquePitch(
    workspaceId,
    pitch,
    lead,
    project,
    channel,
  );

  if (critique && critique.needs_rewrite) {
    // Rewrite the pitch using critique feedback
    const rewritePrompt = `Перепиши питч с учётом замечаний:

ОРИГИНАЛЬНЫЙ ПИТЧ:
${pitch.body}

ЗАМЕЧАНИЯ (оценка ${critique.score}/10):
${critique.issues.map((i, idx) => `${idx + 1}. ${i}`).join("\n")}

Исправь все указанные проблемы. Сохрани общий подход но улучши качество.`;

    const rewritten = await withBackoff(async () => {
      const response = await client.messages.create({
        model: config.claudeModel,
        max_tokens: 1500,
        system: systemBlocks,
        tools: [SEND_REPLY_TOOL],
        tool_choice: { type: "tool", name: "send_reply" },
        messages: [{ role: "user", content: rewritePrompt }],
      });

      return extractPitchFromResponse(response);
    });

    rewritten._critique = critique;
    rewritten._rewritten = true;
    return rewritten;
  }

  pitch._critique = critique;
  pitch._rewritten = false;
  return pitch;
}

/**
 * Qualify a lead — determine if the channel is a good fit for the project.
 */
export async function qualifyLead(
  workspaceId: string,
  lead: any,
  project: any,
): Promise<QualifyResult> {
  const { client, config } = await getAiClient(workspaceId);

  const systemBlocks = buildSystemBlocks(lead, project, "email", null, null);

  const userPrompt = `Оцени, подходит ли этот канал для рекламной интеграции с проектом "${sanitize(project.name)}".

Учитывай:
1. Соответствие аудитории канала целевой аудитории проекта
2. Качество контента и вовлечённость
3. Размер канала (подписчики, просмотры)
4. Наличие контактов
5. Потенциальные красные флаги

${project.idealChannelProfile ? `Идеальный канал: ${sanitize(project.idealChannelProfile, 500)}` : ""}
${project.badFitExamples ? `НЕ подходят: ${sanitize(project.badFitExamples, 300)}` : ""}`;

  // TODO: trackUsage

  return await withBackoff(async () => {
    const response = await client.messages.create({
      model: config.claudeModelSummary,
      max_tokens: 800,
      system: systemBlocks,
      tools: [QUALIFY_TOOL],
      tool_choice: { type: "tool", name: "qualify_lead" },
      messages: [{ role: "user", content: userPrompt }],
    });

    return extractToolResult<QualifyResult>(response, "qualify_lead", {
      suitable: false,
      reason: "Failed to qualify",
      angle: "",
    });
  });
}

/**
 * Critique a pitch — returns score, issues, and whether it needs rewriting.
 */
export async function critiquePitch(
  workspaceId: string,
  pitch: PitchResult,
  lead: any,
  project: any,
  channel: string = "email",
): Promise<CritiqueResult | null> {
  const { client, config } = await getAiClient(workspaceId);

  const systemPrompt = `Ты — старший копирайтер, специализирующийся на B2B-аутриче для блогеров. Твоя задача — критически оценить питч.

КРИТЕРИИ ОЦЕНКИ:
1. Персонализация (0-3): упомянуты ли конкретные видео, факты о канале?
2. Краткость (0-2): не слишком ли длинное сообщение?
3. Ценностное предложение (0-2): понятно ли что получит блогер?
4. CTA (0-1): есть ли один чёткий призыв к действию?
5. Тон (0-2): соответствует ли тон аудитории и каналу?

КРАСНЫЕ ФЛАГИ (автоматически -2 балла каждый):
- Шаблонные фразы ("уникальное предложение", "выгодное сотрудничество")
- Начало с приветствия ("Здравствуйте", "Добрый день")
- Слишком длинное (> 500 символов для первого контакта)
- Нет конкретики о канале блогера
- Множественные CTA`;

  const userPrompt = `Оцени этот питч для канала "${sanitize(lead.channelName)}" (${lead.subscribers?.toLocaleString() || "?"} подписчиков):

${pitch.subject ? `Тема: ${pitch.subject}\n` : ""}Текст:
${pitch.body}

Канал отправки: ${channel}
Проект: ${sanitize(project?.name)}`;

  try {
    return await withBackoff(async () => {
      const response = await client.messages.create({
        model: config.claudeModelSummary,
        max_tokens: 600,
        system: [{ type: "text", text: systemPrompt }],
        tools: [CRITIQUE_TOOL],
        tool_choice: { type: "tool", name: "critique_pitch" },
        messages: [{ role: "user", content: userPrompt }],
      });

      return extractToolResult<CritiqueResult>(response, "critique_pitch", {
        score: 5,
        issues: [],
        needs_rewrite: false,
      });
    });
  } catch (err) {
    console.error("[MKT-AI] Critique failed, skipping:", err);
    return null;
  }
}

/**
 * Generate a reply to an incoming message from a lead.
 * Includes message history (truncated to last N messages).
 */
export async function generateReply(
  workspaceId: string,
  lead: any,
  project: any,
  history: any[],
  channel: string = "email",
  adminDirective: string | null = null,
): Promise<PitchResult> {
  const { client, config } = await getAiClient(workspaceId);

  // TODO: knowledge context (RAG integration)
  const knowledgeContext: string | null = null;

  const systemBlocks = buildSystemBlocks(
    lead,
    project,
    channel,
    adminDirective,
    knowledgeContext,
  );

  // Truncate history to last 20 messages (configurable via loopMessageLimit)
  const row = await db.mktConfig.findUnique({
    where: { workspaceId },
    select: { loopMessageLimit: true },
  });
  const limit = row?.loopMessageLimit ?? 20;
  const truncatedHistory = history.slice(-limit);

  // Build conversation messages
  const messages: Anthropic.MessageParam[] = [];

  for (const msg of truncatedHistory) {
    const role = msg.direction === "OUT" ? "assistant" : "user";
    const content = msg.body || msg.text || "";

    if (role === "assistant") {
      // Wrap outgoing messages to look like tool use results
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `prev_${msg.id || Math.random().toString(36).slice(2)}`,
            name: "send_reply",
            input: {
              body: content,
              subject: msg.subject || null,
            },
          },
        ],
      });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `prev_${msg.id || Math.random().toString(36).slice(2)}`,
            content: "Сообщение отправлено.",
          },
        ],
      });
    } else {
      messages.push({
        role: "user",
        content: `Входящее сообщение от блогера:\n\n${content}`,
      });
    }
  }

  // If last message isn't from user, add a prompt
  if (messages.length === 0 || messages[messages.length - 1]?.role !== "user") {
    messages.push({
      role: "user",
      content:
        "Сгенерируй ответ на последнее сообщение блогера. Учитывай весь контекст переписки.",
    });
  }

  // TODO: trackUsage

  return await withBackoff(async () => {
    const response = await client.messages.create({
      model: config.claudeModel,
      max_tokens: 1500,
      system: systemBlocks,
      tools: [SEND_REPLY_TOOL],
      tool_choice: { type: "tool", name: "send_reply" },
      messages,
    });

    return extractPitchFromResponse(response);
  });
}

/**
 * Generate a follow-up message when the lead hasn't replied.
 */
export async function generateFollowUp(
  workspaceId: string,
  lead: any,
  project: any,
  history: any[],
  channel: string,
  attempt: number = 1,
): Promise<PitchResult> {
  const { client, config } = await getAiClient(workspaceId);

  const systemBlocks = buildSystemBlocks(lead, project, channel, null, null);

  // Build minimal history (just our previous messages)
  const ourMessages = history
    .filter((m) => m.direction === "OUT")
    .map((m) => m.body || m.text || "")
    .filter(Boolean);

  let strategy: string;
  if (attempt === 1) {
    strategy = `Это первый фоллоуап. Стратегия: добавь новую ценность (свежий кейс, новую метрику, интересный факт о их нише). НЕ повторяй предыдущее сообщение. Напиши так, будто просто хочешь поделиться чем-то полезным.`;
  } else if (attempt === 2) {
    strategy = `Это второй фоллоуап. Стратегия: breakup email/message. Короткое (1-2 предложения), слегка провокационное. Например: "Видимо тема не зашла — если что, мы открыты." Без давления.`;
  } else {
    strategy = `Это фоллоуап #${attempt}. Стратегия: ультра-короткое сообщение (1 предложение). Новый угол или просто вежливое закрытие.`;
  }

  const userPrompt = `Напиши фоллоуап-сообщение блогеру "${sanitize(lead.channelName)}" который не ответил на наши предыдущие сообщения.

${strategy}

НАШИ ПРЕДЫДУЩИЕ СООБЩЕНИЯ (${ourMessages.length} шт):
${ourMessages.map((m, i) => `--- Сообщение ${i + 1} ---\n${sanitize(m, 500)}`).join("\n\n")}

ВАЖНО:
- НЕ повторяй информацию из предыдущих сообщений
- Добавь что-то новое
- Будь краток
- ${attempt >= 2 ? "Если это финальный фоллоуап — закрой тему вежливо" : "Покажи ценность"}`;

  // TODO: trackUsage

  return await withBackoff(async () => {
    const response = await client.messages.create({
      model: config.claudeModel,
      max_tokens: 1000,
      system: systemBlocks,
      tools: [SEND_REPLY_TOOL],
      tool_choice: { type: "tool", name: "send_reply" },
      messages: [{ role: "user", content: userPrompt }],
    });

    return extractPitchFromResponse(response);
  });
}

/**
 * Generate a content summary for a YouTube channel.
 * Uses the lightweight summary model (Haiku).
 */
export async function generateContentSummary(
  workspaceId: string,
  lead: any,
  project: any | null = null,
): Promise<string> {
  const { client, config } = await getAiClient(workspaceId);

  const parts: string[] = [];
  parts.push(`Проанализируй YouTube-канал "${sanitize(lead.channelName)}".`);

  if (lead.subscribers)
    parts.push(`Подписчики: ${lead.subscribers.toLocaleString()}`);
  if (lead.avgViews)
    parts.push(`Среднее просмотров: ${lead.avgViews.toLocaleString()}`);
  if (lead.country) parts.push(`Страна: ${lead.country}`);
  if (lead.mainCategory) parts.push(`Категория: ${lead.mainCategory}`);

  if (lead.channelAboutText) {
    parts.push(`\nО канале:\n${sanitize(lead.channelAboutText, 1000)}`);
  }

  if (lead.channelTags) {
    try {
      const tags = JSON.parse(lead.channelTags);
      if (Array.isArray(tags)) {
        parts.push(`Теги: ${tags.slice(0, 20).join(", ")}`);
      }
    } catch {
      // ignore
    }
  }

  if (lead.lastVideosJson) {
    try {
      const videos = JSON.parse(lead.lastVideosJson);
      if (Array.isArray(videos) && videos.length > 0) {
        const videoList = videos
          .slice(0, 10)
          .map(
            (v: any) =>
              `- "${sanitize(v.title, 120)}" | ${(v.views || 0).toLocaleString()} просм. | ${v.publishedAt ? new Date(v.publishedAt).toLocaleDateString("ru") : "?"}`,
          )
          .join("\n");
        parts.push(`\nПоследние видео:\n${videoList}`);
      }
    } catch {
      // ignore
    }
  }

  if (project) {
    parts.push(
      `\nКонтекст: анализ для проекта "${sanitize(project.name)}" (${sanitize(project.description, 200)})`,
    );
  }

  parts.push(
    "\nСоздай структурированное резюме канала, используя инструмент channel_summary.",
  );

  // TODO: trackUsage

  return await withBackoff(async () => {
    const response = await client.messages.create({
      model: config.claudeModelSummary,
      max_tokens: 1200,
      system: [
        {
          type: "text",
          text: "Ты — аналитик YouTube-каналов. Анализируй каналы и создавай структурированные резюме для отдела продаж. Будь объективен и конкретен.",
        },
      ],
      tools: [CHANNEL_SUMMARY_TOOL],
      tool_choice: { type: "tool", name: "channel_summary" },
      messages: [{ role: "user", content: parts.join("\n") }],
    });

    const result = extractToolResult<ContentSummary>(
      response,
      "channel_summary",
      {
        _v: 2,
        niche: "unknown",
        content_style: "unknown",
        audience: "unknown",
        tone: "unknown",
        recent_topics: [],
        pitch_hooks: [],
        red_flags: [],
      },
    );

    return JSON.stringify(result);
  });
}

/**
 * Generate a deep summary that includes comment analysis.
 */
export async function generateDeepSummary(
  workspaceId: string,
  lead: any,
  comments: any[],
): Promise<string> {
  const { client, config } = await getAiClient(workspaceId);

  const parts: string[] = [];
  parts.push(
    `Углублённый анализ YouTube-канала "${sanitize(lead.channelName)}" с учётом комментариев аудитории.`,
  );

  if (lead.subscribers)
    parts.push(`Подписчики: ${lead.subscribers.toLocaleString()}`);
  if (lead.avgViews)
    parts.push(`Среднее просмотров: ${lead.avgViews.toLocaleString()}`);
  if (lead.country) parts.push(`Страна: ${lead.country}`);
  if (lead.mainCategory) parts.push(`Категория: ${lead.mainCategory}`);

  if (lead.channelAboutText) {
    parts.push(`\nО канале:\n${sanitize(lead.channelAboutText, 1000)}`);
  }

  if (lead.lastVideosJson) {
    try {
      const videos = JSON.parse(lead.lastVideosJson);
      if (Array.isArray(videos) && videos.length > 0) {
        const videoList = videos
          .slice(0, 10)
          .map(
            (v: any) =>
              `- "${sanitize(v.title, 120)}" | ${(v.views || 0).toLocaleString()} просм.`,
          )
          .join("\n");
        parts.push(`\nПоследние видео:\n${videoList}`);
      }
    } catch {
      // ignore
    }
  }

  // Existing summary as context
  if (lead.contentSummary) {
    parts.push(`\nПРЕДЫДУЩЕЕ РЕЗЮМЕ:\n${sanitizeLong(lead.contentSummary)}`);
  }

  // Comments
  if (comments.length > 0) {
    const commentSample = comments
      .slice(0, 50)
      .map(
        (c: any) =>
          `[${c.likeCount || 0}❤] ${sanitize(c.author || "Аноним", 50)}: ${sanitize(c.text, 200)}`,
      )
      .join("\n");
    parts.push(
      `\nКОММЕНТАРИИ АУДИТОРИИ (выборка ${Math.min(comments.length, 50)} из ${comments.length}):\n${commentSample}`,
    );
  }

  parts.push(
    "\nСоздай углублённое резюме с учётом комментариев, используя инструмент channel_deep_summary.",
  );

  // TODO: trackUsage

  return await withBackoff(async () => {
    const response = await client.messages.create({
      model: config.claudeModel,
      max_tokens: 2000,
      system: [
        {
          type: "text",
          text: `Ты — аналитик YouTube-каналов с фокусом на анализ аудитории. Твоя задача — создать углублённое резюме канала, включая:
1. Анализ тона и настроения комментариев
2. Типичные вопросы и боли аудитории
3. Отношение аудитории к рекламным интеграциям
4. Голос аудитории — как они говорят, какой сленг используют

Будь объективен. Если видишь негатив к рекламе — отмечай это.`,
        },
      ],
      tools: [CHANNEL_DEEP_SUMMARY_TOOL],
      tool_choice: { type: "tool", name: "channel_deep_summary" },
      messages: [{ role: "user", content: parts.join("\n") }],
    });

    const result = extractToolResult<ContentSummary>(
      response,
      "channel_deep_summary",
      {
        _v: 2,
        niche: "unknown",
        content_style: "unknown",
        audience: "unknown",
        tone: "unknown",
        recent_topics: [],
        pitch_hooks: [],
        red_flags: [],
        deep: true,
        audience_voice: "unknown",
        common_questions: [],
        objections: [],
      },
    );

    return JSON.stringify(result);
  });
}

/**
 * Summarize the dialogue history with a lead (for internal use / handoff).
 */
export async function summarizeDialogue(
  workspaceId: string,
  lead: any,
  history: any[],
): Promise<string> {
  const { client, config } = await getAiClient(workspaceId);

  if (history.length === 0) {
    return "Диалог пуст.";
  }

  const transcript = history
    .map((msg) => {
      const dir = msg.direction === "OUT" ? "МЫ" : "БЛОГЕР";
      const text = msg.body || msg.text || "";
      const date = msg.createdAt
        ? new Date(msg.createdAt).toLocaleDateString("ru")
        : "";
      return `[${dir}] ${date}\n${sanitize(text, 500)}`;
    })
    .join("\n\n");

  const userPrompt = `Резюмируй переписку с блогером "${sanitize(lead.channelName)}" (${history.length} сообщений).

ПЕРЕПИСКА:
${transcript}

Напиши краткое резюме (3-5 предложений):
1. О чём договорились / на чём остановились
2. Какой статус переговоров
3. Следующие шаги (если есть)
4. Красные флаги или важные моменты`;

  // TODO: trackUsage

  return await withBackoff(async () => {
    const response = await client.messages.create({
      model: config.claudeModelSummary,
      max_tokens: 600,
      messages: [{ role: "user", content: userPrompt }],
    });

    // Extract text from response
    for (const block of response.content) {
      if (block.type === "text") {
        return block.text;
      }
    }

    return "Не удалось создать резюме.";
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Response Extraction Helpers
// ═══════════════════════════════════════════════════════════════════════════

function extractPitchFromResponse(response: Anthropic.Message): PitchResult {
  for (const block of response.content) {
    if (block.type === "tool_use" && block.name === "send_reply") {
      const input = block.input as Record<string, unknown>;
      return {
        subject: (input.subject as string) || null,
        body: (input.body as string) || "",
        flag: (input.flag as string) || null,
        extracted_price: (input.extracted_price as number) ?? null,
        consultation_question: (input.consultation_question as string) || null,
      };
    }
  }

  // Fallback: try to extract text
  for (const block of response.content) {
    if (block.type === "text" && block.text.trim()) {
      return {
        subject: null,
        body: block.text.trim(),
        flag: null,
        extracted_price: null,
        consultation_question: null,
      };
    }
  }

  throw new Error("No send_reply tool use found in response");
}

function extractToolResult<T>(
  response: Anthropic.Message,
  toolName: string,
  fallback: T,
): T {
  for (const block of response.content) {
    if (block.type === "tool_use" && block.name === toolName) {
      return block.input as T;
    }
  }
  return fallback;
}
