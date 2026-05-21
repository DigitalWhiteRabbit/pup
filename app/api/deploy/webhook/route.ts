import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

/**
 * POST /api/deploy/webhook
 *
 * Receives GitHub push webhook and triggers deploy notifications in Telegram.
 * Verify signature with GITHUB_WEBHOOK_SECRET env var.
 */
export async function POST(req: NextRequest) {
  const body = await req.text();

  // Verify GitHub signature (REQUIRED)
  const secret = process.env["GITHUB_WEBHOOK_SECRET"];
  if (!secret) {
    return NextResponse.json(
      { error: "GITHUB_WEBHOOK_SECRET not configured" },
      { status: 503 },
    );
  }

  const signature = req.headers.get("x-hub-signature-256");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }

  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return NextResponse.json({ error: "Bad signature" }, { status: 401 });
  }

  const event = req.headers.get("x-github-event");
  if (event !== "push") {
    return NextResponse.json({ ok: true, skipped: true });
  }

  let payload: {
    ref?: string;
    after?: string;
    head_commit?: { message?: string; author?: { name?: string } };
    pusher?: { name?: string };
  };

  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Only track pushes to main branch
  if (payload.ref !== "refs/heads/main") {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const commitSha = payload.after ?? "unknown";
  const commitMsg =
    payload.head_commit?.message?.split("\n")[0] ?? "No message";
  const author =
    payload.head_commit?.author?.name ?? payload.pusher?.name ?? "Unknown";

  // Fire and forget — don't block webhook response
  const { onDeployStarted } = await import("@/lib/services/telegram/deploy");
  void onDeployStarted(commitSha, commitMsg, author);

  // Trigger actual deploy via shell script
  const { exec } = await import("child_process");
  exec("/var/www/deploy.sh", { cwd: "/var/www/pup" }, (err, stdout, stderr) => {
    if (err) {
      console.error("[Deploy] deploy.sh failed:", stderr);
    } else {
      console.log("[Deploy] deploy.sh completed:", stdout.slice(-100));
    }
  });

  return NextResponse.json({ ok: true, commit: commitSha.slice(0, 7) });
}
