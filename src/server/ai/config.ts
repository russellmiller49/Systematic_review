// AI feature configuration from environment (no config module exists in this repo — direct
// process.env reads, centralized here; mirrors the getStorage() pattern).

import type { AiProviderName } from "./types";
import { AI_PROVIDER_NAMES } from "./types";

const DEFAULT_MODELS: Record<AiProviderName, string> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-5.1",
  gemini: "gemini-2.5-pro",
};

const KEY_ENV: Record<AiProviderName, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export interface AiConfig {
  enabled: boolean;
  provider: AiProviderName;
  apiKey: string | null;
  screeningModel: string;
  extractionModel: string;
}

export function getAiConfig(): AiConfig {
  const raw = (process.env.AI_PROVIDER ?? "anthropic").trim().toLowerCase();
  const provider = (AI_PROVIDER_NAMES as readonly string[]).includes(raw)
    ? (raw as AiProviderName)
    : "anthropic";
  const apiKey = (process.env[KEY_ENV[provider]] ?? "").trim() || null;
  return {
    enabled: apiKey !== null,
    provider,
    apiKey,
    screeningModel: (process.env.AI_SCREENING_MODEL ?? "").trim() || DEFAULT_MODELS[provider],
    extractionModel: (process.env.AI_EXTRACTION_MODEL ?? "").trim() || DEFAULT_MODELS[provider],
  };
}
