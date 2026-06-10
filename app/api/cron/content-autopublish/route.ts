import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { runAutoPublish } from "@/lib/services/content/autopublish";

/** Сравнение в постоянном времени (защита от timing-атак на секрет). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Крон-эндпойнт автопубликации контент-плана (задел, phase 2).
 *
 * ВЫКЛЮЧЕН по умолчанию: пока в окружении не задан CRON_SECRET, возвращает 503.
 * Когда задан — вызывается планировщиком (system cron / GitHub Actions / Vercel
 * cron) с заголовком `Authorization: Bearer <CRON_SECRET>`.
 *
 * Публикует только карточки с autoPublish=true (по умолчанию false), так что
 * включение секрета само по себе ничего не публикует.
 */
export async function POST(req: NextRequest) {
  const secret = process.env["CRON_SECRET"];
  if (!secret) {
    return NextResponse.json(
      { error: "Автопубликация выключена (CRON_SECRET не задан)" },
      { status: 503 },
    );
  }

  const auth = req.headers.get("authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const summary = await runAutoPublish();
    return NextResponse.json(summary);
  } catch (e) {
    console.error("[cron/content-autopublish]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Ошибка автопубликации" },
      { status: 500 },
    );
  }
}
