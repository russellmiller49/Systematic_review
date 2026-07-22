import type { ManuscriptSectionKind } from "@prisma/client";

// IMRaD default set, seeded when a project's manuscript is first opened. References is
// NOT a stored section — it is rendered virtually from citation usage.
export const DEFAULT_SECTIONS: { title: string; kind: ManuscriptSectionKind }[] = [
  { title: "Title page", kind: "TITLE_PAGE" },
  { title: "Abstract", kind: "ABSTRACT" },
  { title: "Introduction", kind: "INTRODUCTION" },
  { title: "Methods", kind: "METHODS" },
  { title: "Results", kind: "RESULTS" },
  { title: "Discussion", kind: "DISCUSSION" },
  { title: "Conclusion", kind: "CONCLUSION" },
  { title: "Acknowledgments", kind: "ACKNOWLEDGMENTS" },
];

// Defaults for a guideline PICO sub-project: the general IMRaD material (introduction,
// overall methods, conclusions, …) lives in the PARENT guideline's manuscript; a PICO
// manuscript holds only the sections specific to that question. Fully editable like any
// other manuscript — these are just the starting set.
export const PICO_SECTIONS: { title: string; kind: ManuscriptSectionKind }[] = [
  { title: "Question", kind: "CUSTOM" },
  { title: "Evidence summary", kind: "RESULTS" },
  { title: "Certainty of evidence", kind: "CUSTOM" },
  { title: "Recommendation", kind: "CUSTOM" },
  { title: "Rationale and considerations", kind: "DISCUSSION" },
];
