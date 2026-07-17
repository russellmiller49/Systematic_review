import { describe, expect, it } from "vitest";
import {
  buildGeminiCompletionRequest,
  buildGeminiExtractionRequest,
  buildGeminiScoringRequest,
} from "./gemini";
import type { BuiltPrompt } from "./types";

const PROMPT: BuiltPrompt = {
  system: "system text",
  user: "user text",
  jsonSchema: { type: "object", properties: {}, additionalProperties: false },
};

describe("buildGeminiScoringRequest", () => {
  it("uses responseJsonSchema with application/json output", () => {
    const request = buildGeminiScoringRequest(PROMPT);
    expect(request.contents).toEqual([{ role: "user", parts: [{ text: "user text" }] }]);
    expect(request.config.systemInstruction).toBe("system text");
    expect(request.config.responseMimeType).toBe("application/json");
    expect(request.config.responseJsonSchema).toBe(PROMPT.jsonSchema);
  });
});

describe("buildGeminiCompletionRequest", () => {
  it("is the scoring request with the model inlined", () => {
    const request = buildGeminiCompletionRequest("gemini-3-pro", PROMPT);
    expect(request.model).toBe("gemini-3-pro");
    expect(request.contents).toEqual([{ role: "user", parts: [{ text: "user text" }] }]);
    expect(request.config.systemInstruction).toBe("system text");
    expect(request.config.responseMimeType).toBe("application/json");
    expect(request.config.responseJsonSchema).toBe(PROMPT.jsonSchema);
  });
});

describe("buildGeminiExtractionRequest", () => {
  it("attaches the PDF as inlineData before the text part", () => {
    const request = buildGeminiExtractionRequest(PROMPT, "QkFTRTY0");
    const parts = request.contents[0]!.parts;
    expect(parts[0]).toEqual({
      inlineData: { mimeType: "application/pdf", data: "QkFTRTY0" },
    });
    expect(parts[1]).toEqual({ text: "user text" });
  });
});
