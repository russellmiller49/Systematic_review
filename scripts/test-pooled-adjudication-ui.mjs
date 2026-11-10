// Standalone browser smoke test: in-memory bundle and API fixtures only. No DB or Next auth.
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { resolve } from "node:path";

const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {PooledConflictsClient} from './src/components/conflicts/pooled-conflicts-client'; createRoot(document.getElementById('root')).render(<PooledConflictsClient guidelineId="guide" poolId="pool" />);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  platform: "browser",
  jsx: "automatic",
  tsconfig: resolve("tsconfig.json"),
  define: { "process.env.NODE_ENV": '"development"' },
});
const picos = [
  { id: "p1", title: "First question", picoNumber: 1 },
  { id: "p2", title: "Second question", picoNumber: 2 },
];
const fresh = () => ({
  pool: { id: "pool", name: "Combined pool" },
  picos,
  reasons: [{ label: "Wrong population" }],
  criteria: [
    {
      id: "criteria",
      projectId: "p1",
      type: "INCLUSION",
      category: "Population",
      text: "Adults",
      order: 0,
    },
  ],
  summary: { open: 1, resolved: 0, needsSynchronization: 0 },
  items: [
    {
      id: "group",
      citationIds: ["c1", "c2"],
      stateToken: "token1",
      status: "OPEN",
      citation: {
        id: "c1",
        title: "Example pooled study",
        abstract: "Initial abstract",
        authors: [],
        year: 2025,
        doi: null,
        pmid: null,
      },
      picos,
      decisions: [
        {
          reviewer: { id: "u1", name: "Reviewer One" },
          projectId: "p1",
          citationId: "c1",
          decision: "INCLUDE",
          notes: "Original vote",
        },
      ],
      adjudication: null,
    },
  ],
});
let data = fresh();
let posts = [];
let stale = false;
let changedStatus = false;
let forbidden = false;
let postDelay = 0;
const server = createServer(async (req, res) => {
  if (req.url === "/bundle.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(bundle.outputFiles[0].text);
    return;
  }
  if (req.url.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      posts.push({ url: req.url, ...JSON.parse(body) });
      if (postDelay) await new Promise((done) => setTimeout(done, postDelay));
      if (stale) {
        stale = false;
        data.items[0].stateToken = "token2";
        data.items[0].citation.abstract = "Updated abstract";
        if (changedStatus) data.items[0].status = "RESOLVED";
        res.statusCode = 422;
        res.end(
          JSON.stringify({
            error: {
              code: "INVALID_STATE",
              message: "Linked records changed. Review required.",
            },
          }),
        );
        return;
      }
      data.items[0].status = "RESOLVED";
      res.end(JSON.stringify({ data: {} }));
      return;
    }
    if (forbidden) {
      res.statusCode = 403;
      res.end(
        JSON.stringify({ error: { code: "FORBIDDEN", message: "Forbidden" } }),
      );
      return;
    }
    res.end(JSON.stringify({ data }));
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end(
    '<html><body><div id="root"></div><script>window.process={env:{NODE_ENV:"development"}};</script><script src="/bundle.js"></script></body></html>',
  );
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on(
    "pageerror",
    (error) => (
      errors.push(error.message),
      console.error("Browser error:", error.message)
    ),
  );
  const open = async () => {
    await page.goto(url);
    await page
      .getByRole("button", {
        name: "Adjudicate across linked PICOs",
        exact: true,
      })
      .click();
  };
  const dialog = page.getByRole("dialog");
  await open();
  await dialog
    .getByLabel("Final decision", { exact: true })
    .selectOption("EXCLUDE");
  await dialog
    .getByLabel("Rationale (required)")
    .fill("A considered rationale");
  await expect(
    dialog.getByRole("button", { name: "Record for all linked PICOs" }),
  ).toBeDisabled();
  await dialog
    .getByLabel("Exclusion reason (required)")
    .selectOption("Wrong population");
  await expect(
    dialog.getByRole("button", { name: "Record for all linked PICOs" }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  if (posts.length) throw new Error("Cancel submitted a request");
  console.log("PASS required exclusion reason and cancel without mutation");

  stale = true;
  await open();
  await dialog
    .getByLabel("Final decision", { exact: true })
    .selectOption("INCLUDE");
  await dialog.getByLabel("Rationale (required)").fill("Keep this rationale");
  await dialog
    .getByRole("button", { name: "Record for all linked PICOs" })
    .click();
  await expect(dialog.getByText("Updated abstract")).toBeVisible();
  await expect(dialog.getByLabel("Rationale (required)")).toHaveValue(
    "Keep this rationale",
  );
  await expect(
    dialog.getByLabel("Final decision", { exact: true }),
  ).toHaveValue("");
  await expect(
    dialog.getByRole("button", { name: "Record for all linked PICOs" }),
  ).toBeDisabled();
  await dialog
    .getByLabel("Final decision", { exact: true })
    .selectOption("INCLUDE");
  await expect(
    dialog.getByRole("button", { name: "Record for all linked PICOs" }),
  ).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  postDelay = 150;
  await dialog
    .getByRole("button", { name: "Record for all linked PICOs" })
    .dblclick();
  await expect(dialog).toHaveCount(0);
  if (posts.length !== 2 || posts[1].stateToken !== "token2")
    throw new Error("Stale refresh or duplicate submit failed");
  console.log(
    "PASS stale rationale preservation, new decision/review requirement, refreshed token and duplicate-submit lock",
  );

  data = fresh();
  posts = [];
  stale = true;
  changedStatus = true;
  postDelay = 0;
  await open();
  await dialog
    .getByLabel("Final decision", { exact: true })
    .selectOption("INCLUDE");
  await dialog
    .getByLabel("Rationale (required)")
    .fill("Retain intended action");
  await dialog
    .getByRole("button", { name: "Record for all linked PICOs" })
    .click();
  await expect(
    dialog.getByText(/This citation’s status or linked records changed/),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Record for all linked PICOs" }),
  ).toBeDisabled();
  if (posts.some((post) => post.url.endsWith("/reopen")))
    throw new Error("Action silently changed to reopen");
  console.log(
    "PASS status change cannot silently switch adjudication into reopen",
  );

  data = fresh();
  data.items[0].status = "NEEDS_SYNCHRONIZATION";
  data.items[0].synchronizationReason = "Two copies in one PICO";
  data.items[0].historicalAdjudications = [
    {
      projectId: "p1",
      citationId: "c1",
      conflictStatus: "RESOLVED",
      effectiveAt: "2026-11-10T16:45:00Z",
      timestampSource: "audit",
      adjudication: {
        finalDecision: "EXCLUDE",
        reason: "Historical clinical rationale",
        adjudicator: { id: "prior-adjudicator", name: "Prior Adjudicator" },
        exclusionReason: { label: "Wrong population" },
        createdAt: "2026-10-01T00:00:00Z",
      },
    },
  ];
  await page.goto(url);
  await page
    .getByRole("button", { name: "Needs synchronization", exact: true })
    .click();
  await expect(page.getByText("Historical clinical rationale")).toBeVisible();
  await expect(page.getByText(/Prior Adjudicator/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Adjudicate across linked PICOs" }),
  ).toHaveCount(0);
  console.log(
    "PASS synchronization exceptions show historical attribution without actions",
  );
  await expect(page.locator('time[datetime="2026-11-10T16:45:00Z"]')).toBeVisible();
  await expect(page.locator('time[datetime="2026-10-01T00:00:00Z"]')).toHaveCount(0);
  const effectiveDisplay = await page.evaluate(() => new Date("2026-11-10T16:45:00Z").toLocaleString());
  const originalDisplay = await page.evaluate(() => new Date("2026-10-01T00:00:00Z").toLocaleString());
  await expect(page.getByText(`Adjudicated: ${effectiveDisplay}`, { exact: true })).toBeVisible();
  await expect(page.getByText(originalDisplay, { exact: true })).toHaveCount(0);
  data.items[0].historicalAdjudications[0].effectiveAt = null;
  data.items[0].historicalAdjudications[0].timestampSource = "unknown";
  await page.goto(url);
  await page.getByRole("button", { name: "Needs synchronization", exact: true }).click();
  await expect(page.getByText("Adjudication time unavailable", { exact: true })).toBeVisible();
  await expect(page.locator("time")).toHaveCount(0);
  console.log("PASS historical adjudication uses effective action date, never original creation date; unknown time is explicit");
  forbidden = true;
  await page.goto(url);
  await expect(
    page.getByText(/Adjudication rights are required/),
  ).toBeVisible();
  await expect(page.getByText("Reviewer One")).toHaveCount(0);
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "PASS forbidden response does not show votes; no browser runtime errors",
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
