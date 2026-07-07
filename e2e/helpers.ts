import { expect, type Page } from "@playwright/test";

export const DEMO_PASSWORD = "demo-password-123";
export const DEMO = {
  owner: "owner@demo.test",
  reviewer1: "reviewer1@demo.test",
  reviewer2: "reviewer2@demo.test",
  adjudicator: "adjudicator@demo.test",
};

/** Sign in through the real credentials form and wait for the app shell (/orgs). */
export async function signIn(page: Page, email: string, password = DEMO_PASSWORD) {
  await page.goto("/sign-in");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/orgs(\/|$)/, { timeout: 30_000 });
}

/** Register a brand-new account; lands on /orgs already authenticated. */
export async function signUp(page: Page, name: string, email: string, password = DEMO_PASSWORD) {
  await page.goto("/sign-up");
  await page.fill("#name", name);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.getByRole("button", { name: /create account|sign up/i }).click();
  await page.waitForURL(/\/orgs(\/|$)/, { timeout: 30_000 });
}

/** Open the seeded demo project from the org list, returning its projectId. */
export async function openDemoProject(page: Page): Promise<string> {
  await page.goto("/orgs");
  await page.getByRole("link", { name: /Interventional Pulmonology Evidence Group/i }).click();
  await page.waitForURL(/\/orgs\/[^/]+$/);
  await page.getByRole("link", { name: /Endobronchial valves for severe emphysema/i }).click();
  await page.waitForURL(/\/projects\/[^/]+$/);
  const projectId = page.url().match(/\/projects\/([^/?]+)/)?.[1];
  expect(projectId, "expected to be on a project URL").toBeTruthy();
  return projectId as string;
}

/** Assert the Next.js dev error overlay is not showing (its heading text only appears on error). */
export async function expectNoErrorOverlay(page: Page) {
  await expect(
    page.getByText(/Unhandled Runtime Error|Build Error|Application error/i),
  ).toHaveCount(0);
}
