// Built-in "Generic Risk of Bias Tool" — seeded once, shared by every project
// (projectId null, isBuiltin true, PUBLISHED). Exported for prisma/seed.ts.

import { prisma, type Tx } from "@/server/db";

export const DEFAULT_ALLOWED_ANSWERS = ["Y", "PY", "PN", "N", "NI"] as const;

export const GENERIC_TOOL_NAME = "Generic Risk of Bias Tool";

export const GENERIC_JUDGMENT_SCALE = [
  { value: "low", label: "Low risk", color: "#16a34a", severity: 1 },
  { value: "some_concerns", label: "Some concerns", color: "#d97706", severity: 2 },
  { value: "high", label: "High risk", color: "#dc2626", severity: 3 },
  { value: "unclear", label: "Unclear", color: "#64748b", severity: 4 },
  { value: "not_applicable", label: "Not applicable", color: "#94a3b8", severity: 5 },
];

const GENERIC_DOMAINS: { name: string; guidance: string; questions: string[] }[] = [
  {
    name: "Selection bias",
    guidance: "Systematic differences between comparison groups at baseline.",
    questions: [
      "Was the allocation sequence adequately generated (or were groups otherwise comparable at baseline)?",
      "Was allocation adequately concealed from those enrolling participants?",
    ],
  },
  {
    name: "Performance bias",
    guidance: "Systematic differences in the care provided apart from the intervention under study.",
    questions: [
      "Were participants blinded to the intervention they received?",
      "Were personnel delivering the intervention blinded, or was care standardized across groups?",
    ],
  },
  {
    name: "Detection bias",
    guidance: "Systematic differences in how outcomes were ascertained between groups.",
    questions: [
      "Were outcome assessors blinded to intervention status?",
      "Were outcomes measured with comparable methods and timing across groups?",
    ],
  },
  {
    name: "Attrition bias",
    guidance: "Systematic differences due to withdrawals or incomplete outcome data.",
    questions: [
      "Were outcome data available for all, or nearly all, randomized/enrolled participants?",
      "Were reasons for missing outcome data similar across groups?",
    ],
  },
  {
    name: "Reporting bias",
    guidance: "Selective reporting of outcomes or analyses.",
    questions: [
      "Were all pre-specified outcomes reported in the results?",
      "Is the report free of selective reporting of favourable analyses or subgroups?",
    ],
  },
];

// Idempotent (findFirst by name+isBuiltin). Safe to call from seed scripts and tests.
export async function ensureBuiltinGenericTool(client: Tx = prisma) {
  const existing = await client.riskOfBiasTool.findFirst({
    where: { name: GENERIC_TOOL_NAME, isBuiltin: true, projectId: null },
    include: { domains: { orderBy: { order: "asc" }, include: { questions: true } } },
  });
  if (existing) return existing;

  const tool = await client.riskOfBiasTool.create({
    data: {
      projectId: null,
      name: GENERIC_TOOL_NAME,
      description:
        "A generic domain-based risk of bias tool covering the five classic bias domains. " +
        "Clone it into a project to customize.",
      isBuiltin: true,
      status: "PUBLISHED",
      judgmentScale: GENERIC_JUDGMENT_SCALE,
    },
  });
  for (const [i, domain] of GENERIC_DOMAINS.entries()) {
    await client.riskOfBiasDomain.create({
      data: {
        toolId: tool.id,
        name: domain.name,
        guidance: domain.guidance,
        order: i,
        questions: {
          create: domain.questions.map((text, j) => ({
            text,
            order: j,
            allowedAnswers: [...DEFAULT_ALLOWED_ANSWERS],
          })),
        },
      },
    });
  }
  return client.riskOfBiasTool.findFirstOrThrow({
    where: { id: tool.id },
    include: { domains: { orderBy: { order: "asc" }, include: { questions: true } } },
  });
}
