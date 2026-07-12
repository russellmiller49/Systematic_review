// Standard built-in RoB tool catalog (RoB 2, ROBINS-I, QUADAS-2, NOS, JBI, AMSTAR 2) —
// idempotent seeding, structure fidelity to the definitions, catalog visibility, clone
// into a project, and per-tool judgment/answer validation against each custom scale.
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as rob from "@/server/services/rob";
import {
  ensureBuiltinStandardTools,
  ROB2_DEF,
  ROBINS_I_DEF,
  STANDARD_TOOL_DEFS,
} from "@/server/services/rob/standard-tools";
import { resetDb } from "../db-utils";
import { createTestOrg, createTestProject, createTestUser } from "../factories";

const ctx = (userId: string) => ({ userId });

async function expectAppError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    expect.fail(`expected AppError(${code}) but call succeeded`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    expect(err.code).toBe(code);
  }
}

let owner: { id: string };
let project: { id: string };

beforeAll(async () => {
  await resetDb();
  owner = await createTestUser({ name: "Owner" });
  const org = await createTestOrg(owner.id);
  project = await createTestProject(org.id, owner.id);
});

describe("ensureBuiltinStandardTools", () => {
  it("seeds all six instruments idempotently", async () => {
    const first = await ensureBuiltinStandardTools();
    const second = await ensureBuiltinStandardTools();
    expect(first.map((t) => t.id)).toEqual(second.map((t) => t.id));
    const names = await prisma.riskOfBiasTool.findMany({
      where: { isBuiltin: true, projectId: null, name: { not: "Generic Risk of Bias Tool" } },
      select: { name: true, status: true },
    });
    expect(names.map((t) => t.name).sort()).toEqual(
      STANDARD_TOOL_DEFS.map((d) => d.name).sort(),
    );
    expect(names.every((t) => t.status === "PUBLISHED")).toBe(true);
  });

  it("materializes each definition's structure exactly (domains, questions, answers)", async () => {
    const tools = await ensureBuiltinStandardTools();
    for (const [i, def] of STANDARD_TOOL_DEFS.entries()) {
      const tool = tools[i]!;
      expect(tool.name).toBe(def.name);
      expect(tool.domains.map((d) => d.name)).toEqual(def.domains.map((d) => d.name));
      def.domains.forEach((domainDef, d) => {
        const domain = tool.domains[d]!;
        expect(domain.questions.map((q) => q.text)).toEqual(
          domainDef.questions.map((q) => q.text),
        );
        domainDef.questions.forEach((questionDef, q) => {
          const expected = questionDef.allowedAnswers ?? def.defaultAllowedAnswers;
          expect(domain.questions[q]!.allowedAnswers).toEqual([...(expected ?? [])]);
        });
      });
    }
  });

  it("sanity-checks the published instruments' shapes", async () => {
    const tools = await ensureBuiltinStandardTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("RoB 2")!.domains).toHaveLength(5);
    expect(byName.get("RoB 2")!.domains.map((d) => d.questions.length)).toEqual([3, 7, 4, 5, 3]);
    expect(byName.get("ROBINS-I")!.domains).toHaveLength(7);
    expect(byName.get("QUADAS-2")!.domains).toHaveLength(4);
    expect(byName.get("Newcastle-Ottawa Scale (cohort studies)")!.domains).toHaveLength(3);
    expect(byName.get("JBI Checklist for Randomized Controlled Trials")!.domains).toHaveLength(5);
    const amstar = byName.get("AMSTAR 2")!;
    expect(amstar.domains).toHaveLength(1);
    expect(amstar.domains[0]!.questions).toHaveLength(16);
  });

  it("shows the catalog to any session and inside project tool lists", async () => {
    const tools = await ensureBuiltinStandardTools();
    const catalog = await rob.listBuiltinTools(ctx(owner.id));
    const projectList = await rob.listProjectTools(ctx(owner.id), project.id);
    for (const tool of tools) {
      expect(catalog.map((t) => t.id)).toContain(tool.id);
      expect(projectList.map((t) => t.id)).toContain(tool.id);
    }
  });
});

describe("cloning and using a standard instrument", () => {
  it("clones RoB 2 with full structure, custom scale and NA answer variants", async () => {
    const [rob2] = await ensureBuiltinStandardTools();
    const clone = await rob.cloneTool(ctx(owner.id), project.id, rob2!.id);
    expect(clone.isBuiltin).toBe(false);
    expect(clone.projectId).toBe(project.id);
    expect(clone.status).toBe("DRAFT");
    expect(clone.judgmentScale).toEqual(ROB2_DEF.judgmentScale);

    const structure = await prisma.riskOfBiasTool.findFirstOrThrow({
      where: { id: clone.id },
      include: {
        domains: {
          orderBy: { order: "asc" },
          include: { questions: { orderBy: { order: "asc" } } },
        },
      },
    });
    expect(structure.domains.map((d) => d.name)).toEqual(ROB2_DEF.domains.map((d) => d.name));
    // Conditional signaling questions carry the NA answer option through the clone.
    const q23 = structure.domains[1]!.questions[2]!;
    expect(q23.text).toContain("2.3");
    expect(q23.allowedAnswers).toContain("NA");
  });

  it("validates judgments and answers against the cloned tool's own scale", async () => {
    const robinsBuiltin = (await ensureBuiltinStandardTools()).find(
      (t) => t.name === ROBINS_I_DEF.name,
    )!;
    const clone = await rob.cloneTool(ctx(owner.id), project.id, robinsBuiltin.id);
    await rob.publishTool(ctx(owner.id), project.id, clone.id);
    const structure = await prisma.riskOfBiasTool.findFirstOrThrow({
      where: { id: clone.id },
      include: {
        domains: {
          orderBy: { order: "asc" },
          include: { questions: { orderBy: { order: "asc" } } },
        },
      },
    });
    const study = await prisma.study.create({
      data: { projectId: project.id, label: "ROBINS study", createdById: owner.id },
    });

    const me = ctx(owner.id); // project.edit → implicit self-assignment (R15)
    const assessment = await rob.startAssessment(me, project.id, study.id, {
      toolId: clone.id,
    });

    const confounding = structure.domains[0]!;
    // ROBINS-I scale accepts "serious"…
    await rob.putJudgment(me, project.id, assessment.id, confounding.id, {
      judgment: "serious",
    });
    // …but not RoB 2's "some_concerns".
    await expectAppError(
      rob.putJudgment(me, project.id, assessment.id, confounding.id, {
        judgment: "some_concerns",
      }),
      "VALIDATION",
    );

    // Signaling answers honor each question's allowedAnswers (1.2 is conditional → NA ok).
    const q12 = confounding.questions[1]!;
    await rob.putResponse(me, project.id, assessment.id, q12.id, { answer: "NA" });
    await expectAppError(
      rob.putResponse(me, project.id, assessment.id, q12.id, { answer: "Maybe" }),
      "VALIDATION",
    );
  });
});
