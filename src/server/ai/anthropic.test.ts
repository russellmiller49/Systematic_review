import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_MAX_PDF_BYTES,
  buildAnthropicCompletionParams,
  buildAnthropicExtractionParams,
  buildAnthropicScoringParams,
} from "./anthropic";
import type { BuiltPrompt } from "./types";

const PROMPT: BuiltPrompt = {
  system: "system text",
  user: "user text",
  jsonSchema: { type: "object", properties: {}, additionalProperties: false },
};

describe("buildAnthropicScoringParams", () => {
  it("uses structured outputs and never sends sampling params or thinking budgets", () => {
    const params = buildAnthropicScoringParams("claude-opus-4-8", PROMPT);
    expect(params.model).toBe("claude-opus-4-8");
    expect(params.system).toBe("system text");
    expect(params.messages).toEqual([{ role: "user", content: "user text" }]);
    expect(params.output_config).toEqual({
      format: { type: "json_schema", schema: PROMPT.jsonSchema },
    });
    // claude-opus-4-8 rejects these with a 400 — they must never appear.
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
    expect(params).not.toHaveProperty("top_k");
    expect(params).not.toHaveProperty("thinking");
  });
});

describe("buildAnthropicCompletionParams", () => {
  it("is the scoring shape with 8192 output tokens and no sampling params or thinking", () => {
    const params = buildAnthropicCompletionParams("claude-opus-4-8", PROMPT);
    expect(params.max_tokens).toBe(8192);
    expect(params.system).toBe("system text");
    expect(params.messages).toEqual([{ role: "user", content: "user text" }]);
    expect(params.output_config).toEqual({
      format: { type: "json_schema", schema: PROMPT.jsonSchema },
    });
    // claude-opus-4-8 rejects these with a 400 — they must never appear.
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
    expect(params).not.toHaveProperty("top_k");
    expect(params).not.toHaveProperty("thinking");
  });
});

describe("buildAnthropicExtractionParams", () => {
  it("places the document block before the text block and enables adaptive thinking", () => {
    const params = buildAnthropicExtractionParams("claude-opus-4-8", PROMPT, "QkFTRTY0");
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params).not.toHaveProperty("temperature");
    const content = params.messages[0]!.content;
    expect(content[0]).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "QkFTRTY0" },
    });
    expect(content[1]).toEqual({ type: "text", text: "user text" });
    expect(params.output_config.format.type).toBe("json_schema");
  });
});

describe("ANTHROPIC_MAX_PDF_BYTES", () => {
  it("stays under the 32MB request cap after ~1.33x base64 inflation", () => {
    expect((ANTHROPIC_MAX_PDF_BYTES * 4) / 3).toBeLessThan(32 * 1024 * 1024);
  });
});
