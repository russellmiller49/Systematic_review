import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { signUp, expectNoErrorOverlay } from "./helpers";

const db = new PrismaClient();
test.afterAll(() => db.$disconnect());
async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).data;
}
test("consensus recovery requires explicit clearance, binds selection, and works by keyboard on mobile without altering the remaining review", async ({
  page: owner,
  browser,
}) => {
  test.setTimeout(180000);
  if (
    !process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL
  )
    throw new Error("Use the isolated recovery configuration");
  const stamp = Date.now(),
    otherContext = await browser.newContext(),
    reviewer = await otherContext.newPage();
  try {
    const ownerEmail = `consensus-owner-${stamp}@test.local`,
      reviewerEmail = `consensus-reviewer-${stamp}@test.local`;
    await signUp(owner, "Consensus Owner", ownerEmail);
    await signUp(reviewer, "Consensus Reviewer", reviewerEmail);
    const ownerId = (
      await db.user.findUniqueOrThrow({ where: { email: ownerEmail } })
    ).id;
    const reviewerId = (
      await db.user.findUniqueOrThrow({ where: { email: reviewerEmail } })
    ).id;
    const org = await post(owner.request, "/api/orgs", {
      name: `Synthetic consensus ${stamp}`,
    });
    const guideline = await post(
      owner.request,
      `/api/orgs/${org.id}/projects`,
      {
        title: "Consensus recovery guideline",
        reviewType: "GUIDELINE_EVIDENCE_REVIEW",
        isGuideline: true,
        reviewersPerCitation: 2,
      },
    );
    await post(owner.request, `/api/orgs/${org.id}/members`, {
      email: reviewerEmail,
      role: "MEMBER",
    });
    await post(owner.request, `/api/projects/${guideline.id}/members`, {
      email: reviewerEmail,
      roles: ["REVIEWER"],
    });
    const picos = [];
    for (let i = 1; i <= 6; i++)
      picos.push(
        await post(owner.request, `/api/projects/${guideline.id}/subprojects`, {
          title: `PICO ${i}`,
          researchQuestion: `Configured question ${i}`,
        }),
      );
    const poolResponse = await owner.request.put(
      `/api/projects/${guideline.id}/screening/pool`,
      {
        data: {
          name: "Synthetic PICO 2–6",
          projectIds: picos.slice(1).map((p) => p.id),
        },
      },
    );
    expect(poolResponse.ok()).toBeTruthy();
    const pool = (await poolResponse.json()).data;
    const quotaResponse = await owner.request.put(
      `/api/projects/${guideline.id}/screening/pooled/quotas?poolId=${pool.id}`,
      {
        data: {
          reviewers: [
            { reviewerId, target: 10 },
            { reviewerId: ownerId, target: 10 },
          ],
        },
      },
    );
    expect(quotaResponse.ok()).toBeTruthy();
    const copies = [];
    for (const pico of [...picos.slice(1), picos[1]])
      copies.push(
        (
          await db.citation.create({
            data: {
              projectId: pico.id,
              title: "Synthetic finalized consensus abstract",
              normalizedTitle: "synthetic finalized consensus abstract",
              doi: `10.8000/consensus-${stamp}`,
              authors: [],
              abstract: "Synthetic configured eligibility.",
            },
          })
        ).id,
      );
    const decision = {
      poolId: pool.id,
      citationIds: copies,
      decision: "EXCLUDE",
      exclusionReasonLabel: "Wrong population",
    };
    await post(
      reviewer.request,
      `/api/projects/${guideline.id}/screening/pooled`,
      { ...decision, notes: "Original target review" },
    );
    await post(
      owner.request,
      `/api/projects/${guideline.id}/screening/pooled`,
      { ...decision, notes: "Private remaining review" },
    );
    const before = await db.screeningDecision.findMany({
      where: { citationId: { in: copies }, reviewerId: ownerId },
      orderBy: { id: "asc" },
    });
    const base = `/api/projects/${guideline.id}/screening/recovery`;
    const raw = {
      poolId: pool.id,
      reviewerId,
      reason: "Synthetic incorrect scope",
      mode: "consensus",
    };
    expect(
      (await owner.request.post(`${base}/preview`, { data: raw })).status(),
    ).toBe(400);
    expect(
      (
        await reviewer.request.post(`${base}/preview`, {
          data: {
            ...raw,
            externalUseClearance: {
              confirmed: true,
              reason: "Synthetic lead clearance",
            },
          },
        })
      ).status(),
    ).toBe(403);
    await owner.goto(`/projects/${guideline.id}/screening/recovery`);
    await owner
      .getByLabel("Reviewer", { exact: true })
      .selectOption(reviewerId);
    await owner
      .getByLabel("Reason for this recovery or restoration")
      .fill(raw.reason);
    await owner.getByLabel("Recovery mode").selectOption("consensus");
    const previewButton = owner.getByRole("button", {
      name: "Preview withdrawal",
      exact: true,
    });
    await expect(previewButton).toBeDisabled();
    const clearance = owner.getByRole("checkbox", {
      name: /Review lead confirmed/,
    });
    await clearance.check();
    await expect(previewButton).toBeDisabled();
    await owner
      .getByLabel("External-use clearance details")
      .fill("Synthetic review lead confirmed no external uses");
    await previewButton.focus();
    await owner.keyboard.press("Enter");
    const preflight = owner.getByRole("region", { name: "Recovery preflight" });
    await expect(preflight).toContainText(
      "1 logical groups selected; 1 eligible; 0 held; 6 linked votes to change.",
    );
    await expect(preflight).toContainText(
      "6 automatic consensus results will reopen",
    );
    await expect(preflight).not.toContainText("Private remaining review");
    await clearance.uncheck();
    await expect(preflight).toHaveCount(0);
    await expect(previewButton).toBeDisabled();
    await clearance.check();
    await previewButton.click();
    await expect(preflight).toContainText(
      "6 automatic consensus results will reopen",
    );
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(
      await owner.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await preflight
      .getByRole("button", { name: "Withdraw 1 eligible logical reviews" })
      .focus();
    await owner.keyboard.press("Enter");
    await expect(
      owner
        .getByRole("status")
        .filter({ hasText: "1 logical reviews withdrawn" }),
    ).toBeVisible();
    expect(
      await db.citationStageResult.count({
        where: { citationId: { in: copies } },
      }),
    ).toBe(0);
    expect(
      await db.screeningDecision.count({
        where: {
          citationId: { in: copies },
          reviewerId,
          withdrawnAt: { not: null },
        },
      }),
    ).toBe(6);
    expect(
      await db.screeningDecision.findMany({
        where: { citationId: { in: copies }, reviewerId: ownerId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
    await owner.getByRole("button", { name: "Preview restoration" }).focus();
    await owner.keyboard.press("Enter");
    await expect(preflight).toContainText("Restoration preflight");
    await preflight
      .getByRole("button", { name: "Restore 1 logical reviews" })
      .focus();
    await owner.keyboard.press("Enter");
    await expect(
      owner
        .getByRole("status")
        .filter({ hasText: "1 logical reviews restored" }),
    ).toBeVisible();
    expect(
      await db.citationStageResult.count({
        where: {
          citationId: { in: copies },
          resolvedVia: "CONSENSUS",
          outcome: "EXCLUDE",
        },
      }),
    ).toBe(6);
    expect(
      await db.screeningDecision.findMany({
        where: { citationId: { in: copies }, reviewerId: ownerId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
    await expectNoErrorOverlay(owner);
  } finally {
    await otherContext.close();
  }
});
