import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { addMemberSchema } from "@/lib/schemas/workspace.schema";
import { addMember } from "@/lib/services/member.service";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function POST(request: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await request.json();
    const { loginOrEmail } = addMemberSchema.parse(body);

    const member = await addMember(params.id, loginOrEmail, session.user.id);
    return NextResponse.json(member, { status: 201 });
  });
}
