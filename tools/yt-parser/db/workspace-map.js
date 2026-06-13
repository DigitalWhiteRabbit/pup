/**
 * workspace-map.js — резолвер воркспейса парсера → PUP Workspace.id.
 *
 * Прод: PUP шлёт ?workspace=<cuid> (сам Workspace.id) → cuid отдаём passthrough.
 * Dev/легаси: ключ — имя файла ws-XXX.db без префикса/суффикса; маппится по карте.
 * Карту можно расширить через env WORKSPACE_MAP_JSON (мерж поверх dev-записей),
 * согласовано с scripts/migrate-ytparser-to-prisma.ts в корне PUP.
 */
const WORKSPACE_MAP = {
  "qa-tg": "cmqbkwccn0001onqtv7q6ihrd", // "QA / Telegram Outreach"
  // "default" намеренно не маплен (пустой воркспейс)
  ...(process.env.WORKSPACE_MAP_JSON
    ? JSON.parse(process.env.WORKSPACE_MAP_JSON)
    : {}),
};

// cuid v1: 'c' + 24 [a-z0-9] (всего 25 символов)
const CUID_RE = /^c[a-z0-9]{24}$/;

function resolveWorkspaceId(key) {
  if (!key) return null;
  if (CUID_RE.test(key)) return key; // прод: входящее значение = сам workspaceId
  return WORKSPACE_MAP[key] || null;
}

// Guard для роутов на Prisma: воркспейс обязан резолвиться (иначе 400).
function requireWsId(req, res) {
  if (req.wsId) return true;
  res.status(400).json({
    success: false,
    error: "workspace not mapped to Prisma",
  });
  return false;
}

module.exports = { WORKSPACE_MAP, resolveWorkspaceId, requireWsId };
