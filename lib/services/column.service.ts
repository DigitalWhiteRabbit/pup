import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { handleColumnRename } from "./timer.service";
import { logActivity, generateSummary } from "./logger.service";
import { checkMembership } from "./member.service";

// ─── Column service ──────────────────────────────────────────────────────────

export async function createColumn(input: {
  workspaceId: string;
  name: string;
  requesterId: string;
  requesterRole: "ADMIN" | "USER";
}): Promise<{ id: string; name: string; position: number }> {
  const membership = await checkMembership(
    input.workspaceId,
    input.requesterId,
  );
  if (!membership && input.requesterRole !== "ADMIN") {
    throw new ApiError("Нет доступа к workspace", "FORBIDDEN", 403);
  }

  const maxCol = await db.column.findFirst({
    where: { workspaceId: input.workspaceId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const position = maxCol ? maxCol.position + 1 : 0;

  const column = await db.column.create({
    data: { workspaceId: input.workspaceId, name: input.name, position },
    select: { id: true, name: true, position: true },
  });

  const actor = await db.user.findUnique({
    where: { id: input.requesterId },
    select: { login: true },
  });

  await logActivity({
    workspaceId: input.workspaceId,
    actorId: input.requesterId,
    action: "COLUMN_CREATED",
    entityType: "Column",
    entityId: column.id,
    columnId: column.id,
    summary: generateSummary("COLUMN_CREATED", {
      actorLogin: actor?.login,
      columnName: input.name,
    }),
    metadata: { columnName: input.name, position },
  });

  return column;
}

export async function renameColumn(
  columnId: string,
  newName: string,
  requesterId: string,
  requesterRole: "ADMIN" | "USER",
): Promise<{ id: string; name: string }> {
  const columnCheck = await db.column.findUnique({
    where: { id: columnId },
    select: { workspaceId: true },
  });
  if (!columnCheck) throw new ApiError("Колонка не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(
    columnCheck.workspaceId,
    requesterId,
  );
  if (!membership && requesterRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  const { result: renamed, oldName } = await db.$transaction(async (tx) => {
    const column = await tx.column.findUnique({ where: { id: columnId } });
    if (!column) throw new ApiError("Колонка не найдена", "NOT_FOUND", 404);

    const capturedOldName = column.name;

    await tx.column.update({
      where: { id: columnId },
      data: { name: newName },
    });

    await handleColumnRename(tx, columnId, capturedOldName, newName);

    return {
      result: { id: columnId, name: newName },
      oldName: capturedOldName,
    };
  });

  const actor = await db.user.findUnique({
    where: { id: requesterId },
    select: { login: true },
  });

  await logActivity({
    workspaceId: columnCheck.workspaceId,
    actorId: requesterId,
    action: "COLUMN_RENAMED",
    entityType: "Column",
    entityId: columnId,
    columnId,
    summary: generateSummary("COLUMN_RENAMED", {
      actorLogin: actor?.login,
      columnNameOld: oldName,
      columnName: newName,
    }),
    metadata: { columnId, oldName, newName },
  });

  return renamed;
}

export async function deleteColumn(
  columnId: string,
  requesterId: string,
  requesterRole: "ADMIN" | "USER",
): Promise<void> {
  const column = await db.column.findUnique({
    where: { id: columnId },
    include: { _count: { select: { tasks: true } } },
  });
  if (!column) throw new ApiError("Колонка не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(column.workspaceId, requesterId);
  if (!membership && requesterRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  if (column._count.tasks > 0) {
    throw new ApiError(
      "Нельзя удалить колонку с задачами. Сначала переместите все задачи.",
      "COLUMN_HAS_TASKS",
      400,
    );
  }

  const actor = await db.user.findUnique({
    where: { id: requesterId },
    select: { login: true },
  });

  await logActivity({
    workspaceId: column.workspaceId,
    actorId: requesterId,
    action: "COLUMN_DELETED",
    entityType: "Column",
    entityId: columnId,
    columnId,
    summary: generateSummary("COLUMN_DELETED", {
      actorLogin: actor?.login,
      columnName: column.name,
    }),
    metadata: { columnId, columnName: column.name },
  });

  await db.column.delete({ where: { id: columnId } });
}

export async function reorderColumn(
  columnId: string,
  newPosition: number,
  requesterId: string,
  requesterRole: "ADMIN" | "USER",
): Promise<{ id: string; position: number }> {
  const column = await db.column.findUnique({
    where: { id: columnId },
    select: { workspaceId: true },
  });
  if (!column) throw new ApiError("Колонка не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(column.workspaceId, requesterId);
  if (!membership && requesterRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  await db.column.update({
    where: { id: columnId },
    data: { position: newPosition },
  });

  return { id: columnId, position: newPosition };
}
