import { defineConfig } from "@playwright/test";

// E2E runs against the dev server on a real Postgres. globalSetup reseeds the demo dataset,
// and the suite runs serially (workers: 1) because specs share that one database — the
// happy-path spec adds its own fresh data while the seeded specs read/mutate the demo project.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
