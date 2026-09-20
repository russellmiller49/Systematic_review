import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { signUp, expectNoErrorOverlay } from "./helpers";

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
