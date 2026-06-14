import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { storage } from "@/lib/services/storage";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { ApiError } from "@/lib/api-error";

const MAX_SIZE = 5 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];

type RouteParams = { params: Promise<{ id: string }> };

/** GET — serve workspace logo */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ws = await db.workspace.findUnique({
      where: { id },
      select: { logoPath: true },
    });
    if (!ws?.logoPath) return new NextResponse(null, { status: 404 });

    const stream = await storage().download(ws.logoPath);
    const ext = ws.logoPath.split(".").pop() ?? "jpg";
    const mime =
      ext === "png"
        ? "image/png"
        : ext === "webp"
          ? "image/webp"
          : ext === "gif"
            ? "image/gif"
            : "image/jpeg";

    return new NextResponse(stream, {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}

/** POST — upload workspace logo */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    // Workspace logo is an owner-level setting (global ADMIN passes too).
    await requireWorkspaceAccess(accessCtxFromSession(session), id, {
      requireOwner: true,
    });

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file)
      return NextResponse.json({ error: "Файл не указан" }, { status: 400 });
    if (file.size > MAX_SIZE)
      return NextResponse.json({ error: "Макс 5 МБ" }, { status: 400 });
    const baseMime = file.type.split(";")[0]!.trim();
    if (!ALLOWED.includes(baseMime))
      return NextResponse.json(
        { error: "Только изображения" },
        { status: 400 },
      );

    // Delete old logo
    const ws = await db.workspace.findUnique({
      where: { id },
      select: { logoPath: true },
    });
    if (ws?.logoPath) {
      try {
        await storage().delete(ws.logoPath);
      } catch {
        /* ok */
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await storage().upload({
      scope: "persona",
      workspaceId: id,
      originalName: file.name,
      buffer,
      mimeType: baseMime,
    });

    await db.workspace.update({
      where: { id },
      data: { logoPath: result.storagePath },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}

/** DELETE — remove workspace logo */
export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    await requireWorkspaceAccess(accessCtxFromSession(session), id, {
      requireOwner: true,
    });

    const ws = await db.workspace.findUnique({
      where: { id },
      select: { logoPath: true },
    });
    if (ws?.logoPath) {
      try {
        await storage().delete(ws.logoPath);
      } catch {
        /* ok */
      }
    }

    await db.workspace.update({
      where: { id },
      data: { logoPath: null },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
