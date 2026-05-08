import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { createComment } from "@/lib/services/comment.service";
import { createCommentSchema } from "@/lib/schemas/comment.schema";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await req.json();
    const input = createCommentSchema.parse(body);

    const comment = await createComment(
      { taskId: params.id, authorId: session.user.id, text: input.text },
      session.user.role,
    );

    return NextResponse.json(comment, { status: 201 });
  });
}
