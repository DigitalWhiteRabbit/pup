/**
 * Pure column-reorder math (no server-only/db imports → unit-testable).
 *
 * Computes the new contiguous id order for a column after moving `taskId` to
 * `targetIndex`: removes the task, clamps the index into range, re-inserts.
 * Run inside a DB transaction (see task.service applyColumnOrder) this makes
 * concurrent drag-drops safe — each reorder recomputes a gap-free 0..n-1 order
 * from current state, so positions never duplicate or gap.
 */
export function computeReorderedIds(
  orderedIds: string[],
  taskId: string,
  targetIndex: number,
): string[] {
  const without = orderedIds.filter((id) => id !== taskId);
  const idx = Math.max(0, Math.min(targetIndex, without.length));
  without.splice(idx, 0, taskId);
  return without;
}
