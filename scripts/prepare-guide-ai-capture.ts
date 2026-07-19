/**
 * Prepare the isolated `srb_video` database for screenshots of the implemented AI UI.
 *
 * This fixture never calls an external AI provider. It adds representative suggestion rows to
 * the normal seeded demo, preserving the same separation between suggestions and human records
 * that the production services enforce. The hard database-name guard prevents accidental use
 * against development, test, or production data.
 */
import "dotenv/config";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";

const FIXTURE_VERSION = "video-ai-capture-v1";
const PROVIDER = "anthropic";
const MODEL = "claude-opus-4-8";

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!/\/srb_video(?:\?|$)/.test(databaseUrl)) {
  throw new Error(
    "Refusing to prepare AI capture data: DATABASE_URL must target the isolated srb_video database",
  );
}

function json(value: Prisma.JsonValue): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function removePreviousFixtureRuns(projectId: string) {
  const [screening, extraction, rob, grade] = await Promise.all([
    prisma.aiScreeningRun.findMany({
      where: { projectId, promptVersion: FIXTURE_VERSION },
      select: { id: true },
    }),
    prisma.aiExtractionRun.findMany({
      where: { projectId, promptVersion: FIXTURE_VERSION },
      select: { id: true },
    }),
    prisma.aiRobRun.findMany({
      where: { projectId, promptVersion: FIXTURE_VERSION },
      select: { id: true },
    }),
    prisma.aiGradeRun.findMany({
      where: { projectId, promptVersion: FIXTURE_VERSION },
      select: { id: true },
    }),
  ]);

  const screeningIds = screening.map(({ id }) => id);
  const extractionIds = extraction.map(({ id }) => id);
  const robIds = rob.map(({ id }) => id);
  const gradeIds = grade.map(({ id }) => id);
  const allIds = [...screeningIds, ...extractionIds, ...robIds, ...gradeIds];

  await prisma.$transaction([
    prisma.screeningSuggestion.deleteMany({ where: { runId: { in: screeningIds } } }),
    prisma.extractionSuggestion.deleteMany({ where: { runId: { in: extractionIds } } }),
    prisma.robSuggestion.deleteMany({ where: { runId: { in: robIds } } }),
    prisma.gradeDomainSuggestion.deleteMany({ where: { runId: { in: gradeIds } } }),
    prisma.aiScreeningRun.deleteMany({ where: { id: { in: screeningIds } } }),
    prisma.aiExtractionRun.deleteMany({ where: { id: { in: extractionIds } } }),
    prisma.aiRobRun.deleteMany({ where: { id: { in: robIds } } }),
    prisma.aiGradeRun.deleteMany({ where: { id: { in: gradeIds } } }),
    prisma.auditEvent.deleteMany({ where: { entityId: { in: allIds } } }),
  ]);
}

async function main() {
  const project = await prisma.project.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: "owner@demo.test" } });
  const reviewer = await prisma.user.findUniqueOrThrow({
    where: { email: "reviewer1@demo.test" },
  });
  await removePreviousFixtureRuns(project.id);

  const stage = await prisma.screeningStage.findFirstOrThrow({
    where: { projectId: project.id, type: "TITLE_ABSTRACT" },
  });
  const citation = await prisma.citation.findFirstOrThrow({
    where: {
      projectId: project.id,
      status: "ACTIVE",
      stageResults: { none: { stageId: stage.id } },
    },
    orderBy: { createdAt: "asc" },
  });

  await prisma.screeningStage.update({
    where: { id: stage.id },
    data: { aiShowScores: true, aiRankingEnabled: true },
  });
  await prisma.screeningAssignment.upsert({
    where: {
      stageId_citationId_reviewerId: {
        stageId: stage.id,
        citationId: citation.id,
        reviewerId: owner.id,
      },
    },
    update: { status: "PENDING" },
    create: {
      stageId: stage.id,
      citationId: citation.id,
      reviewerId: owner.id,
      status: "PENDING",
    },
  });
  const screeningRun = await prisma.aiScreeningRun.create({
    data: {
      projectId: project.id,
      stageId: stage.id,
      status: "COMPLETED",
      provider: PROVIDER,
      model: MODEL,
      promptVersion: FIXTURE_VERSION,
      totalCount: 17,
      succeededCount: 17,
      failedCount: 0,
      usage: { inputTokens: 14_820, outputTokens: 1_940 },
      requestedById: owner.id,
      submittedAt: new Date(),
      completedAt: new Date(),
    },
  });
  await prisma.screeningSuggestion.upsert({
    where: { stageId_citationId: { stageId: stage.id, citationId: citation.id } },
    update: {
      runId: screeningRun.id,
      score: 92,
      suggestedDecision: "INCLUDE",
      rationale:
        "The population, intervention, comparator, and clinical outcomes align with the published protocol. Verify the abstract before deciding.",
      provider: PROVIDER,
      model: MODEL,
      promptVersion: FIXTURE_VERSION,
    },
    create: {
      stageId: stage.id,
      citationId: citation.id,
      runId: screeningRun.id,
      score: 92,
      suggestedDecision: "INCLUDE",
      rationale:
        "The population, intervention, comparator, and clinical outcomes align with the published protocol. Verify the abstract before deciding.",
      provider: PROVIDER,
      model: MODEL,
      promptVersion: FIXTURE_VERSION,
    },
  });

  const form = await prisma.extractionForm.findFirstOrThrow({
    where: { extractorId: reviewer.id, study: { projectId: project.id, label: "Slebos 2019" } },
    include: {
      study: {
        include: {
          reportLinks: {
            orderBy: { isPrimaryReport: "desc" },
            include: {
              citation: { include: { fullTextLinks: { include: { file: true } } } },
            },
          },
        },
      },
      template: { include: { fields: { orderBy: { order: "asc" } } } },
      values: true,
    },
  });
  const file = form.study.reportLinks
    .flatMap((link) => link.citation.fullTextLinks)
    .map((link) => link.file)[0];
  if (!file) throw new Error("The Slebos demo study has no linked PDF");

  await prisma.$transaction([
    prisma.extractionForm.update({
      where: { id: form.id },
      data: { status: "IN_PROGRESS", completedAt: null },
    }),
    prisma.extractionAssignment.updateMany({
      where: {
        studyId: form.studyId,
        templateId: form.templateId,
        extractorId: reviewer.id,
      },
      data: { status: "PENDING" },
    }),
  ]);
  const extractionRun = await prisma.aiExtractionRun.create({
    data: {
      projectId: project.id,
      studyId: form.studyId,
      templateId: form.templateId,
      fileId: file.id,
      status: "COMPLETED",
      provider: PROVIDER,
      model: MODEL,
      promptVersion: FIXTURE_VERSION,
      totalFields: form.template.fields.length,
      suggestedCount: 6,
      invalidCount: 0,
      notFoundCount: 0,
      usage: { inputTokens: 8_460, outputTokens: 1_180 },
      requestedById: reviewer.id,
      completedAt: new Date(),
    },
  });
  const valuesByField = new Map(form.values.map((value) => [value.fieldId, value]));
  const suggestedFieldKeys = new Set([
    "study_design",
    "sample_size",
    "mean_age",
    "female_pct",
    "resp_valve_events",
    "resp_control_events",
  ]);
  for (const field of form.template.fields.filter((item) => suggestedFieldKeys.has(item.key))) {
    const value = valuesByField.get(field.id);
    if (!value) continue;
    const page = value.pageNumber ?? null;
    await prisma.extractionSuggestion.upsert({
      where: {
        templateId_studyId_fieldId: {
          templateId: form.templateId,
          studyId: form.studyId,
          fieldId: field.id,
        },
      },
      update: {
        runId: extractionRun.id,
        value: json(value.value),
        sourceQuote: value.sourceQuote,
        pageNumber: page,
        sourceAnchor:
          page === null
            ? Prisma.JsonNull
            : { v: 2, fileId: file.id, page, matchQuality: "exact" },
        confidence: field.key === "study_design" ? 0.91 : 0.96,
        notFound: false,
        invalidReason: null,
        provider: PROVIDER,
        model: MODEL,
        promptVersion: FIXTURE_VERSION,
      },
      create: {
        runId: extractionRun.id,
        templateId: form.templateId,
        studyId: form.studyId,
        fieldId: field.id,
        value: json(value.value),
        sourceQuote: value.sourceQuote,
        pageNumber: page,
        sourceAnchor:
          page === null
            ? Prisma.JsonNull
            : { v: 2, fileId: file.id, page, matchQuality: "exact" },
        confidence: field.key === "study_design" ? 0.91 : 0.96,
        notFound: false,
        provider: PROVIDER,
        model: MODEL,
        promptVersion: FIXTURE_VERSION,
      },
    });
  }

  const assessment = await prisma.riskOfBiasAssessment.findFirstOrThrow({
    where: { assessorId: reviewer.id, study: { projectId: project.id, label: "Slebos 2019" } },
    include: {
      study: true,
      tool: {
        include: {
          domains: {
            orderBy: { order: "asc" },
            include: { questions: { orderBy: { order: "asc" } } },
          },
        },
      },
    },
  });
  await prisma.$transaction([
    prisma.riskOfBiasAssessment.update({
      where: { id: assessment.id },
      data: { status: "IN_PROGRESS", completedAt: null },
    }),
    prisma.riskOfBiasAssignment.updateMany({
      where: {
        studyId: assessment.studyId,
        toolId: assessment.toolId,
        assessorId: reviewer.id,
      },
      data: { status: "PENDING" },
    }),
  ]);
  const robRun = await prisma.aiRobRun.create({
    data: {
      projectId: project.id,
      studyId: assessment.studyId,
      toolId: assessment.toolId,
      fileId: file.id,
      status: "COMPLETED",
      provider: PROVIDER,
      model: MODEL,
      promptVersion: FIXTURE_VERSION,
      totalDomains: assessment.tool.domains.length,
      suggestedCount: assessment.tool.domains.length,
      invalidCount: 0,
      notFoundCount: 0,
      usage: { inputTokens: 9_240, outputTokens: 1_420 },
      requestedById: reviewer.id,
      completedAt: new Date(),
    },
  });
  const robCopy: Record<
    string,
    {
      judgment: string;
      rationale: string;
      confidence: number;
      quotes: Array<{ text: string; page: number }>;
    }
  > = {
    "Selection bias": {
      judgment: "some_concerns",
      rationale:
        "The extension report describes the enrolled groups, but sequence generation and concealment should be checked in the primary trial report.",
      confidence: 0.72,
      quotes: [
        {
          text: "Ninety-seven participants were enrolled, of whom 47 received valve treatment and 50 served as controls.",
          page: 2,
        },
      ],
    },
    "Performance bias": {
      judgment: "some_concerns",
      rationale:
        "Blinding of participants and intervention personnel is not described in this extension report.",
      confidence: 0.7,
      quotes: [],
    },
    "Detection bias": {
      judgment: "low",
      rationale:
        "Outcome assessors were reported as blinded to treatment allocation throughout follow-up.",
      confidence: 0.95,
      quotes: [
        {
          text: "Outcome assessors were blinded to treatment allocation throughout follow-up.",
          page: 2,
        },
      ],
    },
    "Attrition bias": {
      judgment: "unclear",
      rationale:
        "The available report excerpt does not describe completeness of outcome data or reasons for missing observations.",
      confidence: 0.64,
      quotes: [],
    },
    "Reporting bias": {
      judgment: "some_concerns",
      rationale:
        "The extension reports the main lung-function result, but prespecified outcomes should be checked against the protocol.",
      confidence: 0.69,
      quotes: [
        {
          text: "FEV1 response at 12 months was observed in 18 of 47 treated participants compared with 6 of 50 controls.",
          page: 2,
        },
      ],
    },
  };
  for (const domain of assessment.tool.domains) {
    const copy = robCopy[domain.name];
    if (!copy) continue;
    const signalingAnswers =
      domain.name === "Detection bias" && domain.questions[0]
        ? [
            {
              questionId: domain.questions[0].id,
              answer: "Y",
              quote:
                "Outcome assessors were blinded to treatment allocation throughout follow-up.",
              page: 2,
            },
          ]
        : [];
    await prisma.robSuggestion.upsert({
      where: {
        toolId_studyId_domainId: {
          toolId: assessment.toolId,
          studyId: assessment.studyId,
          domainId: domain.id,
        },
      },
      update: {
        runId: robRun.id,
        suggestedJudgment: copy.judgment,
        rationale: copy.rationale,
        quotes: copy.quotes,
        signalingAnswers,
        confidence: copy.confidence,
        notFound: false,
        invalidReason: null,
        provider: PROVIDER,
        model: MODEL,
        promptVersion: FIXTURE_VERSION,
      },
      create: {
        runId: robRun.id,
        toolId: assessment.toolId,
        studyId: assessment.studyId,
        domainId: domain.id,
        suggestedJudgment: copy.judgment,
        rationale: copy.rationale,
        quotes: copy.quotes,
        signalingAnswers,
        confidence: copy.confidence,
        notFound: false,
        provider: PROVIDER,
        model: MODEL,
        promptVersion: FIXTURE_VERSION,
      },
    });
  }

  const outcome = await prisma.analysisOutcome.findFirstOrThrow({
    where: { projectId: project.id },
    include: { gradeAssessment: { include: { ratings: true } } },
  });
  if (!outcome.gradeAssessment) throw new Error("The demo outcome has no GRADE assessment");
  const gradeRun = await prisma.aiGradeRun.create({
    data: {
      projectId: project.id,
      analysisOutcomeId: outcome.id,
      status: "COMPLETED",
      provider: PROVIDER,
      model: MODEL,
      promptVersion: FIXTURE_VERSION,
      totalDomains: 5,
      suggestedCount: 5,
      invalidCount: 0,
      usage: { inputTokens: 3_260, outputTokens: 620 },
      requestedById: owner.id,
      completedAt: new Date(),
    },
  });
  const gradeRationales: Record<string, { rationale: string; confidence: number | null }> = {
    RISK_OF_BIAS: {
      rationale:
        "Most pooled weight comes from studies judged at low risk of bias; no downgrade is suggested.",
      confidence: 0.92,
    },
    INCONSISTENCY: {
      rationale:
        "The pooled studies are directionally consistent and statistical heterogeneity is low.",
      confidence: 0.9,
    },
    INDIRECTNESS: {
      rationale:
        "Study-level applicability details require human comparison with the protocol PICO before this domain is finalized.",
      confidence: null,
    },
    IMPRECISION: {
      rationale:
        "The pooled estimate is informative, but the total sample remains below the optimal information size; one-level downgrade is reasonable.",
      confidence: 0.86,
    },
    PUBLICATION_BIAS: {
      rationale:
        "With only two pooled studies, funnel-based tests are not informative; retain the draft judgment and review manually.",
      confidence: 0.67,
    },
  };
  for (const rating of outcome.gradeAssessment.ratings) {
    const copy = gradeRationales[rating.domain];
    if (!copy) continue;
    await prisma.gradeDomainSuggestion.upsert({
      where: {
        analysisOutcomeId_domain: { analysisOutcomeId: outcome.id, domain: rating.domain },
      },
      update: {
        runId: gradeRun.id,
        suggestedJudgment: rating.judgment,
        rationale: copy.rationale,
        confidence: copy.confidence,
        provider: PROVIDER,
        model: MODEL,
        promptVersion: FIXTURE_VERSION,
      },
      create: {
        runId: gradeRun.id,
        analysisOutcomeId: outcome.id,
        domain: rating.domain,
        suggestedJudgment: rating.judgment,
        rationale: copy.rationale,
        confidence: copy.confidence,
        provider: PROVIDER,
        model: MODEL,
        promptVersion: FIXTURE_VERSION,
      },
    });
  }

  await prisma.auditEvent.createMany({
    data: [
      {
        projectId: project.id,
        userId: owner.id,
        entityType: "AiScreeningRun",
        entityId: screeningRun.id,
        action: "ai.prescreen.completed",
        newValue: { totalCount: 17, succeededCount: 17, failedCount: 0 },
        metadata: { provider: PROVIDER, model: MODEL, captureFixture: true },
      },
      {
        projectId: project.id,
        userId: reviewer.id,
        entityType: "AiExtractionRun",
        entityId: extractionRun.id,
        action: "ai.extraction.completed",
        newValue: { suggestedCount: 6, invalidCount: 0, notFoundCount: 0 },
        metadata: { provider: PROVIDER, model: MODEL, captureFixture: true },
      },
      {
        projectId: project.id,
        userId: reviewer.id,
        entityType: "AiRobRun",
        entityId: robRun.id,
        action: "ai.rob.completed",
        newValue: { suggestedCount: assessment.tool.domains.length },
        metadata: { provider: PROVIDER, model: MODEL, captureFixture: true },
      },
      {
        projectId: project.id,
        userId: owner.id,
        entityType: "AiGradeRun",
        entityId: gradeRun.id,
        action: "ai.grade.completed",
        newValue: { suggestedCount: 5, invalidCount: 0 },
        metadata: { provider: PROVIDER, model: MODEL, captureFixture: true },
      },
    ],
  });

  console.log("Prepared isolated AI capture fixture");
  console.log(`Project: ${project.id}`);
  console.log(`Screening citation: ${citation.id}`);
  console.log(`Extraction form: ${form.id}`);
  console.log(`RoB assessment: ${assessment.id}`);
  console.log(`GRADE outcome: ${outcome.id}`);
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
