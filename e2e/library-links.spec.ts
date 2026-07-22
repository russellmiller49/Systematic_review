import { test, expect } from "@playwright/test";
import { signIn, openDemoProject, expectNoErrorOverlay, DEMO } from "./helpers";

// Institutional library access: the seeded org has library settings, so the org dashboard
// shows the configuration and the full-text queue exposes proxied library links + the OA
// auto-fetch panel. No external network is exercised (the run itself is not started).

test("org dashboard shows library settings and the full-text queue shows library links", async ({
  page,
}) => {
  await signIn(page, DEMO.owner);

  // Org dashboard: the Library access card is populated from the seed.
  await page.goto("/orgs");
  await page.getByRole("link", { name: /Interventional Pulmonology Evidence Group/i }).click();
  await page.waitForURL(/\/orgs\/[^/]+$/);
  await expect(page.getByRole("heading", { name: "Library access" })).toBeVisible();
  await expect(page.getByLabel("Institution name")).toHaveValue("Demo University Library");
  await expect(page.getByLabel("EZProxy prefix URL")).toHaveValue(
    "https://login.ezproxy.demo-university.example/login?url=",
  );

  // Full-text queue: rows carry library links built from those settings.
  await page.goto("/orgs");
  const projectId = await openDemoProject(page);
  await page.goto(`/projects/${projectId}/fulltext`);
  await expect(page.getByRole("heading", { name: "Full text" })).toBeVisible();

  const libraryDoiLink = page.getByRole("link", { name: /Library \(DOI\)/ }).first();
  await expect(libraryDoiLink).toBeVisible({ timeout: 30_000 });
  const href = await libraryDoiLink.getAttribute("href");
  expect(href).toContain("https://login.ezproxy.demo-university.example/login?url=");
  expect(href).toContain(encodeURIComponent("https://doi.org/"));

  await expect(
    page.getByRole("link", { name: /Find via Demo University Library/ }).first(),
  ).toBeVisible();

  // The OA auto-fetch panel renders for fulltext.manage holders (owner).
  await expect(page.getByText("Open-access PDF auto-fetch")).toBeVisible();
  await expect(page.getByRole("button", { name: /Find PDFs \(/ })).toBeVisible();

  await expectNoErrorOverlay(page);
});
