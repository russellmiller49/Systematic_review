// In-text citation rendering shared by the editor chip AND the DOCX mapper, so what's
// on screen always matches the export.

export interface CiteMapLike {
  numeric: boolean;
  markers: Record<string, string>; // referenceId → marker CORE ("1", "Smith & Jones, 2020")
}

export function formatCiteMarker(referenceIds: string[], citeMap: CiteMapLike | null): string {
  if (referenceIds.length === 0 || !citeMap) return "[?]";
  const cores = referenceIds.map((id) => citeMap.markers[id] ?? "?");
  return citeMap.numeric ? `[${cores.join(", ")}]` : `(${cores.join("; ")})`;
}
