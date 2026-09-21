import { normalizeDoi } from "@/server/services/citations/normalize";
import { clusterMetadataConflicts, type ConflictCitation } from "./conflicts";
import { connectedComponents } from "./graph";
import {
  hasConferencePublicationPair,
  type DedupPublication,
} from "@/lib/dedup-publication";

type Member = ConflictCitation & {
  id: string;
  projectId: string;
  status: string;
  publication?: DedupPublication;
};
type Candidate = {
  projectId: string;
  citationAId: string;
  citationBId: string;
  status: string;
  method: string;
  score: number;
  citationA: Member;
  citationB: Member;
};

export function exactDoiEligible(
  projectId: string,
  candidates: Candidate[],
): boolean {
  const suggested = candidates.filter(
    (candidate) => candidate.status === "SUGGESTED",
  );
  const memberIds = new Set(
    suggested.flatMap((candidate) => [
      candidate.citationAId,
      candidate.citationBId,
    ]),
  );
  // Decided rows retain their original group even after suggestions split. An
  // external companion edge must not disqualify the remaining duplicate copies.
  // The service also checks project-wide companion edges through canonical roots.
  if (
    connectedComponents(suggested).length !== 1 ||
    candidates.some(
      (candidate) =>
        candidate.status === "REJECTED" ||
        (candidate.status === "COMPANION" &&
          memberIds.has(candidate.citationAId) &&
          memberIds.has(candidate.citationBId)),
    ) ||
    !suggested.every(
      (candidate) =>
        candidate.projectId === projectId &&
        candidate.method === "EXACT_DOI" &&
        candidate.score === 1,
    )
  )
    return false;
  const members = [
    ...new Map(
      suggested.flatMap((candidate) =>
        [candidate.citationA, candidate.citationB].map(
          (citation) => [citation.id, citation] as const,
        ),
      ),
    ).values(),
  ];
  const dois = members.map((citation) => normalizeDoi(citation.doi));
  return (
    members.length >= 2 &&
    members.every(
      (citation) =>
        citation.status === "ACTIVE" && citation.projectId === projectId,
    ) &&
    dois.every((doi) => doi !== null) &&
    new Set(dois).size === 1 &&
    !hasConferencePublicationPair(members) &&
    clusterMetadataConflicts(members).length === 0
  );
}
