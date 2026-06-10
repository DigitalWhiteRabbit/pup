import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { z } from "zod";

const preferencesSchema = z.object({
  tgNotifyAssign: z.boolean().optional(),
  tgNotifyComment: z.boolean().optional(),
  tgNotifyMove: z.boolean().optional(),
  tgNotifyProject: z.boolean().optional(),
  tgNotifyContent: z.boolean().optional(),
  tgNotifyTaskDeleted: z.boolean().optional(),
  tgNotifyMemberRemoved: z.boolean().optional(),
  tgNotifyWorkspaceDeleted: z.boolean().optional(),
  tgNotifyRoleChanged: z.boolean().optional(),
  tgNotifyDeploy: z.boolean().optional(),
});

export async function PATCH(req: NextRequest) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const body = preferencesSchema.parse(await req.json());

    const updated = await db.user.update({
      where: { id: session.user.id },
      data: body,
      select: {
        tgNotifyAssign: true,
        tgNotifyComment: true,
        tgNotifyMove: true,
        tgNotifyProject: true,
        tgNotifyContent: true,
        tgNotifyTaskDeleted: true,
        tgNotifyMemberRemoved: true,
        tgNotifyWorkspaceDeleted: true,
        tgNotifyRoleChanged: true,
        tgNotifyDeploy: true,
      },
    });

    return NextResponse.json(updated);
  });
}
