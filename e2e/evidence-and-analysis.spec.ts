import { expect, test } from "@playwright/test";
import { signIn, openDemoProject, expectNoErrorOverlay, DEMO } from "./helpers";

// Wave 2 features against the seeded demo:
//  1. The evidence viewer really renders the study PDF with pdf.js and highlights the
//     stored source quote. This needs a browser that actually paints — pdf.js drives its
//     canvas render loop with requestAnimationFrame, which never fires in a hidden
//     document, so this can only be verified end-to-end here (not in the MCP browser pane).
//  2. The Analysis page computes and renders a live forest plot from extracted data.

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

  // The forest plot itself renders as an inline SVG image.
  const plot = page.locator('img[src^="data:image/svg+xml"]');
  await expect(plot).toBeVisible();
  await expectNoErrorOverlay(page);
});
