import { afterEach, describe, expect, it, vi } from "vitest";
import { getAiConfig } from "./config";

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubEnv(vars: Record<string, string>) {
  // Clear the full AI env surface, then apply the case under test.
  for (const key of [
    "AI_PROVIDER",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "AI_SCREENING_MODEL",
    "AI_EXTRACTION_MODEL",
  ]) {
    vi.stubEnv(key, vars[key] ?? "");
  }
}

describe("getAiConfig", () => {
  it("defaults to anthropic and is disabled without a key", () => {
    stubEnv({});
    const config = getAiConfig();
    expect(config.provider).toBe("anthropic");
    expect(config.enabled).toBe(false);
    expect(config.apiKey).toBeNull();
  });

  it("enables when the selected provider's key is present", () => {
    stubEnv({ ANTHROPIC_API_KEY: "sk-test" });
    const config = getAiConfig();
    expect(config.enabled).toBe(true);
    expect(config.apiKey).toBe("sk-test");
    expect(config.screeningModel).toBe("claude-opus-4-8");
    expect(config.extractionModel).toBe("claude-opus-4-8");
  });

  it("ignores other providers' keys", () => {
    stubEnv({ AI_PROVIDER: "openai", ANTHROPIC_API_KEY: "sk-test" });
    expect(getAiConfig().enabled).toBe(false);
  });

  it("selects openai and gemini with their defaults", () => {
    stubEnv({ AI_PROVIDER: "openai", OPENAI_API_KEY: "sk-o" });
    expect(getAiConfig()).toMatchObject({
      provider: "openai",
      enabled: true,
      screeningModel: "gpt-5.1",
    });
    stubEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "sk-g" });
    expect(getAiConfig()).toMatchObject({
      provider: "gemini",
      enabled: true,
      extractionModel: "gemini-2.5-pro",
    });
  });

  it("applies per-feature model overrides", () => {
    stubEnv({
      ANTHROPIC_API_KEY: "sk-test",
      AI_SCREENING_MODEL: "claude-haiku-4-5",
      AI_EXTRACTION_MODEL: "claude-opus-4-8",
    });
    const config = getAiConfig();
    expect(config.screeningModel).toBe("claude-haiku-4-5");
    expect(config.extractionModel).toBe("claude-opus-4-8");
  });

  it("falls back to anthropic on an unknown provider value", () => {
    stubEnv({ AI_PROVIDER: "azure", ANTHROPIC_API_KEY: "sk-test" });
    expect(getAiConfig().provider).toBe("anthropic");
  });
});
