import "server-only";
import { db } from "@/lib/db";
import { logSystem } from "../logger.service";

export async function checkSlaBreaches(): Promise<{
  checked: number;
  breached: number;
}> {
  const now = new Date();

  const overdue = await db.ticket.findMany({
    where: {
      status: { in: ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER"] },
      slaBreached: false,
      slaDeadline: { lt: now },
    },
    select: { id: true, number: true, workspaceId: true, assigneeId: true },
  });

  let breached = 0;

  for (const ticket of overdue) {
    await db.ticket.update({
      where: { id: ticket.id },
      data: { slaBreached: true },
    });

    void logSystem({
      level: "WARN",
      source: "sla-check",
      message: `Ticket #${ticket.number} SLA breached`,
      workspaceId: ticket.workspaceId,
    });

    breached++;
  }

  return { checked: overdue.length, breached };
}
