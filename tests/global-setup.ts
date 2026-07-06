import { execSync } from "node:child_process";
import { config } from "dotenv";

// Runs once before the integration suite: migrate the test database to head.
export default function globalSetup() {
  config();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}
