import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { NextResponse } from "next/server";
import { addMedia } from "@/lib/services/content.service";
import { addVideoSchema } from "@/lib/schemas/content.schema";

type Params = { params: { id: string; cardId: string } };

const MAX_SIZE = 15 * 1024 * 1024; // 15 МБ

/**
 * POST — добавить медиа.
 * multipart/form-data c полем `file` → фото (загрузка файла);
 * application/json c `{ videoUrl }` → видео по ссылке.
 */
export async function POST(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const contentType = req.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("file");
      if (!(file instanceof File))
        return apiError("Файл не передан", "VALIDATION_ERROR", 400);
      if (file.size > MAX_SIZE)
        return apiError("Файл больше 15 МБ", "VALIDATION_ERROR", 400);

      const media = await addMedia(
        params.id,
        params.cardId,
        session.user.id,
        session.user.role,
        { file },
      );
      return NextResponse.json(media, { status: 201 });
    }

    const { videoUrl, name } = addVideoSchema.parse(await req.json());
    const media = await addMedia(
      params.id,
      params.cardId,
      session.user.id,
      session.user.role,
      { videoUrl, name },
    );
    return NextResponse.json(media, { status: 201 });
  });
}
