import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { uploadKbFile, listKbFiles } from "@/lib/services/kb/file.service";

type Params = { params: { id: string } };

export async function GET(_req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const files = await listKbFiles(
      params.id,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(files);
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file || !(file instanceof File)) {
      throw new ApiError("Файл не передан", "VALIDATION_ERROR", 400);
    }

    const result = await uploadKbFile({
      workspaceId: params.id,
      file,
      uploadedById: session.user.id,
      userRole: session.user.role,
    });

    return NextResponse.json(result, { status: 201 });
  });
}
