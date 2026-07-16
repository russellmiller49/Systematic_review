import { describe, expect, it } from "vitest";
import { buildExtractionPrompt, EXTRACTION_PROMPT_VERSION } from "./extraction";
import type { PromptField } from "../schemas";

const FIELDS: PromptField[] = [
  {
    id: "f1",
    key: "sample_size",
    label: "Total sample size",
    type: "NUMBER",
    required: true,
    section: "Participants",
    helpText: "Randomized participants, not screened",
    options: [],
  },
  {
    id: "f2",
    key: "designs",
    label: "Study designs",
    type: "MULTI_SELECT",
    required: false,
    section: null,
    helpText: null,
    options: [
      { value: "rct", label: "Randomized trial" },
      { value: "cohort", label: "Cohort study" },
    ],
  },
  {
    id: "f3",
    key: "start_date",
    label: "Enrollment start",
    type: "DATE",
    required: false,
    section: null,
    helpText: null,
    options: [],
  },
];

describe("buildExtractionPrompt", () => {
  it("lists every field with its typing rule", () => {
    const prompt = buildExtractionPrompt({ studyLabel: "Smith 2019", fields: FIELDS });
    expect(prompt.user).toContain("Study: Smith 2019");
    expect(prompt.user).toContain('key "sample_size": Total sample size (NUMBER, required by the form)');
    expect(prompt.user).toContain("Section: Participants");
    expect(prompt.user).toContain("Guidance: Randomized participants, not screened");
    expect(prompt.user).toContain("no units, commas, ranges");
    expect(prompt.user).toContain('Options: "rct" = Randomized trial; "cohort" = Cohort study');
    expect(prompt.user).toContain("non-empty array of distinct option values");
    expect(prompt.user).toContain("yyyy-mm-dd");
    expect(prompt.system).toContain("found: false");
  });

  it("attaches the field-derived json schema", () => {
    const prompt = buildExtractionPrompt({ studyLabel: "Smith 2019", fields: FIELDS });
    const schema = prompt.jsonSchema as {
      properties: { fields: { items: { properties: { key: { enum: string[] } } } } };
    };
    expect(schema.properties.fields.items.properties.key.enum).toEqual([
      "sample_size",
      "designs",
      "start_date",
    ]);
  });

  it("has a stable version constant", () => {
    expect(EXTRACTION_PROMPT_VERSION).toBe("extraction-v1");
  });
});
