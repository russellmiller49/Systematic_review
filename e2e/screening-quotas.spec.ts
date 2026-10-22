import { test, expect, type APIRequestContext } from "@playwright/test";
import { signUp, expectNoErrorOverlay } from "./helpers";

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).data;
}

async function importAbstracts(request: APIRequestContext, projectId: string) {
  const source = await post(
    request,
    `/api/projects/${projectId}/import-sources`,
    { name: "Quota test source", type: "DATABASE" },
  );
  const response = await request.post(`/api/projects/${projectId}/imports`, {
    multipart: {
      sourceId: source.id,
      format: "RIS",
      file: {
        name: "quotas.ris",
        mimeType: "text/plain",
        buffer: Buffer.from(
          [
            "TY  - JOUR\nTI  - Alpha shared abstract\nAB  - Alpha trial abstract.\nER  - ",
            "TY  - JOUR\nTI  - Beta shared abstract\nAB  - Beta trial abstract.\nER  - ",
            "TY  - JOUR\nTI  - Gamma shared abstract\nAB  - Gamma trial abstract.\nER  - ",
          ].join("\n"),
        ),
      },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const batch = (await response.json()).data;
  await post(
    request,
    `/api/projects/${projectId}/imports/${batch.id}/commit`,
    {},
  );
}

test("shared quota assignment and personal progress in a PICO and combined pool", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const name = `Quota reviewer ${Date.now()}`;
  await signUp(page, name, `quota-${Date.now()}@test.local`);
  const org = await post(page.request, "/api/orgs", {
    name: `Quota test ${Date.now()}`,
  });
  const project = await post(page.request, `/api/orgs/${org.id}/projects`, {
    title: "Quota browser review",
    reviewType: "SYSTEMATIC_REVIEW",
    reviewersPerCitation: 2,
  });
  await importAbstracts(page.request, project.id);
  await page.goto(`/projects/${project.id}/screening`);
  await page
    .getByRole("button", { name: "Reviewer quotas", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").first().check();
  await dialog
    .getByRole("spinbutton", { name: `Target for ${name}`, exact: true })
    .fill("1");
  await dialog.getByRole("button", { name: "Save quotas" }).click();
  const progress = page.getByLabel("Your reviewer quota");
  await expect(progress).toContainText("0 of 1 completed · 1 remaining");
  const navigator = page.getByRole("complementary", {
    name: "Article navigator",
  });
  await navigator
    .getByRole("button", { name: /Gamma shared abstract/ })
    .click();
  await page.getByRole("button", { name: /^Include/ }).click();
  await expect(progress).toContainText("1 of 1 completed · 0 remaining");
  await page.reload();
  await expect(progress).toContainText("Target reached");
  await page
    .getByRole("button", { name: "Reviewer quotas", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  const reviewerRow = dialog.getByRole("row").filter({ hasText: name });
  await expect(reviewerRow.getByRole("cell").nth(2)).toHaveText("1");
  await expect(reviewerRow.getByRole("cell").nth(3)).toHaveText("0");
  await dialog
    .getByRole("spinbutton", { name: `Target for ${name}`, exact: true })
    .fill("2");
  await dialog.getByRole("button", { name: "Save quotas" }).click();
  await expect(progress).toContainText("1 remaining");
  await expect(
    navigator.getByRole("button", { name: /Alpha shared abstract/ }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/quota-pico-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/quota-pico-mobile.png",
    fullPage: true,
  });
  await expectNoErrorOverlay(page);

  await page
    .getByRole("button", { name: "Reviewer quotas", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("checkbox", { name: `No target for ${name}`, exact: true })
    .check();
  await dialog.getByRole("button", { name: "Save quotas" }).click();
  await expect(progress).toContainText("1 review completed");
  await expect(progress).not.toContainText("Remaining:");
  await page.getByRole("button", { name: /^Include/ }).click();
  await expect(progress).toContainText("2 reviews completed");
  await expect(page.getByRole("button", { name: /^Include/ })).toBeEnabled();

  const guideline = await post(page.request, `/api/orgs/${org.id}/projects`, {
    title: "Quota guideline",
    reviewType: "GUIDELINE_EVIDENCE_REVIEW",
    isGuideline: true,
  });
  const pico1 = await post(
    page.request,
    `/api/projects/${guideline.id}/subprojects`,
    { title: "PICO 1", researchQuestion: "First question" },
  );
  const pico2 = await post(
    page.request,
    `/api/projects/${guideline.id}/subprojects`,
    { title: "PICO 2", researchQuestion: "Second question" },
  );
  await importAbstracts(page.request, pico1.id);
  await importAbstracts(page.request, pico2.id);
  const savedPool = await page.request.put(
    `/api/projects/${guideline.id}/screening/pool`,
    { data: { name: "Quota combined pool", projectIds: [pico1.id, pico2.id] } },
  );
  expect(savedPool.ok(), await savedPool.text()).toBeTruthy();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/projects/${guideline.id}/screening`);
  await page
    .getByRole("button", { name: "Reviewer quotas", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").first().check();
  await dialog
    .getByRole("spinbutton", { name: `Target for ${name}`, exact: true })
    .fill("1");
  await dialog.getByRole("button", { name: "Save quotas" }).click();
  await expect(progress).toContainText(/0 of \d+ completed · 1 remaining/);
  await page.getByRole("button", { name: /^Include/ }).click();
  await expect(progress).toContainText("1 of 1 completed · 0 remaining");
  await page.reload();
  await expect(progress).toContainText("Target reached");
  await page.screenshot({
    path: "test-results/quota-pool-desktop.png",
    fullPage: true,
  });
  await expectNoErrorOverlay(page);
  await page
    .getByRole("button", { name: "Reviewer quotas", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "No target", exact: true }).click();
  await dialog.getByRole("button", { name: "Save quotas" }).click();
  await expect(progress).toContainText("1 review completed");
  await page.reload();
  await expect(progress).not.toContainText("Remaining:");
  await page.getByRole("button", { name: /^Include/ }).click();
  await expect(progress).toContainText("2 reviews completed");
  await expect(page.getByRole("button", { name: /^Include/ })).toBeEnabled();
  await page.screenshot({
    path: "test-results/quota-pool-no-target.png",
    fullPage: true,
  });
});

test("reviewers explicitly continue beyond their goal in individual and combined queues", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signUp(page, "Optional reviewer", `optional-${Date.now()}@test.local`);
  const org = await post(page.request, "/api/orgs", {
    name: `Optional quota ${Date.now()}`,
  });
  const guideline = await post(page.request, `/api/orgs/${org.id}/projects`, {
    title: "Optional screening guideline",
    reviewType: "GUIDELINE_EVIDENCE_REVIEW",
    isGuideline: true,
  });
  const picos = [];
  for (const number of [1, 2, 3]) {
    const pico = await post(
      page.request,
      `/api/projects/${guideline.id}/subprojects`,
      {
        title: `PICO ${number}`,
        researchQuestion: `Question ${number}`,
      },
    );
    await importAbstracts(page.request, pico.id);
    picos.push(pico);
  }
  const poolResponse = await page.request.put(
    `/api/projects/${guideline.id}/screening/pool`,
    {
      data: {
        name: "Combined PICOs 2–3",
        projectIds: picos.slice(1).map((p) => p.id),
      },
    },
  );
  expect(poolResponse.ok()).toBeTruthy();
  for (const projectId of [picos[0].id, guideline.id]) {
    await page.goto(`/projects/${projectId}/screening`);
    await page
      .getByRole("button", { name: "Reviewer quotas", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox").first().check();
    await dialog
      .getByRole("spinbutton", {
        name: "Target for Optional reviewer",
        exact: true,
      })
      .fill("1");
    await dialog.getByRole("button", { name: "Save quotas" }).click();
    const progress = page.getByLabel("Your reviewer quota");
    await expect(progress).toContainText("0 of 1 completed · 1 remaining");
    await page.getByRole("button", { name: /^Include/ }).click();
    await expect(progress).toContainText("1 of 1 completed · 0 remaining");
    await expect(progress).toContainText("Available to review: 2");
    await expect(page.getByRole("button", { name: /^Include/ })).toHaveCount(0);
    await page.keyboard.press("i");
    await expect(progress).toContainText("1 of 1 completed");
    await page
      .getByRole("button", { name: "Continue screening", exact: true })
      .click();
    await page.getByRole("button", { name: /^Include/ }).click();
    await expect(progress).toContainText("2 of 1 completed · 0 remaining");
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Continue screening", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Continue screening", exact: true })
      .click();
    await page.getByRole("button", { name: /^Include/ }).click();
    await expect(progress).toContainText("3 of 1 completed · 0 remaining");
    await expect(progress).toContainText("No eligible articles remaining");
    await expect(
      page.getByRole("button", { name: "Continue screening", exact: true }),
    ).toHaveCount(0);
    await expectNoErrorOverlay(page);
  }
});
