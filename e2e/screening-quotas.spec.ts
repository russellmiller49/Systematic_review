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
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("spinbutton", { name: `Target for ${name}`, exact: true })
    .fill("1");
  await dialog.getByRole("button", { name: "Save quotas" }).click();
  const progress = page.getByLabel("Your reviewer quota");
  await expect(progress).toContainText(
    "Target: 1 · Completed: 0 · Remaining: 1",
  );
  const navigator = page.getByRole("complementary", {
    name: "Article navigator",
  });
  await navigator
    .getByRole("button", { name: /Gamma shared abstract/ })
    .click();
  await page.getByRole("button", { name: /^Include/ }).click();
  await expect(progress).toContainText(
    "Target: 1 · Completed: 1 · Remaining: 0",
  );
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
  await expect(progress).toContainText("Remaining: 1");
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
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("spinbutton", { name: `Target for ${name}`, exact: true })
    .fill("1");
  await dialog.getByRole("button", { name: "Save quotas" }).click();
  await expect(progress).toContainText("Completed: 0 · Remaining: 1");
  await page.getByRole("button", { name: /^Include/ }).click();
  await expect(progress).toContainText(
    "Target: 1 · Completed: 1 · Remaining: 0",
  );
  await page.reload();
  await expect(progress).toContainText("Target reached");
  await page.screenshot({
    path: "test-results/quota-pool-desktop.png",
    fullPage: true,
  });
  await expectNoErrorOverlay(page);
});
