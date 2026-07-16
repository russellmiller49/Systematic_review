// Anthropic provider (default). Batch scoring via the Message Batches API; extraction via a
// streaming Messages call with a base64 PDF document block. Structured output via
// output_config.format json_schema on every request.
//
// claude-opus-4-8 notes: never send temperature/top_p/budget_tokens (rejected with 400);
// thinking {type:"adaptive"} is allowed and used for extraction only — scoring omits
// thinking so max_tokens stays predictable across thousands of batch items.

import Anthropic from "@anthropic-ai/sdk";
import type {
  AiProvider,
  BuiltPrompt,
  ScoringBatchItem,
  ScoringBatchSnapshot,
  ScoringItemResult,
  UsageTotals,
} from "./types";

// 32MB request cap at ~1.33x base64 inflation, minus prompt headroom.
export const ANTHROPIC_MAX_PDF_BYTES = 20 * 1024 * 1024;

// --- pure request builders (unit-tested without a client) ---------------------------------

export function buildAnthropicScoringParams(model: string, prompt: BuiltPrompt) {
  return {
    model,
    max_tokens: 2048,
    system: prompt.system,
    messages: [{ role: "user" as const, content: prompt.user }],
    output_config: { format: { type: "json_schema" as const, schema: prompt.jsonSchema } },
  };
}

export function buildAnthropicExtractionParams(
  model: string,
  prompt: BuiltPrompt,
  pdfBase64: string,
) {
  return {
    model,
    max_tokens: 32000,
    system: prompt.system,
    thinking: { type: "adaptive" as const },
    messages: [
      {
        role: "user" as const,
        content: [
          {
            type: "document" as const,
            source: {
              type: "base64" as const,
              media_type: "application/pdf" as const,
              data: pdfBase64,
            },
          },
          { type: "text" as const, text: prompt.user },
        ],
      },
    ],
    output_config: { format: { type: "json_schema" as const, schema: prompt.jsonSchema } },
  };
}

// -------------------------------------------------------------------------------------------

function usageOf(message: Anthropic.Message): UsageTotals {
  return {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic" as const;
  readonly maxPdfBytes = ANTHROPIC_MAX_PDF_BYTES;
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async createScoringBatch(req: { model: string; items: ScoringBatchItem[] }) {
    const batch = await this.client.messages.batches.create({
      requests: req.items.map((item) => ({
        custom_id: item.customId,
        params: buildAnthropicScoringParams(req.model, item.prompt),
      })),
    });
    return { providerBatchId: batch.id };
  }

  async getScoringBatch(req: { providerBatchId: string }): Promise<ScoringBatchSnapshot> {
    const batch = await this.client.messages.batches.retrieve(req.providerBatchId);
    if (batch.processing_status !== "ended") return { status: "processing" };

    const results: ScoringItemResult[] = [];
    for await (const entry of await this.client.messages.batches.results(req.providerBatchId)) {
      if (entry.result.type === "succeeded") {
        const message = entry.result.message;
        if (message.stop_reason === "refusal") {
          results.push({ customId: entry.custom_id, ok: false, error: "Model refusal" });
          continue;
        }
        try {
          results.push({
            customId: entry.custom_id,
            ok: true,
            json: JSON.parse(textOf(message.content)),
            usage: usageOf(message),
          });
        } catch {
          results.push({
            customId: entry.custom_id,
            ok: false,
            error: "Model returned unparseable JSON",
          });
        }
      } else if (entry.result.type === "errored") {
        results.push({
          customId: entry.custom_id,
          ok: false,
          error: JSON.stringify(entry.result.error),
        });
      } else {
        // canceled | expired
        results.push({ customId: entry.custom_id, ok: false, error: entry.result.type });
      }
    }
    return { status: "ended", results };
  }

  async cancelScoringBatch(req: { providerBatchId: string }): Promise<void> {
    await this.client.messages.batches.cancel(req.providerBatchId);
  }

  async extractFromPdf(req: {
    model: string;
    prompt: BuiltPrompt;
    pdf: { bytes: Buffer; filename: string };
  }) {
    if (req.pdf.bytes.byteLength > this.maxPdfBytes) {
      throw new Error(
        `PDF exceeds the anthropic provider's ${Math.floor(this.maxPdfBytes / (1024 * 1024))}MB limit`,
      );
    }
    // Streaming keeps long PDF reads from hitting HTTP timeouts.
    const stream = this.client.messages.stream(
      buildAnthropicExtractionParams(req.model, req.prompt, req.pdf.bytes.toString("base64")),
    );
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") {
      throw new Error("The model declined to process this document");
    }
    if (message.stop_reason === "max_tokens") {
      throw new Error("The model's response was truncated (max_tokens) — try a smaller template");
    }
    return { json: JSON.parse(textOf(message.content)) as unknown, usage: usageOf(message) };
  }
}
