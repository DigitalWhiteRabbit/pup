import "server-only";
import { db } from "@/lib/db";
import type { ChatPersona } from "@prisma/client";

/**
 * Get the day index in the given timezone (days since Unix epoch, timezone-adjusted).
 */
function getDayIndex(timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const year = parseInt(parts.find((p) => p.type === "year")!.value, 10);
  const month = parseInt(parts.find((p) => p.type === "month")!.value, 10);
  const day = parseInt(parts.find((p) => p.type === "day")!.value, 10);
  // Days since epoch using UTC date from timezone-adjusted parts
  const ms = Date.UTC(year, month - 1, day);
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

export async function getActivePersona(
  workspaceId: string,
): Promise<ChatPersona | null> {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { chatTimezone: true, chatPersonaRotation: true },
  });
  if (!workspace) return null;

  const personas = await db.chatPersona.findMany({
    where: { workspaceId },
    orderBy: { position: "asc" },
  });

  if (personas.length === 0) return null;
  if (!workspace.chatPersonaRotation) return null;

  const dayIndex = getDayIndex(workspace.chatTimezone);
  const index = dayIndex % personas.length;
  return personas[index] ?? null;
}

/** Exported for testing */
export { getDayIndex };
