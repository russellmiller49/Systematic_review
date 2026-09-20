import { defineConfig } from "@playwright/test";
import { config } from "dotenv";
config();
if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required");
// Feature QA uses the integration database, never the user's development citations.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.PILOT_EMAIL_ALLOWLIST = "";
const port = Number(process.env.E2E_PORT ?? 3108);
export default defineConfig({
  testDir: "./e2e",
  testMatch: "dedup-safety.spec.ts",
  workers: 1,
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: `http://localhost:${port}`,
    timeout: 120_000,
  },
});
