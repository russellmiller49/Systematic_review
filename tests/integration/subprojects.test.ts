// Guideline families: PICO sub-projects (creation guards, member copy, family payload),
// the shared reference library (root-scoped rows, family-wide dedupe, via-project
// permissions), and the compiled guideline manuscript (PICO defaults, outline access
// rules, whole-guideline DOCX export).
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as projects from "@/server/services/projects";
import * as references from "@/server/services/references";
import * as manuscript from "@/server/services/manuscript";
import { resetDb } from "../db-utils";
import {
  addOrgMember,
  addProjectMember,
  createTestCitation,
  createTestOrg,
  createTestProject,
  createTestUser,
} from "../factories";

const ctx = (userId: string) => ({ userId });

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
    expect.fail(`expected AppError(${code}) but call succeeded`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error("unreachable");
}

async function createGuidelineFamily() {
  const owner = await createTestUser({ name: "Guideline Owner" });
  const org = await createTestOrg(owner.id);
  const guideline = await projects.createProject(ctx(owner.id), org.id, {
    title: "Effusion Guideline",
    reviewType: "GUIDELINE_EVIDENCE_REVIEW",
    isGuideline: true,
  });
  const kq1 = await projects.createSubProject(ctx(owner.id), guideline.id, {
    title: "PICO 1 — IPC vs pleurodesis",
    researchQuestion: "In adults with MPE, does IPC vs talc pleurodesis improve dyspnea?",
  });
  const kq2 = await projects.createSubProject(ctx(owner.id), guideline.id, {
    title: "PICO 2 — Poudrage vs slurry",
    researchQuestion: "In adults with MPE, does poudrage vs slurry improve pleurodesis success?",
  });
  return { owner, org, guideline, kq1, kq2 };
}

const cslFor = (title: string, doi: string) => ({
  type: "article-journal",
  title,
  author: [{ family: "Author", given: "A" }],
  issued: { "date-parts": [[2021]] },
  "container-title": "Journal",
  DOI: doi,
});

describe("guideline sub-projects", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("createSubProject copies the team, inherits config, prefills the protocol, audits both sides", async () => {
    const owner = await createTestUser({ name: "Owner" });
    const admin = await createTestUser({ name: "Admin" });
    const librarian = await createTestUser({ name: "Librarian" });
    const org = await createTestOrg(owner.id);
    await addOrgMember(org.id, admin.id);
    await addOrgMember(org.id, librarian.id);
    const guideline = await projects.createProject(ctx(owner.id), org.id, {
      title: "Config Guideline",
      reviewType: "GUIDELINE_EVIDENCE_REVIEW",
      isGuideline: true,
      dualScreening: true,
      reviewersPerCitation: 3,
      blindedScreening: false,
    });
    await addProjectMember(guideline.id, admin.id, ["ADMIN"]);
    await addProjectMember(guideline.id, librarian.id, ["LIBRARIAN"]);

    // A non-owner ADMIN creates the sub-project: they gain OWNER there, on top of the
    // roles copied from the guideline.
    const sub = await projects.createSubProject(ctx(admin.id), guideline.id, {
      title: "PICO A",
      researchQuestion: "In P does I vs C improve O?",
    });
    expect(sub.orgId).toBe(org.id);
    expect(sub.parentProjectId).toBe(guideline.id);
    expect(sub.reviewType).toBe("GUIDELINE_EVIDENCE_REVIEW");
    expect(sub.isGuideline).toBe(false);

    const protocol = await prisma.protocol.findUniqueOrThrow({ where: { projectId: sub.id } });
    expect(protocol.reviewQuestion).toBe("In P does I vs C improve O?");

    const members = await prisma.projectMember.findMany({ where: { projectId: sub.id } });
    const byUser = new Map(members.map((m) => [m.userId, m.roles]));
    expect(byUser.get(owner.id)).toEqual(["OWNER"]);
    expect(byUser.get(librarian.id)).toEqual(["LIBRARIAN"]);
    expect(byUser.get(admin.id)).toEqual(expect.arrayContaining(["OWNER", "ADMIN"]));

    // Screening config mirrors the guideline's title/abstract stage.
    expect(sub.screeningStages).toHaveLength(2);
    for (const stage of sub.screeningStages) {
      expect(stage.reviewersPerCitation).toBe(3);
      expect(stage.blinded).toBe(false);
    }

    const parentEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { projectId: guideline.id, action: "project.subproject.created" },
    });
    expect(parentEvent.entityId).toBe(sub.id);
    const subEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { projectId: sub.id, action: "project.created" },
    });
    expect(subEvent.newValue).toMatchObject({ parentProjectId: guideline.id });
  });

  it("rejects sub-projects under non-guidelines, nesting, and callers without project.edit", async () => {
    const { owner, org, guideline, kq1 } = await createGuidelineFamily();

    const standard = await createTestProject(org.id, owner.id);
    await expectAppError(
      projects.createSubProject(ctx(owner.id), standard.id, {
        title: "Nope",
        researchQuestion: "Should not work at all?",
      }),
      "INVALID_STATE",
    );

    await expectAppError(
      projects.createSubProject(ctx(owner.id), kq1.id, {
        title: "Nested",
        researchQuestion: "Sub of a sub should fail?",
      }),
      "INVALID_STATE",
    );

    const reviewer = await createTestUser({ name: "Reviewer" });
    await addOrgMember(org.id, reviewer.id);
    await addProjectMember(guideline.id, reviewer.id, ["REVIEWER"]);
    await expectAppError(
      projects.createSubProject(ctx(reviewer.id), guideline.id, {
        title: "No rights",
        researchQuestion: "Reviewer cannot create sub-projects?",
      }),
      "FORBIDDEN",
    );
  });

  it("exposes the family via listSubProjects and getProject", async () => {
    const { owner, guideline, kq1, kq2 } = await createGuidelineFamily();

    const subs = await projects.listSubProjects(ctx(owner.id), guideline.id);
    expect(subs.map((s) => s.id)).toEqual([kq1.id, kq2.id]);
    expect(subs[0]?._count).toMatchObject({ citations: 0, studies: 0, members: 1 });

    const parentView = await projects.getProject(ctx(owner.id), guideline.id);
    expect(parentView.isGuideline).toBe(true);
    expect(parentView.parentProject).toBeNull();
    expect(parentView.subProjects.map((s) => s.id)).toEqual([kq1.id, kq2.id]);

    const subView = await projects.getProject(ctx(owner.id), kq1.id);
    expect(subView.isGuideline).toBe(false);
    expect(subView.parentProject).toMatchObject({ id: guideline.id, title: "Effusion Guideline" });

    // Org membership alone does not open the family payload (R10 project boundary).
    const outsider = await createTestUser({ name: "Outsider" });
    await expectAppError(projects.listSubProjects(ctx(outsider.id), guideline.id), "FORBIDDEN");
  });

  it("converts an owned standalone project without losing its work, team, or manuscript references", async () => {
    const owner = await createTestUser({ name: "Conversion Owner" });
    const guidelineAdmin = await createTestUser({ name: "Guideline Admin" });
    const existingReviewer = await createTestUser({ name: "Existing Reviewer" });
    const org = await createTestOrg(owner.id);
    await addOrgMember(org.id, guidelineAdmin.id);
    await addOrgMember(org.id, existingReviewer.id);

    const guideline = await projects.createProject(ctx(owner.id), org.id, {
      title: "Existing Reviews Guideline",
      reviewType: "GUIDELINE_EVIDENCE_REVIEW",
      isGuideline: true,
    });
    await addProjectMember(guideline.id, guidelineAdmin.id, ["ADMIN"]);

    const standalone = await projects.createProject(ctx(owner.id), org.id, {
      title: "Previously completed PICO",
      reviewType: "SYSTEMATIC_REVIEW_META_ANALYSIS",
      dualScreening: true,
      reviewersPerCitation: 3,
      blindedScreening: false,
    });
    await addProjectMember(standalone.id, existingReviewer.id, ["REVIEWER"]);
    await prisma.protocol.update({
      where: { projectId: standalone.id },
      data: { reviewQuestion: "In adults with prior work, does conversion preserve the review?" },
    });
    const citation = await createTestCitation(standalone.id, {
      title: "Preserved evidence report",
      doi: "10.9000/preserved",
    });
    const reference = await references.createReference(ctx(owner.id), standalone.id, {
      csl: cslFor("Reference cited before conversion", "10.9000/reference-before-conversion"),
      citationId: citation.id,
    });
    const standaloneManuscript = await manuscript.getManuscript(ctx(owner.id), standalone.id);
    const firstSection = standaloneManuscript.sections[0]!;
    await prisma.manuscriptSection.update({
      where: { id: firstSection.id },
      data: {
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "This citation must survive " },
                { type: "citation", attrs: { referenceIds: [reference.id] } },
              ],
            },
          ],
        },
      },
    });
    const originalStageIds = standalone.screeningStages.map((stage) => stage.id).sort();

    const candidates = await projects.listConvertibleProjects(ctx(owner.id), guideline.id);
    expect(candidates.map((candidate) => candidate.id)).toContain(standalone.id);
    expect(candidates.find((candidate) => candidate.id === standalone.id)?._count).toMatchObject({
      citations: 1,
      referenceEntries: 1,
      members: 2,
    });

    const converted = await projects.convertProjectToSubProject(ctx(owner.id), guideline.id, {
      sourceProjectId: standalone.id,
    });
    expect(converted).toMatchObject({
      id: standalone.id,
      parentProjectId: guideline.id,
      reviewType: "SYSTEMATIC_REVIEW_META_ANALYSIS",
      researchQuestion: "In adults with prior work, does conversion preserve the review?",
    });

    // Workflow rows and configuration keep their identities.
    const stagesAfter = await prisma.screeningStage.findMany({
      where: { projectId: standalone.id },
      orderBy: { id: "asc" },
    });
    expect(stagesAfter.map((stage) => stage.id).sort()).toEqual(originalStageIds);
    expect(stagesAfter.every((stage) => stage.reviewersPerCitation === 3)).toBe(true);
    expect(stagesAfter.every((stage) => stage.blinded === false)).toBe(true);
    await expect(
      prisma.citation.findUniqueOrThrow({ where: { id: citation.id } }),
    ).resolves.toMatchObject({ projectId: standalone.id });

    // Reference IDs do not change, so pre-conversion manuscript citation nodes resolve
    // through the guideline's shared library.
    const movedReference = await prisma.referenceEntry.findUniqueOrThrow({
      where: { id: reference.id },
    });
    expect(movedReference.projectId).toBe(guideline.id);
    const citeMap = await manuscript.getCiteMap(ctx(owner.id), standalone.id);
    expect(citeMap.orderedReferenceIds).toEqual([reference.id]);
    expect(citeMap.markers[reference.id]).toBeTruthy();

    const memberships = await prisma.projectMember.findMany({
      where: { projectId: standalone.id },
    });
    const rolesByUser = new Map(memberships.map((member) => [member.userId, member.roles]));
    expect(rolesByUser.get(owner.id)).toEqual(["OWNER"]);
    expect(rolesByUser.get(existingReviewer.id)).toEqual(["REVIEWER"]);
    expect(rolesByUser.get(guidelineAdmin.id)).toEqual(["ADMIN"]);

    const parentView = await projects.getProject(ctx(owner.id), guideline.id);
    expect(parentView.subProjects.map((project) => project.id)).toContain(standalone.id);
    const compiled = await manuscript.getCompiledGuideline(ctx(owner.id), guideline.id);
    expect(compiled.parts.map((part) => part.projectId)).toEqual([
      guideline.id,
      standalone.id,
    ]);
    expect(
      compiled.parts.find((part) => part.projectId === standalone.id)?.sections.map(
        (section) => section.id,
      ),
    ).toContain(firstSection.id);
    const remainingCandidates = await projects.listConvertibleProjects(ctx(owner.id), guideline.id);
    expect(remainingCandidates.map((candidate) => candidate.id)).not.toContain(standalone.id);

    const events = await prisma.auditEvent.findMany({
      where: {
        action: "project.subproject.converted",
        entityId: standalone.id,
      },
    });
    expect(events.map((event) => event.projectId).sort()).toEqual(
      [guideline.id, standalone.id].sort(),
    );
    expect(events[0]?.metadata).toMatchObject({
      movedReferences: 1,
      addedGuidelineMembers: 1,
      preservedExistingMembers: 2,
    });
  });

  it("requires ownership of both projects", async () => {
    const guidelineOwner = await createTestUser({ name: "Guideline Owner" });
    const standaloneOwner = await createTestUser({ name: "Standalone Owner" });
    const org = await createTestOrg(guidelineOwner.id);
    await addOrgMember(org.id, standaloneOwner.id);

    const guideline = await projects.createProject(ctx(guidelineOwner.id), org.id, {
      title: "Owner-only Guideline",
      reviewType: "GUIDELINE_EVIDENCE_REVIEW",
      isGuideline: true,
    });
    await addProjectMember(guideline.id, standaloneOwner.id, ["ADMIN"]);
    const standalone = await projects.createProject(ctx(standaloneOwner.id), org.id, {
      title: "Separately Owned Review",
      reviewType: "SYSTEMATIC_REVIEW",
    });
    await addProjectMember(standalone.id, guidelineOwner.id, ["ADMIN"]);

    await expectAppError(
      projects.listConvertibleProjects(ctx(standaloneOwner.id), guideline.id),
      "FORBIDDEN",
    );
    await expect(projects.listConvertibleProjects(ctx(guidelineOwner.id), guideline.id)).resolves
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: standalone.id })]));
    await expectAppError(
      projects.convertProjectToSubProject(ctx(standaloneOwner.id), guideline.id, {
        sourceProjectId: standalone.id,
      }),
      "FORBIDDEN",
    );
    await expectAppError(
      projects.convertProjectToSubProject(ctx(guidelineOwner.id), guideline.id, {
        sourceProjectId: standalone.id,
      }),
      "FORBIDDEN",
    );

    const unchanged = await prisma.project.findUniqueOrThrow({ where: { id: standalone.id } });
    expect(unchanged.parentProjectId).toBeNull();
  });

  it("rejects duplicate shared references atomically", async () => {
    const owner = await createTestUser({ name: "Collision Owner" });
    const org = await createTestOrg(owner.id);
    const guideline = await projects.createProject(ctx(owner.id), org.id, {
      title: "Reference Collision Guideline",
      reviewType: "GUIDELINE_EVIDENCE_REVIEW",
      isGuideline: true,
    });
    const standalone = await projects.createProject(ctx(owner.id), org.id, {
      title: "Reference Collision Review",
      reviewType: "SYSTEMATIC_REVIEW",
    });
    await references.createReference(ctx(owner.id), guideline.id, {
      csl: cslFor("Guideline copy", "10.9000/conversion-collision"),
    });
    const standaloneReference = await references.createReference(ctx(owner.id), standalone.id, {
      csl: cslFor("Standalone copy", "10.9000/conversion-collision"),
    });

    const err = await expectAppError(
      projects.convertProjectToSubProject(ctx(owner.id), guideline.id, {
        sourceProjectId: standalone.id,
      }),
      "CONFLICT",
    );
    expect(err.message).toContain("duplicate reference");
    expect(err.message).toContain("10.9000/conversion-collision");

    const unchanged = await prisma.project.findUniqueOrThrow({ where: { id: standalone.id } });
    expect(unchanged.parentProjectId).toBeNull();
    const unchangedReference = await prisma.referenceEntry.findUniqueOrThrow({
      where: { id: standaloneReference.id },
    });
    expect(unchangedReference.projectId).toBe(standalone.id);
    expect(
      await prisma.auditEvent.count({
        where: { action: "project.subproject.converted", entityId: standalone.id },
      }),
    ).toBe(0);
  });
});

describe("shared guideline reference library", () => {
  it("stores sub-project references on the root, visible family-wide, permissioned via the sub", async () => {
    const { owner, org, guideline, kq1, kq2 } = await createGuidelineFamily();
    const libUser = await createTestUser({ name: "KQ1 Librarian" });
    await addOrgMember(org.id, libUser.id);
    await addProjectMember(kq1.id, libUser.id, ["LIBRARIAN"]);

    const entry = await references.createReference(ctx(libUser.id), kq1.id, {
      csl: cslFor("Added from the PICO workflow", "10.9000/shared1"),
      tags: ["background"],
    });
    const row = await prisma.referenceEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(row.projectId).toBe(guideline.id); // rows live on the family root

    const viaGuideline = await references.listReferences(ctx(owner.id), guideline.id);
    const viaOtherSub = await references.listReferences(ctx(owner.id), kq2.id);
    expect(viaGuideline.map((r) => r.id)).toContain(entry.id);
    expect(viaOtherSub.map((r) => r.id)).toContain(entry.id);

    // The permission boundary is the project the caller works through: libUser is not a
    // guideline member, so the same pool is closed to them at the guideline surface.
    await expectAppError(references.listReferences(ctx(libUser.id), guideline.id), "FORBIDDEN");

    // Audit lands on the root's trail and records the via-project.
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { projectId: guideline.id, action: "reference.created", entityId: entry.id },
    });
    expect(event.metadata).toMatchObject({ viaProjectId: kq1.id });
  });

  it("dedupes DOIs across the whole family", async () => {
    const { owner, guideline, kq2 } = await createGuidelineFamily();
    await references.createReference(ctx(owner.id), guideline.id, {
      csl: cslFor("Root copy", "10.9000/dupe1"),
    });
    await expectAppError(
      references.createReference(ctx(owner.id), kq2.id, {
        csl: cslFor("Sub copy of the same DOI", "10.9000/dupe1"),
      }),
      "CONFLICT",
    );
  });

  it("addFromCitations mirrors the sub's own included studies; the guideline aggregates every sub", async () => {
    const { owner, guideline, kq1, kq2 } = await createGuidelineFamily();
    const stageFor = (sub: { screeningStages: { id: string; type: string }[] }) =>
      sub.screeningStages.find((s) => s.type === "FULL_TEXT")!;

    const inc1 = await createTestCitation(kq1.id, { doi: "10.9000/inc1" });
    await prisma.citationStageResult.create({
      data: {
        stageId: stageFor(kq1).id,
        citationId: inc1.id,
        outcome: "INCLUDE",
        resolvedVia: "CONSENSUS",
      },
    });
    const inc2 = await createTestCitation(kq2.id, { doi: "10.9000/inc2" });
    await prisma.citationStageResult.create({
      data: {
        stageId: stageFor(kq2).id,
        citationId: inc2.id,
        outcome: "INCLUDE",
        resolvedVia: "CONSENSUS",
      },
    });

    // Working inside PICO 1 mirrors only PICO 1's included studies…
    const fromSub = await references.addFromCitations(ctx(owner.id), kq1.id, {});
    expect(fromSub).toMatchObject({ added: 1, skipped: 0 });
    const mirrored = await prisma.referenceEntry.findFirstOrThrow({
      where: { citationId: inc1.id },
    });
    expect(mirrored.projectId).toBe(guideline.id);

    // …while the guideline surface aggregates all subs (PICO 1's copy skips as mirrored).
    const fromGuideline = await references.addFromCitations(ctx(owner.id), guideline.id, {});
    expect(fromGuideline).toMatchObject({ added: 1, skipped: 1 });
    const all = await references.listReferences(ctx(owner.id), guideline.id);
    expect(all.map((r) => r.citationId).filter(Boolean).sort()).toEqual(
      [inc1.id, inc2.id].sort(),
    );
  });

  it("formats one family bibliography and resolves cite maps from any member project", async () => {
    const { owner, guideline, kq1 } = await createGuidelineFamily();
    const rootRef = await references.createReference(ctx(owner.id), guideline.id, {
      csl: cslFor("Cited from a PICO manuscript", "10.9000/cite1"),
    });

    const bib = await references.formatBibliography(ctx(owner.id), kq1.id, {});
    expect(bib.entries.map((e) => e.referenceId)).toContain(rootRef.id);

    // A PICO manuscript citing the root-scoped reference resolves markers + bibliography.
    const kq1Ms = await manuscript.getManuscript(ctx(owner.id), kq1.id);
    const question = kq1Ms.sections[0]!;
    await prisma.manuscriptSection.update({
      where: { id: question.id },
      data: {
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Evidence exists " },
                { type: "citation", attrs: { referenceIds: [rootRef.id] } },
              ],
            },
          ],
        },
      },
    });
    const citeMap = await manuscript.getCiteMap(ctx(owner.id), kq1.id);
    expect(citeMap.orderedReferenceIds).toEqual([rootRef.id]);
    expect(citeMap.markers[rootRef.id]).toBeTruthy();
    expect(citeMap.bibliography.map((e) => e.referenceId)).toEqual([rootRef.id]);
  });
});

describe("guideline manuscript compilation", () => {
  it("seeds PICO sections for subs and IMRaD for the guideline", async () => {
    const { owner, guideline, kq1 } = await createGuidelineFamily();
    const parentMs = await manuscript.getManuscript(ctx(owner.id), guideline.id);
    expect(parentMs.sections.map((s) => s.kind)).toContain("INTRODUCTION");
    expect(parentMs.sections).toHaveLength(8);

    const subMs = await manuscript.getManuscript(ctx(owner.id), kq1.id);
    expect(subMs.sections.map((s) => s.title)).toEqual([
      "Question",
      "Evidence summary",
      "Certainty of evidence",
      "Recommendation",
      "Rationale and considerations",
    ]);
  });

  it("compiles the outline in order and reports subs the caller cannot view", async () => {
    const { owner, org, guideline, kq1, kq2 } = await createGuidelineFamily();

    const compiled = await manuscript.getCompiledGuideline(ctx(owner.id), guideline.id);
    expect(compiled.canExportAll).toBe(true);
    expect(compiled.skipped).toEqual([]);
    expect(compiled.parts.map((p) => p.projectId)).toEqual([guideline.id, kq1.id, kq2.id]);
    expect(compiled.parts[0]?.isParent).toBe(true);
    expect(compiled.parts.map((p) => p.picoNumber)).toEqual([null, 1, 2]);

    // A guideline-only member sees the outline but the PICO parts are skipped.
    const panelist = await createTestUser({ name: "Panelist" });
    await addOrgMember(org.id, panelist.id);
    await addProjectMember(guideline.id, panelist.id, ["PANEL_MEMBER"]);
    const partial = await manuscript.getCompiledGuideline(ctx(panelist.id), guideline.id);
    expect(partial.parts.map((p) => p.projectId)).toEqual([guideline.id]);
    expect(partial.skipped.map((s) => s.projectId).sort()).toEqual([kq1.id, kq2.id].sort());
    expect(partial.canExportAll).toBe(false);

    await expectAppError(manuscript.getCompiledGuideline(ctx(owner.id), kq1.id), "INVALID_STATE");
  });

  it("exports the whole guideline only with access to every sub; the DOCX is audited", async () => {
    const { owner, org, guideline } = await createGuidelineFamily();

    const panelist = await createTestUser({ name: "Blocked Panelist" });
    await addOrgMember(org.id, panelist.id);
    await addProjectMember(guideline.id, panelist.id, ["PANEL_MEMBER"]);
    const err = await expectAppError(
      manuscript.exportGuidelineDocx(ctx(panelist.id), guideline.id),
      "FORBIDDEN",
    );
    expect(err.message).toContain("PICO 1 — IPC vs pleurodesis");

    const { filename, buffer } = await manuscript.exportGuidelineDocx(ctx(owner.id), guideline.id);
    expect(filename).toBe("effusion-guideline-guideline.docx");
    expect(buffer.length).toBeGreaterThan(1000);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { projectId: guideline.id, action: "manuscript.exported" },
    });
    expect(event.metadata).toMatchObject({ compiledGuideline: true, projectCount: 3 });
  });
});
