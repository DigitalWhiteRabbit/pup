// Client-side toast utility — do NOT add "server-only"
// Constitution XVII: human-readable errors, no raw 500s
import { toast } from "sonner";

/** Show a success toast */
export function toastSuccess(message: string): void {
  toast.success(message);
}

/** Show an error toast with a human-readable message */
export function toastError(message: string): void {
  toast.error(message);
}

/** Parse an unknown API error and show a toast */
export function toastApiError(error: unknown): void {
  toast.error(parseError(error));
}

function parseError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    typeof (error as Record<string, unknown>)["error"] === "string"
  ) {
    return (error as { error: string }).error;
  }
  return "Произошла ошибка. Попробуйте ещё раз.";
}
