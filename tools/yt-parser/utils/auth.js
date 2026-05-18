/**
 * Простая авторизация админских мутаций через заголовок x-admin-token.
 *
 * ENV:
 *   ADMIN_TOKEN — если задан, все защищённые мутации требуют этот токен
 *                 в заголовке `x-admin-token` (или `Authorization: Bearer <token>`).
 *                 Если не задан — middleware пропускает всех и логирует warning
 *                 один раз (удобно для локальной разработки).
 */

let warnedOnce = false;

function adminAuth(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || !expected.trim()) {
    if (!warnedOnce) {
      console.warn(
        "[auth] ADMIN_TOKEN не задан в .env — эндпоинты мутаций НЕ защищены. " +
          "Задай ADMIN_TOKEN для продакшена.",
      );
      warnedOnce = true;
    }
    return next();
  }

  const header =
    req.headers["x-admin-token"] ||
    (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");

  if (!header || header !== expected) {
    return res
      .status(401)
      .json({ success: false, error: "unauthorized: admin token required" });
  }
  next();
}

module.exports = { adminAuth };
