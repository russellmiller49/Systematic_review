"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Alert, Skeleton } from "@/components/ui/misc";
import type { getScreeningScope } from "@/server/services/screening/scope";

type ScreeningScope = Awaited<ReturnType<typeof getScreeningScope>>;

export function ScreeningScopePanel({ projectId, poolId }: { projectId: string; poolId?: string }) {
  const [scope, setScope] = useState<ScreeningScope | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setScope(undefined);
    api<ScreeningScope>(
      `/api/projects/${projectId}/screening/scope${poolId ? `?poolId=${encodeURIComponent(poolId)}` : ""}`,
    )
      .then((value) => {
        if (!cancelled) setScope(value);
      })
      .catch(() => {
        if (!cancelled) setScope(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, poolId]);

  if (scope === undefined) return <Skeleton className="h-28 w-full" />;
  if (!scope)
    return (
      <Alert variant="warning">
        The configured screening scope could not be loaded. Confirm your assigned queue and protocol
        with an Owner or Admin before screening.
      </Alert>
    );
  return (
    <section
      aria-label="Screening scope"
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <h2 className="font-semibold">
        {scope.combined ? "Combined screening scope" : "Individual screening scope"} · {scope.name}
      </h2>
      <p className="text-sm">
        {scope.combined
          ? "Assess relevance to ANY PICO in this pool. Do not exclude solely because a record does not answer one question. Check each PICO's configured eligibility and exceptions; ask the review lead to clarify conflicting criteria."
          : "Screen against this project's configured question, population, and eligibility criteria."}{" "}
        Project membership alone does not specify your screening workload; use your personal target
        or fixed assignments below.
      </p>
      {scope.projects.map((project) => (
        <div key={project.id} className="space-y-1 border-t border-border pt-2 text-sm">
          <p className="font-medium">
            {project.picoNumber !== null && `PICO ${project.picoNumber} · `}
            {project.title}
          </p>
          <p className="whitespace-pre-wrap">
            Population:{" "}
            {project.protocol?.population ||
              "Not configured at protocol level; check question definitions and criteria below with the review lead."}
          </p>
          <details>
            <summary className="cursor-pointer text-primary">
              Question definitions and eligibility ·{" "}
              {project.protocol?.versions[0]
                ? `protocol version ${project.protocol.versions[0].versionNumber}`
                : "no published version"}
            </summary>
            <div className="mt-2 space-y-2 whitespace-pre-wrap">
              {project.protocol ? (
                <>
                  {project.protocol.reviewQuestion && (
                    <p>Question: {project.protocol.reviewQuestion}</p>
                  )}
                  {project.protocol.intervention && (
                    <p>Intervention: {project.protocol.intervention}</p>
                  )}
                  {project.protocol.comparator && <p>Comparator: {project.protocol.comparator}</p>}
                  {project.protocol.outcomesNarrative && (
                    <p>Outcomes: {project.protocol.outcomesNarrative}</p>
                  )}
                  {project.protocol.picoQuestions.map((pico, i) => (
                    <div key={i} className="space-y-1">
                      <p>{pico.question}</p>
                      {pico.population && <p>Population: {pico.population}</p>}
                      {pico.intervention && <p>Intervention: {pico.intervention}</p>}
                      {pico.comparator && <p>Comparator: {pico.comparator}</p>}
                      {pico.outcome && <p>Outcome: {pico.outcome}</p>}
                    </div>
                  ))}
                  {project.protocol.studyDesigns.length > 0 && (
                    <p>Study designs: {project.protocol.studyDesigns.join(", ")}</p>
                  )}
                  {project.protocol.setting && <p>Setting: {project.protocol.setting}</p>}
                  {(project.protocol.dateRestrictionFrom || project.protocol.dateRestrictionTo) && (
                    <p>
                      Publication years: {project.protocol.dateRestrictionFrom ?? "No lower bound"}{" "}
                      – {project.protocol.dateRestrictionTo ?? "No upper bound"}
                    </p>
                  )}
                  {project.protocol.languageRestrictions.length > 0 && (
                    <p>Languages: {project.protocol.languageRestrictions.join(", ")}</p>
                  )}
                  {project.protocol.criteria.map((criterion, i) => (
                    <p key={i}>
                      <strong>
                        {criterion.type === "INCLUSION" ? "Inclusion" : "Exclusion"}
                        {criterion.category ? ` · ${criterion.category}` : ""}:
                      </strong>{" "}
                      {criterion.text}
                    </p>
                  ))}
                  {project.protocol.criteria.length === 0 && (
                    <p>
                      No eligibility criteria configured. Confirm eligibility with the review lead.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Current protocol last updated:{" "}
                    {new Date(project.protocol.updatedAt).toLocaleString()}. Version history and
                    amendments are available in the protocol.
                  </p>
                </>
              ) : (
                <p>No protocol configured. Confirm scope with the review lead before screening.</p>
              )}
              <Link
                href={`/projects/${project.id}/protocol`}
                className="inline-block text-primary underline"
              >
                Open protocol and version history
              </Link>
            </div>
          </details>
        </div>
      ))}
      {scope.combined && (
        <p className="text-sm font-medium">
          Article provenance shows where a record was imported, not the full screening scope. One
          decision and note are saved to every linked PICO record.
        </p>
      )}
    </section>
  );
}
