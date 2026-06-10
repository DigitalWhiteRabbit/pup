/**
 * Pure utility for checking module access.
 * Can be imported from both server and client code.
 */

/**
 * Check if a module key is allowed given an allowedModules list.
 *
 * @param allowedModules - Array of allowed module keys, or null for full access
 * @param moduleKey - The module key to check (e.g. "marketing", "marketing:parsers:youtube")
 * @returns true if access is granted
 */
export function checkModuleAccess(
  allowedModules: string[] | null,
  moduleKey: string,
): boolean {
  // null = full access
  if (allowedModules === null) return true;

  // Exact match
  if (allowedModules.includes(moduleKey)) return true;

  // Check if any allowed entry is a parent of the requested key
  // e.g. "marketing" allows "marketing:parsers:youtube"
  for (const allowed of allowedModules) {
    if (moduleKey.startsWith(allowed + ":")) return true;
  }

  // Check if any allowed entry is a child of the requested key
  // e.g. if checking "marketing" top-level and user has "marketing:parsers:youtube",
  // they should see the marketing module (but only the allowed sub-tabs inside)
  const requestedPrefix = moduleKey + ":";
  for (const allowed of allowedModules) {
    if (allowed.startsWith(requestedPrefix)) return true;
  }

  return false;
}

/**
 * Filter a list of top-level module keys based on member access.
 */
export function filterModulesByAccess(
  allModules: string[],
  allowedModules: string[] | null,
): string[] {
  if (allowedModules === null) return allModules;
  return allModules.filter((key) => checkModuleAccess(allowedModules, key));
}

/**
 * Module tree definition for the access control UI.
 */
export type ModuleTreeNode = {
  key: string;
  label: string;
  children?: ModuleTreeNode[];
};

export const MODULE_ACCESS_TREE: ModuleTreeNode[] = [
  { key: "crm", label: "CRM" },
  { key: "knowledge", label: "База знаний" },
  { key: "tickets", label: "Тикеты" },
  { key: "logs", label: "Логи" },
  { key: "chat", label: "Чат" },
  {
    key: "marketing",
    label: "Маркетинг",
    children: [
      { key: "marketing:dashboard", label: "Dashboard" },
      {
        key: "marketing:parsers",
        label: "Парсеры",
        children: [
          { key: "marketing:parsers:youtube", label: "YouTube" },
          { key: "marketing:parsers:telegram", label: "Telegram" },
        ],
      },
      { key: "marketing:leads", label: "Лиды" },
      { key: "marketing:campaigns", label: "Кампании" },
      { key: "marketing:analytics", label: "Аналитика" },
      { key: "marketing:settings", label: "Настройки" },
    ],
  },
  {
    // Полный доступ ("content") = старший менеджер (вкл. модерацию).
    // Для SMM-автора выдают подключ "content:author" (видит модуль, но без модерации).
    key: "content",
    label: "Контент-план (полный / старший менеджер)",
    children: [
      { key: "content:author", label: "Автор (SMM) — без модерации" },
      { key: "content:moderate", label: "Модерация (старший менеджер)" },
    ],
  },
  { key: "analytics", label: "Аналитика" },
  { key: "users", label: "Пользователи" },
];
