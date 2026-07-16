// Provider registry + test seam. Services always go through requireAiProvider(); the UI
// learns whether AI is enabled via the project payload (getAiConfig().enabled).

import { invalidState } from "@/server/errors";
import { getAiConfig } from "./config";
import type { AiProvider } from "./types";
import { AnthropicProvider } from "./anthropic";
import { OpenAiProvider } from "./openai";
import { GeminiProvider } from "./gemini";

let cached: { key: string; provider: AiProvider } | null = null;
let testOverride: AiProvider | null | undefined; // undefined = no override active

export function getAiProvider(): AiProvider | null {
  if (testOverride !== undefined) return testOverride;
  const config = getAiConfig();
  if (!config.enabled || config.apiKey === null) return null;
  const key = `${config.provider}:${config.apiKey}`;
  if (cached?.key !== key) {
    const provider =
      config.provider === "anthropic"
        ? new AnthropicProvider(config.apiKey)
        : config.provider === "openai"
          ? new OpenAiProvider(config.apiKey)
          : new GeminiProvider(config.apiKey);
    cached = { key, provider };
  }
  return cached.provider;
}

export function requireAiProvider(): AiProvider {
  const provider = getAiProvider();
  if (!provider) {
    throw invalidState(
      "AI features are disabled — set AI_PROVIDER and its API key in the server environment",
    );
  }
  return provider;
}

// Test seam (mirrors the lazy env-singleton pattern of getStorage()): integration tests
// inject a typed FakeAiProvider without module mocks. Pass null to simulate "disabled".
export function setAiProviderForTests(provider: AiProvider | null): void {
  testOverride = provider;
}

export function resetAiProviderForTests(): void {
  testOverride = undefined;
  cached = null;
}
