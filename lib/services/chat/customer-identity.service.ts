import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { findOrCreateCustomer } from "../tickets/customer.service";
import {
  issueCustomerToken,
  verifyCustomerToken,
} from "./customer-token.service";
import type { CustomerIdentityMethod } from "@prisma/client";

function generateCuid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function identifyOrCreateCustomer(
  workspaceId: string,
  identity: {
    method: CustomerIdentityMethod;
    email?: string;
    name?: string;
    telegramChatId?: string;
    telegramName?: string;
  },
): Promise<{
  customer: { id: string; email: string; name: string | null };
  token: string;
  csrf: string;
}> {
  // Verify workspace exists and method matches
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { chatIdentityMethod: true },
  });
  if (!workspace) throw new ApiError("Workspace не найден", "NOT_FOUND", 404);

  if (identity.method !== workspace.chatIdentityMethod) {
    throw new ApiError(
      "Метод идентификации не соответствует настройкам workspace",
      "IDENTITY_METHOD_MISMATCH",
      400,
    );
  }

  let email: string;
  let name: string | null = null;
  let externalId: string | undefined;

  switch (identity.method) {
    case "ANONYMOUS": {
      email = `anon-${generateCuid()}@anonymous.local`;
      name = "Аноним";
      break;
    }
    case "EMAIL_ONLY": {
      if (!identity.email) {
        throw new ApiError("Email обязателен", "EMAIL_REQUIRED", 400);
      }
      email = identity.email;
      break;
    }
    case "EMAIL_WITH_NAME": {
      if (!identity.email) {
        throw new ApiError("Email обязателен", "EMAIL_REQUIRED", 400);
      }
      email = identity.email;
      name = identity.name ?? null;
      break;
    }
    case "TELEGRAM_LOGIN": {
      if (!identity.telegramChatId) {
        throw new ApiError(
          "Telegram данные обязательны",
          "TELEGRAM_REQUIRED",
          400,
        );
      }
      email = `tg-${identity.telegramChatId}@telegram.local`;
      name = identity.telegramName ?? null;
      externalId = identity.telegramChatId;
      break;
    }
  }

  // P0 takeover fix: claiming an EMAIL is unauthenticated. If a customer with
  // that email ALREADY exists, we cannot prove the claimer owns it → issue an
  // UNVERIFIED session (emailVerified=false) which is scoped to NOT expose the
  // pre-existing customer's prior tickets (see verifyCustomerSession consumers).
  // A brand-new email (no prior customer), ANONYMOUS, and TELEGRAM_LOGIN
  // (proven by telegramChatId) are first-party → verified.
  let emailVerified = true;
  if (
    identity.method === "EMAIL_ONLY" ||
    identity.method === "EMAIL_WITH_NAME"
  ) {
    const pre = await db.customer.findUnique({
      where: { workspaceId_email: { workspaceId, email } },
      select: { id: true },
    });
    if (pre) emailVerified = false;
  }

  const customer = await findOrCreateCustomer(workspaceId, {
    email,
    // Don't let an UNVERIFIED existing-email claim overwrite the victim's
    // profile name (the takeover fix must keep an unverified claim inert).
    name: emailVerified ? (name ?? undefined) : undefined,
    externalId,
  });

  const csrfToken = crypto.randomUUID();
  const token = await issueCustomerToken(
    customer.id,
    workspaceId,
    csrfToken,
    emailVerified,
  );

  return { customer, token, csrf: csrfToken };
}

export type CustomerSession = {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  /** Token issue time (epoch ms). Unverified sessions can only see tickets
   *  created at/after this — the takeover-scoping boundary. */
  issuedAt: number | null;
};

/**
 * The "created-at floor" for an unverified email session: it may only see/touch
 * tickets created at/after the token was issued. Verified sessions → undefined
 * (no restriction). Used by ticket read/write paths.
 */
export function unverifiedTicketFloor(s: CustomerSession): Date | undefined {
  if (s.emailVerified) return undefined;
  return s.issuedAt ? new Date(s.issuedAt) : undefined;
}

export async function verifyCustomerSession(
  token: string,
  workspaceSlug: string,
): Promise<CustomerSession | null> {
  const payload = await verifyCustomerToken(token);
  if (!payload) return null;

  const workspace = await db.workspace.findUnique({
    where: { slug: workspaceSlug },
    select: { id: true },
  });
  if (!workspace || workspace.id !== payload.workspaceId) return null;

  const customer = await db.customer.findUnique({
    where: { id: payload.customerId },
    select: { id: true, email: true, name: true, workspaceId: true },
  });
  if (!customer || customer.workspaceId !== payload.workspaceId) return null;

  return {
    id: customer.id,
    email: customer.email,
    name: customer.name,
    emailVerified: payload.emailVerified,
    issuedAt: payload.issuedAt,
  };
}
