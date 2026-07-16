// Pure prompt builder for AI risk-of-bias assessment drafts. No I/O — unit-tested.
// The tool structure (domains, signaling questions, allowed answers, judgment scale,
// guidance) is serialized into the prompt + wire schema, so any tool works — the six
// seeded standard tools and custom ones alike. Conditional-answer rules (e.g. RoB 2's
// "answer NA unless 2.1 is Y/PY/NI") ride on the serialized guidance strings.
// Bump ROB_PROMPT_VERSION whenever the wording or schema changes.

import type { BuiltPrompt } from "../types";
import type { RobPromptDomain } from "../schemas";
import { robJsonSchemaFor } from "../schemas";

export const ROB_PROMPT_VERSION = "rob-v1";

const SYSTEM = `You are assessing risk of bias for a study report (PDF) in a systematic review, using the assessment tool specified below. Base every answer ONLY on what this document reports.

Rules:
- For each domain: answer every signaling question using only that question's allowed answer codes, then propose a domain judgment using only the tool's scale values (use the value string, not the label).
- Follow each domain's and question's guidance exactly, including conditional rules (e.g. "answer NA unless question 2.1 is Y/PY/NI").
- Per domain, give a 1-3 sentence rationale and 1 to 3 short verbatim quotes from the document, each with the 1-based page number of the PDF file where it appears (count PDF pages from 1, not the journal's printed page numbers).
- Never guess or infer beyond the document. When the document does not report the information a question needs, prefer the tool's no-information code (e.g. NI, Unclear) where available.
- If an entire domain cannot be assessed from this document (e.g. the tool does not fit the study design), return assessable: false with judgment: null and explain why in the rationale.
- If the tool's guidance implies an algorithmic mapping from signaling answers to the domain judgment, follow that mapping.
- Return exactly one entry per domain id, and within it one answer per signaling question id.`;

export interface RobPromptScaleEntry {
  value: string;
  label: string;
}

function questionLines(domain: RobPromptDomain): string[] {
  const lines: string[] = [];
  for (const question of domain.questions) {
    lines.push(
      `- question id ${JSON.stringify(question.id)}: ${question.text.trim()}`,
      `  Allowed answers: ${question.allowedAnswers.map((a) => JSON.stringify(a)).join(", ")}`,
    );
    if (question.guidance?.trim()) lines.push(`  Guidance: ${question.guidance.trim()}`);
  }
  return lines;
}

export function buildRobPrompt(input: {
  studyLabel: string;
  toolName: string;
  toolDescription: string | null;
  judgmentScale: RobPromptScaleEntry[];
  domains: RobPromptDomain[];
}): BuiltPrompt {
  const lines: string[] = [`Study: ${input.studyLabel.trim()}`, ""];
  lines.push(`Assessment tool: ${input.toolName.trim()}`);
  if (input.toolDescription?.trim()) lines.push(input.toolDescription.trim());
  lines.push(
    "",
    `Judgment scale (use the value string, not the label): ${input.judgmentScale
      .map((e) => `${JSON.stringify(e.value)} = ${e.label}`)
      .join("; ")}`,
    "",
    "Assess the following domains from the attached document:",
  );
  for (const domain of input.domains) {
    lines.push("", `Domain id ${JSON.stringify(domain.id)}: ${domain.name.trim()}`);
    if (domain.guidance?.trim()) lines.push(`Guidance: ${domain.guidance.trim()}`);
    if (domain.questions.length > 0) {
      lines.push("Signaling questions:", ...questionLines(domain));
    }
  }
  lines.push(
    "",
    "Remember: one entry per domain id; one answer per signaling question id; quotes must be verbatim from the document with 1-based PDF page numbers; assessable: false with judgment: null for domains this document cannot support.",
  );

  const scaleValues = input.judgmentScale.map((e) => e.value);
  return {
    system: SYSTEM,
    user: lines.join("\n"),
    jsonSchema: robJsonSchemaFor(scaleValues, input.domains),
  };
}
