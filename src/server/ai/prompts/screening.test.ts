import { describe, expect, it } from "vitest";
import {
  buildScreeningPrompt,
  SCREENING_PROMPT_VERSION,
  type ScreeningProtocolContext,
} from "./screening";
import { SCREENING_JSON_SCHEMA } from "../schemas";

const PROTOCOL: ScreeningProtocolContext = {
  reviewQuestion: "Does drug X reduce mortality in adults with sepsis?",
  population: "Adults with sepsis",
  intervention: "Drug X",
  comparator: "Placebo",
  outcomesNarrative: "28-day mortality",
  studyDesigns: ["RCT", "Quasi-experimental"],
  setting: "ICU",
  dateRestrictionFrom: 2000,
  dateRestrictionTo: 2025,
  languageRestrictions: ["English"],
  picoQuestions: [
    {
      question: "Primary PICO",
      population: "Adults",
      intervention: "Drug X",
      comparator: "Placebo",
      outcome: "Mortality",
    },
  ],
  inclusionCriteria: [
    { category: "population", text: "Adults 18 years or older" },
    { category: null, text: "Reports mortality outcomes" },
  ],
  exclusionCriteria: [{ category: "design", text: "Case reports and editorials" }],
};

describe("buildScreeningPrompt", () => {
  it("includes protocol context, criteria, and the citation", () => {
    const prompt = buildScreeningPrompt({
      protocol: PROTOCOL,
      citation: {
        title: "A randomized trial of drug X in sepsis",
        abstract: "We enrolled 400 adults...",
        year: 2019,
        journal: "Crit Care Med",
      },
    });
    expect(prompt.user).toContain("Does drug X reduce mortality");
    expect(prompt.user).toContain("1. [population] Adults 18 years or older");
    expect(prompt.user).toContain("2. Reports mortality outcomes");
    expect(prompt.user).toContain("1. [design] Case reports and editorials");
    expect(prompt.user).toContain("Primary PICO");
    expect(prompt.user).toContain("Publication years: 2000 to 2025");
    expect(prompt.user).toContain("Language restrictions: English");
    expect(prompt.user).toContain("Title: A randomized trial of drug X in sepsis");
    expect(prompt.user).toContain("We enrolled 400 adults...");
    expect(prompt.system).toContain("INCLUDE");
    expect(prompt.jsonSchema).toBe(SCREENING_JSON_SCHEMA);
  });

  it("handles a missing abstract and empty protocol sections", () => {
    const prompt = buildScreeningPrompt({
      protocol: {
        ...PROTOCOL,
        reviewQuestion: null,
        picoQuestions: [],
        inclusionCriteria: [],
        exclusionCriteria: [],
        languageRestrictions: [],
        dateRestrictionFrom: null,
        dateRestrictionTo: null,
        studyDesigns: [],
      },
      citation: { title: "Only a title", abstract: "   ", year: null, journal: null },
    });
    expect(prompt.user).toContain("No abstract is available");
    expect(prompt.user).toContain("(none recorded)");
    expect(prompt.user).not.toContain("Review question:");
    expect(prompt.user).not.toContain("Publication years:");
  });

  it("has a stable version constant", () => {
    expect(SCREENING_PROMPT_VERSION).toBe("screening-v1");
  });
});
