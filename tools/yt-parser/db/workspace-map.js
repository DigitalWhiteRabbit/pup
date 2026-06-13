/**
 * workspace-map.js — резолвер ключа воркспейса парсера → PUP Workspace.id.
 *
 * Ключ — имя файла ws-XXX.db без префикса/суффикса (он же ?workspace= query).
 * Карта согласована с scripts/migrate-ytparser-to-prisma.ts в корне PUP.
 */
module.exports = {
  WORKSPACE_MAP: {
    "qa-tg": "cmqbkwccn0001onqtv7q6ihrd", // "QA / Telegram Outreach"
    // "default" намеренно не маплен (пустой воркспейс)
  },
  resolveWorkspaceId(key) {
    return module.exports.WORKSPACE_MAP[key] || null;
  },
  // Guard для роутов, переведённых на Prisma: воркспейс обязан быть замаплен.
  requireWsId(req, res) {
    if (req.wsId) return true;
    res.status(400).json({
      success: false,
      error: "workspace not mapped to Prisma",
    });
    return false;
  },
};
