export function safeInternalPath(value: string | null | undefined, fallback = "/orgs") {
  if (!value?.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}
