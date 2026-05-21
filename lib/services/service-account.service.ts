import "server-only";

import crypto from "crypto";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";

// ─── Types ───────────────────────────────────────────────────────────────────

export const VALID_SCOPES = [
  "tasks:read",
  "tickets:read",
  "tickets:analytics",
  "customers:read",
  "leads:read",
  "marketing:analytics",
  "kb:read",
  "users:read",
  "dashboard:read",
] as const;

export type ServiceScope = (typeof VALID_SCOPES)[number];

export type ServiceAccountView = {
  id: string;
  name: string;
  scopes: ServiceScope[];
  allowedIPs: string[] | null;
  isActive: boolean;
  workspaceId: string;
  lastUsedAt: Date | null;
  createdAt: Date;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return `pup_sa_${crypto.randomBytes(32).toString("hex")}`;
}

function parseScopes(raw: string): ServiceScope[] {
  try {
    return JSON.parse(raw) as ServiceScope[];
  } catch {
    return [];
  }
}

function parseIPs(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return null;
  }
}

function toView(row: {
  id: string;
  name: string;
  scopes: string;
  allowedIPs: string | null;
  isActive: boolean;
  workspaceId: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}): ServiceAccountView {
  return {
    id: row.id,
    name: row.name,
    scopes: parseScopes(row.scopes),
    allowedIPs: parseIPs(row.allowedIPs),
    isActive: row.isActive,
    workspaceId: row.workspaceId,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function createServiceAccount(input: {
  name: string;
  scopes: ServiceScope[];
  allowedIPs?: string[];
  workspaceId: string;
}): Promise<{ account: ServiceAccountView; token: string }> {
  // Validate scopes
  for (const scope of input.scopes) {
    if (!VALID_SCOPES.includes(scope)) {
      throw new ApiError(`Invalid scope: ${scope}`, "VALIDATION_ERROR", 400);
    }
  }

  // Verify workspace exists
  const workspace = await db.workspace.findUnique({
    where: { id: input.workspaceId },
  });
  if (!workspace) {
    throw new ApiError("Workspace not found", "NOT_FOUND", 404);
  }

  const token = generateToken();

  const row = await db.serviceAccount.create({
    data: {
      name: input.name,
      tokenHash: hashToken(token),
      scopes: JSON.stringify(input.scopes),
      allowedIPs: input.allowedIPs ? JSON.stringify(input.allowedIPs) : null,
      workspaceId: input.workspaceId,
    },
  });

  return { account: toView(row), token };
}

export async function listServiceAccounts(
  workspaceId: string,
): Promise<ServiceAccountView[]> {
  const rows = await db.serviceAccount.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toView);
}

export async function getServiceAccount(
  id: string,
): Promise<ServiceAccountView | null> {
  const row = await db.serviceAccount.findUnique({ where: { id } });
  return row ? toView(row) : null;
}

export async function updateServiceAccount(
  id: string,
  input: {
    name?: string;
    scopes?: ServiceScope[];
    allowedIPs?: string[] | null;
    isActive?: boolean;
  },
): Promise<ServiceAccountView> {
  if (input.scopes) {
    for (const scope of input.scopes) {
      if (!VALID_SCOPES.includes(scope)) {
        throw new ApiError(`Invalid scope: ${scope}`, "VALIDATION_ERROR", 400);
      }
    }
  }

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.scopes !== undefined) data.scopes = JSON.stringify(input.scopes);
  if (input.allowedIPs !== undefined) {
    data.allowedIPs = input.allowedIPs
      ? JSON.stringify(input.allowedIPs)
      : null;
  }
  if (input.isActive !== undefined) data.isActive = input.isActive;

  const row = await db.serviceAccount.update({ where: { id }, data });
  return toView(row);
}

export async function deleteServiceAccount(id: string): Promise<void> {
  await db.serviceAccount.delete({ where: { id } });
}

export async function rotateToken(
  id: string,
): Promise<{ account: ServiceAccountView; token: string }> {
  const token = generateToken();
  const row = await db.serviceAccount.update({
    where: { id },
    data: { tokenHash: hashToken(token) },
  });
  return { account: toView(row), token };
}

// ─── Token verification (used by middleware) ─────────────────────────────────

export type ResolvedServiceAccount = {
  id: string;
  name: string;
  scopes: ServiceScope[];
  allowedIPs: string[] | null;
  workspaceId: string;
};

export async function verifyToken(
  token: string,
): Promise<ResolvedServiceAccount | null> {
  const hash = hashToken(token);
  const row = await db.serviceAccount.findUnique({
    where: { tokenHash: hash },
  });
  if (!row || !row.isActive) return null;

  // Touch lastUsedAt (fire-and-forget)
  db.serviceAccount
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return {
    id: row.id,
    name: row.name,
    scopes: parseScopes(row.scopes),
    allowedIPs: parseIPs(row.allowedIPs),
    workspaceId: row.workspaceId,
  };
}
