// Client-side fetch helper for the REST API's { data } / { error } envelope.

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Flattens structured API details (including zod flatten()) into messages that can
// be shown to a person instead of discarding the useful reason behind "Invalid request".
export function apiErrorMessages(err: unknown): string[] {
  if (!(err instanceof ApiError)) {
    return [err instanceof Error ? err.message : "Request failed"];
  }
  const messages: string[] = [];
  const details = err.details;
  if (Array.isArray(details)) {
    for (const item of details) {
      if (typeof item === "string") messages.push(item);
      else if (
        item !== null &&
        typeof item === "object" &&
        typeof (item as { message?: unknown }).message === "string"
      ) {
        messages.push((item as { message: string }).message);
      }
    }
  } else if (details !== null && typeof details === "object") {
    const flat = details as { formErrors?: unknown; fieldErrors?: unknown };
    if (Array.isArray(flat.formErrors)) {
      messages.push(
        ...flat.formErrors.filter((message): message is string => typeof message === "string"),
      );
    }
    if (flat.fieldErrors !== null && typeof flat.fieldErrors === "object") {
      for (const [key, value] of Object.entries(flat.fieldErrors as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue;
        for (const message of value) {
          if (typeof message === "string") messages.push(`${key}: ${message}`);
        }
      }
    }
  }
  return messages.length > 0 ? messages : [err.message];
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...init?.headers,
    },
  });
  let json: { data?: T; error?: { code: string; message: string; details?: unknown } };
  try {
    json = await res.json();
  } catch {
    throw new ApiError("INTERNAL", `Unexpected response (${res.status})`, res.status);
  }
  if (!res.ok || json.error) {
    const err = json.error ?? { code: "INTERNAL", message: "Request failed" };
    throw new ApiError(err.code, err.message, res.status, err.details);
  }
  return json.data as T;
}

export const apiPost = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const apiPatch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const apiPut = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const apiDelete = <T>(path: string, body?: unknown) =>
  api<T>(path, {
    method: "DELETE",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
