import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { addMemberSchema } from "@/lib/schemas/workspace.schema";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function POST(request: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await request.json();
    const { loginOrEmail } = addMemberSchema.parse(body);

    // Dynamic import to avoid webpack chain
    const { addMember } = await (Function(
      "p",
      "return import(p)",
    )("@/lib/services/member.service") as Promise<
      typeof import("@/lib/services/member.service")
    >);
    const member = await addMember(params.id, loginOrEmail, session.user.id);
    return NextResponse.json(member, { status: 201 });
  });
}
