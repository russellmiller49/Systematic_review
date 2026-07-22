// The single seam for outbound HTTP to external scholarly APIs (Unpaywall, Europe PMC,
// Crossref, NCBI E-utilities). Mirrors the lazy-singleton + test-override pattern of
// getAiProvider(): integration tests inject a FakeHttpClient without module mocks.
//
// Contract: HTTP-level responses (any status) RESOLVE with the status so callers decide;
// network-level failures (timeout, DNS, aborted body) and maxBytes violations REJECT.

export interface HttpFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface HttpBytesOptions extends HttpFetchOptions {
  maxBytes?: number;
}

export interface HttpJsonResponse {
  status: number;
  json: unknown; // null when the body is not valid JSON
}

export interface HttpBytesResponse {
  status: number;
  contentType: string | null;
  bytes: Buffer;
}

export interface HttpClient {
  fetchJson(url: string, opts?: HttpFetchOptions): Promise<HttpJsonResponse>;
  fetchBytes(url: string, opts?: HttpBytesOptions): Promise<HttpBytesResponse>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // matches MAX_PDF_BYTES in the fulltext service

class FetchHttpClient implements HttpClient {
  async fetchJson(url: string, opts?: HttpFetchOptions): Promise<HttpJsonResponse> {
    const res = await fetch(url, {
      headers: opts?.headers,
      signal: AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      redirect: "follow",
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  async fetchBytes(url: string, opts?: HttpBytesOptions): Promise<HttpBytesResponse> {
    const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
    const res = await fetch(url, {
      headers: opts?.headers,
      signal: AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      redirect: "follow",
    });
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`Response exceeds ${maxBytes} bytes (declared ${declared})`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Response exceeds ${maxBytes} bytes`);
    }
    return { status: res.status, contentType: res.headers.get("content-type"), bytes };
  }
}

let cached: HttpClient | null = null;
let testOverride: HttpClient | null | undefined; // undefined = no override active

export function getHttpClient(): HttpClient {
  if (testOverride !== undefined && testOverride !== null) return testOverride;
  if (!cached) cached = new FetchHttpClient();
  return cached;
}

export function setHttpClientForTests(client: HttpClient | null): void {
  testOverride = client;
}

export function resetHttpClientForTests(): void {
  testOverride = undefined;
}

// Politeness contact sent to external scholarly APIs. Unpaywall requires it as a query
// param; Crossref/Europe PMC etiquette asks for a mailto in the User-Agent. Absent env
// var → null (callers that REQUIRE it, e.g. Unpaywall, disable themselves).
export function getContactEmail(): string | null {
  const email = process.env.CONTACT_EMAIL?.trim();
  return email ? email : null;
}

export function politeHeaders(): Record<string, string> {
  const email = getContactEmail();
  return {
    "User-Agent": email ? `Synthesis/0.1 (mailto:${email})` : "Synthesis/0.1",
  };
}
