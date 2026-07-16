// Cohort-overlap service — companion-report detection run, candidate review (link /
// reject), and live study-membership recomputation at decision time. The engine
// (engine.ts) is pure; all persistence is here. Idempotency mirrors the dedup service:
// decided pairs (LINKED/REJECTED) are never resurrected or re-scored, still-SUGGESTED
// pairs are refreshed, and stale SUGGESTED pairs not re-proposed by the run are deleted.

import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { invalidState, notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import type { AuthorName } from "@/server/services/citations/normalize";
import { parse } from "@/server/services/imports/parsers";
import { studyLabelFor } from "@/server/services/studies";
import { detectCohortOverlap, type CohortCitationLite } from "./engine";

export const listCandidatesQuerySchema = z.object({
  status: z.enum(["SUGGESTED", "LINKED", "REJECTED"]).optional(),
});

// Detection population cap — newest first; the run audit notes when the cap was hit.
export const COHORT_POPULATION_CAP = 2000;

const BACKFILL_CHUNK_SIZE = 25;

const CITATION_DISPLAY_SELECT = {
  id: true,
  status: true,
  title: true,
  authors: true,
  year: true,
  journal: true,
  doi: true,
  pmid: true,
  studyLinks: { select: { study: { select: { id: true, label: true } } } },
} satisfies Prisma.CitationSelect;

function toAuthorNames(authors: unknown): AuthorName[] {
  return Array.isArray(authors) ? (authors as unknown as AuthorName[]) : [];
}

// ---------------------------------------------------------------------------
// Detection run
// ---------------------------------------------------------------------------

export async function runCohortDetection(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "project.edit");

  // Population: ACTIVE citations that are analysis-relevant — study-linked OR full-text
  // included (an FT INCLUDE stage result, the same derivation PRISMA reporting uses).
  const populationPlusOne = await prisma.citation.findMany({
    where: {
      projectId,
      status: "ACTIVE",
      OR: [
        { studyLinks: { some: {} } },
        {
          stageResults: {
            some: { stage: { projectId, type: "FULL_TEXT" }, outcome: "INCLUDE" },
          },
        },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: COHORT_POPULATION_CAP + 1,
    select: {
      id: true,
      title: true,
      authors: true,
      year: true,
      affiliations: true,
      doi: true,
      identifiers: { where: { type: "REGISTRY_ID" }, select: { value: true } },
      studyLinks: { select: { studyId: true } },
    },
  });
  const populationCapped = populationPlusOne.length > COHORT_POPULATION_CAP;
  const population = populationCapped
    ? populationPlusOne.slice(0, COHORT_POPULATION_CAP)
    : populationPlusOne;

  // Lazy backfill: citations imported before affiliation capture existed (affiliations
  // null) are re-parsed from their preserved raw source records (parsers are pure), and
  // affiliations + missing REGISTRY_ID identifiers are persisted in chunks. A citation
  // with no source record simply stays null.
  const backfilled = await backfillAffiliations(
    population.filter((c) => c.affiliations === null).map((c) => c.id),
  );
  for (const c of population) {
    const patch = backfilled.get(c.id);
    if (!patch) continue;
    c.affiliations = patch.affiliations as unknown as Prisma.JsonValue;
    for (const rid of patch.registryIds) {
      if (!c.identifiers.some((i) => i.value === rid)) c.identifiers.push({ value: rid });
    }
  }

  const lites: CohortCitationLite[] = population.map((c) => ({
    id: c.id,
    title: c.title,
    authors: toAuthorNames(c.authors),
    year: c.year,
    affiliations: Array.isArray(c.affiliations) ? (c.affiliations as string[]) : null,
    registryIds: c.identifiers.map((i) => i.value),
    doi: c.doi,
    studyIds: c.studyLinks.map((l) => l.studyId),
  }));
  const pairs = detectCohortOverlap(lites);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.cohortCandidate.findMany({ where: { projectId } });
    const byPair = new Map(existing.map((c) => [`${c.citationAId}|${c.citationBId}`, c]));

    let newlySuggested = 0;
    let refreshed = 0;
    let skippedDecided = 0;
    const proposedKeys = new Set<string>();
    for (const pair of pairs) {
      const key = `${pair.aId}|${pair.bId}`;
      proposedKeys.add(key);
      const current = byPair.get(key);
      if (!current) {
        await tx.cohortCandidate.create({
          data: {
            projectId,
            citationAId: pair.aId,
            citationBId: pair.bId,
            method: pair.method,
            score: pair.score,
            signals: pair.signals as unknown as Prisma.InputJsonValue,
          },
        });
        newlySuggested++;
      } else if (current.status === "SUGGESTED") {
        await tx.cohortCandidate.update({
          where: { id: current.id },
          data: {
            method: pair.method,
            score: pair.score,
            signals: pair.signals as unknown as Prisma.InputJsonValue,
          },
        });
        refreshed++;
      } else {
        skippedDecided++; // human already decided (LINKED/REJECTED) — never resurrect
      }
    }

    // Stale SUGGESTED pairs the run no longer proposes are derived data — delete them.
    // Skipped entirely when the population was capped: pairs whose citations fell
    // outside the scored window were not re-evaluated, so their absence proves nothing.
    let removed = 0;
    if (!populationCapped) {
      const staleIds = existing
        .filter(
          (c) => c.status === "SUGGESTED" && !proposedKeys.has(`${c.citationAId}|${c.citationBId}`),
        )
        .map((c) => c.id);
      if (staleIds.length > 0) {
        // status re-checked in the delete: a candidate decided between our read and
        // this write must survive (deleting it would let a later run resurrect it).
        const res = await tx.cohortCandidate.deleteMany({
          where: { id: { in: staleIds }, status: "SUGGESTED" },
        });
        removed = res.count;
      }
    }

    const summary = {
      candidates: pairs.length,
      newlySuggested,
      refreshed,
      removed,
      skippedDecided,
      populationSize: population.length,
      backfilled: backfilled.size,
      ...(populationCapped ? { populationCapped: true, populationCap: COHORT_POPULATION_CAP } : {}),
    };
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "Project",
      entityId: projectId,
      action: AuditActions.COHORT_RUN,
      metadata: summary,
    });
    return summary;
    // Sequential per-pair writes on a large project can outlive Prisma's 5s default.
  }, { timeout: 60_000, maxWait: 10_000 });
}

// Re-parse preserved raw records for the given citations and persist affiliations (union
// across a citation's source records, possibly []) plus any missing REGISTRY_ID
// identifiers. Returns the per-citation backfill so the caller can score without reloading.
async function backfillAffiliations(citationIds: string[]) {
  const result = new Map<string, { affiliations: string[]; registryIds: string[] }>();
  if (citationIds.length === 0) return result;

  const rows = await prisma.citationSourceRecord.findMany({
    where: { citationId: { in: citationIds } },
    select: {
      citationId: true,
      rawRecord: true,
      batch: { select: { format: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  for (const row of rows) {
    if (!row.citationId) continue;
    // Parsers are pure and never throw; a raw chunk that fails to parse yields no records.
    const { records } = parse(row.batch.format, row.rawRecord);
    const record = records[0];
    const entry = result.get(row.citationId) ?? { affiliations: [], registryIds: [] };
    for (const a of record?.affiliations ?? []) {
      if (!entry.affiliations.includes(a)) entry.affiliations.push(a);
    }
    for (const rid of record?.registryIds ?? []) {
      if (!entry.registryIds.includes(rid)) entry.registryIds.push(rid);
    }
    result.set(row.citationId, entry);
  }
  // Citations with source records but no parseable affiliations still persist [] so the
  // backfill is one-time; citations with NO source record are absent → stay null.
  for (const id of citationIds) {
    if (rows.some((r) => r.citationId === id) && !result.has(id)) {
      result.set(id, { affiliations: [], registryIds: [] });
    }
  }

  const entries = [...result.entries()];
  for (let i = 0; i < entries.length; i += BACKFILL_CHUNK_SIZE) {
    const chunk = entries.slice(i, i + BACKFILL_CHUNK_SIZE);
    await prisma.$transaction(async (tx) => {
      for (const [citationId, patch] of chunk) {
        await tx.citation.update({
          where: { id: citationId },
          data: { affiliations: patch.affiliations as unknown as Prisma.InputJsonValue },
        });
        if (patch.registryIds.length > 0) {
          await tx.citationIdentifier.createMany({
            data: patch.registryIds.map((value) => ({
              citationId,
              type: "REGISTRY_ID" as const,
              value,
            })),
            skipDuplicates: true,
          });
        }
      }
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

// Candidates with both citations' display fields and each side's current study links so
// the UI can preview what a Link decision would do. No status → all candidates.
export async function listCohortCandidates(
  ctx: Ctx,
  projectId: string,
  query: z.infer<typeof listCandidatesQuerySchema> = {},
) {
  await requirePermission(ctx, projectId, "project.view");
  const candidates = await prisma.cohortCandidate.findMany({
    where: { projectId, ...(query.status ? { status: query.status } : {}) },
    orderBy: [{ score: "desc" }, { createdAt: "asc" }, { id: "asc" }],
    include: {
      citationA: { select: CITATION_DISPLAY_SELECT },
      citationB: { select: CITATION_DISPLAY_SELECT },
      decidedBy: { select: { id: true, name: true, email: true } },
    },
  });
  return candidates.map((c) => ({
    ...c,
    citationA: { ...c.citationA, studies: c.citationA.studyLinks.map((l) => l.study) },
    citationB: { ...c.citationB, studies: c.citationB.studyLinks.map((l) => l.study) },
  }));
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type CohortLinkCase =
  | "LINKED_INTO_EXISTING" // exactly one side had a study
  | "CREATED_STUDY" // neither side had a study
  | "MERGED_STUDIES" // both sides had different studies; B's was folded into A's
  | "ALREADY_SAME_STUDY"; // both sides already share a study

// Link a companion pair: recompute study membership LIVE (the candidate stores citations,
// not studies) and apply the appropriate case in one transaction.
export async function linkCohortCandidate(ctx: Ctx, projectId: string, candidateId: string) {
  await requirePermission(ctx, projectId, "project.edit");

  return prisma.$transaction(async (tx) => {
    const candidate = await tx.cohortCandidate.findFirst({
      where: { id: candidateId, projectId }, // tenant-scoped by-id load (R9)
    });
    if (!candidate) throw notFound("Cohort candidate");
    if (candidate.status !== "SUGGESTED") {
      throw invalidState("Only suggested candidates can be linked");
    }

    const [citationA, citationB] = await Promise.all([
      tx.citation.findFirstOrThrow({
        where: { id: candidate.citationAId, projectId },
        include: { studyLinks: { include: { study: { select: { id: true, label: true } } } } },
      }),
      tx.citation.findFirstOrThrow({
        where: { id: candidate.citationBId, projectId },
        include: { studyLinks: { include: { study: { select: { id: true, label: true } } } } },
      }),
    ]);
    if (citationA.status !== "ACTIVE" || citationB.status !== "ACTIVE") {
      throw invalidState(
        "Both citations must be ACTIVE to link — one of them was merged as a duplicate",
      );
    }

    const aStudyIds = citationA.studyLinks.map((l) => l.study.id);
    const bStudyIds = citationB.studyLinks.map((l) => l.study.id);
    const shared = aStudyIds.find((id) => bStudyIds.includes(id));

    let linkCase: CohortLinkCase;
    let studyId: string;

    const linkReport = async (targetStudyId: string, citationId: string, primary: boolean) => {
      const link = await tx.studyReportLink.create({
        data: { studyId: targetStudyId, citationId, isPrimaryReport: primary },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "StudyReportLink",
        entityId: link.id,
        action: AuditActions.STUDY_REPORT_LINKED,
        newValue: { studyId: targetStudyId, citationId, isPrimaryReport: primary },
      });
    };

    if (shared) {
      // Both already belong to the same study — nothing to move, just record the decision.
      linkCase = "ALREADY_SAME_STUDY";
      studyId = shared;
    } else if (aStudyIds.length > 0 && bStudyIds.length === 0) {
      // Case 1: A is study-linked → add B's report to A's study (not primary).
      linkCase = "LINKED_INTO_EXISTING";
      studyId = aStudyIds[0]!;
      await linkReport(studyId, citationB.id, false);
    } else if (bStudyIds.length > 0 && aStudyIds.length === 0) {
      // Case 1 (mirrored): B is study-linked → add A's report to B's study.
      linkCase = "LINKED_INTO_EXISTING";
      studyId = bStudyIds[0]!;
      await linkReport(studyId, citationA.id, false);
    } else if (aStudyIds.length === 0 && bStudyIds.length === 0) {
      // Case 2: neither linked → create the study, labeled from the earlier-year
      // citation ("Criner 2018" convention), which becomes the primary report.
      linkCase = "CREATED_STUDY";
      const [earlier, later] =
        citationB.year !== null && (citationA.year === null || citationB.year < citationA.year)
          ? [citationB, citationA]
          : [citationA, citationB];
      const study = await tx.study.create({
        data: { projectId, label: studyLabelFor(earlier), createdById: ctx.userId },
      });
      studyId = study.id;
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "Study",
        entityId: study.id,
        action: AuditActions.STUDY_CREATED,
        newValue: { label: study.label, citationId: earlier.id, cohortCandidateId: candidate.id },
      });
      await linkReport(study.id, earlier.id, true);
      await linkReport(study.id, later.id, false);
    } else {
      // Case 3: both linked to different studies → merge B's study into A's, but only
      // when the source study carries no reviewer work.
      linkCase = "MERGED_STUDIES";
      studyId = aStudyIds[0]!;
      const sourceStudyId = bStudyIds[0]!;
      const source = await tx.study.findFirstOrThrow({
        where: { id: sourceStudyId, projectId },
        include: {
          _count: {
            select: {
              extractionForms: true,
              extractionAssignments: true,
              extractionConflicts: true,
              robAssignments: true,
              robAssessments: true,
              robConflicts: true,
              aiExtractionRuns: true,
              aiSuggestions: true,
              aiRobRuns: true,
              robSuggestions: true,
              analysisExclusions: true,
            },
          },
        },
      });
      // Every restricting Study relation must be covered here — a miss doesn't relax
      // the rule, it just turns the intended 422 into a P2003 crash at study.delete.
      const counts = source._count;
      const blocked =
        counts.extractionForms > 0 ||
        counts.extractionAssignments > 0 ||
        counts.extractionConflicts > 0 ||
        counts.robAssignments > 0 ||
        counts.robAssessments > 0 ||
        counts.robConflicts > 0 ||
        counts.aiExtractionRuns > 0 ||
        counts.aiSuggestions > 0 ||
        counts.aiRobRuns > 0 ||
        counts.robSuggestions > 0 ||
        counts.analysisExclusions > 0;
      if (blocked) {
        throw invalidState(
          `Both reports already belong to different studies and “${source.label}” has ` +
            "extraction, risk-of-bias, AI, or analysis work. Merging would orphan that " +
            "work — reconcile the two studies manually instead.",
        );
      }
      // Move every report link off the source study (skip citations the target already has).
      const sourceLinks = await tx.studyReportLink.findMany({ where: { studyId: sourceStudyId } });
      const targetLinks = await tx.studyReportLink.findMany({ where: { studyId } });
      const targetCitationIds = new Set(targetLinks.map((l) => l.citationId));
      for (const link of sourceLinks) {
        if (targetCitationIds.has(link.citationId)) {
          await tx.studyReportLink.delete({ where: { id: link.id } });
        } else {
          // Merged-in reports are never the primary of the surviving study.
          await tx.studyReportLink.update({
            where: { id: link.id },
            data: { studyId, isPrimaryReport: false },
          });
        }
      }
      await tx.study.delete({ where: { id: sourceStudyId } });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "Study",
        entityId: sourceStudyId,
        action: AuditActions.STUDY_MERGED,
        previousValue: { label: source.label },
        metadata: { from: sourceStudyId, to: studyId, movedReports: sourceLinks.length },
      });
    }

    const updated = await tx.cohortCandidate.update({
      where: { id: candidate.id },
      data: { status: "LINKED", decidedById: ctx.userId, decidedAt: new Date() },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "CohortCandidate",
      entityId: candidate.id,
      action: AuditActions.COHORT_LINKED,
      previousValue: { status: "SUGGESTED" },
      newValue: { status: "LINKED" },
      metadata: {
        case: linkCase,
        studyId,
        citationAId: candidate.citationAId,
        citationBId: candidate.citationBId,
      },
    });
    return { candidate: updated, case: linkCase, studyId };
  });
}

export async function rejectCohortCandidate(ctx: Ctx, projectId: string, candidateId: string) {
  await requirePermission(ctx, projectId, "project.edit");

  return prisma.$transaction(async (tx) => {
    const candidate = await tx.cohortCandidate.findFirst({
      where: { id: candidateId, projectId }, // tenant-scoped by-id load (R9)
    });
    if (!candidate) throw notFound("Cohort candidate");
    if (candidate.status !== "SUGGESTED") {
      throw invalidState("Only suggested candidates can be rejected");
    }
    const updated = await tx.cohortCandidate.update({
      where: { id: candidate.id },
      data: { status: "REJECTED", decidedById: ctx.userId, decidedAt: new Date() },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "CohortCandidate",
      entityId: candidate.id,
      action: AuditActions.COHORT_REJECTED,
      previousValue: { status: "SUGGESTED" },
      newValue: { status: "REJECTED" },
      metadata: { citationAId: candidate.citationAId, citationBId: candidate.citationBId },
    });
    return { candidate: updated };
  });
}
