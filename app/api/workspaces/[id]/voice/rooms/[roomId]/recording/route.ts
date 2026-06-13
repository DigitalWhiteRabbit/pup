import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import Anthropic from "@anthropic-ai/sdk";
import {
  assertMember,
  loadRoomInWorkspace,
  voiceErrorResponse,
} from "@/lib/services/voice-access";

type RouteParams = { params: Promise<{ id: string; roomId: string }> };

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * POST — upload call recording, transcribe with Whisper, generate AI summary
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: workspaceId, roomId } = await params;

  try {
    await assertMember(workspaceId, session.user.id, session.user.role);
    await loadRoomInWorkspace(roomId, workspaceId);
  } catch (err) {
    const { status, body } = voiceErrorResponse(err);
    return NextResponse.json(body, { status });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const sessionId = formData.get("sessionId") as string | null;

  if (!file)
    return NextResponse.json({ error: "No audio file" }, { status: 400 });

  // Find the voice session (scoped to this workspace+room to avoid cross-ws IDOR)
  const voiceSession = sessionId
    ? await db.voiceSession.findFirst({
        where: { id: sessionId, workspaceId, roomId },
      })
    : await db.voiceSession.findFirst({
        where: { roomId, workspaceId },
        orderBy: { startedAt: "desc" },
      });

  console.log(
    "[VOICE RECORDING] Session found:",
    voiceSession?.id,
    "endedAt:",
    voiceSession?.endedAt,
  );

  if (!voiceSession)
    return NextResponse.json({ error: "No session found" }, { status: 404 });

  // Step 1: Transcribe with Groq Whisper
  let transcript = "";
  if (GROQ_API_KEY) {
    try {
      const groqForm = new FormData();
      groqForm.append("file", file);
      groqForm.append("model", "whisper-large-v3");
      groqForm.append("language", "ru");
      groqForm.append("response_format", "json");

      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
        body: groqForm,
      });

      if (res.ok) {
        const data = (await res.json()) as { text: string };
        transcript = data.text.trim();
      }
    } catch (e) {
      console.error("Whisper transcription failed:", e);
    }
  }

  if (!transcript) {
    return NextResponse.json(
      { error: "Transcription failed" },
      { status: 502 },
    );
  }

  // Step 2: Get chat messages for context
  const chatMessages = await db.voiceMessage.findMany({
    where: { roomId, createdAt: { gte: voiceSession.startedAt } },
    orderBy: { createdAt: "asc" },
    take: 100,
    include: { user: { select: { login: true } } },
  });

  const chatTranscript =
    chatMessages.length > 0
      ? chatMessages
          .map(
            (m) =>
              `[чат] ${m.user?.login ?? m.guestName ?? "Гость"}: ${m.content}`,
          )
          .join("\n")
      : "";

  // Step 3: Parse participants
  let participantNames: string[] = [];
  try {
    const parsed = JSON.parse(voiceSession.participants) as Array<{
      login?: string;
      guestName?: string;
    }>;
    participantNames = parsed
      .map((p) => p.login ?? p.guestName ?? "Гость")
      .filter(Boolean);
  } catch {
    /* */
  }

  const durationMin = voiceSession.duration
    ? Math.ceil(voiceSession.duration / 60)
    : "?";

  // Step 4: Generate summary with Claude
  let summary = "";
  if (ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

      const response = await client.messages.create({
        model: "claude-haiku-4.5-20251001",
        max_tokens: 800,
        messages: [
          {
            role: "user",
            content: `Сделай структурированную сводку голосового звонка.

Канал: ${voiceSession.roomName}
Участники: ${participantNames.join(", ") || "неизвестно"}
Длительность: ${durationMin} мин

Транскрипция разговора:
${transcript}
${chatTranscript ? `\nТекстовый чат во время звонка:\n${chatTranscript}` : ""}

Формат ответа:
## Тема обсуждения
Краткое описание о чём был звонок (1-2 предложения)

## Ключевые моменты
- Пункт 1
- Пункт 2
- ...

## Решения и договорённости
- Что решили / что делать дальше

## Задачи (если были)
- Кому → что сделать

Ответь на русском, кратко и по делу.`,
          },
        ],
      });

      summary =
        response.content[0]?.type === "text" ? response.content[0].text : "";
    } catch (e) {
      console.error("Claude summary failed:", e);
    }
  }

  // Step 5: Save summary to session
  if (summary) {
    await db.voiceSession.update({
      where: { id: voiceSession.id },
      data: { summary },
    });
  }

  return NextResponse.json({
    transcript: transcript.slice(0, 500),
    summary: summary ? "Generated" : "Failed",
    sessionId: voiceSession.id,
  });
}
