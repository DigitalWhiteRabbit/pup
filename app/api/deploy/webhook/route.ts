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

  // Trigger deploy via setsid so the child becomes its own session leader.
  // deploy.sh MUST survive pup being stopped (pm2 stop pup happens inside deploy.sh).
  // nohup + detached:true is NOT enough — pm2 stop kills the whole process group,
  // and "detached" in Node only puts the child in its own *group*, not session.
  // setsid creates a brand-new session, immune to PM2's group-targeted SIGTERM.
  const { spawn } = await import("child_process");
  const child = spawn("setsid", ["nohup", "/var/www/deploy.sh"], {
    cwd: "/var/www/pup",
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log(`[Deploy] deploy.sh spawned via setsid (pid ${child.pid})`);

  return NextResponse.json({ ok: true, commit: commitSha.slice(0, 7) });
}
