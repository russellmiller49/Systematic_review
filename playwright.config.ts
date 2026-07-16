import { defineConfig } from "@playwright/test";

// E2E runs against the dev server on a real Postgres. globalSetup reseeds the demo dataset,
// and the suite runs serially (workers: 1) because specs share that one database — the
// happy-path spec adds its own fresh data while the seeded specs read/mutate the demo project.
//
// E2E_PORT (default 3000) picks the dev-server port — set it when another app already
// occupies 3000 (reuseExistingServer would otherwise latch onto the foreign server).
const port = Number(process.env.E2E_PORT ?? 3000);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
