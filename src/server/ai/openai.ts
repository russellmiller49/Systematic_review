// OpenAI provider. Batch scoring via the Batch API (JSONL file upload → /v1/chat/completions
// lines); extraction via a chat completion with a base64 PDF file part; text-only structured
// completions via a plain chat completion. Structured output via response_format json_schema
// strict on every request.

import OpenAI, { toFile } from "openai";
import type {
  AiProvider,
  BuiltPrompt,
  ScoringBatchItem,
  ScoringBatchSnapshot,
  ScoringItemResult,
  UsageTotals,
} from "./types";

export const OPENAI_MAX_PDF_BYTES = 20 * 1024 * 1024;

// --- pure request builders (unit-tested without a client) ---------------------------------

export function buildOpenAiScoringBody(model: string, prompt: BuiltPrompt) {
  return {
    model,
    messages: [
      { role: "system" as const, content: prompt.system },
      { role: "user" as const, content: prompt.user },
    ],
    response_format: {
      type: "json_schema" as const,
      json_schema: { name: "screening_result", strict: true, schema: prompt.jsonSchema },
    },
  };
}

export function buildOpenAiCompletionBody(model: string, prompt: BuiltPrompt) {
  return {
    model,
    messages: [
      { role: "system" as const, content: prompt.system },
      { role: "user" as const, content: prompt.user },
    ],
    response_format: {
      type: "json_schema" as const,
      json_schema: { name: "structured_result", strict: true, schema: prompt.jsonSchema },
    },
  };
}

export function buildOpenAiBatchJsonl(model: string, items: ScoringBatchItem[]): string {
  return items
    .map((item) =>
      JSON.stringify({
        custom_id: item.customId,
        method: "POST",
        url: "/v1/chat/completions",
        body: buildOpenAiScoringBody(model, item.prompt),
      }),
    )
    .join("\n");
}

export function buildOpenAiExtractionBody(
  model: string,
  prompt: BuiltPrompt,
  pdfBase64: string,
  filename: string,
) {
  return {
    model,
    messages: [
      { role: "system" as const, content: prompt.system },
      {
        role: "user" as const,
        content: [
          {
            type: "file" as const,
            file: { filename, file_data: `data:application/pdf;base64,${pdfBase64}` },
          },
          { type: "text" as const, text: prompt.user },
        ],
      },
    ],
    response_format: {
      type: "json_schema" as const,
      json_schema: { name: "extraction_result", strict: true, schema: prompt.jsonSchema },
    },
  };
}

// -------------------------------------------------------------------------------------------

interface BatchOutputLine {
  custom_id: string;
  response?: {
    status_code: number;
    body?: {
      choices?: { message?: { content?: string | null; refusal?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
  } | null;
  error?: { message?: string } | null;
}

function parseOutputLine(line: BatchOutputLine): ScoringItemResult {
  if (line.error) {
    return { customId: line.custom_id, ok: false, error: line.error.message ?? "Request failed" };
  }
  const body = line.response?.body;
  const message = body?.choices?.[0]?.message;
  if (!line.response || line.response.status_code !== 200 || !message) {
    return {
      customId: line.custom_id,
      ok: false,
      error: `Request failed with status ${line.response?.status_code ?? "unknown"}`,
    };
  }
  if (message.refusal) {
    return { customId: line.custom_id, ok: false, error: "Model refusal" };
  }
  try {
    const usage: UsageTotals | undefined = body?.usage
      ? {
          inputTokens: body.usage.prompt_tokens ?? 0,
          outputTokens: body.usage.completion_tokens ?? 0,
        }
      : undefined;
    return {
      customId: line.custom_id,
      ok: true,
      json: JSON.parse(message.content ?? "") as unknown,
      usage,
    };
  } catch {
    return { customId: line.custom_id, ok: false, error: "Model returned unparseable JSON" };
  }
}

export class OpenAiProvider implements AiProvider {
  readonly name = "openai" as const;
  readonly maxPdfBytes = OPENAI_MAX_PDF_BYTES;
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async createScoringBatch(req: { model: string; items: ScoringBatchItem[] }) {
    const jsonl = buildOpenAiBatchJsonl(req.model, req.items);
    const file = await this.client.files.create({
      file: await toFile(Buffer.from(jsonl, "utf8"), "prescreen.jsonl"),
      purpose: "batch",
    });
    const batch = await this.client.batches.create({
      input_file_id: file.id,
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
    });
    return { providerBatchId: batch.id };
  }

  async getScoringBatch(req: { providerBatchId: string }): Promise<ScoringBatchSnapshot> {
    const batch = await this.client.batches.retrieve(req.providerBatchId);
    if (batch.status === "failed" || batch.status === "expired" || batch.status === "cancelled") {
      const detail = batch.errors?.data?.[0]?.message;
      return { status: "failed", error: detail ?? `Batch ${batch.status}` };
    }
    if (batch.status !== "completed") return { status: "processing" };

    const results: ScoringItemResult[] = [];
    for (const fileId of [batch.output_file_id, batch.error_file_id]) {
      if (!fileId) continue;
      const content = await this.client.files.content(fileId);
      const text = await content.text();
      for (const raw of text.split("\n")) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        try {
          results.push(parseOutputLine(JSON.parse(trimmed) as BatchOutputLine));
        } catch {
          // Skip unparseable transport lines; affected items surface as missing results.
        }
      }
    }
    return { status: "ended", results };
  }

  async cancelScoringBatch(req: { providerBatchId: string }): Promise<void> {
    await this.client.batches.cancel(req.providerBatchId);
  }

  async extractFromPdf(req: {
    model: string;
    prompt: BuiltPrompt;
    pdf: { bytes: Buffer; filename: string };
  }) {
    if (req.pdf.bytes.byteLength > this.maxPdfBytes) {
      throw new Error(
        `PDF exceeds the openai provider's ${Math.floor(this.maxPdfBytes / (1024 * 1024))}MB limit`,
      );
    }
    const completion = await this.client.chat.completions.create(
      buildOpenAiExtractionBody(
        req.model,
        req.prompt,
        req.pdf.bytes.toString("base64"),
        req.pdf.filename,
      ),
    );
    const message = completion.choices[0]?.message;
    if (!message || message.refusal) {
      throw new Error(message?.refusal ?? "The model returned no response");
    }
    const usage: UsageTotals | undefined = completion.usage
      ? {
          inputTokens: completion.usage.prompt_tokens,
          outputTokens: completion.usage.completion_tokens,
        }
      : undefined;
    return { json: JSON.parse(message.content ?? "") as unknown, usage };
  }

  async completeStructured(req: { model: string; prompt: BuiltPrompt }) {
    const completion = await this.client.chat.completions.create(
      buildOpenAiCompletionBody(req.model, req.prompt),
    );
    const message = completion.choices[0]?.message;
    if (!message || message.refusal) {
      throw new Error(message?.refusal ?? "The model returned no response");
    }
    const usage: UsageTotals | undefined = completion.usage
      ? {
          inputTokens: completion.usage.prompt_tokens,
          outputTokens: completion.usage.completion_tokens,
        }
      : undefined;
    return { json: JSON.parse(message.content ?? "") as unknown, usage };
  }
}
