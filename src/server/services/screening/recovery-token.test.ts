import { afterEach, expect, it, vi } from "vitest";
import { readPlan, signPlan } from "./recovery-token";

afterEach(() => vi.unstubAllEnvs());
it("authenticates a preflight without trusting edited payloads or malformed signatures", () => {
  vi.stubEnv("AUTH_SECRET", "synthetic-test-secret");
  const token = signPlan({ actorId: "owner", operation: "withdraw" });
  expect(readPlan(token)).toEqual({ actorId: "owner", operation: "withdraw" });
  expect(() =>
    readPlan(
      token.replace(
        token.split(".")[0]!,
        Buffer.from('{"actorId":"other"}').toString("base64url"),
      ),
    ),
  ).toThrow("Invalid recovery plan");
  expect(() => readPlan(token + ".extra")).toThrow("Invalid recovery plan");
  expect(() => readPlan(token.split(".")[0] + ".AA")).toThrow(
    "Invalid recovery plan",
  );
});
it("fails closed without the application signing secret", () => {
  vi.stubEnv("AUTH_SECRET", "");
  expect(() => signPlan({})).toThrow("signing is unavailable");
});
