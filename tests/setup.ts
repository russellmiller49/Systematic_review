import { config } from "dotenv";

// Runs in each worker BEFORE test files import src/server/db — point Prisma at srb_test.
config();
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is not set");
process.env.DATABASE_URL = url;
