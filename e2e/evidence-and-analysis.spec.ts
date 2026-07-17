import { expect, test } from "@playwright/test";
import { signIn, openDemoProject, expectNoErrorOverlay, DEMO } from "./helpers";

// Wave 2 features against the seeded demo:
//  1. The evidence viewer really renders the study PDF with pdf.js and highlights the
//     stored source quote. This needs a browser that actually paints — pdf.js drives its
//     canvas render loop with requestAnimationFrame, which never fires in a hidden
//     document, so this can only be verified end-to-end here (not in the MCP browser pane).
//  2. The Analysis page computes and renders a live forest plot from extracted data.
// Plus wave 4: the GRADE draft seeded over that outcome and its Summary of Findings row.

test("evidence viewer highlights the extracted quote inside the PDF", async ({ page }) => {
  await signIn(page, DEMO.owner);
  const projectId = await openDemoProject(page);
  await page.goto(`/projects/${projectId}/extraction`);

  await page.getByRole("tab", { name: "Table" }).click();
  // Cell popover -> the extractor entry's evidence -> the PDF dialog.
  await page.getByRole("button", { name: "Criner 2018 — Total sample size" }).click();
  await page.getByRole("button", { name: /Open in PDF/i }).first().click();

  const dialog = page.getByRole("dialog").filter({ hasText: "criner.pdf" });
  await expect(dialog).toBeVisible();
  // pdf.js rendered the page (canvas) and located the quote on the anchored page.
  await expect(dialog.locator("canvas")).toBeVisible();
  await expect(dialog.getByText("Quote highlighted")).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText("2 / 2")).toBeVisible();

  // The highlight is real geometry over the text layer, not just a status chip.
  const rects = dialog.locator(".mix-blend-multiply");
  await expect(rects.first()).toBeVisible({ timeout: 30_000 });
  const box = await rects.first().boundingBox();
  expect(box, "highlight rect should have a measurable box").toBeTruthy();
  expect(box!.width).toBeGreaterThan(5);
  expect(box!.height).toBeGreaterThan(3);

  // ...and it actually overlays the quoted sentence, not just "a rect exists
  // somewhere": a coordinate-mapping regression in applyHighlight (e.g. offsetting
  // against the scroller instead of the page wrapper) keeps the rect's size but
  // misplaces it, which the size checks above cannot catch. The seeded criner PDF
  // renders each line as a single text item, so the quote's opening line is one
  // .textLayer span; :not(.markedContent) skips pdf.js's display:contents wrappers.
  const quoteSpan = dialog
    .locator(".textLayer span:not(.markedContent)", { hasText: "A total of 190" })
    .first();
  await expect(quoteSpan).toBeVisible();
  // Measure both boxes together (post-scroll layout is settled by now) and require
  // a real geometric intersection on both axes — position, not just size.
  const hlBox = await rects.first().boundingBox();
  const spanBox = await quoteSpan.boundingBox();
  expect(hlBox, "highlight rect should have a measurable box").toBeTruthy();
  expect(spanBox, "quote text span should have a measurable box").toBeTruthy();
  const xOverlap =
    Math.min(hlBox!.x + hlBox!.width, spanBox!.x + spanBox!.width) -
    Math.max(hlBox!.x, spanBox!.x);
  const yOverlap =
    Math.min(hlBox!.y + hlBox!.height, spanBox!.y + spanBox!.height) -
    Math.max(hlBox!.y, spanBox!.y);
  expect(xOverlap, "highlight should horizontally overlap the quoted text").toBeGreaterThan(0);
  expect(yOverlap, "highlight should vertically overlap the quoted text").toBeGreaterThan(0);
  await expectNoErrorOverlay(page);
});

test("analysis page renders a live forest plot from extracted data", async ({ page }) => {
  await signIn(page, DEMO.owner);
  const projectId = await openDemoProject(page);
  await page.goto(`/projects/${projectId}/analysis`);

  await page.getByRole("button", { name: /FEV1 responder/i }).first().click();

  // Per-study effects resolved from extraction, with pooled results + heterogeneity.
  await expect(page.getByText("2.91 [1.60, 5.28]").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("3.19 [1.39, 7.35]").first()).toBeVisible();
  await expect(page.getByText(/Random effects \(DL\): 3\.00 \[1\.85, 4\.87\]/)).toBeVisible();
  await expect(page.getByText(/I²=0\.0%/)).toBeVisible();

  // The forest plot itself renders as an inline SVG image (the funnel plot is a
  // second data-URI image on the page, so target the first).
  const plot = page.locator('img[src^="data:image/svg+xml"]').first();
  await expect(plot).toBeVisible();
  await expectNoErrorOverlay(page);
});

test("GRADE draft and summary of findings render from the seeded assessment", async ({ page }) => {
  await signIn(page, DEMO.owner);
  const projectId = await openDemoProject(page);
  await page.goto(`/projects/${projectId}/analysis`);

  await page.getByRole("button", { name: /FEV1 responder/i }).first().click();
  await page.getByRole("tab", { name: "GRADE" }).click();

  // The seeded draft: 287 participants (< the 400 OIS threshold) downgrades imprecision
  // once from the randomized start of 4 → Moderate certainty.
  await expect(page.getByText("Moderate").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Started HIGH \(4\) − 1 = 3 → Moderate/)).toBeVisible();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  // Scope the judgment to the domain heading's own header. A page-wide div filter can
  // match every ancestor of the card and makes `.last()` depend on incidental DOM depth.
  const imprecisionHeader = page
    .getByRole("heading", { name: "Imprecision", exact: true })
    .locator("..");
  await expect(imprecisionHeader.getByText("Serious", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Pooled RR 3.00 (95% CI 1.85 to 4.87) does not cross the null value of 1. Total N = 287 falls short of the optimal information size heuristic of 400 participants. 1 imprecision concern.",
      { exact: true },
    ),
  ).toBeVisible();

  const indirectnessHeader = page
    .getByRole("heading", { name: "Indirectness", exact: true })
    .locator("..");
  await expect(indirectnessHeader.getByText("Edited", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Population, intervention and comparator match the protocol PICO; the outcome is measured at the protocol timepoint.",
      { exact: true },
    ),
  ).toBeVisible();

  const publicationBiasHeader = page
    .getByRole("heading", { name: "Publication bias", exact: true })
    .locator("..");
  await expect(publicationBiasHeader.getByText("Needs review", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Regenerate draft/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /AI suggestions/i })).toHaveCount(0);

  // The same assessment drives the Summary of Findings row.
  await page.getByRole("button", { name: "Summary of findings" }).click();
  const row = page.getByRole("row").filter({ hasText: "FEV1 responder" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText("287")).toBeVisible();
  await expect(row.getByText("3.00 [1.85, 4.87]")).toBeVisible();
  await expect(row.getByText("Moderate")).toBeVisible();
  await expectNoErrorOverlay(page);
});
