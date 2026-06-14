import { NextResponse } from "next/server";
import { z } from "zod";
import {
  handleInboundEmail,
  verifyInboundSecret,
} from "@/lib/services/email/email.service";
import { checkRateLimit } from "@/lib/services/chat/rate-limit.service";
import { getClientIp } from "@/lib/services/chat/helpers";

const inboundSchema = z.object({
  from: z.string().email(),
  fromName: z.string().optional(),
  subject: z.string().max(500).default(""),
  textBody: z.string().min(1).max(50000),
  inReplyTo: z.string().optional(),
  // Back-compat: secret may still arrive in the body. Prefer the header
  // (X-Inbound-Secret / Authorization: Bearer) — see verification below.
  secret: z.string().optional(),
});

/**
 * Webhook endpoint for inbound emails (custom JSON forwarder / SendGrid Inbound
 * Parse / Mailgun Routes normalized upstream).
 *
 * Auth = per-workspace shared secret, checked CONSTANT-TIME against the
 * encrypted-at-rest `inboundSecret`. The secret is read preferentially from the
 * `X-Inbound-Secret` header (or `Authorization: Bearer`), with a body-field
 * fallback for forwarders not yet migrated. Migrate forwarders to the header,
 * then the body fallback can be dropped.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;

    // Rate-limit by workspace + client IP (abuse / brute-force of the secret).
    const ip = getClientIp(request);
    const rl = checkRateLimit(`inbound:${workspaceId}:${ip}`, 120);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Слишком много запросов" },
        { status: 429 },
      );
    }

    const body: unknown = await request.json();
    const validated = inboundSchema.parse(body);

    // Secret: header takes precedence over the (legacy) body field.
    const headerSecret =
      request.headers.get("x-inbound-secret") ??
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      null;
    const presented = headerSecret ?? validated.secret ?? null;

    const { ok } = await verifyInboundSecret(workspaceId, presented);
    if (!ok) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await handleInboundEmail(workspaceId, {
      from: validated.from,
      fromName: validated.fromName,
      subject: validated.subject,
      textBody: validated.textBody,
      inReplyTo: validated.inReplyTo,
    });

    return NextResponse.json(result, { status: result.isNew ? 201 : 200 });
  } catch (err) {
    if (err instanceof z.ZodError)
      return NextResponse.json(
        { error: err.errors[0]?.message ?? "Ошибка" },
        { status: 400 },
      );
    console.error("[Inbound email]", err);
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
