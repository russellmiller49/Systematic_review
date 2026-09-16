import { randomBytes, createHash } from "node:crypto";
import { config } from "dotenv";
import { hash } from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { test, expect } from "@playwright/test";

config();
const db = new PrismaClient();
const email = `password-reset-${randomBytes(8).toString("hex")}@example.com`;
const oldPassword = "original-password-123";
const newPassword = "replacement-password-456";
const token = randomBytes(32).toString("hex");
let userId: string;

test.beforeAll(async () => {
  const user = await db.user.create({ data: { email, name: "Reset Test", passwordHash: await hash(oldPassword, 4) } });
  userId = user.id;
  await db.passwordResetToken.create({ data: {
    userId, tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 30 * 60_000),
  } });
});

test.afterAll(async () => {
  if (userId) {
    await db.auditEvent.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } });
  }
  await db.$disconnect();
});

test("forgot password, reset validation, session invalidation, and sign-in with the new password", async ({ page, browser }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(oldPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/orgs/);

  const resetContext = await browser.newContext();
  const resetPage = await resetContext.newPage();
  const origin = new URL(page.url()).origin;
  await resetPage.goto(`${origin}/sign-in`);
  await resetPage.getByRole("link", { name: "Reset password", exact: true }).click();
  await expect(resetPage).toHaveURL(`${origin}/forgot-password`);
  // Delivery is exercised against mocked Resend in the real-DB integration suite.
  await resetPage.route("**/api/auth/forgot-password", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ data: { message: "If an account exists for that email, we’ll send a password reset link." } }),
  }));
  await resetPage.getByLabel("Email", { exact: true }).fill(email);
  await resetPage.getByRole("button", { name: "Send reset link" }).click();
  await expect(resetPage.getByRole("status")).toContainText("If an account exists");

  await resetPage.goto(`${origin}/reset-password`);
  await expect(resetPage.getByRole("main").getByRole("alert")).toContainText("missing or invalid");
  await resetPage.goto(`${origin}/reset-password#token=${token}`);
  await resetPage.getByLabel("New password", { exact: true }).fill(newPassword);
  await resetPage.getByLabel("Confirm new password").fill("mismatched-password");
  await resetPage.getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(resetPage.getByRole("main").getByRole("alert")).toHaveText("Passwords do not match.");
  await resetPage.getByLabel("Confirm new password").fill(newPassword);
  await resetPage.getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(resetPage.getByRole("status")).toContainText("changed successfully");
  await expect(resetPage).toHaveURL(`${origin}/reset-password`);

  await page.reload();
  await expect(page).toHaveURL(/\/sign-in/);
  await resetPage.getByRole("link", { name: "Back to sign in" }).click();
  await expect(resetPage).toHaveURL(`${origin}/sign-in`);
  await resetPage.getByLabel("Email", { exact: true }).fill(email);
  await resetPage.getByLabel("Password", { exact: true }).fill(oldPassword);
  await resetPage.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(resetPage.getByText("Invalid email or password", { exact: true })).toBeVisible();
  await resetPage.getByLabel("Password", { exact: true }).fill(newPassword);
  await resetPage.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(resetPage).toHaveURL(/\/orgs/);

  await resetPage.goto(`${origin}/reset-password#token=${token}`);
  await resetPage.getByLabel("New password", { exact: true }).fill(newPassword);
  await resetPage.getByLabel("Confirm new password").fill(newPassword);
  await resetPage.getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(resetPage.getByRole("main").getByRole("alert")).toContainText("invalid or has expired");
  await resetPage.setViewportSize({ width: 390, height: 844 });
  await expect(resetPage.getByRole("button", { name: "Reset password", exact: true })).toBeInViewport();
  expect(await resetPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await resetContext.close();
});
