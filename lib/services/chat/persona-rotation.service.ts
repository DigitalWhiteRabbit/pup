import "server-only";
import { db } from "@/lib/db";
import type { ChatPersona } from "@prisma/client";

/**
 * Get day of week in workspace timezone (0=Sun, 1=Mon, ..., 6=Sat).
 */
function getDayOfWeek(timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  });
  const weekday = formatter.format(new Date());
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[weekday] ?? 0;
}

/**
 * Get day index (days since epoch) for position-based rotation fallback.
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
  const ms = Date.UTC(year, month - 1, day);
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function parseScheduleDays(scheduleDays: string | null): number[] | null {
  if (!scheduleDays) return null;
  try {
    const parsed = JSON.parse(scheduleDays);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "number")) {
      return parsed as number[];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get active personas for today.
 * If personas have scheduleDays set — returns those scheduled for today's day of week.
 * Otherwise falls back to position-based rotation (1 persona).
 */
export async function getActivePersonas(
  workspaceId: string,
): Promise<ChatPersona[]> {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { chatTimezone: true, chatPersonaRotation: true },
  });
  if (!workspace) return [];

  const personas = await db.chatPersona.findMany({
    where: { workspaceId },
    orderBy: { position: "asc" },
  });

  if (personas.length === 0) return [];
  if (!workspace.chatPersonaRotation) return [];

  const todayDow = getDayOfWeek(workspace.chatTimezone);

  // Check if any persona has schedule configured
  const hasSchedule = personas.some(
    (p) => parseScheduleDays(p.scheduleDays) !== null,
  );

  if (hasSchedule) {
    // Return personas scheduled for today
    return personas.filter((p) => {
      const days = parseScheduleDays(p.scheduleDays);
      if (!days) return false; // no schedule = not on shift
      return days.includes(todayDow);
    });
  }

  // Fallback: position-based rotation (old behavior, 1 persona)
  const dayIndex = getDayIndex(workspace.chatTimezone);
  const index = dayIndex % personas.length;
  const persona = personas[index];
  return persona ? [persona] : [];
}

/**
 * Get single active persona (first from today's shift).
 * Used by public chat config.
 */
export async function getActivePersona(
  workspaceId: string,
): Promise<ChatPersona | null> {
  const active = await getActivePersonas(workspaceId);
  return active[0] ?? null;
}

export { getDayOfWeek, getDayIndex };
