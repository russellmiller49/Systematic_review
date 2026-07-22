import { test, expect } from "@playwright/test";
import { signIn, openDemoProject, expectNoErrorOverlay, DEMO } from "./helpers";

// Every project workspace page renders (against the rich seeded demo project) without crashing
// to the Next.js error overlay, and shows a real heading. Complements the flow specs by
// exercising each page's data-loading paths on realistic state.
const NAV = [
  "Dashboard",
  "Team chat",
  "Protocol",
  "Import",
  "Deduplication",
  "Screening",
  "Conflicts",
  "Full text",
  "Extraction",
  "Risk of bias",
  "Analysis",
  "PRISMA",
  "Manuscript",
  "References",
  "Audit trail",
  "Settings",
];

test("every workspace page renders on the seeded project", async ({ page }) => {
  await signIn(page, DEMO.owner);
  const projectId = await openDemoProject(page);

  for (const label of NAV) {
    await page.getByRole("link", { name: label, exact: true }).click();
    // The sidebar link stays visible (we didn't crash to an error page) and no overlay appears.
    await expect(page.getByRole("link", { name: label, exact: true })).toBeVisible();
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 30_000 });
    await expectNoErrorOverlay(page);
  }

  // Sanity: we ended up inside the project workspace.
  expect(page.url()).toContain(`/projects/${projectId}`);
});
