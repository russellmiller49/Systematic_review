import { NextResponse } from "next/server";
import { ZodError, type ZodSchema } from "zod";
import { AppError } from "@/server/errors";

// Uniform response envelope: { data } on success, { error: { code, message, details? } } on failure.

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ data }, init);
}

export function created<T>(data: T): NextResponse {
  return ok(data, { status: 201 });
}

function errorResponse(status: number, code: string, message: string, details?: unknown) {
  return NextResponse.json({ error: { code, message, details } }, { status });
}

// Wraps a route handler body: maps AppError/ZodError to HTTP, logs unexpected errors.
export async function handleRoute(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) {
      return errorResponse(err.status, err.code, err.message, err.details);
    }
    if (err instanceof ZodError) {
      return errorResponse(400, "VALIDATION", "Invalid request", err.flatten());
    }
    console.error("Unhandled API error:", err);
    return errorResponse(500, "INTERNAL", "Something went wrong");
  }
}

export async function parseBody<T>(req: Request, schema: ZodSchema<T>): Promise<T> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new AppError("VALIDATION", "Request body must be valid JSON");
  }
  return schema.parse(json);
}
