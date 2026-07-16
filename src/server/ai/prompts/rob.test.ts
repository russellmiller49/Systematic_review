import { describe, expect, it } from "vitest";
import { buildRobPrompt, ROB_PROMPT_VERSION } from "./rob";
import type { RobPromptDomain } from "../schemas";

const DOMAINS: RobPromptDomain[] = [
  {
    id: "d1",
    name: "Randomization process",
    guidance: "Consider allocation sequence generation and concealment.",
    questions: [
      {
        id: "q1",
        text: "1.1 Was the allocation sequence random?",
        guidance: null,
        allowedAnswers: ["Y", "PY", "PN", "N", "NI"],
      },
      {
        id: "q2",
        text: "1.2 Was the allocation sequence concealed?",
        guidance: "Answer NA unless 1.1 is Y/PY/NI.",
        allowedAnswers: ["Y", "PY", "PN", "N", "NI", "NA"],
      },
    ],
  },
  {
    id: "d2",
    name: "Missing outcome data",
    guidance: null,
    questions: [],
  },
];

const SCALE = [
  { value: "low", label: "Low risk of bias" },
  { value: "some_concerns", label: "Some concerns" },
  { value: "high", label: "High risk of bias" },
];

describe("buildRobPrompt", () => {
  it("serializes the tool structure — scale, domains, questions, allowed answers, guidance", () => {
    const prompt = buildRobPrompt({
      studyLabel: "Smith 2019",
      toolName: "RoB 2",
      toolDescription: "Answer codes: Y = yes; PY = probably yes.",
      judgmentScale: SCALE,
      domains: DOMAINS,
    });
    expect(prompt.user).toContain("Study: Smith 2019");
    expect(prompt.user).toContain("Assessment tool: RoB 2");
    expect(prompt.user).toContain("Answer codes: Y = yes");
    expect(prompt.user).toContain('"low" = Low risk of bias; "some_concerns" = Some concerns');
    expect(prompt.user).toContain('Domain id "d1": Randomization process');
    expect(prompt.user).toContain("Guidance: Consider allocation sequence generation");
    expect(prompt.user).toContain('question id "q2": 1.2 Was the allocation sequence concealed?');
    expect(prompt.user).toContain('Allowed answers: "Y", "PY", "PN", "N", "NI", "NA"');
    expect(prompt.user).toContain("Guidance: Answer NA unless 1.1 is Y/PY/NI.");
    expect(prompt.system).toContain("assessable: false");
    expect(prompt.system).toContain("1-based page number");
  });

  it("omits the questions block for question-less domains", () => {
    const prompt = buildRobPrompt({
      studyLabel: "Smith 2019",
      toolName: "Generic",
      toolDescription: null,
      judgmentScale: SCALE,
      domains: [DOMAINS[1]!],
    });
    expect(prompt.user).toContain('Domain id "d2": Missing outcome data');
    expect(prompt.user).not.toContain("Signaling questions:");
  });

  it("attaches the tool-derived json schema", () => {
    const prompt = buildRobPrompt({
      studyLabel: "Smith 2019",
      toolName: "RoB 2",
      toolDescription: null,
      judgmentScale: SCALE,
      domains: DOMAINS,
    });
    const schema = prompt.jsonSchema as {
      properties: {
        domains: {
          items: {
            properties: {
              domainId: { enum: string[] };
              judgment: { anyOf: [{ enum: string[] }, { type: string }] };
            };
          };
        };
      };
    };
    expect(schema.properties.domains.items.properties.domainId.enum).toEqual(["d1", "d2"]);
    expect(schema.properties.domains.items.properties.judgment.anyOf[0].enum).toEqual([
      "low",
      "some_concerns",
      "high",
    ]);
  });

  it("has a stable version constant", () => {
    expect(ROB_PROMPT_VERSION).toBe("rob-v1");
  });
});
