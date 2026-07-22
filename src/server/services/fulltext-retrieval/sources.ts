// Open-access PDF resolvers — pure given an injected HttpClient (unit-tested with stubs).
// Only OA-declared locations are used: Unpaywall's reported locations and Europe PMC's
// open-access subset. Paywalled publisher content is never scraped (docs/09 posture).

import type { HttpClient } from "@/server/http/client";
import { getContactEmail, politeHeaders } from "@/server/http/client";

export const OA_SOURCES = ["unpaywall", "europepmc"] as const;
export type OaSource = (typeof OA_SOURCES)[number];

const RESOLVE_TIMEOUT_MS = 8_000;

// Unpaywall requires a contact email; without CONTACT_EMAIL the source is disabled.
export async function resolveUnpaywallPdf(http: HttpClient, doi: string): Promise<string | null> {
  const email = getContactEmail();
  if (!email) return null;
  const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
  const res = await http.fetchJson(url, { headers: politeHeaders(), timeoutMs: RESOLVE_TIMEOUT_MS });
  if (res.status !== 200 || res.json === null || typeof res.json !== "object") return null;
  const body = res.json as {
    best_oa_location?: { url_for_pdf?: unknown } | null;
    oa_locations?: { url_for_pdf?: unknown }[] | null;
  };
  const best = body.best_oa_location?.url_for_pdf;
  if (typeof best === "string" && best) return best;
  for (const loc of body.oa_locations ?? []) {
    if (typeof loc?.url_for_pdf === "string" && loc.url_for_pdf) return loc.url_for_pdf;
  }
  return null;
}

// Europe PMC: search by PMID (preferred) or DOI; when the record is in the OA subset,
// its PDF is served by the fullTextPDF endpoint.
export async function resolveEuropePmcPdf(
  http: HttpClient,
  ids: { pmid?: string | null; doi?: string | null },
): Promise<string | null> {
  const query = ids.pmid
    ? `EXT_ID:${ids.pmid} AND SRC:MED`
    : ids.doi
      ? `DOI:"${ids.doi}"`
      : null;
  if (!query) return null;
  const url =
    "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=" +
    encodeURIComponent(query) +
    "&format=json&pageSize=1";
  const res = await http.fetchJson(url, { headers: politeHeaders(), timeoutMs: RESOLVE_TIMEOUT_MS });
  if (res.status !== 200 || res.json === null || typeof res.json !== "object") return null;
  const body = res.json as {
    resultList?: { result?: { pmcid?: unknown; isOpenAccess?: unknown; inEPMC?: unknown }[] };
  };
  const hit = body.resultList?.result?.[0];
  if (!hit || typeof hit.pmcid !== "string" || !hit.pmcid) return null;
  const isOa = hit.isOpenAccess === "Y" || hit.inEPMC === "Y";
  if (!isOa) return null;
  return `https://www.ebi.ac.uk/europepmc/webservices/rest/${encodeURIComponent(hit.pmcid)}/fullTextPDF`;
}
