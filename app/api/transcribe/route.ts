import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/services/rate-limit";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/** POST — transcribe audio file via Groq Whisper */
export async function POST(req: Request) {
  try {
    if (!GROQ_API_KEY)
      return NextResponse.json(
        { error: "Transcription not configured" },
        { status: 501 },
      );

    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Groq Whisper call — cost/DoS limit. Generous: 60/user/hour (voice messages).
    const limited = enforceRateLimit({
      scope: "ai:transcribe",
      userId: session.user.id,
      req,
      max: 60,
      windowMs: 60 * 60 * 1000,
    });
    if (limited) return limited;

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file)
      return NextResponse.json({ error: "Файл не указан" }, { status: 400 });

    // Max 25 MB (Groq limit)
    if (file.size > 25 * 1024 * 1024)
      return NextResponse.json({ error: "Макс 25 МБ" }, { status: 400 });

    // Forward to Groq Whisper API
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

    if (!res.ok) {
      const err = await res.text().catch(() => "Groq error");
      console.error("Groq transcription error:", res.status, err);
      return NextResponse.json(
        { error: "Ошибка транскрибации" },
        { status: 502 },
      );
    }

    const data = (await res.json()) as { text: string };
    return NextResponse.json({ text: data.text.trim() });
  } catch (e) {
    console.error("Transcription error:", e);
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}

/** GET — check if transcription is available */
export async function GET() {
  return NextResponse.json({ available: !!GROQ_API_KEY });
}
