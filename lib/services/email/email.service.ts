import "server-only";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "../workspace.service";
import { logActivity, generateSummary } from "../logger.service";
import { findOrCreateCustomer } from "../tickets/customer.service";
import { encrypt, decrypt } from "@/lib/services/crypto.service";

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
    // Decrypted for the OWNER/ADMIN (gated above) — they need it to configure
    // the external inbound forwarder. smtpPass is intentionally NEVER returned.
    inboundSecret: cfg.inboundSecret ? decrypt(cfg.inboundSecret) : null,
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

  // Secrets are encrypted at rest (AES-256-GCM). decrypt() is graceful on read
  // (legacy plaintext passes through, re-encrypted on next write).
  const encPass =
    data.smtpPass !== undefined
      ? data.smtpPass
        ? encrypt(data.smtpPass)
        : null
      : undefined;

  await db.workspaceEmailConfig.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      enabled: data.enabled ?? false,
      smtpHost: data.smtpHost ?? null,
      smtpPort: data.smtpPort ?? null,
      smtpUser: data.smtpUser ?? null,
      smtpPass: encPass ?? null,
      smtpSecure: data.smtpSecure ?? true,
      fromEmail: data.fromEmail ?? null,
      fromName: data.fromName ?? null,
      inboundSecret: encrypt(crypto.randomUUID()),
    },
    update: {
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.smtpHost !== undefined ? { smtpHost: data.smtpHost } : {}),
      ...(data.smtpPort !== undefined ? { smtpPort: data.smtpPort } : {}),
      ...(data.smtpUser !== undefined ? { smtpUser: data.smtpUser } : {}),
      ...(encPass !== undefined ? { smtpPass: encPass } : {}),
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
          ? { user: cfg.smtpUser, pass: decrypt(cfg.smtpPass) }
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

// ─── Inbound secret verification (timing-safe) ──────────────────────────────

/**
 * Verify a presented inbound-webhook secret against the workspace config.
 * Constant-time compare; decrypts the stored (encrypted) secret first.
 * Returns whether inbound is enabled and the secret matches.
 */
export async function verifyInboundSecret(
  workspaceId: string,
  provided: string | null | undefined,
): Promise<{ enabled: boolean; ok: boolean }> {
  const cfg = await db.workspaceEmailConfig.findUnique({
    where: { workspaceId },
    select: { enabled: true, inboundSecret: true },
  });
  if (!cfg?.enabled || !cfg.inboundSecret)
    return { enabled: !!cfg?.enabled, ok: false };
  if (!provided) return { enabled: true, ok: false };

  const expected = Buffer.from(decrypt(cfg.inboundSecret));
  const got = Buffer.from(provided);
  const ok =
    expected.length === got.length && crypto.timingSafeEqual(expected, got);
  return { enabled: true, ok };
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

  // Create new ticket (with transaction + retry to avoid number race condition)
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const ticket = await db.$transaction(async (tx) => {
        const last = await tx.ticket.findFirst({
          where: { workspaceId },
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const nextNumber = (last?.number ?? 0) + 1;

        return tx.ticket.create({
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
      });

      void logActivity({
        workspaceId,
        actorId: null,
        action: "TICKET_CREATED",
        entityType: "Ticket",
        entityId: ticket.id,
        summary: generateSummary("TICKET_CREATED", {
          kbArticleTitle: `#${ticket.number} ${input.subject}`,
        }),
        metadata: { source: "EMAIL", from: input.from },
      });

      return { ticketId: ticket.id, isNew: true };
    } catch (err: unknown) {
      const prismaErr = err as { code?: string };
      if (prismaErr.code === "P2002" && attempt < MAX_RETRIES - 1) continue;
      throw err;
    }
  }

  throw new Error("Failed to create ticket from inbound email after retries");
}
