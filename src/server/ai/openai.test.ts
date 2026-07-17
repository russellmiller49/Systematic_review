import { describe, expect, it } from "vitest";
import {
  buildOpenAiBatchJsonl,
  buildOpenAiCompletionBody,
  buildOpenAiExtractionBody,
  buildOpenAiScoringBody,
} from "./openai";
import type { BuiltPrompt } from "./types";

const PROMPT: BuiltPrompt = {
  system: "system text",
  user: "user text",
  jsonSchema: { type: "object", properties: {}, additionalProperties: false },
};

describe("buildOpenAiScoringBody", () => {
  it("uses strict json_schema response format", () => {
    const body = buildOpenAiScoringBody("gpt-5.1", PROMPT);
    expect(body.messages[0]).toEqual({ role: "system", content: "system text" });
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "screening_result", strict: true, schema: PROMPT.jsonSchema },
    });
  });
});

describe("buildOpenAiCompletionBody", () => {
  it("uses strict json_schema response format named structured_result", () => {
    const body = buildOpenAiCompletionBody("gpt-5.1", PROMPT);
    expect(body.model).toBe("gpt-5.1");
    expect(body.messages).toEqual([
      { role: "system", content: "system text" },
      { role: "user", content: "user text" },
    ]);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "structured_result", strict: true, schema: PROMPT.jsonSchema },
    });
  });
});

describe("buildOpenAiBatchJsonl", () => {
  it("emits one /v1/chat/completions line per item keyed by custom_id", () => {
    const jsonl = buildOpenAiBatchJsonl("gpt-5.1", [
      { customId: "cit_a", prompt: PROMPT },
      { customId: "cit_b", prompt: PROMPT },
    ]);
    const lines = jsonl.split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      custom_id: "cit_a",
      method: "POST",
      url: "/v1/chat/completions",
    });
    expect(lines[1].custom_id).toBe("cit_b");
    expect(lines[0].body.model).toBe("gpt-5.1");
  });
});

describe("buildOpenAiExtractionBody", () => {
  it("attaches the PDF as a data-URL file part before the text part", () => {
    const body = buildOpenAiExtractionBody("gpt-5.1", PROMPT, "QkFTRTY0", "paper.pdf");
    const userContent = body.messages[1]!.content as { type: string }[];
    expect(userContent[0]).toEqual({
      type: "file",
      file: { filename: "paper.pdf", file_data: "data:application/pdf;base64,QkFTRTY0" },
    });
    expect(userContent[1]).toEqual({ type: "text", text: "user text" });
  });
});
