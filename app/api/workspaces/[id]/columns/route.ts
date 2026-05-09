import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { createColumn } from "@/lib/services/workspace.service";
import { createColumnSchema } from "@/lib/schemas/column.schema";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await req.json();
    const input = createColumnSchema.parse(body);

    const column = await createColumn({
      workspaceId: params.id,
      name: input.name,
      requesterId: session.user.id,
      requesterRole: session.user.role,
    });

    return NextResponse.json(column, { status: 201 });
  });
}
