// Typed application errors. Route handlers map these to HTTP responses via handleRoute().

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_STATE"
  | "VALIDATION";

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE: 422,
  VALIDATION: 400,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export const unauthenticated = (message = "Sign in required") =>
  new AppError("UNAUTHENTICATED", message);
export const forbidden = (message = "You do not have permission to do this") =>
  new AppError("FORBIDDEN", message);
export const notFound = (what = "Resource") => new AppError("NOT_FOUND", `${what} not found`);
export const conflict = (message: string) => new AppError("CONFLICT", message);
export const invalidState = (message: string) => new AppError("INVALID_STATE", message);
export const validationError = (message: string, details?: unknown) =>
  new AppError("VALIDATION", message, details);
