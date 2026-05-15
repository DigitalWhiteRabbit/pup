import { db } from "@/lib/db";
import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * Generate AI summary for a completed voice session.
 * Called when the last participant leaves a room.
 */
export async function generateVoiceSessionSummary(sessionId: string) {
  if (!ANTHROPIC_API_KEY) return;

  try {
    const session = await db.voiceSession.findUnique({
      where: { id: sessionId },
      include: {
        room: {
          include: {
            messages: {
              orderBy: { createdAt: "asc" },
              take: 200,
              include: { user: { select: { login: true } } },
            },
          },
        },
      },
    });

    if (!session) return;

    const messages = session.room.messages;
    if (messages.length < 1) {
      const durationMin = session.duration
        ? Math.ceil(session.duration / 60)
        : 0;
      let pNames: string[] = [];
      try {
        pNames = (
          JSON.parse(session.participants) as Array<{
            login?: string;
            guestName?: string;
          }>
        ).map((p) => p.login ?? p.guestName ?? "Гость");
      } catch {
        /* */
      }
      await db.voiceSession.update({
        where: { id: sessionId },
        data: {
          summary: `Голосовой звонок без текстового чата.\nУчастники: ${pNames.join(", ") || "неизвестно"}\nДлительность: ${durationMin} мин`,
        },
      });
      return;
    }

    // Build chat transcript
    const transcript = messages
      .map((m) => {
        const author = m.user?.login ?? m.guestName ?? "Гость";
        return `${author}: ${m.content}`;
      })
      .join("\n");

    // Parse participants
    let participantNames: string[] = [];
    try {
      const parsed = JSON.parse(session.participants) as Array<{
        login?: string;
        guestName?: string;
      }>;
      participantNames = parsed
        .map((p) => p.login ?? p.guestName ?? "Гость")
        .filter(Boolean);
    } catch {
      /* empty */
    }

    const durationMin = session.duration
      ? Math.ceil(session.duration / 60)
      : "?";

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: "claude-haiku-4.5-20251001",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `Сделай краткую сводку (3-5 пунктов) голосового звонка на основе текстового чата во время звонка.

Канал: ${session.roomName}
Участники: ${participantNames.join(", ") || "неизвестно"}
Длительность: ${durationMin} мин

Чат во время звонка:
${transcript}

Формат ответа:
- Краткие пункты что обсуждалось
- Ключевые решения если были
- Итоги

Ответь на русском, кратко.`,
        },
      ],
    });

    const summary =
      response.content[0]?.type === "text" ? response.content[0].text : null;

    if (summary) {
      await db.voiceSession.update({
        where: { id: sessionId },
        data: { summary },
      });
    }
  } catch (e) {
    console.error("Voice summary generation failed:", e);
  }
}
