// External metadata lookups (Crossref by DOI, PubMed esummary by PMID) for the
// reference library's add-by-identifier flow. Read-only previews — no DB writes.

import { invalidState } from "@/server/errors";
import { getHttpClient, politeHeaders } from "@/server/http/client";
import { normalizeDoi, normalizePmid } from "@/server/services/citations/normalize";
import { crossrefToCsl, pubmedSummaryToCsl, type CslItemInput } from "./csl";

const LOOKUP_TIMEOUT_MS = 10_000;

export async function lookupDoi(doi: string): Promise<CslItemInput> {
  const normalized = normalizeDoi(doi);
  if (!normalized) throw invalidState("That does not look like a DOI");
  const url = `https://api.crossref.org/works/${encodeURIComponent(normalized)}`;
  let res;
  try {
    res = await getHttpClient().fetchJson(url, {
      headers: politeHeaders(),
      timeoutMs: LOOKUP_TIMEOUT_MS,
    });
  } catch (err) {
    throw invalidState(`Crossref lookup failed: ${message(err)}`);
  }
  if (res.status === 404) throw invalidState("Crossref has no record for that DOI");
  if (res.status !== 200) throw invalidState(`Crossref lookup failed (HTTP ${res.status})`);
  const body = res.json as { message?: unknown } | null;
  if (!body?.message) throw invalidState("Crossref returned an unexpected response");
  try {
    return crossrefToCsl(body.message);
  } catch {
    throw invalidState("Crossref record could not be converted to a reference");
  }
}

export async function lookupPmid(pmid: string): Promise<CslItemInput> {
  const normalized = normalizePmid(pmid);
  if (!normalized) throw invalidState("That does not look like a PMID");
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${normalized}&retmode=json`;
  let res;
  try {
    res = await getHttpClient().fetchJson(url, {
      headers: politeHeaders(),
      timeoutMs: LOOKUP_TIMEOUT_MS,
    });
  } catch (err) {
    throw invalidState(`PubMed lookup failed: ${message(err)}`);
  }
  if (res.status !== 200) throw invalidState(`PubMed lookup failed (HTTP ${res.status})`);
  const body = res.json as { result?: Record<string, unknown> } | null;
  const docsum = body?.result?.[normalized] as Record<string, unknown> | undefined;
  if (!docsum || typeof docsum !== "object" || "error" in docsum) {
    throw invalidState("PubMed has no record for that PMID");
  }
  try {
    return pubmedSummaryToCsl(docsum);
  } catch {
    throw invalidState("PubMed record could not be converted to a reference");
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
