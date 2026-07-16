// AI risk-of-bias integration tests — synchronous suggestion runs against the
// FakeAiProvider, valid/invalid/notFound domain handling, invalid signaling answers
// kept-but-skipped, latest-wins re-runs, the applySuggestion path (server-authoritative
// judgment + responses + audit provenance), builtin-tool support, and permission/guard
// rails. Both assessors see the same suggestions (documented R1 independence tradeoff).
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as aiRob from "@/server/services/ai-rob";
import * as rob from "@/server/services/rob";
import { resetAiProviderForTests, setAiProviderForTests } from "@/server/ai/provider";
import { ROB_PROMPT_VERSION } from "@/server/ai/prompts/rob";
import { getStorage } from "@/server/storage";
import { FakeAiProvider } from "../fake-ai-provider";
import { resetDb } from "../db-utils";
import {
  addOrgMember,
  addProjectMember,
  createProjectWithTeam,
  createTestCitation,
  createTestUser,
  uniq,
} from "../factories";

// Point the lazy storage singleton at a temp dir BEFORE the first storage call.
process.env.STORAGE_DIR = mkdtempSync(path.join(os.tmpdir(), "srb-ai-rob-it-"));

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

async function createPdfFile(projectId: string, uploaderId: string, body = "%PDF-1.4 test body") {
  const key = `${projectId}/${uniq("pdf")}.pdf`;
  const bytes = Buffer.from(body);
  await getStorage().put(key, bytes);
  return prisma.fullTextFile.create({
    data: {
      projectId,
      storageKey: key,
      filename: `${uniq("paper")}.pdf`,
      contentType: "application/pdf",
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      uploadedById: uploaderId,
    },
  });
}

const SCALE = [
  { value: "low", label: "Low risk" },
  { value: "some_concerns", label: "Some concerns" },
  { value: "high", label: "High risk" },
];

async function setup() {
  const team = await createProjectWithTeam();
  const assessor = await createTestUser({ name: "Assessor" });
  const assessor2 = await createTestUser({ name: "Assessor Two" });
  const observer = await createTestUser({ name: "Observer" });
  await addOrgMember(team.org.id, assessor.id);
  await addOrgMember(team.org.id, assessor2.id);
  await addOrgMember(team.org.id, observer.id);
  await addProjectMember(team.project.id, assessor.id, ["EXTRACTOR"]); // holds rob.assess
  await addProjectMember(team.project.id, assessor2.id, ["EXTRACTOR"]);
  await addProjectMember(team.project.id, observer.id, ["OBSERVER"]);

  const tool = await prisma.riskOfBiasTool.create({
    data: {
      projectId: team.project.id,
      name: "Test RoB tool",
      description: "Answer codes: Y yes / N no / NI no information.",
      isBuiltin: false,
      status: "PUBLISHED",
      judgmentScale: SCALE,
      createdById: team.owner.id,
      domains: {
        create: [
          {
            name: "Randomization",
            guidance: "Consider sequence generation.",
            order: 0,
            questions: {
              create: [
                { text: "1.1 Random sequence?", order: 0, allowedAnswers: ["Y", "PY", "PN", "N", "NI"] },
                { text: "1.2 Concealed?", order: 1, allowedAnswers: ["Y", "N", "NA"] },
              ],
            },
          },
          { name: "Missing data", order: 1 },
          { name: "Outcome measurement", order: 2 },
        ],
      },
    },
    include: {
      domains: { orderBy: { order: "asc" }, include: { questions: { orderBy: { order: "asc" } } } },
    },
  });

  const citation = await createTestCitation(team.project.id);
  const study = await prisma.study.create({
    data: {
      projectId: team.project.id,
      label: "Smith 2020",
      createdById: team.owner.id,
      reportLinks: { create: { citationId: citation.id, isPrimaryReport: true } },
    },
  });
  const file = await createPdfFile(team.project.id, team.owner.id);
  await prisma.citationFullTextLink.create({
    data: { citationId: citation.id, fileId: file.id },
  });

  const [d1, d2, d3] = tool.domains;
  const [q1, q2] = d1!.questions;
  return { ...team, assessor, assessor2, observer, tool, citation, study, file, d1: d1!, d2: d2!, d3: d3!, q1: q1!, q2: q2! };
}

type Setup = Awaited<ReturnType<typeof setup>>;

// d1: applyable (one valid + one invalid answer + one unknown question id);
// d2: judgment outside the scale → invalidReason; d3: missing from the response → notFound.
function mixedResult(s: Setup) {
  return {
    domains: [
      {
        domainId: s.d1.id,
        assessable: true,
        judgment: "low",
        rationale: "Central randomization with concealed allocation.",
        confidence: 0.9,
        quotes: [
          { text: "computer-generated sequence", page: 3 },
          { text: "sealed opaque envelopes", page: null },
        ],
        answers: [
          { questionId: s.q1.id, answer: "Y", quote: "random sequence", page: 3 },
          { questionId: s.q2.id, answer: "BOGUS", quote: null, page: null },
          { questionId: "unknown-question", answer: "Y", quote: null, page: null },
        ],
      },
      {
        domainId: s.d2.id,
        assessable: true,
        judgment: "very_bad",
        rationale: "High attrition.",
        confidence: 0.5,
        quotes: [],
        answers: [],
      },
    ],
  };
}

let fake: FakeAiProvider;

beforeAll(async () => {
  await resetDb();
});

beforeEach(() => {
  fake = new FakeAiProvider();
  setAiProviderForTests(fake);
});

afterEach(() => {
  resetAiProviderForTests();
});

describe("ai rob suggestion runs", () => {
  it("stores applyable, invalid, and not-found domain suggestions with correct counts", async () => {
    const s = await setup();
    fake.extractionJson = mixedResult(s);

    const { run, suggestions } = await aiRob.runRobSuggestion(
      ctx(s.assessor.id),
      s.project.id,
      s.study.id,
      { toolId: s.tool.id },
    );
    expect(run).toMatchObject({
      status: "COMPLETED",
      totalDomains: 3,
      suggestedCount: 1,
      invalidCount: 1,
      notFoundCount: 1,
      provider: "anthropic",
      promptVersion: ROB_PROMPT_VERSION,
    });
    expect(run.usage).toEqual({ inputTokens: 1000, outputTokens: 100 });
    expect(suggestions).toHaveLength(3);

    // The provider saw the stored PDF and a prompt serializing the tool structure.
    expect(fake.extractCalls[0]!.filename).toBe(s.file.filename);
    expect(fake.extractCalls[0]!.pdfBytes).toBeGreaterThan(0);
    expect(fake.extractCalls[0]!.prompt.user).toContain(`Domain id "${s.d1.id}"`);
    expect(fake.extractCalls[0]!.prompt.user).toContain(`question id "${s.q1.id}"`);
    expect(fake.extractCalls[0]!.prompt.user).toContain('"low" = Low risk');

    const byDomain = new Map(suggestions.map((sg) => [sg.domainId, sg]));
    const good = byDomain.get(s.d1.id)!;
    expect(good).toMatchObject({
      suggestedJudgment: "low",
      rationale: "Central randomization with concealed allocation.",
      confidence: 0.9,
      notFound: false,
      invalidReason: null,
    });
    expect(good.quotes).toEqual([
      { text: "computer-generated sequence", page: 3 },
      { text: "sealed opaque envelopes", page: null },
    ]);
    // Valid answer kept clean; invalid answer kept with invalidReason; unknown id dropped.
    expect(good.signalingAnswers).toEqual([
      { questionId: s.q1.id, answer: "Y", quote: "random sequence", page: 3 },
      {
        questionId: s.q2.id,
        answer: "BOGUS",
        quote: null,
        page: null,
        invalidReason: '"BOGUS" is not an allowed answer for this question',
      },
    ]);

    const invalid = byDomain.get(s.d2.id)!;
    expect(invalid.suggestedJudgment).toBe("very_bad"); // raw kept for transparency
    expect(invalid.invalidReason).toContain("not one of the tool's scale values");

    const missing = byDomain.get(s.d3.id)!;
    expect(missing).toMatchObject({ notFound: true, suggestedJudgment: null, invalidReason: null });

    // Run-level audit only.
    const actions = await prisma.auditEvent.findMany({
      where: { projectId: s.project.id, action: { startsWith: "ai.rob" } },
      select: { action: true },
    });
    expect(actions.map((a) => a.action).sort()).toEqual(["ai.rob.completed", "ai.rob.started"]);

    // listRobSuggestions returns rows ordered by domain order, plus run + pdf info —
    // and the SECOND assessor sees the same suggestions (documented tradeoff).
    const listed = await aiRob.listRobSuggestions(ctx(s.assessor2.id), s.project.id, s.study.id, {
      toolId: s.tool.id,
    });
    expect(listed.suggestions.map((sg) => sg.domain.name)).toEqual([
      "Randomization",
      "Missing data",
      "Outcome measurement",
    ]);
    expect(listed.latestRun?.id).toBe(run.id);
    expect(listed.pdf).toEqual({
      fileId: s.file.id,
      filename: s.file.filename,
      sizeBytes: s.file.sizeBytes,
    });
  });

  it("re-runs replace the previous suggestions (latest-wins)", async () => {
    const s = await setup();
    fake.extractionJson = mixedResult(s);
    await aiRob.runRobSuggestion(ctx(s.assessor.id), s.project.id, s.study.id, {
      toolId: s.tool.id,
    });

    fake.extractionJson = {
      domains: [
        {
          domainId: s.d1.id,
          assessable: true,
          judgment: "high",
          rationale: "Second look.",
          confidence: 0.6,
          quotes: [],
          answers: [],
        },
      ],
    };
    const { run: secondRun } = await aiRob.runRobSuggestion(
      ctx(s.assessor.id),
      s.project.id,
      s.study.id,
      { toolId: s.tool.id },
    );

    const rows = await prisma.robSuggestion.findMany({
      where: { toolId: s.tool.id, studyId: s.study.id },
    });
    expect(rows).toHaveLength(3); // full replace, one row per domain
    expect(rows.every((r) => r.runId === secondRun.id)).toBe(true);
    expect(rows.find((r) => r.domainId === s.d1.id)!.suggestedJudgment).toBe("high");
    expect(rows.filter((r) => r.notFound)).toHaveLength(2);
  });

  it("works against a builtin tool (projectId null)", async () => {
    const s = await setup();
    const builtin = await prisma.riskOfBiasTool.create({
      data: {
        projectId: null,
        name: uniq("Builtin"),
        isBuiltin: true,
        status: "PUBLISHED",
        judgmentScale: SCALE,
        domains: { create: [{ name: "Only domain", order: 0 }] },
      },
      include: { domains: true },
    });
    fake.extractionJson = {
      domains: [
        {
          domainId: builtin.domains[0]!.id,
          assessable: true,
          judgment: "low",
          rationale: "ok",
          confidence: null,
          quotes: [],
          answers: [],
        },
      ],
    };
    const { run } = await aiRob.runRobSuggestion(ctx(s.assessor.id), s.project.id, s.study.id, {
      toolId: builtin.id,
    });
    expect(run).toMatchObject({ status: "COMPLETED", suggestedCount: 1, toolId: builtin.id });
  });
});

describe("applySuggestion", () => {
  async function startedAssessment(s: Setup, assessorId: string) {
    await prisma.riskOfBiasAssignment.create({
      data: { toolId: s.tool.id, studyId: s.study.id, assessorId },
    });
    return rob.startAssessment(ctx(assessorId), s.project.id, s.study.id, { toolId: s.tool.id });
  }

  it("applies judgment + valid responses atomically, keeping the assessor as author", async () => {
    const s = await setup();
    fake.extractionJson = mixedResult(s);
    const { suggestions } = await aiRob.runRobSuggestion(ctx(s.assessor.id), s.project.id, s.study.id, {
      toolId: s.tool.id,
    });
    const suggestion = suggestions.find((sg) => sg.domainId === s.d1.id)!;
    const assessment = await startedAssessment(s, s.assessor.id);

    const result = await rob.applySuggestion(ctx(s.assessor.id), s.project.id, assessment.id, {
      domainId: s.d1.id,
    });
    expect(result.responsesApplied).toBe(1); // q1 "Y"
    expect(result.responsesSkipped).toBe(1); // q2 "BOGUS"
    expect(result.judgment).toMatchObject({
      assessmentId: assessment.id,
      domainId: s.d1.id,
      judgment: "low",
    });
    expect(result.judgment.support).toBe(
      "Central randomization with concealed allocation.\n\np. 3: “computer-generated sequence”\n“sealed opaque envelopes”",
    );

    const responses = await prisma.riskOfBiasSignalingResponse.findMany({
      where: { assessmentId: assessment.id },
    });
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      questionId: s.q1.id,
      answer: "Y",
      note: "“random sequence” (p. 3)",
    });

    // Audit provenance on the judgment event.
    const event = await prisma.auditEvent.findFirst({
      where: { projectId: s.project.id, action: "rob.judgment.created" },
      orderBy: { createdAt: "desc" },
    });
    const metadata = event?.metadata as Record<string, unknown>;
    expect(metadata.appliedFromSuggestionId).toBe(suggestion.id);
    expect(metadata.aiProvider).toBe("anthropic");
    expect(typeof metadata.aiModel).toBe("string");

    // Re-apply updates in place (audited as rob.judgment.updated).
    await rob.applySuggestion(ctx(s.assessor.id), s.project.id, assessment.id, {
      domainId: s.d1.id,
    });
    expect(
      await prisma.auditEvent.count({
        where: { projectId: s.project.id, action: "rob.judgment.updated" },
      }),
    ).toBe(1);
    expect(
      await prisma.riskOfBiasJudgment.count({ where: { assessmentId: assessment.id } }),
    ).toBe(1);
  });

  it("rejects non-applyable suggestions, foreign assessments, and locked domains", async () => {
    const s = await setup();
    fake.extractionJson = mixedResult(s);
    await aiRob.runRobSuggestion(ctx(s.assessor.id), s.project.id, s.study.id, {
      toolId: s.tool.id,
    });
    const assessment = await startedAssessment(s, s.assessor.id);

    // invalidReason (d2) and notFound (d3) are never applyable.
    await expectAppError(
      rob.applySuggestion(ctx(s.assessor.id), s.project.id, assessment.id, { domainId: s.d2.id }),
      "NOT_FOUND",
    );
    await expectAppError(
      rob.applySuggestion(ctx(s.assessor.id), s.project.id, assessment.id, { domainId: s.d3.id }),
      "NOT_FOUND",
    );

    // Only the assessment's own assessor can apply into it.
    await expectAppError(
      rob.applySuggestion(ctx(s.assessor2.id), s.project.id, assessment.id, { domainId: s.d1.id }),
      "FORBIDDEN",
    );

    // Adjudicated (RESOLVED) domain is locked.
    const conflict = await prisma.riskOfBiasConflict.create({
      data: {
        toolId: s.tool.id,
        studyId: s.study.id,
        domainId: s.d1.id,
        status: "RESOLVED",
        resolvedAt: new Date(),
      },
    });
    await expectAppError(
      rob.applySuggestion(ctx(s.assessor.id), s.project.id, assessment.id, { domainId: s.d1.id }),
      "INVALID_STATE",
    );
    await prisma.riskOfBiasConflict.delete({ where: { id: conflict.id } });

    // Completed assessments are closed to applies.
    await prisma.riskOfBiasAssessment.update({
      where: { id: assessment.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    await expectAppError(
      rob.applySuggestion(ctx(s.assessor.id), s.project.id, assessment.id, { domainId: s.d1.id }),
      "INVALID_STATE",
    );
  });
});

describe("guards", () => {
  it("tool state, permissions, disabled provider, malformed output, missing/oversized PDFs", async () => {
    const s = await setup();

    // Draft tool.
    const draft = await prisma.riskOfBiasTool.create({
      data: {
        projectId: s.project.id,
        name: "Draft tool",
        status: "DRAFT",
        judgmentScale: SCALE,
        createdById: s.owner.id,
        domains: { create: [{ name: "D", order: 0 }] },
      },
    });
    await expectAppError(
      aiRob.runRobSuggestion(ctx(s.assessor.id), s.project.id, s.study.id, { toolId: draft.id }),
      "INVALID_STATE",
    );

    // Published tool without domains.
    const empty = await prisma.riskOfBiasTool.create({
      data: {
        projectId: s.project.id,
        name: "Empty tool",
        status: "PUBLISHED",
        judgmentScale: SCALE,
        createdById: s.owner.id,
      },
    });
    await expectAppError(
      aiRob.runRobSuggestion(ctx(s.assessor.id), s.project.id, s.study.id, { toolId: empty.id }),
      "INVALID_STATE",
    );

    // Permissions: OBSERVER lacks rob.assess for both run and list.
    await expectAppError(
      aiRob.runRobSuggestion(ctx(s.observer.id), s.project.id, s.study.id, { toolId: s.tool.id }),
      "FORBIDDEN",
    );
    await expectAppError(
      aiRob.listRobSuggestions(ctx(s.observer.id), s.project.id, s.study.id, { toolId: s.tool.id }),
      "FORBIDDEN",
    );

    // Disabled provider.
    setAiProviderForTests(null);
    await expectAppError(
      aiRob.runRobSuggestion(ctx(s.assessor.id), s.project.id, s.study.id, { toolId: s.tool.id }),
      "INVALID_STATE",
    );
    setAiProviderForTests(fake);

    // Malformed model output → run FAILED + audited, no suggestion rows.
    fake.extractionJson = { nope: true };
    await expectAppError(
      aiRob.runRobSuggestion(ctx(s.assessor.id), s.project.id, s.study.id, { toolId: s.tool.id }),
      "INVALID_STATE",
    );
    expect(
      await prisma.aiRobRun.findFirst({ where: { studyId: s.study.id, status: "FAILED" } }),
    ).not.toBeNull();
    expect(
      await prisma.auditEvent.count({
        where: { projectId: s.project.id, action: "ai.rob.failed" },
      }),
    ).toBe(1);
    expect(
      await prisma.robSuggestion.count({ where: { toolId: s.tool.id, studyId: s.study.id } }),
    ).toBe(0);

    // No PDF linked.
    const bare = await prisma.study.create({
      data: { projectId: s.project.id, label: "No PDF 2021", createdById: s.owner.id },
    });
    await expectAppError(
      aiRob.runRobSuggestion(ctx(s.assessor.id), s.project.id, bare.id, { toolId: s.tool.id }),
      "INVALID_STATE",
    );

    // Over the provider's PDF cap — rejected before any provider call.
    fake.extractionJson = mixedResult(s);
    fake.maxPdfBytes = 4;
    const callsBefore = fake.extractCalls.length;
    await expectAppError(
      aiRob.runRobSuggestion(ctx(s.assessor.id), s.project.id, s.study.id, { toolId: s.tool.id }),
      "INVALID_STATE",
    );
    expect(fake.extractCalls).toHaveLength(callsBefore);
  });
});
