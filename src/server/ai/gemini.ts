// Gemini provider. Batch scoring via Batch Mode with inlined requests (responses are
// positional — mapped back to customIds by submission order, which the service persists on
// the run row as requestKeys); extraction via generateContent with an inline PDF part.
// Structured output via responseJsonSchema + responseMimeType application/json.

import { GoogleGenAI } from "@google/genai";
import type {
  AiProvider,
  BuiltPrompt,
  ScoringBatchItem,
  ScoringBatchSnapshot,
  ScoringItemResult,
  UsageTotals,
} from "./types";

// Gemini inline requests cap at 20MB total request size.
export const GEMINI_MAX_PDF_BYTES = 14 * 1024 * 1024;

// Keep the whole inlined batch payload safely under the API's request-size ceiling.
const GEMINI_MAX_INLINE_BATCH_BYTES = 15 * 1024 * 1024;

// --- pure request builders (unit-tested without a client) ---------------------------------

export function buildGeminiScoringRequest(prompt: BuiltPrompt) {
  return {
    contents: [{ role: "user" as const, parts: [{ text: prompt.user }] }],
    config: {
      systemInstruction: prompt.system,
      responseMimeType: "application/json",
      responseJsonSchema: prompt.jsonSchema,
    },
  };
}

export function buildGeminiExtractionRequest(prompt: BuiltPrompt, pdfBase64: string) {
  return {
    contents: [
      {
        role: "user" as const,
        parts: [
          { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
          { text: prompt.user },
        ],
      },
    ],
    config: {
      systemInstruction: prompt.system,
      responseMimeType: "application/json",
      responseJsonSchema: prompt.jsonSchema,
    },
  };
}

// -------------------------------------------------------------------------------------------

// Batch responses come back as plain objects; read text via the candidates path rather than
// relying on SDK getters.
interface GeminiResponseLike {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

function textOf(response: GeminiResponseLike): string {
  return (response.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("");
}

function usageOf(response: GeminiResponseLike): UsageTotals | undefined {
  const meta = response.usageMetadata;
  if (!meta) return undefined;
  return {
    inputTokens: meta.promptTokenCount ?? 0,
    outputTokens: meta.candidatesTokenCount ?? 0,
  };
}

const TERMINAL_FAILURE_STATES = new Set([
  "JOB_STATE_FAILED",
  "JOB_STATE_CANCELLED",
  "JOB_STATE_EXPIRED",
]);

export class GeminiProvider implements AiProvider {
  readonly name = "gemini" as const;
  readonly maxPdfBytes = GEMINI_MAX_PDF_BYTES;
  private readonly client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async createScoringBatch(req: { model: string; items: ScoringBatchItem[] }) {
    const inlinedRequests = req.items.map((item) => ({
      model: req.model,
      ...buildGeminiScoringRequest(item.prompt),
    }));
    const payloadBytes = Buffer.byteLength(JSON.stringify(inlinedRequests), "utf8");
    if (payloadBytes > GEMINI_MAX_INLINE_BATCH_BYTES) {
      throw new Error(
        "This prescreen run is too large for the gemini provider's inline batch limit — run it in smaller increments or switch AI_PROVIDER",
      );
    }
    const job = await this.client.batches.create({
      model: req.model,
      src: inlinedRequests,
      config: { displayName: `prescreen-${Date.now()}` },
    });
    if (!job.name) throw new Error("Gemini did not return a batch job name");
    return { providerBatchId: job.name };
  }

  async getScoringBatch(req: {
    providerBatchId: string;
    customIds: string[];
  }): Promise<ScoringBatchSnapshot> {
    const job = await this.client.batches.get({ name: req.providerBatchId });
    const state = String(job.state ?? "");
    if (TERMINAL_FAILURE_STATES.has(state)) {
      return { status: "failed", error: job.error?.message ?? state };
    }
    if (state !== "JOB_STATE_SUCCEEDED") return { status: "processing" };

    // Inline batch responses preserve submission order — zip with the persisted customIds.
    const inlined = job.dest?.inlinedResponses ?? [];
    const results: ScoringItemResult[] = [];
    for (let i = 0; i < req.customIds.length; i++) {
      const customId = req.customIds[i]!;
      const entry = inlined[i];
      if (!entry) {
        results.push({ customId, ok: false, error: "No response returned for this item" });
        continue;
      }
      if (entry.error || !entry.response) {
        results.push({
          customId,
          ok: false,
          error: entry.error?.message ?? "Request failed",
        });
        continue;
      }
      const response = entry.response as GeminiResponseLike;
      try {
        results.push({
          customId,
          ok: true,
          json: JSON.parse(textOf(response)) as unknown,
          usage: usageOf(response),
        });
      } catch {
        results.push({ customId, ok: false, error: "Model returned unparseable JSON" });
      }
    }
    return { status: "ended", results };
  }

  async cancelScoringBatch(req: { providerBatchId: string }): Promise<void> {
    await this.client.batches.cancel({ name: req.providerBatchId });
  }

  async extractFromPdf(req: {
    model: string;
    prompt: BuiltPrompt;
    pdf: { bytes: Buffer; filename: string };
  }) {
    if (req.pdf.bytes.byteLength > this.maxPdfBytes) {
      throw new Error(
        `PDF exceeds the gemini provider's ${Math.floor(this.maxPdfBytes / (1024 * 1024))}MB limit`,
      );
    }
    const request = buildGeminiExtractionRequest(req.prompt, req.pdf.bytes.toString("base64"));
    const response = await this.client.models.generateContent({
      model: req.model,
      contents: request.contents,
      config: request.config,
    });
    const text = textOf(response as GeminiResponseLike);
    if (!text) throw new Error("The model returned no response");
    return {
      json: JSON.parse(text) as unknown,
      usage: usageOf(response as GeminiResponseLike),
    };
  }
}
