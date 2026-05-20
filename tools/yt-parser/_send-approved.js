require("dotenv").config();
const { getDb } = require("./db/database");
const ws = getDb("cmp5co9x00003l533elxydepe");

const pr = ws.db
  .prepare("SELECT * FROM pending_replies WHERE status = ?")
  .get("approved");
if (!pr) {
  console.log("No approved replies");
  process.exit(0);
}

console.log("Found PR #" + pr.id + " to " + pr.recipient);
const body = pr.edited_body || pr.body;
const subject = pr.edited_subject || pr.subject;
console.log("Subject:", subject);

const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);

(async () => {
  const r = await resend.emails.send({
    from:
      (process.env.RESEND_SENDER_NAME || "Atlas System") +
      " <" +
      process.env.EMAIL_FROM +
      ">",
    to: [pr.recipient],
    subject,
    html: body.replace(/\n/g, "<br>"),
  });
  console.log("SENT! Resend ID:", r.data?.id);

  ws.db
    .prepare("UPDATE pending_replies SET status = ?, sent_at = ? WHERE id = ?")
    .run("sent", new Date().toISOString(), pr.id);

  const now = new Date().toISOString();
  let dlg = ws.db
    .prepare(
      "SELECT * FROM dialogues WHERE lead_id = ? AND channel = ? LIMIT 1",
    )
    .get(pr.lead_id, "email");
  if (!dlg) {
    const dr = ws.stmts.insertDialogue.run(
      pr.lead_id,
      "email",
      r.data?.id,
      now,
    );
    dlg = { id: dr.lastInsertRowid };
  }
  ws.stmts.insertMessage.run({
    dialogue_id: dlg.id,
    direction: "out",
    sender: "agent",
    content: body,
    metadata: JSON.stringify({ subject, resend_id: r.data?.id }),
    created_at: now,
  });
  ws.stmts.incrementDialogueMsgCount.run(dlg.id);
  ws.stmts.updateLeadStage.run("contacted", now, pr.lead_id);
  console.log("Done! Lead stage → contacted");
})().catch((e) => console.error("ERR:", e.message));
