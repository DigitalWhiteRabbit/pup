import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Cheap change-signature for the global chat. The client polls THIS (~50 bytes)
 * instead of refetching 50 messages + joins every 3s, and only refetches the
 * full list when the signature changes. The signature captures new messages
 * (count + latest createdAt), edits (max editedAt), deletes (count drops) and
 * reactions (reaction count) — so no change is missed.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [msgCount, latest, editedAgg, reactionCount] = await Promise.all([
    db.globalChatMsg.count({ where: { deletedAt: null } }),
    db.globalChatMsg.findFirst({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    db.globalChatMsg.aggregate({
      where: { deletedAt: null },
      _max: { editedAt: true },
    }),
    db.globalChatReaction.count(),
  ]);

  const sig = [
    msgCount,
    latest?.createdAt?.getTime() ?? 0,
    editedAgg._max.editedAt?.getTime() ?? 0,
    reactionCount,
  ].join(":");

  return NextResponse.json({ sig });
}
