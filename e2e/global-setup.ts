import { execSync } from "node:child_process";

// Reseed the demo dataset before the E2E run so the seeded specs (adjudication, authz,
// dashboard reads) have a known, deterministic starting state. The seed resets the database.
export default function globalSetup() {
  // eslint-disable-next-line no-console
  console.log("[e2e] Seeding demo dataset…");
  execSync("npm run db:seed", { stdio: "inherit" });
}
