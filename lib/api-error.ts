import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";

export interface ApiErrorResponse {
  error: string;
  code: string;
}

/** Return a typed JSON error response */
export function apiError(
  message: string,
  code: string,
  status = 400,
): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ error: message, code }, { status });
}

/** Wrap a route handler with consistent error handling */
export async function withErrorHandler<T>(
  handler: () => Promise<NextResponse<T>>,
): Promise<NextResponse<T | ApiErrorResponse>> {
  try {
    return await handler();
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      const message = err.errors[0]?.message ?? "Ошибка валидации";
      return apiError(
        message,
        "VALIDATION_ERROR",
        400,
      ) as NextResponse<ApiErrorResponse>;
    }
    if (err instanceof ApiError) {
      return apiError(
        err.message,
        err.code,
        err.status,
      ) as NextResponse<ApiErrorResponse>;
    }
    console.error("[API Error]", err);
    return apiError(
      "Внутренняя ошибка сервера",
      "INTERNAL_ERROR",
      500,
    ) as NextResponse<ApiErrorResponse>;
  }
}

/** Domain error with HTTP status and error code */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
