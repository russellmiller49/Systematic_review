// Risk of bias integration tests — services against real Postgres (srb_test_rob).
// Covers: builder + publish + freeze-once-assessed (clone path), builtin immutability,
// per-tool judgment validation, dual-assessment conflict detection (domain + single overall),
// adjudication + post-adjudication lock, blind assessments GET, idempotent builtin seeding.
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as rob from "@/server/services/rob";
import { ensureBuiltinGenericTool } from "@/server/services/rob/builtin";
import { resetDb } from "../db-utils";
import {
  addOrgMember,
  addProjectMember,
  createTestOrg,
  createTestProject,
  createTestUser,
  uniq,
} from "../factories";

const ctx = (userId: string) => ({ userId });

async function expectAppError(promise: Promise<unknown>, code: string, contains?: string) {
  try {
    await promise;
    expect.fail(`expected AppError(${code}) but call succeeded`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    expect(err.code).toBe(code);
    if (contains) expect(err.message).toContain(contains);
  }
}

const SCALE = [
  { value: "low", label: "Low risk" },
  { value: "high", label: "High risk" },
];

type Team = {
  owner: { id: string };
  assessor1: { id: string };
  assessor2: { id: string };
  assessor3: { id: string };
  adjudicator: { id: string };
  observer: { id: string };
  project: { id: string };
  org: { id: string };
};

let team: Team;
let otherProject: { id: string };

async function createStudy(label = uniq("Study")) {
  return prisma.study.create({
    data: { projectId: team.project.id, label, createdById: team.owner.id },
  });
}

// Published 2-value-scale tool with `domainCount` domains, via the real service path.
async function makePublishedTool(domainCount = 2) {
  const owner = ctx(team.owner.id);
  const tool = await rob.createTool(owner, team.project.id, {
    name: uniq("Tool"),
    judgmentScale: SCALE,
  });
  const domains = [];
  for (let i = 0; i < domainCount; i++) {
    domains.push(
      await rob.createDomain(owner, team.project.id, tool.id, { name: `Domain ${i + 1}` }),
    );
  }
  await rob.publishTool(owner, team.project.id, tool.id);
  return { tool, domains };
}

async function assign(toolId: string, studyIds: string[], assessorIds: string[]) {
  return rob.createAssignments(ctx(team.owner.id), team.project.id, {
    toolId,
    studyIds,
    assessorIds,
  });
}

// Start + judge every domain + optionally set overall + complete, as one assessor.
async function assessAndComplete(
  userId: string,
  toolId: string,
  studyId: string,
  judgments: Record<string, string>,
  overall?: string,
) {
  const c = ctx(userId);
  const assessment = await rob.startAssessment(c, team.project.id, studyId, { toolId });
  for (const [domainId, judgment] of Object.entries(judgments)) {
    await rob.putJudgment(c, team.project.id, assessment.id, domainId, { judgment });
  }
  if (overall) {
    await rob.updateAssessment(c, team.project.id, assessment.id, {
      overallJudgment: overall,
    });
  }
  return rob.completeAssessment(c, team.project.id, assessment.id);
}

beforeAll(async () => {
  await resetDb();
  const owner = await createTestUser({ name: "Owner" });
  const assessor1 = await createTestUser({ name: "Assessor One" });
  const assessor2 = await createTestUser({ name: "Assessor Two" });
  const assessor3 = await createTestUser({ name: "Assessor Three" });
  const adjudicator = await createTestUser({ name: "Adjudicator" });
  const observer = await createTestUser({ name: "Observer" });
  const org = await createTestOrg(owner.id);
  for (const u of [assessor1, assessor2, assessor3, adjudicator, observer]) {
    await addOrgMember(org.id, u.id);
  }
  const project = await createTestProject(org.id, owner.id);
  await addProjectMember(project.id, assessor1.id, ["EXTRACTOR"]);
  await addProjectMember(project.id, assessor2.id, ["EXTRACTOR"]);
  await addProjectMember(project.id, assessor3.id, ["EXTRACTOR"]);
  await addProjectMember(project.id, adjudicator.id, ["ADJUDICATOR"]);
  await addProjectMember(project.id, observer.id, ["OBSERVER"]);
  team = { owner, assessor1, assessor2, assessor3, adjudicator, observer, project, org };
  otherProject = await createTestProject(org.id, owner.id);
});

describe("tool builder & publishing", () => {
  it("creates a DRAFT tool, builds structure, publishes (audited)", async () => {
    const owner = ctx(team.owner.id);
    const tool = await rob.createTool(owner, team.project.id, {
      name: "Custom RoB",
      description: "test tool",
      judgmentScale: SCALE,
    });
    expect(tool.status).toBe("DRAFT");
    expect(tool.isBuiltin).toBe(false);
    expect(tool.projectId).toBe(team.project.id);

    // cannot publish with zero domains
    await expectAppError(
      rob.publishTool(owner, team.project.id, tool.id),
      "INVALID_STATE",
    );

    const domain = await rob.createDomain(owner, team.project.id, tool.id, {
      name: "Randomization",
      guidance: "How was the sequence generated?",
    });
    const q1 = await rob.createQuestion(owner, team.project.id, tool.id, domain.id, {
      text: "Was the allocation sequence random?",
    });
    expect(q1.allowedAnswers).toEqual(["Y", "PY", "PN", "N", "NI"]);

    const q2 = await rob.createQuestion(owner, team.project.id, tool.id, domain.id, {
      text: "Temporary question",
      allowedAnswers: ["yes", "no"],
    });
    await rob.updateQuestion(owner, team.project.id, tool.id, domain.id, q2.id, {
      text: "Renamed question",
    });
    await rob.deleteQuestion(owner, team.project.id, tool.id, domain.id, q2.id);
    await rob.updateDomain(owner, team.project.id, tool.id, domain.id, {
      name: "Randomization process",
    });

    const published = await rob.publishTool(owner, team.project.id, tool.id);
    expect(published.status).toBe("PUBLISHED");
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: tool.id, action: "rob.tool.published" },
    });
    // publishing twice is rejected
    await expectAppError(rob.publishTool(owner, team.project.id, tool.id), "INVALID_STATE");
  });

  it("validates the judgment scale shape via the exported zod schema", () => {
    expect(
      rob.createToolSchema.safeParse({
        name: "Bad scale",
        judgmentScale: [{ value: "Low Risk", label: "x" }, { value: "ok", label: "y" }],
      }).success,
    ).toBe(false);
    expect(
      rob.createToolSchema.safeParse({
        name: "Too few",
        judgmentScale: [{ value: "only_one", label: "x" }],
      }).success,
    ).toBe(false);
    expect(
      rob.createToolSchema.safeParse({
        name: "Fine",
        judgmentScale: SCALE,
      }).success,
    ).toBe(true);
  });

  it("members without rob.tools cannot build", async () => {
    await expectAppError(
      rob.createTool(ctx(team.assessor1.id), team.project.id, {
        name: uniq("Tool"),
        judgmentScale: SCALE,
      }),
      "FORBIDDEN",
    );
  });

  it("freezes structure once any assessment exists; clone path works", async () => {
    const owner = ctx(team.owner.id);
    const { tool, domains } = await makePublishedTool(1);
    const study = await createStudy();
    await assign(tool.id, [study.id], [team.assessor1.id]);
    await rob.startAssessment(ctx(team.assessor1.id), team.project.id, study.id, {
      toolId: tool.id,
    });

    await expectAppError(
      rob.createDomain(owner, team.project.id, tool.id, { name: "New domain" }),
      "INVALID_STATE",
      "tool is in use — clone it to modify",
    );
    await expectAppError(
      rob.updateDomain(owner, team.project.id, tool.id, domains[0]!.id, { name: "X" }),
      "INVALID_STATE",
    );

    const clone = await rob.cloneTool(owner, team.project.id, tool.id);
    expect(clone.status).toBe("DRAFT");
    expect(clone.isBuiltin).toBe(false);
    expect(clone.projectId).toBe(team.project.id);
    expect(clone.domains).toHaveLength(1);
    expect(clone.domains[0]!.name).toBe(domains[0]!.name);

    const cloneAudit = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: clone.id, action: "rob.tool.created" },
    });
    expect(cloneAudit.metadata).toMatchObject({ clonedFrom: tool.id });

    // the clone is editable again
    await rob.createDomain(owner, team.project.id, clone.id, { name: "Extra domain" });
  });
});

describe("builtin generic tool", () => {
  it("ensureBuiltinGenericTool is idempotent and seeds 5 domains x 2 questions", async () => {
    const first = await ensureBuiltinGenericTool();
    const second = await ensureBuiltinGenericTool();
    expect(second.id).toBe(first.id);
    const rows = await prisma.riskOfBiasTool.count({
      where: { isBuiltin: true, projectId: null, name: first.name },
    });
    expect(rows).toBe(1);
    expect(first.status).toBe("PUBLISHED");
    expect(first.domains).toHaveLength(5);
    expect(first.domains.flatMap((d) => d.questions)).toHaveLength(10);
  });

  it("is listed for sessions and inside projects", async () => {
    const builtin = await ensureBuiltinGenericTool();
    const catalog = await rob.listBuiltinTools(ctx(team.assessor1.id));
    expect(catalog.map((t) => t.id)).toContain(builtin.id);
    const projectList = await rob.listProjectTools(ctx(team.observer.id), team.project.id);
    expect(projectList.map((t) => t.id)).toContain(builtin.id);
  });

  it("is not mutable via project routes (NOT_FOUND) but IS clonable", async () => {
    const owner = ctx(team.owner.id);
    const builtin = await ensureBuiltinGenericTool();

    await expectAppError(
      rob.createDomain(owner, team.project.id, builtin.id, { name: "Nope" }),
      "NOT_FOUND",
    );
    await expectAppError(rob.publishTool(owner, team.project.id, builtin.id), "NOT_FOUND");
    await expectAppError(
      rob.updateDomain(owner, team.project.id, builtin.id, builtin.domains[0]!.id, {
        name: "Nope",
      }),
      "NOT_FOUND",
    );

    const clone = await rob.cloneTool(owner, team.project.id, builtin.id);
    expect(clone.projectId).toBe(team.project.id);
    expect(clone.isBuiltin).toBe(false);
    expect(clone.status).toBe("DRAFT");
    expect(clone.domains).toHaveLength(5);
    expect(clone.domains.flatMap((d) => d.questions)).toHaveLength(10);
  });
});

describe("assignments (R15)", () => {
  it("bulk-assigns studies x assessors, skips existing, audits each", async () => {
    const { tool } = await makePublishedTool(1);
    const s1 = await createStudy();
    const s2 = await createStudy();

    const result = await assign(tool.id, [s1.id, s2.id], [team.assessor1.id, team.assessor2.id]);
    expect(result.created).toHaveLength(4);
    expect(result.skipped).toBe(0);

    const again = await assign(tool.id, [s1.id, s2.id], [team.assessor1.id, team.assessor2.id]);
    expect(again.created).toHaveLength(0);
    expect(again.skipped).toBe(4);

    const audits = await prisma.auditEvent.count({
      where: { action: "rob.assigned", newValue: { path: ["toolId"], equals: tool.id } },
    });
    expect(audits).toBe(4);

    const mine = await rob.listAssignments(ctx(team.assessor1.id), team.project.id, {
      mine: true,
    });
    expect(mine.filter((a) => a.tool.id === tool.id)).toHaveLength(2);
    expect(mine.every((a) => a.assessorId === team.assessor1.id)).toBe(true);

    // listing everyone's assignments needs project.edit
    await expectAppError(
      rob.listAssignments(ctx(team.assessor1.id), team.project.id, {}),
      "FORBIDDEN",
    );
    const all = await rob.listAssignments(ctx(team.owner.id), team.project.id, {});
    expect(all.length).toBeGreaterThanOrEqual(4);
  });

  it("rejects draft tools, foreign studies, and non-assessing assessors", async () => {
    const owner = ctx(team.owner.id);
    const draft = await rob.createTool(owner, team.project.id, {
      name: uniq("Draft"),
      judgmentScale: SCALE,
    });
    const study = await createStudy();
    await expectAppError(
      assign(draft.id, [study.id], [team.assessor1.id]),
      "INVALID_STATE",
    );

    const { tool } = await makePublishedTool(1);
    const foreignStudy = await prisma.study.create({
      data: { projectId: otherProject.id, label: uniq("Foreign"), createdById: team.owner.id },
    });
    await expectAppError(
      assign(tool.id, [foreignStudy.id], [team.assessor1.id]),
      "NOT_FOUND",
    );

    // OBSERVER lacks rob.assess; strangers are not members at all
    await expectAppError(assign(tool.id, [study.id], [team.observer.id]), "VALIDATION");
    const stranger = await createTestUser();
    await expectAppError(assign(tool.id, [study.id], [stranger.id]), "VALIDATION");

    // only project.edit can assign
    await expectAppError(
      rob.createAssignments(ctx(team.assessor1.id), team.project.id, {
        toolId: tool.id,
        studyIds: [study.id],
        assessorIds: [team.assessor2.id],
      }),
      "FORBIDDEN",
    );
  });
});

describe("assessments, judgments & responses", () => {
  it("requires an assignment unless the caller has project.edit (implicit self-assign)", async () => {
    const { tool } = await makePublishedTool(1);
    const study = await createStudy();

    await expectAppError(
      rob.startAssessment(ctx(team.assessor3.id), team.project.id, study.id, {
        toolId: tool.id,
      }),
      "FORBIDDEN",
    );

    // owner self-assigns implicitly — the assignment row is materialized
    const ownersAssessment = await rob.startAssessment(
      ctx(team.owner.id),
      team.project.id,
      study.id,
      { toolId: tool.id },
    );
    expect(ownersAssessment.status).toBe("IN_PROGRESS");
    const implicit = await prisma.riskOfBiasAssignment.findUniqueOrThrow({
      where: {
        toolId_studyId_assessorId: {
          toolId: tool.id,
          studyId: study.id,
          assessorId: team.owner.id,
        },
      },
    });
    expect(implicit.status).toBe("PENDING");

    // starting again returns the same assessment
    const again = await rob.startAssessment(ctx(team.owner.id), team.project.id, study.id, {
      toolId: tool.id,
    });
    expect(again.id).toBe(ownersAssessment.id);

    await assign(tool.id, [study.id], [team.assessor1.id]);
    const assessment = await rob.startAssessment(
      ctx(team.assessor1.id),
      team.project.id,
      study.id,
      { toolId: tool.id },
    );
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: assessment.id, action: "rob.assessment.started" },
    });
  });

  it("validates judgments against the owning tool's scale; custom 2-value scale end-to-end", async () => {
    const a1 = ctx(team.assessor1.id);
    const { tool, domains } = await makePublishedTool(1);
    const domain = domains[0]!;
    const study = await createStudy();
    await assign(tool.id, [study.id], [team.assessor1.id]);
    const assessment = await rob.startAssessment(a1, team.project.id, study.id, {
      toolId: tool.id,
    });

    // bad judgment value → VALIDATION (R2: strings validated per tool)
    await expectAppError(
      rob.putJudgment(a1, team.project.id, assessment.id, domain.id, {
        judgment: "some_concerns",
      }),
      "VALIDATION",
    );

    // domain from a different tool → NOT_FOUND
    const other = await makePublishedTool(1);
    await expectAppError(
      rob.putJudgment(a1, team.project.id, assessment.id, other.domains[0]!.id, {
        judgment: "low",
      }),
      "NOT_FOUND",
    );

    const judgment = await rob.putJudgment(a1, team.project.id, assessment.id, domain.id, {
      judgment: "low",
      support: "quote from methods",
    });
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: judgment.id, action: "rob.judgment.created" },
    });

    // update in place → audited with previousValue
    await rob.putJudgment(a1, team.project.id, assessment.id, domain.id, { judgment: "high" });
    const updEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: judgment.id, action: "rob.judgment.updated" },
    });
    expect(updEvent.previousValue).toMatchObject({
      judgment: "low",
      support: "quote from methods",
    });

    // only the owner of the assessment can write to it
    await expectAppError(
      rob.putJudgment(ctx(team.owner.id), team.project.id, assessment.id, domain.id, {
        judgment: "low",
      }),
      "FORBIDDEN",
    );

    // overall judgment: validated against the scale too
    await expectAppError(
      rob.updateAssessment(a1, team.project.id, assessment.id, { overallJudgment: "meh" }),
      "VALIDATION",
    );
    await rob.updateAssessment(a1, team.project.id, assessment.id, { overallJudgment: "high" });

    const completed = await rob.completeAssessment(a1, team.project.id, assessment.id);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.completedAt).not.toBeNull();
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: assessment.id, action: "rob.assessment.completed" },
    });
    // assignment flipped to COMPLETED
    const assignment = await prisma.riskOfBiasAssignment.findUniqueOrThrow({
      where: {
        toolId_studyId_assessorId: {
          toolId: tool.id,
          studyId: study.id,
          assessorId: team.assessor1.id,
        },
      },
    });
    expect(assignment.status).toBe("COMPLETED");

    // completed assessments are immutable
    await expectAppError(
      rob.putJudgment(a1, team.project.id, assessment.id, domain.id, { judgment: "low" }),
      "INVALID_STATE",
    );
  });

  it("signaling responses validate against allowedAnswers (no audit by design)", async () => {
    const a1 = ctx(team.assessor1.id);
    const owner = ctx(team.owner.id);
    const tool = await rob.createTool(owner, team.project.id, {
      name: uniq("Tool"),
      judgmentScale: SCALE,
    });
    const domain = await rob.createDomain(owner, team.project.id, tool.id, { name: "D1" });
    const question = await rob.createQuestion(owner, team.project.id, tool.id, domain.id, {
      text: "Was randomization adequate?",
    });
    await rob.publishTool(owner, team.project.id, tool.id);
    const study = await createStudy();
    await assign(tool.id, [study.id], [team.assessor1.id]);
    const assessment = await rob.startAssessment(a1, team.project.id, study.id, {
      toolId: tool.id,
    });

    await expectAppError(
      rob.putResponse(a1, team.project.id, assessment.id, question.id, { answer: "MAYBE" }),
      "VALIDATION",
    );
    const response = await rob.putResponse(a1, team.project.id, assessment.id, question.id, {
      answer: "Y",
      note: "clearly reported",
    });
    expect(response.answer).toBe("Y");
    const updated = await rob.putResponse(a1, team.project.id, assessment.id, question.id, {
      answer: "PN",
    });
    expect(updated.id).toBe(response.id);
    expect(updated.answer).toBe("PN");
    expect(updated.note).toBe("clearly reported");
  });

  it("complete requires a judgment for EVERY domain (missing names reported)", async () => {
    const a1 = ctx(team.assessor1.id);
    const { tool, domains } = await makePublishedTool(2);
    const study = await createStudy();
    await assign(tool.id, [study.id], [team.assessor1.id]);
    const assessment = await rob.startAssessment(a1, team.project.id, study.id, {
      toolId: tool.id,
    });
    await rob.putJudgment(a1, team.project.id, assessment.id, domains[0]!.id, {
      judgment: "low",
    });
    try {
      await rob.completeAssessment(a1, team.project.id, assessment.id);
      expect.fail("expected VALIDATION");
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      expect(err.code).toBe("VALIDATION");
      expect(err.details).toMatchObject({ missingDomains: [domains[1]!.name] });
    }
  });

  it("blind rule: assessors only list their own; adjudicators/admins see all", async () => {
    const { tool, domains } = await makePublishedTool(1);
    const study = await createStudy();
    await assign(tool.id, [study.id], [team.assessor1.id, team.assessor2.id]);
    await assessAndComplete(team.assessor1.id, tool.id, study.id, {
      [domains[0]!.id]: "low",
    });
    await assessAndComplete(team.assessor2.id, tool.id, study.id, {
      [domains[0]!.id]: "high",
    });

    const forA1 = await rob.listAssessments(ctx(team.assessor1.id), team.project.id, {
      studyId: study.id,
    });
    expect(forA1).toHaveLength(1);
    expect(forA1[0]!.assessorId).toBe(team.assessor1.id);

    const forOwner = await rob.listAssessments(ctx(team.owner.id), team.project.id, {
      studyId: study.id,
    });
    expect(forOwner).toHaveLength(2);

    const forAdjudicator = await rob.listAssessments(ctx(team.adjudicator.id), team.project.id, {
      studyId: study.id,
    });
    expect(forAdjudicator).toHaveLength(2);

    // non-members see nothing at all
    const stranger = await createTestUser();
    await expectAppError(
      rob.listAssessments(ctx(stranger.id), team.project.id, { studyId: study.id }),
      "FORBIDDEN",
    );
  });
});

describe("conflict detection & adjudication", () => {
  it("dual assessment: differing domains open conflicts; overall conflict is single (domainId null)", async () => {
    const { tool, domains } = await makePublishedTool(2);
    const [d1, d2] = [domains[0]!, domains[1]!];
    const study = await createStudy();
    await assign(tool.id, [study.id], [team.assessor1.id, team.assessor2.id]);

    await assessAndComplete(
      team.assessor1.id,
      tool.id,
      study.id,
      { [d1.id]: "low", [d2.id]: "low" },
      "low",
    );
    // one completed assessment → no conflicts yet
    expect(
      await prisma.riskOfBiasConflict.count({ where: { toolId: tool.id, studyId: study.id } }),
    ).toBe(0);

    await assessAndComplete(
      team.assessor2.id,
      tool.id,
      study.id,
      { [d1.id]: "high", [d2.id]: "low" },
      "high",
    );

    const conflicts = await prisma.riskOfBiasConflict.findMany({
      where: { toolId: tool.id, studyId: study.id },
    });
    expect(conflicts).toHaveLength(2);
    const domainConflict = conflicts.find((c) => c.domainId === d1.id);
    const overallConflict = conflicts.find((c) => c.domainId === null);
    expect(domainConflict?.status).toBe("OPEN");
    expect(overallConflict?.status).toBe("OPEN");
    expect(conflicts.find((c) => c.domainId === d2.id)).toBeUndefined();

    const openedAudits = await prisma.auditEvent.count({
      where: {
        action: "rob.conflict.opened",
        newValue: { path: ["studyId"], equals: study.id },
      },
    });
    expect(openedAudits).toBe(2);

    // a third completion re-runs detection — still exactly ONE overall conflict
    await assessAndComplete(
      team.owner.id,
      tool.id,
      study.id,
      { [d1.id]: "low", [d2.id]: "low" },
      "low",
    );
    const overallConflicts = await prisma.riskOfBiasConflict.findMany({
      where: { toolId: tool.id, studyId: study.id, domainId: null },
    });
    expect(overallConflicts).toHaveLength(1);
  });

  it("adjudication resolves the conflict and locks the domain for further judgment writes", async () => {
    const { tool, domains } = await makePublishedTool(1);
    const d1 = domains[0]!;
    const study = await createStudy();
    await assign(tool.id, [study.id], [team.assessor1.id, team.assessor2.id, team.assessor3.id]);
    await assessAndComplete(team.assessor1.id, tool.id, study.id, { [d1.id]: "low" }, "low");
    await assessAndComplete(team.assessor2.id, tool.id, study.id, { [d1.id]: "high" }, "high");

    // adjudicator-only listing, with domain name + each assessor's judgment/support
    await expectAppError(
      rob.listConflicts(ctx(team.assessor1.id), team.project.id, {}),
      "FORBIDDEN",
    );
    const listed = await rob.listConflicts(ctx(team.adjudicator.id), team.project.id, {
      status: "OPEN",
    });
    const domainConflict = listed.find((c) => c.studyId === study.id && c.domainId === d1.id);
    expect(domainConflict).toBeDefined();
    expect(domainConflict!.domainName).toBe(d1.name);
    expect(domainConflict!.assessors.map((a) => a.judgment).sort()).toEqual(["high", "low"]);
    const overall = listed.find((c) => c.studyId === study.id && c.domainId === null);
    expect(overall!.domainName).toBe("Overall");
    expect(overall!.assessors.map((a) => a.judgment).sort()).toEqual(["high", "low"]);

    // adjudicate: judgment must be on the tool's scale, reason required
    await expectAppError(
      rob.adjudicateConflict(ctx(team.adjudicator.id), team.project.id, domainConflict!.id, {
        finalJudgment: "unclear",
        reason: "not on this tool's scale",
      }),
      "VALIDATION",
    );
    const adjudication = await rob.adjudicateConflict(
      ctx(team.adjudicator.id),
      team.project.id,
      domainConflict!.id,
      { finalJudgment: "high", reason: "Methods section confirms inadequate concealment" },
    );
    expect(adjudication.adjudicatorId).toBe(team.adjudicator.id);
    const resolved = await prisma.riskOfBiasConflict.findUniqueOrThrow({
      where: { id: domainConflict!.id },
    });
    expect(resolved.status).toBe("RESOLVED");
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: domainConflict!.id, action: "rob.conflict.adjudicated" },
    });

    // re-adjudication is rejected
    await expectAppError(
      rob.adjudicateConflict(ctx(team.adjudicator.id), team.project.id, domainConflict!.id, {
        finalJudgment: "low",
        reason: "changed my mind",
      }),
      "INVALID_STATE",
    );

    // POST-ADJUDICATION LOCK: a third assessor cannot judge the adjudicated domain anymore
    const a3 = ctx(team.assessor3.id);
    const third = await rob.startAssessment(a3, team.project.id, study.id, { toolId: tool.id });
    await expectAppError(
      rob.putJudgment(a3, team.project.id, third.id, d1.id, { judgment: "low" }),
      "INVALID_STATE",
    );
    // ...and the overall stays writable while ITS conflict is merely OPEN? No — the overall
    // conflict here is still OPEN (not RESOLVED), so overall writes remain allowed.
    await rob.updateAssessment(a3, team.project.id, third.id, { overallJudgment: "low" });
  });

  it("adjudication is tenant-scoped and adjudicator-gated", async () => {
    const { tool, domains } = await makePublishedTool(1);
    const study = await createStudy();
    await assign(tool.id, [study.id], [team.assessor1.id, team.assessor2.id]);
    await assessAndComplete(team.assessor1.id, tool.id, study.id, { [domains[0]!.id]: "low" });
    await assessAndComplete(team.assessor2.id, tool.id, study.id, { [domains[0]!.id]: "high" });
    const conflict = await prisma.riskOfBiasConflict.findFirstOrThrow({
      where: { toolId: tool.id, studyId: study.id },
    });

    await expectAppError(
      rob.adjudicateConflict(ctx(team.assessor1.id), team.project.id, conflict.id, {
        finalJudgment: "low",
        reason: "I am not allowed to do this",
      }),
      "FORBIDDEN",
    );
    // wrong project in the path → NOT_FOUND (R9)
    await expectAppError(
      rob.adjudicateConflict(ctx(team.owner.id), otherProject.id, conflict.id, {
        finalJudgment: "low",
        reason: "wrong tenant",
      }),
      "NOT_FOUND",
    );
  });

  it("voids an OPEN conflict when judgments come to agree", async () => {
    const { tool, domains } = await makePublishedTool(1);
    const d1 = domains[0]!;
    const study = await createStudy();
    await assign(tool.id, [study.id], [team.assessor1.id, team.assessor2.id, team.assessor3.id]);
    await assessAndComplete(team.assessor1.id, tool.id, study.id, { [d1.id]: "low" });
    const second = await assessAndComplete(team.assessor2.id, tool.id, study.id, {
      [d1.id]: "high",
    });
    const conflict = await prisma.riskOfBiasConflict.findFirstOrThrow({
      where: { toolId: tool.id, studyId: study.id, domainId: d1.id, status: "OPEN" },
    });

    // simulate a reopen-style correction: assessor2's judgment now agrees
    await prisma.riskOfBiasJudgment.updateMany({
      where: { assessmentId: second.id, domainId: d1.id },
      data: { judgment: "low" },
    });
    // detection re-runs on the next completion
    await assessAndComplete(team.assessor3.id, tool.id, study.id, { [d1.id]: "low" });
    const voided = await prisma.riskOfBiasConflict.findUniqueOrThrow({
      where: { id: conflict.id },
    });
    expect(voided.status).toBe("VOIDED");
  });
});
