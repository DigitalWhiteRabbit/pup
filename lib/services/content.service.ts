import "server-only";

import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkModuleAccess } from "@/lib/module-access";
import { storage } from "@/lib/services/storage";
import {
  CHANNEL_LABEL,
  FORMAT_LABEL,
  PRIORITY_LABEL,
  STATUS_LABEL,
  VISUAL_LABEL,
} from "@/lib/content/constants";
import { fmtShort, isOverdue, isReady, gates } from "@/lib/content/derive";
import type {
  CardAction,
  ContentCardInput,
  ContentCardView,
  ContentFilter,
  ContentHistoryEntry,
  ContentMediaView,
  ContentSummary,
} from "@/lib/content/types";
import type { Prisma } from "@prisma/client";

type Role = "ADMIN" | "USER";

// ─── Доступ / роль модератора ──────────────────────────────────────────────────

export async function resolveContentAccess(
  workspaceId: string,
  userId: string,
  userRole: Role,
): Promise<{ isModerator: boolean }> {
  if (userRole === "ADMIN") return { isModerator: true };

  const m = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true, allowedModules: true },
  });
  if (!m) throw new ApiError("Нет доступа к проекту", "FORBIDDEN", 403);

  // OWNER = полный доступ (allowedModules игнорируется)
  let allowed: string[] | null = null;
  if (m.role !== "OWNER" && m.allowedModules) {
    try {
      const parsed = JSON.parse(m.allowedModules) as unknown;
      if (Array.isArray(parsed)) allowed = parsed as string[];
    } catch {
      /* malformed → trated as null (full access) */
    }
  }

  if (m.role !== "OWNER" && !checkModuleAccess(allowed, "content")) {
    throw new ApiError("Нет доступа к модулю «Контент-план»", "FORBIDDEN", 403);
  }

  const isModerator =
    m.role === "OWNER" || checkModuleAccess(allowed, "content:moderate");
  return { isModerator };
}

// ─── Mapping ───────────────────────────────────────────────────────────────────

const cardInclude = {
  author: { select: { id: true, login: true } },
  assignee: { select: { id: true, login: true } },
  media: { orderBy: { order: "asc" } },
  history: {
    orderBy: { createdAt: "asc" },
    include: { user: { select: { login: true } } },
  },
} satisfies Prisma.ContentCardInclude;

type CardWithRelations = Prisma.ContentCardGetPayload<{
  include: typeof cardInclude;
}>;

function mapMedia(
  workspaceId: string,
  m: CardWithRelations["media"][number],
): ContentMediaView {
  return {
    id: m.id,
    type: m.type,
    src:
      m.type === "IMAGE"
        ? `/api/workspaces/${workspaceId}/content/media/${m.id}`
        : m.url,
    url: m.url,
    name: m.name,
    order: m.order,
  };
}

function mapCard(card: CardWithRelations): ContentCardView {
  return {
    id: card.id,
    workspaceId: card.workspaceId,
    author: card.author
      ? { id: card.author.id, login: card.author.login }
      : null,
    assignee: card.assignee
      ? { id: card.assignee.id, login: card.assignee.login }
      : null,
    title: card.title,
    channel: card.channel,
    format: card.format,
    priority: card.priority,
    status: card.status,
    visualStatus: card.visualStatus,
    publishDate: card.publishDate
      ? card.publishDate.toISOString().slice(0, 10)
      : null,
    visualBrief: card.visualBrief,
    visualLink: card.visualLink,
    text: card.text,
    workComment: card.workComment,
    adminComment: card.adminComment,
    publishedUrl: card.publishedUrl,
    publishedExternalId: card.publishedExternalId,
    autoPublish: card.autoPublish,
    proofChecked: card.proofChecked,
    visualApproved: card.visualApproved,
    media: card.media.map((m) => mapMedia(card.workspaceId, m)),
    history: card.history.map((h) => ({
      id: h.id,
      at: h.createdAt.toISOString(),
      userLogin: h.user.login,
      action: h.action,
      field: h.field,
      oldValue: h.oldValue,
      newValue: h.newValue,
    })),
    createdAt: card.createdAt.toISOString(),
    updatedAt: card.updatedAt.toISOString(),
  };
}

async function loadCardOrThrow(
  workspaceId: string,
  cardId: string,
): Promise<CardWithRelations> {
  const card = await db.contentCard.findUnique({
    where: { id: cardId },
    include: cardInclude,
  });
  if (!card || card.workspaceId !== workspaceId) {
    throw new ApiError("Карточка не найдена", "NOT_FOUND", 404);
  }
  return card;
}

function parseDate(d?: string | null): Date | null {
  if (!d) return null;
  const dt = new Date(d.length === 10 ? `${d}T00:00:00.000Z` : d);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// ─── List / Get ────────────────────────────────────────────────────────────────

export async function listCards(
  workspaceId: string,
  userId: string,
  userRole: Role,
  filter: ContentFilter = {},
): Promise<ContentCardView[]> {
  await resolveContentAccess(workspaceId, userId, userRole);

  const where: Prisma.ContentCardWhereInput = { workspaceId };
  if (filter.channel) where.channel = filter.channel;
  if (filter.status) where.status = filter.status;
  if (filter.priority) where.priority = filter.priority;
  if (filter.format) where.format = filter.format;
  if (filter.search) {
    const q = filter.search;
    where.OR = [
      { title: { contains: q } },
      { text: { contains: q } },
      { workComment: { contains: q } },
      { adminComment: { contains: q } },
    ];
  }

  const cards = await db.contentCard.findMany({
    where,
    include: cardInclude,
    orderBy: [{ publishDate: "asc" }, { createdAt: "asc" }],
  });
  return cards.map(mapCard);
}

export async function getCard(
  workspaceId: string,
  cardId: string,
  userId: string,
  userRole: Role,
): Promise<ContentCardView> {
  await resolveContentAccess(workspaceId, userId, userRole);
  const card = await loadCardOrThrow(workspaceId, cardId);
  return mapCard(card);
}

// ─── History helper ──────────────────────────────────────────────────────────

async function writeHistory(
  client: Prisma.TransactionClient | typeof db,
  cardId: string,
  userId: string,
  action: string,
  field?: string | null,
  oldValue?: string | null,
  newValue?: string | null,
): Promise<void> {
  await client.contentCardHistory.create({
    data: {
      cardId,
      userId,
      action,
      field: field ?? null,
      oldValue: oldValue ?? null,
      newValue: newValue ?? null,
    },
  });
}

// ─── Create ────────────────────────────────────────────────────────────────────

export async function createCard(
  workspaceId: string,
  userId: string,
  userRole: Role,
  input: ContentCardInput,
): Promise<ContentCardView> {
  await resolveContentAccess(workspaceId, userId, userRole);

  const card = await db.$transaction(async (tx) => {
    const created = await tx.contentCard.create({
      data: {
        workspaceId,
        authorId: userId,
        assigneeId: input.assigneeId ?? null,
        title: input.title,
        channel: input.channel,
        format: input.format,
        priority: input.priority,
        status: input.status ?? "DRAFT",
        visualStatus: input.visualStatus ?? "NONE",
        publishDate: parseDate(input.publishDate),
        visualBrief: input.visualBrief ?? null,
        visualLink: input.visualLink ?? null,
        text: input.text ?? null,
        workComment: input.workComment ?? null,
        adminComment: input.adminComment ?? null,
        autoPublish: input.autoPublish ?? false,
      },
    });
    await writeHistory(tx, created.id, userId, "создал карточку");
    return created;
  });

  return getCardById(card.id, workspaceId);
}

async function getCardById(
  cardId: string,
  workspaceId: string,
): Promise<ContentCardView> {
  const card = await loadCardOrThrow(workspaceId, cardId);
  return mapCard(card);
}

// ─── Update (с пополевым diff) ─────────────────────────────────────────────────

const LABEL = {
  channel: (v: string) => CHANNEL_LABEL[v as keyof typeof CHANNEL_LABEL] ?? v,
  format: (v: string) => FORMAT_LABEL[v as keyof typeof FORMAT_LABEL] ?? v,
  priority: (v: string) =>
    PRIORITY_LABEL[v as keyof typeof PRIORITY_LABEL] ?? v,
  status: (v: string) => STATUS_LABEL[v as keyof typeof STATUS_LABEL] ?? v,
  visualStatus: (v: string) =>
    VISUAL_LABEL[v as keyof typeof VISUAL_LABEL] ?? v,
};

function fmtVal(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  if (!s) return "—";
  return `«${s.length > 60 ? s.slice(0, 60) + "…" : s}»`;
}

export async function updateCard(
  workspaceId: string,
  cardId: string,
  userId: string,
  userRole: Role,
  input: Partial<ContentCardInput>,
): Promise<ContentCardView> {
  const { isModerator } = await resolveContentAccess(
    workspaceId,
    userId,
    userRole,
  );
  const card = await loadCardOrThrow(workspaceId, cardId);
  if (!isModerator && card.authorId !== userId) {
    throw new ApiError(
      "Можно редактировать только свои карточки",
      "FORBIDDEN",
      403,
    );
  }

  // ── Пополевая авторизация (привилегированные поля — только модератор) ──
  if (!isModerator) {
    // adminComment пишет только старший менеджер
    if (
      input.adminComment !== undefined &&
      (input.adminComment ?? "") !== (card.adminComment ?? "")
    ) {
      throw new ApiError(
        "Админ-комментарий может оставлять только старший менеджер",
        "FORBIDDEN",
        403,
      );
    }
    // Переход в OK у визуала — только модератор (согласование визуала)
    if (
      input.visualStatus !== undefined &&
      input.visualStatus !== card.visualStatus &&
      input.visualStatus === "OK"
    ) {
      throw new ApiError(
        "Согласовать визуал может только старший менеджер",
        "FORBIDDEN",
        403,
      );
    }
    // Статус: автор может ставить только IDEA/DRAFT/PAUSED; REVIEW/READY/PUBLISHED — через cardAction
    const AUTHOR_STATUSES = ["IDEA", "DRAFT", "PAUSED"];
    if (
      input.status !== undefined &&
      input.status !== card.status &&
      !AUTHOR_STATUSES.includes(input.status)
    ) {
      throw new ApiError(
        "Этот статус выставляется через действия (вычитка/публикация) или старшим менеджером",
        "FORBIDDEN",
        403,
      );
    }
  }

  const changes: Array<{
    field: string;
    action: string;
    oldValue: string | null;
    newValue: string | null;
  }> = [];
  const data: Prisma.ContentCardUpdateInput = {};

  function diffText(
    field: keyof ContentCardInput,
    label: string,
    oldRaw: string | null,
    newRaw: string | null | undefined,
  ) {
    if (newRaw === undefined) return;
    const o = oldRaw ?? "";
    const n = newRaw ?? "";
    if (o === n) return;
    changes.push({
      field,
      action: `изменил «${label}»: ${fmtVal(oldRaw)} → ${fmtVal(newRaw)}`,
      oldValue: oldRaw,
      newValue: newRaw,
    });
    (data as Record<string, unknown>)[field] = newRaw === "" ? null : newRaw;
  }

  function diffEnum(
    field: "channel" | "format" | "priority" | "status" | "visualStatus",
    label: string,
    oldVal: string,
    newVal: string | undefined,
  ) {
    if (newVal === undefined || newVal === oldVal) return;
    changes.push({
      field,
      action: `изменил «${label}»: ${LABEL[field](oldVal)} → ${LABEL[field](newVal)}`,
      oldValue: oldVal,
      newValue: newVal,
    });
    (data as Record<string, unknown>)[field] = newVal;
  }

  diffText("title", "Тема", card.title, input.title);
  diffText("visualBrief", "ТЗ визуала", card.visualBrief, input.visualBrief);
  diffText("text", "Финальный текст", card.text, input.text);
  diffText(
    "workComment",
    "Рабочий комментарий",
    card.workComment,
    input.workComment,
  );
  diffText("visualLink", "Ссылка на визуал", card.visualLink, input.visualLink);
  diffText(
    "adminComment",
    "Админ-комментарий",
    card.adminComment,
    input.adminComment,
  );
  diffEnum("channel", "Канал", card.channel, input.channel);
  diffEnum("format", "Формат", card.format, input.format);
  diffEnum("priority", "Приоритет", card.priority, input.priority);
  diffEnum("status", "Статус", card.status, input.status);
  diffEnum(
    "visualStatus",
    "Готовность визуала",
    card.visualStatus,
    input.visualStatus,
  );

  // Дата
  if (input.publishDate !== undefined) {
    const oldStr = card.publishDate
      ? card.publishDate.toISOString().slice(0, 10)
      : null;
    const newStr = input.publishDate ?? null;
    if (oldStr !== newStr) {
      changes.push({
        field: "publishDate",
        action: `изменил «Дата»: ${fmtShortRaw(oldStr)} → ${fmtShortRaw(newStr)}`,
        oldValue: oldStr,
        newValue: newStr,
      });
      data.publishDate = parseDate(newStr);
    }
  }

  // Ответственный
  if (input.assigneeId !== undefined) {
    const oldId = card.assigneeId;
    const newId = input.assigneeId ?? null;
    if (oldId !== newId) {
      const [oldUser, newUser] = await Promise.all([
        oldId
          ? db.user.findUnique({
              where: { id: oldId },
              select: { login: true },
            })
          : null,
        newId
          ? db.user.findUnique({
              where: { id: newId },
              select: { login: true },
            })
          : null,
      ]);
      changes.push({
        field: "assigneeId",
        action: `изменил «Ответственный»: ${oldUser?.login ?? "—"} → ${newUser?.login ?? "—"}`,
        oldValue: oldId,
        newValue: newId,
      });
      data.assignee = newId ? { connect: { id: newId } } : { disconnect: true };
    }
  }

  // autoPublish (без записи в историю — служебное)
  if (
    input.autoPublish !== undefined &&
    input.autoPublish !== card.autoPublish
  ) {
    data.autoPublish = input.autoPublish;
  }

  if (Object.keys(data).length === 0 && changes.length === 0) {
    return mapCard(card);
  }

  await db.$transaction(async (tx) => {
    await tx.contentCard.update({ where: { id: cardId }, data });
    for (const ch of changes) {
      await writeHistory(
        tx,
        cardId,
        userId,
        ch.action,
        ch.field,
        ch.oldValue,
        ch.newValue,
      );
    }
  });

  return getCardById(cardId, workspaceId);
}

function fmtShortRaw(d: string | null): string {
  return d ? fmtShort(d) : "—";
}

// ─── Delete ────────────────────────────────────────────────────────────────────

export async function deleteCard(
  workspaceId: string,
  cardId: string,
  userId: string,
  userRole: Role,
): Promise<void> {
  const { isModerator } = await resolveContentAccess(
    workspaceId,
    userId,
    userRole,
  );
  const card = await loadCardOrThrow(workspaceId, cardId);
  if (!isModerator && card.authorId !== userId) {
    throw new ApiError("Нет прав на удаление карточки", "FORBIDDEN", 403);
  }
  // Удаляем файлы изображений из хранилища
  for (const m of card.media) {
    if (m.type === "IMAGE") {
      try {
        await storage().delete(m.url);
      } catch {
        /* ok */
      }
    }
  }
  await db.contentCard.delete({ where: { id: cardId } });
}

// ─── Duplicate ─────────────────────────────────────────────────────────────────

export async function duplicateCard(
  workspaceId: string,
  cardId: string,
  userId: string,
  userRole: Role,
): Promise<ContentCardView> {
  await resolveContentAccess(workspaceId, userId, userRole);
  const card = await loadCardOrThrow(workspaceId, cardId);

  const copy = await db.contentCard.create({
    data: {
      workspaceId,
      authorId: userId,
      assigneeId: card.assigneeId,
      title: card.title,
      channel: card.channel,
      format: card.format,
      priority: card.priority,
      status: "DRAFT",
      visualStatus:
        card.visualStatus === "OK" ? "IN_REVIEW" : card.visualStatus,
      publishDate: card.publishDate,
      visualBrief: card.visualBrief,
      visualLink: card.visualLink,
      text: card.text,
      workComment: card.workComment,
      autoPublish: false,
      proofChecked: false,
      visualApproved: false,
    },
  });

  // Копируем медиа: видео — по ссылке; фото — отдельная копия файла
  for (const m of card.media) {
    if (m.type === "VIDEO") {
      await db.contentMedia.create({
        data: {
          cardId: copy.id,
          type: "VIDEO",
          url: m.url,
          name: m.name,
          order: m.order,
        },
      });
    } else {
      try {
        const buffer = await readStorageFile(m.url);
        const result = await storage().upload({
          scope: "content",
          workspaceId,
          cardId: copy.id,
          originalName: m.name ?? "image",
          buffer,
          mimeType: "image/*",
        });
        await db.contentMedia.create({
          data: {
            cardId: copy.id,
            type: "IMAGE",
            url: result.storagePath,
            name: m.name,
            order: m.order,
          },
        });
      } catch {
        /* пропускаем недоступное фото */
      }
    }
  }

  await writeHistory(db, copy.id, userId, "дубликат карточки");
  return getCardById(copy.id, workspaceId);
}

async function readStorageFile(storagePath: string): Promise<Buffer> {
  const stream = await storage().download(storagePath);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// ─── Сдвиг даты ────────────────────────────────────────────────────────────────

export async function shiftCardDate(
  workspaceId: string,
  cardId: string,
  userId: string,
  userRole: Role,
  delta: number,
): Promise<ContentCardView> {
  const { isModerator } = await resolveContentAccess(
    workspaceId,
    userId,
    userRole,
  );
  const card = await loadCardOrThrow(workspaceId, cardId);
  if (!isModerator && card.authorId !== userId) {
    throw new ApiError("Нет прав на изменение карточки", "FORBIDDEN", 403);
  }
  const base = card.publishDate ?? new Date();
  const next = new Date(base);
  next.setUTCDate(next.getUTCDate() + delta);
  await db.contentCard.update({
    where: { id: cardId },
    data: { publishDate: next },
  });
  return getCardById(cardId, workspaceId);
}

// ─── Workflow actions ──────────────────────────────────────────────────────────

export type ActionResult = {
  card: ContentCardView;
  /** Событие для системы уведомлений (Phase 5). */
  event: { kind: CardAction; cardId: string; authorId: string } | null;
};

export async function cardAction(
  workspaceId: string,
  cardId: string,
  userId: string,
  userRole: Role,
  action: CardAction,
  extra?: { publishedUrl?: string },
): Promise<ActionResult> {
  const { isModerator } = await resolveContentAccess(
    workspaceId,
    userId,
    userRole,
  );
  const card = await loadCardOrThrow(workspaceId, cardId);
  const isAuthor = card.authorId === userId;

  const authorOrMod = isModerator || isAuthor;
  const modOnly = isModerator;

  const data: Prisma.ContentCardUpdateInput = {};
  let historyAction = "";

  switch (action) {
    case "review":
      if (!authorOrMod)
        throw new ApiError("Нет прав на это действие", "FORBIDDEN", 403);
      data.status = "REVIEW";
      historyAction = "отправил на вычитку";
      break;
    case "request-changes":
      if (!modOnly)
        throw new ApiError(
          "Только модератор может вернуть на правки",
          "FORBIDDEN",
          403,
        );
      data.status = "DRAFT";
      data.proofChecked = false;
      historyAction = "вернул на правки";
      break;
    case "approve":
      if (!modOnly)
        throw new ApiError(
          "Только модератор может пометить «Проверено»",
          "FORBIDDEN",
          403,
        );
      data.proofChecked = true;
      if (card.status === "REVIEW") data.status = "READY";
      historyAction = "проверено";
      break;
    case "approve-visual":
      if (!modOnly)
        throw new ApiError(
          "Только модератор может согласовать визуал",
          "FORBIDDEN",
          403,
        );
      data.visualApproved = true;
      data.visualStatus = "OK";
      historyAction = "визуал OK";
      break;
    case "publish":
      if (!authorOrMod)
        throw new ApiError("Нет прав на публикацию", "FORBIDDEN", 403);
      data.status = "PUBLISHED";
      if (extra?.publishedUrl) data.publishedUrl = extra.publishedUrl;
      historyAction = "опубликовано";
      break;
    default:
      throw new ApiError("Неизвестное действие", "VALIDATION_ERROR", 400);
  }

  await db.$transaction(async (tx) => {
    await tx.contentCard.update({ where: { id: cardId }, data });
    await writeHistory(tx, cardId, userId, historyAction);
  });

  const view = await getCardById(cardId, workspaceId);
  return {
    card: view,
    event: { kind: action, cardId, authorId: card.authorId },
  };
}

// ─── Media ─────────────────────────────────────────────────────────────────────

function mediaCounts(media: Array<{ type: string }>): {
  images: number;
  videos: number;
} {
  return {
    images: media.filter((m) => m.type === "IMAGE").length,
    videos: media.filter((m) => m.type === "VIDEO").length,
  };
}

function mediaDiffText(
  before: { images: number; videos: number },
  after: { images: number; videos: number },
): string {
  const part = (c: { images: number; videos: number }) =>
    `${c.images} фото${c.videos ? " + видео" : ""}`;
  return `изменил «Медиа»: было ${part(before)} → стало ${part(after)}`;
}

export async function addMedia(
  workspaceId: string,
  cardId: string,
  userId: string,
  userRole: Role,
  input: { file?: File; videoUrl?: string; name?: string },
): Promise<ContentMediaView> {
  const { isModerator } = await resolveContentAccess(
    workspaceId,
    userId,
    userRole,
  );
  const card = await loadCardOrThrow(workspaceId, cardId);
  if (!isModerator && card.authorId !== userId) {
    throw new ApiError("Нет прав на изменение карточки", "FORBIDDEN", 403);
  }

  const before = mediaCounts(card.media);
  const maxOrder = card.media.reduce((acc, m) => Math.max(acc, m.order), -1);

  let media;
  if (input.file) {
    const baseMime = (input.file.type || "image/*").split(";")[0]!.trim();
    if (!baseMime.startsWith("image/")) {
      throw new ApiError(
        "Фото должно быть изображением",
        "VALIDATION_ERROR",
        400,
      );
    }
    const buffer = Buffer.from(await input.file.arrayBuffer());
    const result = await storage().upload({
      scope: "content",
      workspaceId,
      cardId,
      originalName: input.file.name,
      buffer,
      mimeType: baseMime,
    });
    media = await db.contentMedia.create({
      data: {
        cardId,
        type: "IMAGE",
        url: result.storagePath,
        name: input.file.name,
        order: maxOrder + 1,
      },
    });
  } else if (input.videoUrl) {
    media = await db.contentMedia.create({
      data: {
        cardId,
        type: "VIDEO",
        url: input.videoUrl,
        name: input.name ?? "видео",
        order: maxOrder + 1,
      },
    });
  } else {
    throw new ApiError("Не передан файл или ссылка", "VALIDATION_ERROR", 400);
  }

  const after = {
    images: before.images + (media.type === "IMAGE" ? 1 : 0),
    videos: before.videos + (media.type === "VIDEO" ? 1 : 0),
  };
  await writeHistory(db, cardId, userId, mediaDiffText(before, after), "media");

  return mapMedia(workspaceId, media);
}

export async function deleteMedia(
  workspaceId: string,
  cardId: string,
  mediaId: string,
  userId: string,
  userRole: Role,
): Promise<void> {
  const { isModerator } = await resolveContentAccess(
    workspaceId,
    userId,
    userRole,
  );
  const card = await loadCardOrThrow(workspaceId, cardId);
  if (!isModerator && card.authorId !== userId) {
    throw new ApiError("Нет прав на изменение карточки", "FORBIDDEN", 403);
  }
  const media = card.media.find((m) => m.id === mediaId);
  if (!media) throw new ApiError("Медиа не найдено", "NOT_FOUND", 404);

  const before = mediaCounts(card.media);
  if (media.type === "IMAGE") {
    try {
      await storage().delete(media.url);
    } catch {
      /* ok */
    }
  }
  await db.contentMedia.delete({ where: { id: mediaId } });

  const after = {
    images: before.images - (media.type === "IMAGE" ? 1 : 0),
    videos: before.videos - (media.type === "VIDEO" ? 1 : 0),
  };
  await writeHistory(db, cardId, userId, mediaDiffText(before, after), "media");
}

export async function getMediaForDownload(
  workspaceId: string,
  mediaId: string,
  userId: string,
  userRole: Role,
): Promise<{ storagePath: string; name: string | null }> {
  await resolveContentAccess(workspaceId, userId, userRole);
  const media = await db.contentMedia.findUnique({
    where: { id: mediaId },
    include: { card: { select: { workspaceId: true } } },
  });
  if (
    !media ||
    media.card.workspaceId !== workspaceId ||
    media.type !== "IMAGE"
  ) {
    throw new ApiError("Файл не найден", "NOT_FOUND", 404);
  }
  return { storagePath: media.url, name: media.name };
}

// ─── History ───────────────────────────────────────────────────────────────────

export async function getHistory(
  workspaceId: string,
  cardId: string,
  userId: string,
  userRole: Role,
): Promise<ContentHistoryEntry[]> {
  await resolveContentAccess(workspaceId, userId, userRole);
  await loadCardOrThrow(workspaceId, cardId);
  const rows = await db.contentCardHistory.findMany({
    where: { cardId },
    orderBy: { createdAt: "asc" },
    include: { user: { select: { login: true } } },
  });
  return rows.map((h) => ({
    id: h.id,
    at: h.createdAt.toISOString(),
    userLogin: h.user.login,
    action: h.action,
    field: h.field,
    oldValue: h.oldValue,
    newValue: h.newValue,
  }));
}

// ─── Dashboard summary ─────────────────────────────────────────────────────────

export async function getSummary(
  workspaceId: string,
  userId: string,
  userRole: Role,
): Promise<ContentSummary> {
  await resolveContentAccess(workspaceId, userId, userRole);
  const cards = (
    await db.contentCard.findMany({
      where: { workspaceId },
      include: cardInclude,
    })
  ).map(mapCard);

  const total = cards.length;
  const review = cards.filter((c) => c.status === "REVIEW").length;
  const checked = cards.filter((c) => c.proofChecked).length;
  const visualOk = cards.filter((c) => c.visualApproved).length;
  const toPublish = cards.filter(
    (c) => isReady(c) && c.status !== "PUBLISHED",
  ).length;
  const published = cards.filter((c) => c.status === "PUBLISHED").length;
  const linkOk = cards.filter((c) => c.publishedUrl).length;

  const metrics: Record<string, number> = {
    overdue: cards.filter((c) => isOverdue(c)).length,
    today: cards.filter(
      (c) => c.publishDate === new Date().toISOString().slice(0, 10),
    ).length,
    notext: cards.filter((c) => !gates(c).text).length,
    review,
    highprio: cards.filter((c) => c.priority === "HIGH").length,
    ready: toPublish,
    novisual: cards.filter((c) => !c.visualApproved).length,
    needvisual: cards.filter((c) => c.visualStatus === "IN_REVIEW").length,
    changes: cards.filter((c) => c.adminComment && c.status === "DRAFT").length,
    nodate: cards.filter((c) => !c.publishDate).length,
    noowner: cards.filter((c) => !c.assignee).length,
    published,
    checked,
    visualok: visualOk,
  };

  const channelCounts = new Map<string, number>();
  for (const c of cards)
    channelCounts.set(c.channel, (channelCounts.get(c.channel) ?? 0) + 1);

  return {
    kpi: { total, review, checked, visualOk, toPublish, published },
    coverage: {
      checkPercent: total ? Math.round((checked / total) * 100) : 0,
      checkedOf: { done: checked, total },
      linkPercent: published ? Math.round((linkOk / published) * 100) : 0,
      linkOf: { done: linkOk, total: published },
    },
    metrics,
    channels: Array.from(channelCounts.entries()).map(([channel, count]) => ({
      channel: channel as ContentSummary["channels"][number]["channel"],
      count,
    })),
  };
}
