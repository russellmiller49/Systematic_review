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
export const apiDelete = <T>(path: string) => api<T>(path, { method: "DELETE" });
