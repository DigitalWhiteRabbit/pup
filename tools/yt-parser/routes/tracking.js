const express = require("express");
const router = express.Router();

// 1x1 transparent PNG pixel (68 bytes)
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// GET /api/track/open/:trackingId.png
// trackingId format: {workspaceId}_{uuid}
// The tracking pixel is loaded by the recipient's email client when they open the email.
router.get("/open/:trackingId.png", (req, res) => {
  const raw = req.params.trackingId;

  // Log asynchronously — never block or error the pixel response
  try {
    const { getDb } = require("../db/database");
    const now = new Date().toISOString();
    const ip =
      req.headers["x-forwarded-for"] ||
      req.headers["x-real-ip"] ||
      req.ip ||
      "";
    const ua = req.headers["user-agent"] || "";

    // Parse composite id: workspaceId_uuid
    const sepIdx = raw.indexOf("_");
    if (sepIdx > 0) {
      const wsId = raw.slice(0, sepIdx);
      const trackingId = raw.slice(sepIdx + 1);

      const ws = getDb(wsId);
      // Update opened_at (only first open) and always increment open_count
      const result = ws.db
        .prepare(
          `UPDATE messages
         SET opened_at = COALESCE(opened_at, ?),
             open_count = COALESCE(open_count, 0) + 1,
             open_ip = COALESCE(open_ip, ?),
             open_ua = COALESCE(open_ua, ?)
         WHERE tracking_id = ?`,
        )
        .run(now, ip.slice(0, 100), ua.slice(0, 300), trackingId);

      if (result.changes > 0) {
        console.log(
          `[tracking] Email opened: ws=${wsId} tid=${trackingId.slice(0, 8)}.. ip=${ip.split(",")[0]} ua=${ua.slice(0, 60)}`,
        );
      }
    }
  } catch (e) {
    // Never let tracking errors break the pixel response
    console.error("[tracking] error:", e.message);
  }

  // Always return the pixel with aggressive no-cache headers
  // so email clients re-fetch on every open
  res.set({
    "Content-Type": "image/png",
    "Content-Length": PIXEL.length,
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.end(PIXEL);
});

module.exports = router;
