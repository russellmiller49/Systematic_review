// Programmable in-memory AiProvider for integration tests. Injected via
// setAiProviderForTests() (src/server/ai/provider.ts) — no network, no module mocks.

import type {
  AiProvider,
  AiProviderName,
  BuiltPrompt,
  ScoringBatchItem,
  ScoringBatchSnapshot,
  ScoringItemResult,
  UsageTotals,
} from "@/server/ai/types";

export class FakeAiProvider implements AiProvider {
  readonly name: AiProviderName = "anthropic";
  maxPdfBytes = 20 * 1024 * 1024;

  // Programmable behavior
  failSubmit: string | null = null;
  failExtract: string | null = null;
  batchSnapshot: ScoringBatchSnapshot = { status: "processing" };
  extractionJson: unknown = { fields: [] };
  extractionUsage: UsageTotals | undefined = { inputTokens: 1000, outputTokens: 100 };

  // Recorded calls
  createdBatches: { model: string; items: ScoringBatchItem[] }[] = [];
  polls: { providerBatchId: string; customIds: string[] }[] = [];
  canceledBatchIds: string[] = [];
  extractCalls: { model: string; prompt: BuiltPrompt; pdfBytes: number; filename: string }[] = [];

  async createScoringBatch(req: { model: string; items: ScoringBatchItem[] }) {
    if (this.failSubmit) throw new Error(this.failSubmit);
    this.createdBatches.push(req);
    return { providerBatchId: `fake-batch-${this.createdBatches.length}` };
  }

  async getScoringBatch(req: { providerBatchId: string; customIds: string[] }) {
    this.polls.push(req);
    return this.batchSnapshot;
  }

  async cancelScoringBatch(req: { providerBatchId: string }) {
    this.canceledBatchIds.push(req.providerBatchId);
  }

  async extractFromPdf(req: {
    model: string;
    prompt: BuiltPrompt;
    pdf: { bytes: Buffer; filename: string };
  }) {
    if (this.failExtract) throw new Error(this.failExtract);
    this.extractCalls.push({
      model: req.model,
      prompt: req.prompt,
      pdfBytes: req.pdf.bytes.byteLength,
      filename: req.pdf.filename,
    });
    return { json: this.extractionJson, usage: this.extractionUsage };
  }

  // Convenience: mark the batch ended with the given per-item results.
  endBatchWith(results: ScoringItemResult[]) {
    this.batchSnapshot = { status: "ended", results };
  }

  // Convenience: score every submitted item of the last batch identically.
  endBatchScoringAll(score: number, decision: "INCLUDE" | "EXCLUDE" | "MAYBE" = "MAYBE") {
    const last = this.createdBatches[this.createdBatches.length - 1];
    this.endBatchWith(
      (last?.items ?? []).map((item) => ({
        customId: item.customId,
        ok: true as const,
        json: { score, decision, rationale: `Scored ${score} by fake provider` },
        usage: { inputTokens: 100, outputTokens: 20 },
      })),
    );
  }
}
