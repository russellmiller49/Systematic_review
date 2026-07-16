// Trial-registry identifier extraction (cohort-overlap detection, docs/AI roadmap Wave 3C).
// Pure, never throws. Scans free-form strings (NBIB SI / RIS AD values, titles, abstracts)
// for registry ids with anchored, case-insensitive patterns and returns canonical UPPERCASE
// forms, deduplicated and sorted for determinism.
//
// Canonical forms:
//   NCT12345678            ClinicalTrials.gov
//   ISRCTN12345678         ISRCTN registry
//   ACTRN12605000123456    Australian NZ registry (14 digits)
//   CHICTR... / CHICTR-XXX-123456   Chinese registry (optional letter infix)
//   DRKS00001234           German registry
//   EUDRACT2016-001234-56  EudraCT — both "EudraCT 2016-001234-56" and
//                          "EUCTR2016-001234-56" normalize to this single form so a
//                          shared European trial matches across databases.

interface RegistryPattern {
  re: RegExp;
  canonical: (match: RegExpMatchArray) => string;
}

// (?<![A-Za-z0-9]) / (?![A-Za-z0-9-]) anchor each id so digits or letters glued to either
// side ("XNCT12345678", "NCT123456789") never produce a partial match. A single space or
// hyphen between prefix and digits is tolerated ("ISRCTN 12345678", "NCT 01796392") —
// registries print both forms.
const PATTERNS: RegistryPattern[] = [
  {
    re: /(?<![A-Za-z0-9])NCT[ -]?(\d{8})(?!\d)/gi,
    canonical: (m) => `NCT${m[1]}`,
  },
  {
    re: /(?<![A-Za-z0-9])ISRCTN[ -]?(\d{8})(?!\d)/gi,
    canonical: (m) => `ISRCTN${m[1]}`,
  },
  {
    re: /(?<![A-Za-z0-9])ACTRN[ -]?(\d{14})(?!\d)/gi,
    canonical: (m) => `ACTRN${m[1]}`,
  },
  {
    re: /(?<![A-Za-z0-9])ChiCTR(-[A-Za-z]+-)?[ ]?(\d+)(?!\d)/gi,
    canonical: (m) => `CHICTR${(m[1] ?? "").toUpperCase()}${m[2]}`,
  },
  {
    re: /(?<![A-Za-z0-9])DRKS[ -]?(\d{8})(?!\d)/gi,
    canonical: (m) => `DRKS${m[1]}`,
  },
  // "EudraCT 2016-001234-56", "EudraCT: 2016-001234-56", "EudraCT number 2016-001234-56"
  {
    re: /(?<![A-Za-z0-9])EudraCT(?:\s+(?:number|no\.?))?[\s:#-]*(\d{4}-\d{6}-\d{2})(?!\d)/gi,
    canonical: (m) => `EUDRACT${m[1]}`,
  },
  // WHO/EU-CTR style: "EUCTR2016-001234-56" (optionally suffixed "/GB" — suffix ignored)
  {
    re: /(?<![A-Za-z0-9])EUCTR(\d{4}-\d{6}-\d{2})(?!\d)/gi,
    canonical: (m) => `EUDRACT${m[1]}`,
  },
];

// Scan the provided strings for trial-registry identifiers. Undefined/empty inputs are
// tolerated so callers can pass optional fields directly.
export function extractRegistryIds(...texts: (string | undefined | null)[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const pattern of PATTERNS) {
      for (const match of text.matchAll(pattern.re)) {
        found.add(pattern.canonical(match));
      }
    }
  }
  return [...found].sort();
}
