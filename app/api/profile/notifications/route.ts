import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { chatSoundEnabled: true, chatDesktopNotify: true },
  });

  return NextResponse.json(user);
}

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();

  await db.user.update({
    where: { id: session.user.id },
    data: {
      ...(typeof body.chatSoundEnabled === "boolean"
        ? { chatSoundEnabled: body.chatSoundEnabled }
        : {}),
      ...(typeof body.chatDesktopNotify === "boolean"
        ? { chatDesktopNotify: body.chatDesktopNotify }
        : {}),
    },
  });

  return NextResponse.json({ ok: true });
}
