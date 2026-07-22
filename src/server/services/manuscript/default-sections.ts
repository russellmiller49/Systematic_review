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
