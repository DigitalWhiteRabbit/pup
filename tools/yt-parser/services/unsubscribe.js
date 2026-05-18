const crypto = require("crypto");

function getSecret() {
  const s = process.env.UNSUBSCRIBE_SECRET;
  if (!s) throw new Error("UNSUBSCRIBE_SECRET не задан в .env");
  return s;
}

function generateUnsubscribeToken(leadId) {
  return crypto
    .createHmac("sha256", getSecret())
    .update(String(leadId))
    .digest("hex");
}

function verifyUnsubscribeToken(token, leadId) {
  if (!token || token.length !== 64) return false;
  try {
    const expected = generateUnsubscribeToken(leadId);
    return crypto.timingSafeEqual(
      Buffer.from(token, "hex"),
      Buffer.from(expected, "hex"),
    );
  } catch {
    return false;
  }
}

module.exports = { generateUnsubscribeToken, verifyUnsubscribeToken };
