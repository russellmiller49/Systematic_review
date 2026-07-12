// Built-in risk-of-bias tools — seeded once, shared by every project (projectId null,
// isBuiltin true, PUBLISHED). This file is the seeding mechanism + the generic tool;
// the standard published instruments (RoB 2, ROBINS-I, …) live in ./standard-tools.ts.
// Exported for prisma/seed.ts.

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

export interface BuiltinQuestionDef {
  text: string;
  guidance?: string;
  allowedAnswers?: readonly string[];
}

export interface BuiltinDomainDef {
  name: string;
  guidance?: string;
  questions: BuiltinQuestionDef[];
}

export interface BuiltinToolDef {
  name: string; // stable identity — the idempotency key for seeding
  description: string;
  judgmentScale: { value: string; label: string; color: string; severity: number }[];
  defaultAllowedAnswers?: readonly string[];
  domains: BuiltinDomainDef[];
}

const GENERIC_TOOL_DEF: BuiltinToolDef = {
  name: GENERIC_TOOL_NAME,
  description:
    "A generic domain-based risk of bias tool covering the five classic bias domains. " +
    "Clone it into a project to customize.",
  judgmentScale: GENERIC_JUDGMENT_SCALE,
  domains: [
    {
      name: "Selection bias",
      guidance: "Systematic differences between comparison groups at baseline.",
      questions: [
        {
          text: "Was the allocation sequence adequately generated (or were groups otherwise comparable at baseline)?",
        },
        { text: "Was allocation adequately concealed from those enrolling participants?" },
      ],
    },
    {
      name: "Performance bias",
      guidance:
        "Systematic differences in the care provided apart from the intervention under study.",
      questions: [
        { text: "Were participants blinded to the intervention they received?" },
        {
          text: "Were personnel delivering the intervention blinded, or was care standardized across groups?",
        },
      ],
    },
    {
      name: "Detection bias",
      guidance: "Systematic differences in how outcomes were ascertained between groups.",
      questions: [
        { text: "Were outcome assessors blinded to intervention status?" },
        { text: "Were outcomes measured with comparable methods and timing across groups?" },
      ],
    },
    {
      name: "Attrition bias",
      guidance: "Systematic differences due to withdrawals or incomplete outcome data.",
      questions: [
        {
          text: "Were outcome data available for all, or nearly all, randomized/enrolled participants?",
        },
        { text: "Were reasons for missing outcome data similar across groups?" },
      ],
    },
    {
      name: "Reporting bias",
      guidance: "Selective reporting of outcomes or analyses.",
      questions: [
        { text: "Were all pre-specified outcomes reported in the results?" },
        {
          text: "Is the report free of selective reporting of favourable analyses or subgroups?",
        },
      ],
    },
  ],
};

/**
 * Idempotently seed one built-in tool (findFirst by name+isBuiltin — the tool's name is
 * its stable identity; existing rows are never restructured). Safe to call from seed
 * scripts and tests.
 */
export async function ensureBuiltinTool(def: BuiltinToolDef, client: Tx = prisma) {
  const existing = await client.riskOfBiasTool.findFirst({
    where: { name: def.name, isBuiltin: true, projectId: null },
    include: {
      domains: {
        orderBy: { order: "asc" },
        include: { questions: { orderBy: { order: "asc" } } },
      },
    },
  });
  if (existing) return existing;

  const defaultAnswers = def.defaultAllowedAnswers ?? DEFAULT_ALLOWED_ANSWERS;
  const tool = await client.riskOfBiasTool.create({
    data: {
      projectId: null,
      name: def.name,
      description: def.description,
      isBuiltin: true,
      status: "PUBLISHED",
      judgmentScale: def.judgmentScale,
    },
  });
  for (const [i, domain] of def.domains.entries()) {
    await client.riskOfBiasDomain.create({
      data: {
        toolId: tool.id,
        name: domain.name,
        guidance: domain.guidance ?? null,
        order: i,
        questions: {
          create: domain.questions.map((q, j) => ({
            text: q.text,
            guidance: q.guidance ?? null,
            order: j,
            allowedAnswers: [...(q.allowedAnswers ?? defaultAnswers)],
          })),
        },
      },
    });
  }
  return client.riskOfBiasTool.findFirstOrThrow({
    where: { id: tool.id },
    include: {
      domains: {
        orderBy: { order: "asc" },
        include: { questions: { orderBy: { order: "asc" } } },
      },
    },
  });
}

/** The built-in "Generic Risk of Bias Tool". Idempotent. */
export async function ensureBuiltinGenericTool(client: Tx = prisma) {
  return ensureBuiltinTool(GENERIC_TOOL_DEF, client);
}
