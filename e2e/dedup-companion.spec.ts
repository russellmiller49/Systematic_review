import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { signUp, expectNoErrorOverlay } from "./helpers";

test("classify, reopen, and group five separate reports; included companions share one study", async ({
  page,
}) => {
  const db = new PrismaClient();
  try {
    await signUp(
      page,
      "Companion reviewer",
      `companion-${Date.now()}@test.local`,
    );
    const orgResponse = await page.request.post("/api/orgs", {
      data: { name: `Companion QA ${Date.now()}` },
    });
    expect(orgResponse.ok()).toBeTruthy();
    const org = (await orgResponse.json()).data;
    const projectResponse = await page.request.post(
      `/api/orgs/${org.id}/projects`,
      {
        data: {
          title: "Five UCL reports",
          reviewType: "SYSTEMATIC_REVIEW",
          reviewersPerCitation: 1,
          dualScreening: false,
        },
      },
    );
    expect(projectResponse.ok()).toBeTruthy();
    const project = (await projectResponse.json()).data;
    const sourceResponse = await page.request.post(
      `/api/projects/${project.id}/import-sources`,
      { data: { name: "Conference reports" } },
    );
    const source = (await sourceResponse.json()).data;
    const journals = [
      "United European Gastroenterology Journal",
      "Diseases of the Esophagus",
      "Gut",
      "Endoscopy",
      "Frontline Gastroenterology",
    ];
    const content = journals
      .map(
        (journal, i) =>
          `TY  - JOUR\nTI  - UCL cohort treatment outcomes\nAU  - Smith, A\nPY  - ${i < 3 ? 2024 : 2025}\nJO  - ${journal}\nM3  - ${i === 4 ? "Journal Article" : "Conference Abstract"}\nDO  - 10.1234/ucl-e2e-${i}\nAB  - UCL, 2019–2023: 26 patients with overlapping treatment and follow-up results. Report ${i + 1}.\nER  -`,
      )
      .join("\n\n");
    const imported = await page.request.post(
      `/api/projects/${project.id}/imports`,
      {
        multipart: {
          sourceId: source.id,
          format: "RIS",
          file: {
            name: "reports.ris",
            mimeType: "text/plain",
            buffer: Buffer.from(content),
          },
        },
      },
    );
    expect(imported.ok()).toBeTruthy();
    const batch = (await imported.json()).data;
    expect(
      (
        await page.request.post(
          `/api/projects/${project.id}/imports/${batch.id}/commit`,
        )
      ).ok(),
    ).toBeTruthy();
    expect(
      (await page.request.post(`/api/projects/${project.id}/dedup/run`)).ok(),
    ).toBeTruthy();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`/projects/${project.id}/dedup`);
    await page
      .getByRole("button", { name: /UCL cohort treatment outcomes/ })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Same study / separate report",
        exact: true,
      }),
    ).toHaveCount(10);
    await page
      .getByRole("button", {
        name: "Same study / separate report",
        exact: true,
      })
      .first()
      .click();
    await expect
      .poll(() =>
        db.deduplicationCandidate.count({
          where: { projectId: project.id, status: "COMPANION" },
        }),
      )
      .toBe(1);
    await page.getByRole("tab", { name: "Resolved", exact: true }).click();
    await expect(
      page.getByText("Same study / separate report", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Reopen decision" }).click();
    await expect(page.getByText("Pair reopened for review")).toBeVisible();
    await page.getByRole("tab", { name: /Open groups/ }).click();
    await page
      .getByRole("button", { name: /UCL cohort treatment outcomes/ })
      .click();
    await page
      .getByRole("button", {
        name: "Mark all as separate reports of the same study",
      })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText(/All 5 citations will stay active/),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Confirm separate reports" })
      .click();
    await expect(page.getByText("No duplicate candidates")).toBeVisible();
    expect(
      await db.citation.count({
        where: { projectId: project.id, status: "ACTIVE", duplicateOfId: null },
      }),
    ).toBe(5);
    expect(await db.study.count({ where: { projectId: project.id } })).toBe(0);
    expect(
      await db.deduplicationCandidate.count({
        where: { projectId: project.id, status: "COMPANION" },
      }),
    ).toBe(10);
    await page.goto(`/projects/${project.id}/extraction`);
    await page.getByRole("tab", { name: "Companions" }).click();
    await expect(
      page.getByText("Confirmed during deduplication", { exact: true }),
    ).toHaveCount(10);
    await expect(
      page.getByRole("button", { name: "Link", exact: true }),
    ).toHaveCount(0);

    const me = (await (await page.request.get("/api/me")).json()).data.user;
    const citations = await db.citation.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "asc" },
    });
    const ta = await db.screeningStage.findFirstOrThrow({
      where: { projectId: project.id, type: "TITLE_ABSTRACT" },
    });
    const ft = await db.screeningStage.findFirstOrThrow({
      where: { projectId: project.id, type: "FULL_TEXT" },
    });
    // Setup prior TA eligibility, then settle FT through the real authenticated API.
    for (const citation of citations.slice(0, 2)) {
      await db.citationStageResult.create({
        data: {
          stageId: ta.id,
          citationId: citation.id,
          outcome: "INCLUDE",
          resolvedVia: "SINGLE_REVIEWER",
        },
      });
      await db.screeningAssignment.create({
        data: { stageId: ft.id, citationId: citation.id, reviewerId: me.id },
      });
      const result = await page.request.post(
        `/api/projects/${project.id}/screening/stages/${ft.id}/decisions`,
        { data: { citationId: citation.id, decision: "INCLUDE" } },
      );
      expect(result.ok(), await result.text()).toBeTruthy();
    }
    expect(await db.study.count({ where: { projectId: project.id } })).toBe(1);
    expect(
      await db.studyReportLink.count({
        where: { study: { projectId: project.id } },
      }),
    ).toBe(2);
    await page.reload();
    await page.getByRole("tab", { name: "Companions" }).click();
    await expect(page.getByText(/These reports share one study/)).toHaveCount(
      1,
    );
    await page.screenshot({
      path: "/tmp/companion-reports-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "/tmp/companion-reports-mobile.png",
      fullPage: true,
    });
    await expectNoErrorOverlay(page);
    expect(errors).toEqual([]);
  } finally {
    await db.$disconnect();
  }
});

test("merge PubMed and Embase copies inside a companion family while protecting explicit separate reports", async ({
  page,
}) => {
  const db = new PrismaClient();
  try {
    await signUp(
      page,
      "Duplicate reviewer",
      `companion-copies-${Date.now()}@test.local`,
    );
    const orgResponse = await page.request.post("/api/orgs", {
      data: { name: `Duplicate copies QA ${Date.now()}` },
    });
    expect(orgResponse.ok()).toBeTruthy();
    const org = (await orgResponse.json()).data;
    const projectResponse = await page.request.post(
      `/api/orgs/${org.id}/projects`,
      {
        data: {
          title: "Duplicate copies within a study family",
          reviewType: "SYSTEMATIC_REVIEW",
          reviewersPerCitation: 1,
          dualScreening: false,
        },
      },
    );
    expect(projectResponse.ok()).toBeTruthy();
    const project = (await projectResponse.json()).data;
    const title =
      "Prospective trial of biodegradable stents for refractory benign esophageal strictures after curative treatment of esophageal cancer";
    const citations = [];
    for (let i = 0; i < 4; i++) {
      citations.push(
        await db.citation.create({
          data: {
            projectId: project.id,
            title,
            normalizedTitle: title.toLowerCase(),
            authors: [{ family: "Smith", given: "A" }],
            year: 2017,
            journal: "Gastrointestinal Endoscopy",
            doi:
              i < 2
                ? "10.1016/j.gie.2017.01.011"
                : `10.1234/external-report-${i}`,
            pmid: i === 0 ? "28137598" : null,
          },
        }),
      );
    }
    const pubmed = citations[0]!;
    const embase = citations[1]!;
    expect(
      (await page.request.post(`/api/projects/${project.id}/dedup/run`)).ok(),
    ).toBeTruthy();
    const pairs = await db.deduplicationCandidate.findMany({
      where: { projectId: project.id },
    });
    expect(pairs).toHaveLength(6);
    const duplicate = pairs.find(
      (p) =>
        [p.citationAId, p.citationBId].includes(pubmed.id) &&
        [p.citationAId, p.citationBId].includes(embase.id),
    )!;
    const companions = pairs.filter((p) => p.id !== duplicate.id);
    async function confirmPair(id: string) {
      const response = await page.request.post(
        `/api/projects/${project.id}/dedup/candidates/${id}/companion`,
      );
      expect(response.ok(), await response.text()).toBeTruthy();
    }
    // A remaining suggested path must never bypass a direct separate-report judgment.
    await confirmPair(companions[0]!.id);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`/projects/${project.id}/dedup`);
    await page
      .getByRole("button", { name: /4 citations · 5 suggested pairs/ })
      .click();
    // A citation repeats across pair cards; select it and assert the group action.
    await page.getByRole("radio").first().click();
    await expect(
      page.getByRole("button", { name: "Merge group", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Merge group", exact: true })
      .click();
    await expect(
      page.getByText(
        "These citations were previously confirmed as separate reports of the same study. Reopen that companion decision before merging them as duplicate citations.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      await db.citation.count({
        where: { projectId: project.id, status: "ACTIVE" },
      }),
    ).toBe(4);
    for (const pair of companions.slice(1)) await confirmPair(pair.id);
    const history = await db.deduplicationCandidate.findMany({
      where: { projectId: project.id, status: "COMPANION" },
      orderBy: { id: "asc" },
    });
    await page.reload();
    await expect(
      page.getByRole("button", { name: /Merge exact DOI matches/ }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: /2 citations · 1 suggested pair/ })
      .click();
    await expect(
      page.getByText(/These may be separate reports of the same study/),
    ).toHaveCount(0);
    await page
      .getByRole("radio", {
        name: `Keep ${title} (${pubmed.id}) as canonical`,
        exact: true,
      })
      .check();
    await page
      .getByRole("button", { name: "Merge group", exact: true })
      .click();
    await expect(page.getByText("No duplicate candidates")).toBeVisible();
    expect(
      await db.citation.findUnique({ where: { id: embase.id } }),
    ).toMatchObject({ status: "DUPLICATE", duplicateOfId: pubmed.id });
    expect(await db.study.count({ where: { projectId: project.id } })).toBe(0);
    expect(
      (await page.request.post(`/api/projects/${project.id}/dedup/run`)).ok(),
    ).toBeTruthy();
    await page.reload();
    await expect(page.getByText("No duplicate candidates")).toBeVisible();
    const me = (await (await page.request.get("/api/me")).json()).data.user;
    const ta = await db.screeningStage.findFirstOrThrow({
      where: { projectId: project.id, type: "TITLE_ABSTRACT" },
    });
    const ft = await db.screeningStage.findFirstOrThrow({
      where: { projectId: project.id, type: "FULL_TEXT" },
    });
    for (const citation of [pubmed, citations[2]!, citations[3]!]) {
      await db.citationStageResult.create({
        data: {
          stageId: ta.id,
          citationId: citation.id,
          outcome: "INCLUDE",
          resolvedVia: "SINGLE_REVIEWER",
        },
      });
      await db.screeningAssignment.create({
        data: { stageId: ft.id, citationId: citation.id, reviewerId: me.id },
      });
      const response = await page.request.post(
        `/api/projects/${project.id}/screening/stages/${ft.id}/decisions`,
        { data: { citationId: citation.id, decision: "INCLUDE" } },
      );
      expect(response.ok(), await response.text()).toBeTruthy();
    }
    expect(await db.study.count({ where: { projectId: project.id } })).toBe(1);
    const links = await db.studyReportLink.findMany({
      where: { study: { projectId: project.id } },
    });
    expect(links.map((l) => l.citationId).sort()).toEqual(
      [pubmed.id, citations[2]!.id, citations[3]!.id].sort(),
    );
    expect(
      await db.deduplicationCandidate.findMany({
        where: { projectId: project.id, status: "COMPANION" },
        orderBy: { id: "asc" },
      }),
    ).toEqual(history);
    await expectNoErrorOverlay(page);
    expect(errors).toEqual([]);
  } finally {
    await db.$disconnect();
  }
});
