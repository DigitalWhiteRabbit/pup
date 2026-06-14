import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { checkMembership } from "@/lib/services/workspace.service";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { storage } from "@/lib/services/storage";

const MAX_SIZE = 2 * 1024 * 1024; // 2MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; personaId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: workspaceId, personaId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (membership !== "OWNER" && session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Нет доступа" }, { status: 403 });
    }

    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "tickets",
    });

    const persona = await db.chatPersona.findUnique({
      where: { id: personaId },
      select: { workspaceId: true, avatarUrl: true },
    });
    if (!persona || persona.workspaceId !== workspaceId) {
      return NextResponse.json(
        { error: "Персона не найдена" },
        { status: 404 },
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "Файл не передан" }, { status: 400 });
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: "Допустимые форматы: JPEG, PNG, WebP, GIF" },
        { status: 400 },
      );
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { error: "Максимальный размер файла — 2 МБ" },
        { status: 400 },
      );
    }

    // Delete old avatar if exists
    if (persona.avatarUrl) {
      try {
        await storage().delete(persona.avatarUrl);
      } catch {
        /* old file may not exist */
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await storage().upload({
      scope: "persona",
      workspaceId,
      originalName: file.name,
      buffer,
      mimeType: file.type,
    });

    await db.chatPersona.update({
      where: { id: personaId },
      data: { avatarUrl: result.storagePath },
    });

    return NextResponse.json({ avatarUrl: result.storagePath });
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[POST persona avatar]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
