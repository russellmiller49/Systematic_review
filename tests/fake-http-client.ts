import type {
  HttpBytesOptions,
  HttpBytesResponse,
  HttpClient,
  HttpFetchOptions,
  HttpJsonResponse,
} from "@/server/http/client";

// Canned-response HTTP client for integration tests (inject via setHttpClientForTests).
// Responses are matched by URL substring, first match wins. Unmatched URLs throw so a
// test that forgot a canned response fails loudly instead of silently degrading.

export interface CannedResponse {
  status?: number; // default 200
  json?: unknown;
  bytes?: Buffer;
  contentType?: string | null;
  error?: Error; // simulate a network-level failure (timeout/DNS)
}

export class FakeHttpClient implements HttpClient {
  readonly requests: string[] = [];
  private readonly canned: Array<{ match: string; response: CannedResponse }> = [];

  on(urlSubstring: string, response: CannedResponse): this {
    this.canned.push({ match: urlSubstring, response });
    return this;
  }

  private find(url: string): CannedResponse {
    const hit = this.canned.find((c) => url.includes(c.match));
    if (!hit) throw new Error(`FakeHttpClient: no canned response for ${url}`);
    return hit.response;
  }

  async fetchJson(url: string, _opts?: HttpFetchOptions): Promise<HttpJsonResponse> {
    this.requests.push(url);
    const r = this.find(url);
    if (r.error) throw r.error;
    return { status: r.status ?? 200, json: r.json ?? null };
  }

  async fetchBytes(url: string, _opts?: HttpBytesOptions): Promise<HttpBytesResponse> {
    this.requests.push(url);
    const r = this.find(url);
    if (r.error) throw r.error;
    return {
      status: r.status ?? 200,
      contentType: r.contentType ?? null,
      bytes: r.bytes ?? Buffer.alloc(0),
    };
  }
}
