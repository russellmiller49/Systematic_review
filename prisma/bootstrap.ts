/* eslint-disable no-console */
// Safe production bootstrap: creates only the shared built-in RoB catalog. Unlike seed.ts,
// this is idempotent and never deletes project or user data.
import "dotenv/config";
import { prisma } from "@/server/db";
import { ensureBuiltinGenericTool } from "@/server/services/rob/builtin";
import { ensureBuiltinStandardTools } from "@/server/services/rob/standard-tools";

async function main() {
  await ensureBuiltinGenericTool();
  const tools = await ensureBuiltinStandardTools();
  console.log(`Production bootstrap complete (${tools.length + 1} built-in RoB tools ready).`);
}

main()
  .catch((error) => {
    console.error("Production bootstrap failed:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
