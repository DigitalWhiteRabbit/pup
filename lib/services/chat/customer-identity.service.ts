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

  const customer = await findOrCreateCustomer(workspaceId, {
    email,
    name: name ?? undefined,
    externalId,
  });

  const csrfToken = crypto.randomUUID();
  const token = await issueCustomerToken(customer.id, workspaceId, csrfToken);

  return { customer, token, csrf: csrfToken };
}

export async function verifyCustomerSession(
  token: string,
  workspaceSlug: string,
): Promise<{ id: string; email: string; name: string | null } | null> {
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

  return { id: customer.id, email: customer.email, name: customer.name };
}
