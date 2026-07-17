// Server-side RoB roll-up for GRADE — resolves one FINAL overall risk-of-bias judgment
// per study, mirroring the traffic-light precedence in src/components/rob/summary-tab.tsx
// cell(studyId, null) PLUS the R1 blind mirror the analysis resolver applies to SINGLE
// values (resolve-values.ts):
//
//   1. RESOLVED overall conflict (domainId null) with an adjudication -> "adjudicated".
//   2. Non-null overallJudgment values across COMPLETED assessments:
//      >= 2 all equal -> "consensus"; >= 2 differing -> unresolved (neither vote leaks);
//      exactly 1 -> "single", but WITHHELD (treated as unassessed) while any other
//      assessment for (tool, study) is IN_PROGRESS or any PENDING assignment exists for
//      (tool, study). The withholding is deliberately CALLER-INDEPENDENT: stored GRADE
//      metrics must never contain provisional RoB data regardless of who generates.
//   3. No overall judgment anywhere: derive from per-domain judgments (same precedence
//      per domain — adjudicated domain conflict > unanimous COMPLETED > single with the
//      same withholding rule). When ALL domains resolve, the study's bucket is the WORST
//      domain bucket (low < moderate < unclear < high) and the judgment/label are that
//      worst domain's ("derived-from-domains"). Otherwise unassessed.
//
// The primary tool is the one with the most COMPLETED assessments across the requested
// studies (tie -> lowest tool id); studies assessed only with other tools stay unassessed.

import type { Tx } from "@/server/db";
import { classifyRobJudgment } from "@/lib/grade/rob-bucket";
import type { GradeStudyInput, RobBucket } from "@/lib/grade/types";

export type ResolvedRob = GradeStudyInput["rob"];

const UNASSESSED: ResolvedRob = {
  judgment: null,
  judgmentLabel: null,
  bucket: "unassessed",
  classificationCertain: false,
  provenance: null,
  toolId: null,
  toolName: null,
};

// Worst-of order for the derived-from-domains roll-up (unclear outranks moderate:
// an unresolvable domain is a bigger concern than a known-moderate one).
const WORST_ORDER: readonly RobBucket[] = ["low", "moderate", "unclear", "high"];

function scaleLabelFor(scale: unknown, value: string): string | null {
  if (!Array.isArray(scale)) return null;
  for (const raw of scale) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (entry.value === value && typeof entry.label === "string") return entry.label;
  }
  return null;
}

export async function resolveRobForStudies(
  db: Tx,
  projectId: string,
  studyIds: string[],
): Promise<Map<string, ResolvedRob>> {
  const out = new Map<string, ResolvedRob>(studyIds.map((id) => [id, UNASSESSED]));
  if (studyIds.length === 0) return out;

  const assessments = await db.riskOfBiasAssessment.findMany({
    where: {
      studyId: { in: studyIds },
      status: { in: ["COMPLETED", "IN_PROGRESS"] },
      study: { projectId },
    },
    select: {
      toolId: true,
      studyId: true,
      status: true,
      overallJudgment: true,
      judgments: { select: { domainId: true, judgment: true } },
    },
  });

  // Primary tool: most COMPLETED assessments across the requested studies, tie -> lowest id.
  const completedCountByTool = new Map<string, number>();
  for (const a of assessments) {
    if (a.status !== "COMPLETED") continue;
    completedCountByTool.set(a.toolId, (completedCountByTool.get(a.toolId) ?? 0) + 1);
  }
  if (completedCountByTool.size === 0) return out;
  const primaryToolId = [...completedCountByTool.entries()].sort(
    (x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1),
  )[0]![0];

  const [tool, pendingAssignments, resolvedConflicts] = await Promise.all([
    db.riskOfBiasTool.findFirst({
      where: { id: primaryToolId },
      include: { domains: { orderBy: { order: "asc" }, select: { id: true } } },
    }),
    db.riskOfBiasAssignment.findMany({
      where: {
        toolId: primaryToolId,
        studyId: { in: studyIds },
        status: "PENDING",
        study: { projectId },
      },
      select: { studyId: true },
    }),
    db.riskOfBiasConflict.findMany({
      where: {
        toolId: primaryToolId,
        studyId: { in: studyIds },
        status: "RESOLVED",
        study: { projectId },
      },
      select: {
        studyId: true,
        domainId: true,
        adjudication: { select: { finalJudgment: true } },
      },
    }),
  ]);
  if (!tool) return out; // FK guarantees this cannot happen; stay unassessed if it does

  const completedByStudy = new Map<string, (typeof assessments)[number][]>();
  const openWorkStudies = new Set<string>(pendingAssignments.map((p) => p.studyId));
  for (const a of assessments) {
    if (a.toolId !== primaryToolId) continue;
    if (a.status === "COMPLETED") {
      const list = completedByStudy.get(a.studyId);
      if (list) list.push(a);
      else completedByStudy.set(a.studyId, [a]);
    } else {
      openWorkStudies.add(a.studyId);
    }
  }

  // `${studyId}:${domainId ?? "overall"}` -> adjudicated final judgment.
  const adjudicatedByKey = new Map<string, string>();
  for (const c of resolvedConflicts) {
    if (c.adjudication) {
      adjudicatedByKey.set(`${c.studyId}:${c.domainId ?? "overall"}`, c.adjudication.finalJudgment);
    }
  }

  const resolved = (
    value: string,
    provenance: NonNullable<ResolvedRob["provenance"]>,
  ): ResolvedRob => {
    const classification = classifyRobJudgment(tool.judgmentScale, value);
    return {
      judgment: value,
      judgmentLabel: scaleLabelFor(tool.judgmentScale, value) ?? value,
      bucket: classification.bucket,
      classificationCertain: classification.certain,
      provenance,
      toolId: tool.id,
      toolName: tool.name,
    };
  };

  for (const studyId of studyIds) {
    const completed = completedByStudy.get(studyId) ?? [];
    const openWork = openWorkStudies.has(studyId);

    // 1. Adjudicated overall conflict wins outright.
    const adjudicatedOverall = adjudicatedByKey.get(`${studyId}:overall`);
    if (adjudicatedOverall !== undefined) {
      out.set(studyId, resolved(adjudicatedOverall, "adjudicated"));
      continue;
    }

    // 2. Overall votes across COMPLETED assessments.
    const votes = completed
      .map((a) => a.overallJudgment)
      .filter((j): j is string => j !== null);
    if (votes.length >= 2) {
      if (votes.every((v) => v === votes[0])) out.set(studyId, resolved(votes[0]!, "consensus"));
      continue; // differing votes stay unassessed — neither vote may leak
    }
    if (votes.length === 1) {
      if (!openWork) out.set(studyId, resolved(votes[0]!, "single"));
      continue; // withheld while a co-assessment is in progress or assigned
    }

    // 3. No overall judgment anywhere — derive from per-domain judgments.
    if (tool.domains.length === 0) continue;
    let worstBucketRank = -1;
    let worstValue: string | null = null;
    let allResolved = true;
    let allClassificationsCertain = true;
    for (const domain of tool.domains) {
      let value = adjudicatedByKey.get(`${studyId}:${domain.id}`) ?? null;
      if (value === null) {
        const domainVotes = completed.flatMap((a) =>
          a.judgments.filter((j) => j.domainId === domain.id).map((j) => j.judgment),
        );
        if (domainVotes.length >= 2 && domainVotes.every((v) => v === domainVotes[0])) {
          value = domainVotes[0]!;
        } else if (domainVotes.length === 1 && !openWork) {
          value = domainVotes[0]!;
        }
      }
      if (value === null) {
        allResolved = false;
        break;
      }
      const classification = classifyRobJudgment(tool.judgmentScale, value);
      allClassificationsCertain &&= classification.certain;
      const rank = WORST_ORDER.indexOf(classification.bucket);
      if (rank > worstBucketRank) {
        worstBucketRank = rank;
        worstValue = value;
      }
    }
    if (allResolved && worstValue !== null) {
      out.set(studyId, {
        ...resolved(worstValue, "derived-from-domains"),
        // A certain informational "unclear" and an unrankable non-informational value
        // occupy the same bucket. Preserve uncertainty from every contributing domain,
        // not only whichever tied value supplied the display label.
        classificationCertain: allClassificationsCertain,
      });
    }
  }
  return out;
}
