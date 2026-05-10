import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "../workspace.service";
import { logActivity, generateSummary } from "../logger.service";

export type CustomerView = {
  id: string;
  email: string;
  name: string | null;
  externalId: string | null;
  ticketsCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export async function findOrCreateCustomer(
  workspaceId: string,
  input: {
    email: string;
    name?: string;
    externalId?: string;
    metadata?: Record<string, unknown>;
  },
  actorId?: string,
): Promise<{ id: string; email: string; name: string | null }> {
  const existing = await db.customer.findUnique({
    where: { workspaceId_email: { workspaceId, email: input.email } },
    select: { id: true, email: true, name: true },
  });

  if (existing) {
    if (
      (input.name && input.name !== existing.name) ||
      input.externalId !== undefined
    ) {
      return db.customer.update({
        where: { id: existing.id },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.externalId !== undefined
            ? { externalId: input.externalId }
            : {}),
          ...(input.metadata !== undefined
            ? { metadata: JSON.stringify(input.metadata) }
            : {}),
        },
        select: { id: true, email: true, name: true },
      });
    }
    return existing;
  }

  const customer = await db.customer.create({
    data: {
      workspaceId,
      email: input.email,
      name: input.name ?? null,
      externalId: input.externalId ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    },
    select: { id: true, email: true, name: true },
  });

  void logActivity({
    workspaceId,
    actorId: actorId ?? null,
    action: "CUSTOMER_CREATED",
    entityType: "Customer",
    entityId: customer.id,
    summary: generateSummary("CUSTOMER_CREATED", {
      kbArticleTitle: customer.email,
    }),
    metadata: { email: customer.email },
  });

  return customer;
}

export async function listCustomers(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
  filters: { page?: number; pageSize?: number; search?: string } = {},
): Promise<{ data: CustomerView[]; total: number }> {
  const m = await checkMembership(workspaceId, userId);
  if (!m && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const skip = (page - 1) * pageSize;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = { workspaceId };
  if (filters.search) {
    where.OR = [
      { email: { contains: filters.search } },
      { name: { contains: filters.search } },
    ];
  }

  const [customers, total] = await db.$transaction([
    db.customer.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { tickets: true } } },
    }),
    db.customer.count({ where }),
  ]);

  return {
    data: customers.map((c) => ({
      id: c.id,
      email: c.email,
      name: c.name,
      externalId: c.externalId,
      ticketsCount: c._count.tickets,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
    total,
  };
}

export async function getCustomer(
  customerId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<CustomerView> {
  const customer = await db.customer.findUnique({
    where: { id: customerId },
    include: { _count: { select: { tickets: true } } },
  });
  if (!customer) throw new ApiError("Клиент не найден", "NOT_FOUND", 404);

  const m = await checkMembership(customer.workspaceId, userId);
  if (!m && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  return {
    id: customer.id,
    email: customer.email,
    name: customer.name,
    externalId: customer.externalId,
    ticketsCount: customer._count.tickets,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
  };
}

export async function updateCustomer(
  customerId: string,
  data: { name?: string; externalId?: string },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<CustomerView> {
  const customer = await db.customer.findUnique({
    where: { id: customerId },
  });
  if (!customer) throw new ApiError("Клиент не найден", "NOT_FOUND", 404);

  const m = await checkMembership(customer.workspaceId, userId);
  if (!m && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const updated = await db.customer.update({
    where: { id: customerId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.externalId !== undefined ? { externalId: data.externalId } : {}),
    },
    include: { _count: { select: { tickets: true } } },
  });

  void logActivity({
    workspaceId: customer.workspaceId,
    actorId: userId,
    action: "CUSTOMER_UPDATED",
    entityType: "Customer",
    entityId: customerId,
    summary: generateSummary("CUSTOMER_UPDATED", {
      kbArticleTitle: updated.email,
    }),
    metadata: { email: updated.email },
  });

  return {
    id: updated.id,
    email: updated.email,
    name: updated.name,
    externalId: updated.externalId,
    ticketsCount: updated._count.tickets,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  };
}
