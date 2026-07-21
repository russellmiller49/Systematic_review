import { describe, expect, it } from "vitest";
import { safeInternalPath } from "./navigation";

describe("safeInternalPath", () => {
  it("allows application-relative paths", () => {
    expect(safeInternalPath("/invitations/token-123")).toBe("/invitations/token-123");
    expect(safeInternalPath("/organization-invitations/token-456")).toBe(
      "/organization-invitations/token-456",
    );
  });

  it("rejects external and protocol-relative callback URLs", () => {
    expect(safeInternalPath("https://example.com")).toBe("/orgs");
    expect(safeInternalPath("//example.com/path")).toBe("/orgs");
  });
});
