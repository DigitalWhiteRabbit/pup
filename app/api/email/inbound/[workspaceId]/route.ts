import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handleInboundEmail } from "@/lib/services/email/email.service";

const inboundSchema = z.object({
  from: z.string().email(),
  fromName: z.string().optional(),
  subject: z.string().max(500).default(""),
  textBody: z.string().min(1).max(50000),
  inReplyTo: z.string().optional(),
  secret: z.string(),
});

/**
 * Webhook endpoint for inbound emails.
 * Called by email service (SendGrid, Mailgun, etc.) or custom forwarder.
 * Authenticated by workspace inbound secret.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    const body: unknown = await request.json();
    const validated = inboundSchema.parse(body);

    // Verify secret
    const cfg = await db.workspaceEmailConfig.findUnique({
      where: { workspaceId },
      select: { enabled: true, inboundSecret: true },
    });
    if (!cfg?.enabled || cfg.inboundSecret !== validated.secret) {
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
