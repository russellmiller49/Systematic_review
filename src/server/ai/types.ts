// Domain-shaped AI provider abstraction. Providers are transport-thin: prompts are built by
// src/server/ai/prompts/* and results are validated by src/server/ai/schemas.ts, so every
// provider sends identical instructions and returns the same normalized shapes.

export type AiProviderName = "anthropic" | "openai" | "gemini";

export const AI_PROVIDER_NAMES = ["anthropic", "openai", "gemini"] as const;

// A fully rendered prompt. jsonSchema is plain JSON Schema with additionalProperties:false
// throughout and no numeric bounds (providers can't enforce them — ingest clamps instead).
export interface BuiltPrompt {
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
}

export type ScoringItemResult =
  | { customId: string; ok: true; json: unknown; usage?: UsageTotals }
  | { customId: string; ok: false; error: string };

export type ScoringBatchSnapshot =
  | { status: "processing" }
  | { status: "failed"; error: string }
  | { status: "ended"; results: ScoringItemResult[] }; // keyed by customId; order NOT guaranteed

export interface ScoringBatchItem {
  customId: string; // round-trips through the provider (we use the citationId)
  prompt: BuiltPrompt;
}

export interface AiProvider {
  readonly name: AiProviderName;
  // Hard per-request PDF cap for this provider's document-input path (raw bytes, pre-base64).
  readonly maxPdfBytes: number;

  createScoringBatch(req: {
    model: string;
    items: ScoringBatchItem[];
  }): Promise<{ providerBatchId: string }>;

  // customIds: the submission-order ids from createScoringBatch — required by providers whose
  // batch results are positional rather than id-keyed (gemini inline requests).
  getScoringBatch(req: {
    providerBatchId: string;
    customIds: string[];
  }): Promise<ScoringBatchSnapshot>;

  cancelScoringBatch(req: { providerBatchId: string }): Promise<void>;

  extractFromPdf(req: {
    model: string;
    prompt: BuiltPrompt;
    pdf: { bytes: Buffer; filename: string };
  }): Promise<{ json: unknown; usage?: UsageTotals }>;

  // Text-only structured completion (no document attached); synchronous, not batched.
  completeStructured(req: {
    model: string;
    prompt: BuiltPrompt;
  }): Promise<{ json: unknown; usage?: UsageTotals }>;
}
