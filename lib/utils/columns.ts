/**
 * Determines if a column name matches "В работе" (case-insensitive, trim).
 * Used by task.service and project.service to control TimeInterval logic.
 */
export function isWorkColumn(name: string): boolean {
  return name.trim().toLowerCase() === "в работе";
}
