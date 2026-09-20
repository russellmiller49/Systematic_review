export interface DedupPublication {
  kind: "conference" | "journal" | "unknown";
  types: string[];
  sources: string[];
}

export function hasConferencePublicationPair(
  citations: { publication?: DedupPublication }[],
): boolean {
  return (
    citations.some((c) => c.publication?.kind === "conference") &&
    citations.some((c) => c.publication?.kind === "journal")
  );
}
