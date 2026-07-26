const TEXT_LIMITS = {
  background: 50_000,
  reviewQuestion: 10_000,
  population: 10_000,
  intervention: 10_000,
  comparator: 10_000,
  outcomesNarrative: 20_000,
  setting: 10_000,
  searchStrategyNotes: 20_000,
  subgroupAnalysisPlan: 20_000,
  sensitivityAnalysisPlan: 20_000,
  metaAnalysisPlan: 20_000,
  gradePlan: 20_000,
} as const;

const LIST_KEYS = [
  "studyDesigns",
  "languageRestrictions",
  "databases",
  "grayLiteratureSources",
] as const;

const FIELD_LABELS: Record<keyof typeof TEXT_LIMITS | (typeof LIST_KEYS)[number], string> = {
  background: "Background",
  reviewQuestion: "Review question",
  population: "Population",
  intervention: "Intervention / exposure",
  comparator: "Comparator",
  outcomesNarrative: "Outcomes (narrative)",
  studyDesigns: "Study designs",
  setting: "Setting",
  languageRestrictions: "Language restrictions",
  databases: "Databases",
  grayLiteratureSources: "Gray literature sources",
  searchStrategyNotes: "Search strategy notes",
  subgroupAnalysisPlan: "Subgroup analyses",
  sensitivityAnalysisPlan: "Sensitivity analyses",
  metaAnalysisPlan: "Meta-analysis plan",
  gradePlan: "GRADE / certainty of evidence plan",
};

function count(value: number): string {
  return value.toLocaleString("en-US");
}

// Mirrors updateProtocolSchema's limits so the overview form can explain invalid
// content before sending it. The server remains authoritative.
export function validateOverviewPatch(patch: object): string | null {
  const values = patch as Record<string, unknown>;
  for (const [key, max] of Object.entries(TEXT_LIMITS)) {
    const value = values[key];
    if (typeof value === "string" && value.length > max) {
      const label = FIELD_LABELS[key as keyof typeof TEXT_LIMITS];
      return `${label} is ${count(value.length)} characters; the maximum is ${count(max)}.`;
    }
  }

  for (const key of LIST_KEYS) {
    const value = values[key];
    if (!Array.isArray(value)) continue;
    if (value.length > 200) {
      return `${FIELD_LABELS[key]} has ${count(value.length)} entries; the maximum is 200.`;
    }
    const longIndex = value.findIndex((item) => typeof item === "string" && item.length > 500);
    if (longIndex >= 0) {
      const item = value[longIndex] as string;
      return `${FIELD_LABELS[key]} line ${longIndex + 1} is ${count(item.length)} characters; the maximum is 500. Keep one item per line.`;
    }
  }

  return null;
}
