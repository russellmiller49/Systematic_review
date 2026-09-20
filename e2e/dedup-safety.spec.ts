import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { signUp, expectNoErrorOverlay } from "./helpers";

test("reviewer can expand abstracts and identify a conference/full-publication pair", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const db = new PrismaClient();
  try {
    await signUp(page, "Abstract reviewer", `abstracts-${Date.now()}@test.local`);
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Abstract QA ${Date.now()}` },
    });
    expect(orgRes.ok()).toBeTruthy();
    const org = (await orgRes.json()).data;
    const projectRes = await page.request.post(`/api/orgs/${org.id}/projects`, {
      data: {
        title: "Abstract comparison QA",
        reviewType: "SYSTEMATIC_REVIEW",
      },
    });
    expect(projectRes.ok()).toBeTruthy();
    const project = (await projectRes.json()).data;
    for (const [name, format, content] of [
      [
        "Embase",
        "RIS",
        "TY  - JOUR\nTI  - Comparative trial results\nM3  - Conference Abstract\nAB  - Preliminary results: 40 participants were enrolled.\nDO  - 10.1234/abstract-qa\nER  -",
      ],
      [
        "PubMed",
        "NBIB",
        "PMID- 12345678\nTI  - Comparative trial results\nPT  - Journal Article\nAB  - Final results: 120 participants completed follow-up.\nAID - 10.1234/abstract-qa [doi]",
      ],
    ]) {
      const sourceRes = await page.request.post(`/api/projects/${project.id}/import-sources`, {
        data: { name },
      });
      expect(sourceRes.ok()).toBeTruthy();
      const source = (await sourceRes.json()).data;
      const importRes = await page.request.post(`/api/projects/${project.id}/imports`, {
        multipart: {
          sourceId: source.id,
          format: format!,
          file: {
            name: `test.${format!.toLowerCase()}`,
            mimeType: "text/plain",
            buffer: Buffer.from(content!),
          },
        },
      });
      expect(importRes.ok()).toBeTruthy();
      const batch = (await importRes.json()).data;
      const commit = await page.request.post(
        `/api/projects/${project.id}/imports/${batch.id}/commit`,
      );
      expect(commit.ok()).toBeTruthy();
    }
    const detection = await page.request.post(`/api/projects/${project.id}/dedup/run`);
    expect(detection.ok()).toBeTruthy();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/projects/${project.id}/dedup`);
    const card = page.getByRole("button", {
      name: /2 citations · 1 suggested pair/,
    });
    await expect(card).toContainText("Possible conference / full publication");
    await expect(card).not.toContainText("100% match");
    await expect(page.getByRole("button", { name: /Merge exact DOI matches/ })).toBeDisabled();
    await card.click();
    await expect(
      page.getByText("Possible conference abstract and full publication", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText("Embase", { exact: true })).toBeVisible();
    await expect(page.getByText("PubMed", { exact: true })).toBeVisible();
    const summary = page.locator("summary", { hasText: "Compare abstracts" });
    const preliminary = page.getByText("Preliminary results: 40 participants were enrolled.", {
      exact: true,
    });
    const final = page.getByText("Final results: 120 participants completed follow-up.", {
      exact: true,
    });
    await expect(preliminary).not.toBeVisible();
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(preliminary).toBeVisible();
    await expect(final).toBeVisible();
    await page.screenshot({
      path: "test-results/dedup-abstracts-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(summary).toBeVisible();
    await page.screenshot({
      path: "test-results/dedup-abstracts-mobile.png",
      fullPage: true,
    });
    await summary.click();
    await expect(preliminary).not.toBeVisible();
    await db.citation.updateMany({
      where: { projectId: project.id, pmid: "12345678" },
      data: { abstract: null },
    });
    await page.reload();
    await card.click();
    await summary.click();
    await expect(preliminary).toBeVisible();
    await expect(page.getByText("No abstract available in this imported record.")).toBeVisible();
    await expectNoErrorOverlay(page);
    expect(errors).toEqual([]);
  } finally {
    await db.$disconnect();
  }
});

// Real API + browser regression, intentionally using a sparse graph to exercise bridge rejection.
test("rejection splits cards, resets canonical selection, and excludes metadata conflicts from bulk merge", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const db = new PrismaClient();
  try {
    await signUp(page, "Dedup reviewer", `dedup-${Date.now()}@test.local`);
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Dedup QA ${Date.now()}` },
    });
    expect(orgRes.ok()).toBeTruthy();
    const org = (await orgRes.json()).data;
    const projectRes = await page.request.post(`/api/orgs/${org.id}/projects`, {
      data: { title: "Dedup safety QA", reviewType: "SYSTEMATIC_REVIEW" },
    });
    expect(projectRes.ok()).toBeTruthy();
    const project = (await projectRes.json()).data;
    const citations = [];
    for (let i = 0; i < 4; i++)
      citations.push(
        await db.citation.create({
          data: {
            projectId: project.id,
            title: `Publication ${i < 2 ? "Alpha" : "Beta"} record ${i + 1}`,
            normalizedTitle: `publication ${i < 2 ? "alpha" : "beta"}`,
            authors: [],
            year: 2018,
            doi: "10.1234/shared",
            pmid: i < 2 ? "1111" : "2222",
          },
        }),
      );
    const group = await db.deduplicationGroup.create({
      data: { projectId: project.id },
    });
    for (const [a, b] of [
      [0, 1],
      [1, 2],
      [2, 3],
    ]) {
      const [citationAId, citationBId] = [citations[a!]!.id, citations[b!]!.id].sort();
      await db.deduplicationCandidate.create({
        data: {
          projectId: project.id,
          groupId: group.id,
          citationAId: citationAId!,
          citationBId: citationBId!,
          method: "EXACT_DOI",
          score: 1,
          reasons: {
            titleSimilarity: 1,
            authorOverlap: 0,
            yearMatch: true,
            journalMatch: false,
            matchedOn: ["doi"],
          },
        },
      });
    }
    const renderingErrors: string[] = [];
    page.on("pageerror", (error) => renderingErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && /hydration|cannot be a descendant/i.test(message.text())) {
        renderingErrors.push(message.text());
      }
    });
    await page.goto(`/projects/${project.id}/dedup`);
    const bulk = page.getByRole("button", { name: /Merge exact DOI matches/ });
    await expect(bulk).toBeDisabled();
    const summary = page.getByRole("button", {
      name: /4 citations · 3 suggested pairs/,
    });
    await expect(summary).toContainText("manual review required");
    await expect(summary).not.toContainText("100% match");
    await summary.click();
    await page.getByRole("radio").first().check();
    await expect(page.getByRole("button", { name: "Merge group", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Not a duplicate", exact: true }).nth(1).click();
    const cards = page.getByRole("button", {
      name: /2 citations · 1 suggested pair/,
    });
    await expect(cards).toHaveCount(2);
    await cards.nth(0).click();
    await cards.nth(1).click();
    await expect(page.getByRole("radio")).toHaveCount(4);
    await expect(
      page.getByRole("button", {
        name: "Select a canonical citation to merge",
      }),
    ).toHaveCount(2);
    const radios = page.getByRole("radio");
    await radios.nth(0).check();
    await radios.nth(2).check();
    await expect(radios.nth(0)).toBeChecked();
    await expect(radios.nth(2)).toBeChecked();
    await expect(page.getByRole("button", { name: "Merge group", exact: true })).toHaveCount(2);
    await page.screenshot({
      path: "test-results/dedup-split-desktop.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Merge group", exact: true }).first().click();
    await expect(cards).toHaveCount(1);
    expect(
      await db.citation.count({
        where: { projectId: project.id, status: "DUPLICATE" },
      }),
    ).toBe(1);
    await expectNoErrorOverlay(page);
    expect(renderingErrors).toEqual([]);
  } finally {
    await db.$disconnect();
  }
});
