import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { checkMembership } from "@/lib/services/project.service";
import { NextResponse } from "next/server";
import { z } from "zod";

type Params = { params: { id: string } };

const createLabelSchema = z.object({
  name: z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

export async function GET(_req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const membership = await checkMembership(params.id, session.user.id);
    if (!membership && session.user.role !== "ADMIN") {
      throw new ApiError("Нет доступа", "FORBIDDEN", 403);
    }

    const labels = await db.label.findMany({
      where: { projectId: params.id },
      orderBy: { name: "asc" },
    });
    return NextResponse.json(labels);
  });
}

export async function POST(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const membership = await checkMembership(params.id, session.user.id);
    if (!membership && session.user.role !== "ADMIN") {
      throw new ApiError("Нет доступа", "FORBIDDEN", 403);
    }

    const body: unknown = await req.json();
    const { name, color } = createLabelSchema.parse(body);

    const label = await db.label.create({
      data: { projectId: params.id, name, color },
    });
    return NextResponse.json(label, { status: 201 });
  });
}
