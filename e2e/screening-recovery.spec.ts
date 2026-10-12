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
test("administrator previews and applies one logical recovery on mobile, restores by keyboard; reviewer cannot invoke recovery", async ({
  page: owner,
  browser,
}) => {
  test.setTimeout(180000);
  if (
    !process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL
  )
    throw new Error("Use the isolated quota test configuration");
  const stamp = Date.now();
  const context = await browser.newContext();
  const reviewer = await context.newPage();
  try {
    await signUp(owner, "Recovery Owner", `recovery-owner-${stamp}@test.local`);
    const email = `recovery-reviewer-${stamp}@test.local`;
    await signUp(reviewer, "Recovery Reviewer", email);
    const org = await post(owner.request, "/api/orgs", {
      name: `Synthetic recovery ${stamp}`,
    });
    const guideline = await post(
      owner.request,
      `/api/orgs/${org.id}/projects`,
      {
        title: "Recovery guideline",
        reviewType: "GUIDELINE_EVIDENCE_REVIEW",
        isGuideline: true,
        reviewersPerCitation: 2,
      },
    );
    await post(owner.request, `/api/orgs/${org.id}/members`, {
      email,
      role: "MEMBER",
    });
    await post(owner.request, `/api/projects/${guideline.id}/members`, {
      email,
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
          name: "Configured PICO 2–6 pool",
          projectIds: picos.slice(1).map((p) => p.id),
        },
      },
    );
    expect(poolResponse.ok()).toBeTruthy();
    const pool = (await poolResponse.json()).data;
    const reviewerId = (await db.user.findUniqueOrThrow({ where: { email } }))
      .id;
    const quotaResponse = await owner.request.put(
      `/api/projects/${guideline.id}/screening/pooled/quotas?poolId=${pool.id}`,
      { data: { reviewers: [{ reviewerId, target: 10 }] } },
    );
    expect(quotaResponse.ok()).toBeTruthy();
    const copies = [];
    for (const pico of [...picos.slice(1), picos[1]]) {
      const c = await db.citation.create({
        data: {
          projectId: pico.id,
          title: "Synthetic six-copy abstract",
          normalizedTitle: "synthetic six copy abstract",
          doi: "10.7000/recovery",
          authors: [],
          abstract: "Synthetic eligibility evidence for configured questions.",
        },
      });
      copies.push(c.id);
    }
    await post(
      reviewer.request,
      `/api/projects/${guideline.id}/screening/pooled`,
      {
        poolId: pool.id,
        citationIds: copies,
        decision: "EXCLUDE",
        exclusionReasonLabel: "Wrong population",
        notes: "Retain this original review",
      },
    );
    const base = `/api/projects/${guideline.id}/screening/recovery`;
    const denied = await reviewer.request.post(`${base}/preview`, {
      data: { poolId: pool.id, reviewerId, reason: "Unauthorized attempt" },
    });
    expect(denied.status()).toBe(403);
    expect((await reviewer.request.get(base)).status()).toBe(403);
    await reviewer.goto(`/projects/${guideline.id}/screening/recovery`);
    await expect(
      reviewer.getByText(
        "Only current project owners and administrators can access screening recovery.",
      ),
    ).toBeVisible();
    await expect(
      reviewer.getByRole("button", { name: "Preview withdrawal" }),
    ).toHaveCount(0);
    await expectNoErrorOverlay(reviewer);
    await owner.goto(`/projects/${guideline.id}/settings`);
    await owner
      .getByRole("link", { name: /Preview an audited withdrawal/ })
      .click();
    await expect(
      owner.getByRole("heading", { name: "Screening recovery", exact: true }),
    ).toBeVisible();
    await owner
      .getByLabel("Reviewer", { exact: true })
      .selectOption(reviewerId);
    await owner
      .getByLabel("Reason for this recovery or restoration")
      .fill("Incorrect scope; repeat screening");
    await owner
      .getByRole("button", { name: "Preview withdrawal", exact: true })
      .focus();
    await owner.keyboard.press("Enter");
    const preflight = owner.getByRole("region", { name: "Recovery preflight" });
    await expect(preflight).toContainText(
      "1 logical groups selected; 1 eligible; 0 held; 6 linked votes to change.",
    );
    expect(
      await db.screeningWithdrawal.count({
        where: { guidelineId: guideline.id },
      }),
    ).toBe(0);
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(
      await owner.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await preflight
      .getByRole("button", { name: "Withdraw 1 eligible logical reviews" })
      .click();
    await expect(
      owner
        .getByRole("status")
        .filter({ hasText: "1 logical reviews withdrawn" }),
    ).toBeVisible();
    expect(
      await db.screeningDecision.count({
        where: { citationId: { in: copies }, withdrawnAt: { not: null } },
      }),
    ).toBe(6);
    const history = owner.getByRole("region", { name: "Recovery history" });
    await history.getByRole("button", { name: "Preview restoration" }).focus();
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
      await db.screeningDecision.count({
        where: {
          citationId: { in: copies },
          withdrawnAt: null,
          notes: "Retain this original review",
        },
      }),
    ).toBe(6);
    await expect(history).toContainText("Restored");
    const fresh = await post(owner.request, `${base}/preview`, {
      poolId: pool.id,
      reviewerId,
      reason: "Synthetic missing assignment association",
    });
    const secondWithdrawal = await post(owner.request, base, {
      token: fresh.token,
    });
    const retained = await db.screeningAssignment.findFirstOrThrow({
      where: { citationId: copies[0], reviewerId },
    });
    const ownerId = (
      await db.user.findUniqueOrThrow({
        where: { email: `recovery-owner-${stamp}@test.local` },
      })
    ).id;
    await db.screeningAssignment.update({
      where: { id: retained.id },
      data: { reviewerId: ownerId },
    });
    const held = await post(owner.request, `${base}/restore-preview`, {
      withdrawalId: secondWithdrawal.withdrawalId,
      reason: "Inspect missing original assignment",
    });
    expect(held.token).toBeNull();
    expect(held.groups[0].reasons).toContain("RETAINED_ASSIGNMENT_CHANGED");
    await owner.reload();
    await owner
      .getByLabel("Reason for this recovery or restoration")
      .fill("Inspect retained assignment keys");
    await owner.getByRole("button", { name: "Preview restoration" }).click();
    await expect(preflight).toContainText(
      "Retained assignment is missing or its reviewer, citation, stage, or status changed",
    );
    await expect(
      preflight.getByRole("button", { name: "Restore 0 logical reviews" }),
    ).toBeDisabled();
    expect(
      await db.screeningAssignment.findUnique({ where: { id: retained.id } }),
    ).toMatchObject({ reviewerId: ownerId, status: "PENDING" });
    await expectNoErrorOverlay(owner);
  } finally {
    await context.close();
  }
});
