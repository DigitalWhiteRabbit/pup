const express = require("express");
// Шаг 3.3b: запись открытий переведена на db/prisma-store (единый Postgres).
const store = require("../db/prisma-store");
const { resolveWorkspaceId, WORKSPACE_MAP } = require("../db/workspace-map");
const router = express.Router();

// 1x1 transparent PNG pixel (68 bytes)
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// GET /api/track/open/:trackingId.png
// trackingId format: {workspaceKey}_{uuid}
// The tracking pixel is loaded by the recipient's email client when they open the email.
router.get("/open/:trackingId.png", (req, res) => {
  const raw = req.params.trackingId;

  // Log asynchronously — never block or error the pixel response
  try {
    const now = new Date().toISOString();
    const ip =
      req.headers["x-forwarded-for"] ||
      req.headers["x-real-ip"] ||
      req.ip ||
      "";
    const ua = req.headers["user-agent"] || "";

    // Parse composite id: workspaceKey_uuid
    const sepIdx = raw.indexOf("_");
    if (sepIdx > 0) {
      const wsKey = raw.slice(0, sepIdx);
      const trackingId = raw.slice(sepIdx + 1);
      // Ключ из пикселя → PUP cuid (принимаем и сам cuid)
      const wsId =
        resolveWorkspaceId(wsKey) ||
        (Object.values(WORKSPACE_MAP).includes(wsKey) ? wsKey : null);

      if (wsId) {
        // fire-and-forget: пиксель не ждёт записи
        store
          .recordMessageOpen(
            wsId,
            now,
            ip.slice(0, 100),
            ua.slice(0, 300),
            trackingId,
          )
          .then((result) => {
            if (result.changes > 0) {
              console.log(
                `[tracking] Email opened: ws=${wsKey} tid=${trackingId.slice(0, 8)}.. ip=${ip.split(",")[0]} ua=${ua.slice(0, 60)}`,
              );
            }
          })
          .catch((e) => console.error("[tracking] error:", e.message));
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
