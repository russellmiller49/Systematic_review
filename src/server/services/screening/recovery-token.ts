import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { invalidState, validationError } from "@/server/errors";

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value) throw invalidState("Recovery preflight signing is unavailable");
  return value;
}
export function signPlan(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", secret()).update(body).digest("base64url")}`;
}
export function readPlan(token: string): unknown {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra)
    throw validationError("Invalid recovery plan");
  const actual = Buffer.from(signature, "base64url");
  const expected = createHmac("sha256", secret()).update(body).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw validationError("Invalid recovery plan");
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    throw validationError("Invalid recovery plan");
  }
}
