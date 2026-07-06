import { defineConfig } from "vitest/config";
import path from "node:path";

// Unit tests: pure logic, colocated with source, no database.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
