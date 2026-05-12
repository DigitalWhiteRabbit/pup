import "server-only";
import nodemailer from "nodemailer";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "../workspace.service";
import { logActivity, generateSummary } from "../logger.service";
import { findOrCreateCustomer } from "../tickets/customer.service";

// ─── Email config CRUD ──────────────────────────────────────────────────────

export type EmailConfigView = {
  id: string;
  enabled: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpSecure: boolean;
  fromEmail: string | null;
  fromName: string | null;
  inboundSecret: string | null;
};

export async function getEmailConfig(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<EmailConfigView | null> {
  const m = await checkMembership(workspaceId, userId);
  if (m !== "OWNER" && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const cfg = await db.workspaceEmailConfig.findUnique({
    where: { workspaceId },
  });
  if (!cfg) return null;

  return {
    id: cfg.id,
    enabled: cfg.enabled,
    smtpHost: cfg.smtpHost,
    smtpPort: cfg.smtpPort,
    smtpUser: cfg.smtpUser,
    smtpSecure: cfg.smtpSecure,
    fromEmail: cfg.fromEmail,
    fromName: cfg.fromName,
    inboundSecret: cfg.inboundSecret,
  };
}

export async function updateEmailConfig(
  workspaceId: string,
  data: {
    enabled?: boolean;
    smtpHost?: string | null;
    smtpPort?: number | null;
    smtpUser?: string | null;
    smtpPass?: string | null;
    smtpSecure?: boolean;
    fromEmail?: string | null;
    fromName?: string | null;
  },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<void> {
  const m = await checkMembership(workspaceId, userId);
  if (m !== "OWNER" && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  await db.workspaceEmailConfig.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      enabled: data.enabled ?? false,
      smtpHost: data.smtpHost ?? null,
      smtpPort: data.smtpPort ?? null,
      smtpUser: data.smtpUser ?? null,
      smtpPass: data.smtpPass ?? null,
      smtpSecure: data.smtpSecure ?? true,
      fromEmail: data.fromEmail ?? null,
      fromName: data.fromName ?? null,
      inboundSecret: crypto.randomUUID(),
    },
    update: {
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.smtpHost !== undefined ? { smtpHost: data.smtpHost } : {}),
      ...(data.smtpPort !== undefined ? { smtpPort: data.smtpPort } : {}),
      ...(data.smtpUser !== undefined ? { smtpUser: data.smtpUser } : {}),
      ...(data.smtpPass !== undefined ? { smtpPass: data.smtpPass } : {}),
      ...(data.smtpSecure !== undefined ? { smtpSecure: data.smtpSecure } : {}),
      ...(data.fromEmail !== undefined ? { fromEmail: data.fromEmail } : {}),
      ...(data.fromName !== undefined ? { fromName: data.fromName } : {}),
    },
  });

  void logActivity({
    workspaceId,
    actorId: userId,
    action: "EMAIL_CONFIG_UPDATED",
    entityType: "WorkspaceEmailConfig",
    summary: generateSummary("EMAIL_CONFIG_UPDATED", {}),
    metadata: { enabled: data.enabled },
  });
}

// ─── Send email reply ───────────────────────────────────────────────────────

export async function sendEmailReply(
  workspaceId: string,
  toEmail: string,
  subject: string,
  body: string,
): Promise<boolean> {
  const cfg = await db.workspaceEmailConfig.findUnique({
    where: { workspaceId },
  });
  if (!cfg?.enabled || !cfg.smtpHost || !cfg.fromEmail) return false;

  try {
    const transport = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort ?? 587,
      secure: cfg.smtpSecure,
      auth:
        cfg.smtpUser && cfg.smtpPass
          ? { user: cfg.smtpUser, pass: cfg.smtpPass }
          : undefined,
    });

    await transport.sendMail({
      from: cfg.fromName
        ? `"${cfg.fromName}" <${cfg.fromEmail}>`
        : cfg.fromEmail,
      to: toEmail,
      subject,
      text: body,
    });

    return true;
  } catch (err) {
    console.error("[Email send error]", err);
    return false;
  }
}

// ─── Inbound email → ticket ─────────────────────────────────────────────────

export async function handleInboundEmail(
  workspaceId: string,
  input: {
    from: string;
    fromName?: string;
    subject: string;
    textBody: string;
    inReplyTo?: string; // ticket ID for threading
  },
): Promise<{ ticketId: string; isNew: boolean }> {
  const customer = await findOrCreateCustomer(workspaceId, {
    email: input.from,
    name: input.fromName,
  });

  // Check if reply to existing ticket
  if (input.inReplyTo) {
    const existing = await db.ticket.findUnique({
      where: { id: input.inReplyTo },
      select: { id: true, workspaceId: true, customerId: true, status: true },
    });

    if (
      existing &&
      existing.workspaceId === workspaceId &&
      existing.customerId === customer.id &&
      existing.status !== "CLOSED"
    ) {
      await db.ticketMessage.create({
        data: {
          ticketId: existing.id,
          authorType: "CUSTOMER",
          customerAuthorId: customer.id,
          content: input.textBody,
        },
      });

      // Auto-transition from WAITING_CUSTOMER
      if (existing.status === "WAITING_CUSTOMER") {
        await db.ticket.update({
          where: { id: existing.id },
          data: { status: "IN_PROGRESS" },
        });
      }

      return { ticketId: existing.id, isNew: false };
    }
  }

  // Create new ticket
  const last = await db.ticket.findFirst({
    where: { workspaceId },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const nextNumber = (last?.number ?? 0) + 1;

  const ticket = await db.ticket.create({
    data: {
      workspaceId,
      number: nextNumber,
      title: input.subject || "Email обращение",
      description: input.textBody,
      source: "EMAIL",
      category: "GENERAL",
      priority: "MEDIUM",
      slaDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      customerId: customer.id,
      messages: {
        create: {
          authorType: "CUSTOMER",
          customerAuthorId: customer.id,
          content: input.textBody,
        },
      },
    },
  });

  void logActivity({
    workspaceId,
    actorId: null,
    action: "TICKET_CREATED",
    entityType: "Ticket",
    entityId: ticket.id,
    summary: generateSummary("TICKET_CREATED", {
      kbArticleTitle: `#${nextNumber} ${input.subject}`,
    }),
    metadata: { source: "EMAIL", from: input.from },
  });

  return { ticketId: ticket.id, isNew: true };
}
