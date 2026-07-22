import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getHttpClient,
  politeHeaders,
  resetHttpClientForTests,
  setHttpClientForTests,
  type HttpClient,
} from "./client";

// Exercises the real FetchHttpClient against a local node:http server.

let server: Server;
let base = "";
const ORIGINAL_CONTACT_EMAIL = process.env.CONTACT_EMAIL;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hello: "world" }));
    } else if (req.url === "/not-json") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>interstitial</html>");
    } else if (req.url === "/missing") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "nope" }));
    } else if (req.url === "/bytes") {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end(Buffer.from("%PDF-1.7 fake"));
    } else if (req.url === "/big") {
      const body = Buffer.alloc(2048, 1);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
      res.end(body);
    } else if (req.url === "/slow") {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }, 500);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  if (ORIGINAL_CONTACT_EMAIL === undefined) delete process.env.CONTACT_EMAIL;
  else process.env.CONTACT_EMAIL = ORIGINAL_CONTACT_EMAIL;
});

afterEach(() => {
  resetHttpClientForTests();
});

describe("FetchHttpClient", () => {
  it("fetchJson parses a JSON body and returns the status", async () => {
    const res = await getHttpClient().fetchJson(`${base}/json`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ hello: "world" });
  });

  it("fetchJson resolves (not rejects) on non-2xx and on non-JSON bodies", async () => {
    const missing = await getHttpClient().fetchJson(`${base}/missing`);
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ error: "nope" });

    const html = await getHttpClient().fetchJson(`${base}/not-json`);
    expect(html.status).toBe(200);
    expect(html.json).toBeNull();
  });

  it("fetchBytes returns bytes and content type", async () => {
    const res = await getHttpClient().fetchBytes(`${base}/bytes`);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/pdf");
    expect(res.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("fetchBytes rejects when the response exceeds maxBytes", async () => {
    await expect(getHttpClient().fetchBytes(`${base}/big`, { maxBytes: 1024 })).rejects.toThrow(
      /exceeds 1024 bytes/,
    );
  });

  it("rejects on timeout", async () => {
    await expect(getHttpClient().fetchJson(`${base}/slow`, { timeoutMs: 50 })).rejects.toThrow();
  });
});

describe("test seam", () => {
  it("setHttpClientForTests overrides the client until reset", async () => {
    const fake: HttpClient = {
      fetchJson: async () => ({ status: 299, json: { fake: true } }),
      fetchBytes: async () => ({ status: 299, contentType: null, bytes: Buffer.alloc(0) }),
    };
    setHttpClientForTests(fake);
    expect((await getHttpClient().fetchJson("http://ignored")).status).toBe(299);
    resetHttpClientForTests();
    const real = await getHttpClient().fetchJson(`${base}/json`);
    expect(real.status).toBe(200);
  });
});

describe("politeHeaders", () => {
  it("includes a mailto User-Agent when CONTACT_EMAIL is set, plain otherwise", () => {
    process.env.CONTACT_EMAIL = "librarian@example.edu";
    expect(politeHeaders()).toEqual({
      "User-Agent": "Synthesis/0.1 (mailto:librarian@example.edu)",
    });
    process.env.CONTACT_EMAIL = "   ";
    expect(politeHeaders()).toEqual({ "User-Agent": "Synthesis/0.1" });
  });
});
