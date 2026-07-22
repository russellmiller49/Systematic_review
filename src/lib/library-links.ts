// Institutional library link builder — pure, isomorphic (used server-side by the
// full-text queue payload and rendered client-side). The app never stores institutional
// credentials: these links open in the member's own browser session, where their
// EZProxy/SSO login does the authentication.

export interface LibrarySettingsFields {
  institutionName: string | null;
  ezproxyBaseUrl: string | null;
  openUrlBaseUrl: string | null;
}

export interface CitationLinkFields {
  title: string;
  authors?: unknown; // Citation.authors Json: [{ family?, given?, raw? }]
  year?: number | null;
  journal?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  doi?: string | null;
  pmid?: string | null;
}

export interface LibraryLinks {
  institutionName: string | null;
  proxiedDoiUrl?: string;
  proxiedPubMedUrl?: string;
  openUrlLink?: string;
}

function firstAuthorFamily(authors: unknown): string | null {
  if (!Array.isArray(authors) || authors.length === 0) return null;
  const first = authors[0] as { family?: unknown; raw?: unknown };
  if (typeof first?.family === "string" && first.family.trim()) return first.family.trim();
  if (typeof first?.raw === "string" && first.raw.trim()) {
    // "Smith J" / "Smith, J." → take the leading token before a comma or space.
    return first.raw.trim().split(/[,\s]/)[0] || null;
  }
  return null;
}

function firstPage(pages: string | null | undefined): string | null {
  if (!pages) return null;
  const start = pages.split(/[-–—]/)[0]?.trim();
  return start || null;
}

// Z39.88-2004 KEV OpenURL for a journal article, built from whatever fields exist.
function buildOpenUrl(citation: CitationLinkFields, base: string): string | null {
  const params: [string, string][] = [
    ["url_ver", "Z39.88-2004"],
    ["url_ctx_fmt", "info:ofi/fmt:kev:mtx:ctx"],
    ["rft_val_fmt", "info:ofi/fmt:kev:mtx:journal"],
    ["rft.genre", "article"],
  ];
  if (citation.doi) params.push(["rft_id", `info:doi/${citation.doi}`]);
  if (citation.pmid) params.push(["rft_id", `info:pmid/${citation.pmid}`]);
  if (citation.title) params.push(["rft.atitle", citation.title]);
  if (citation.journal) params.push(["rft.jtitle", citation.journal]);
  const aulast = firstAuthorFamily(citation.authors);
  if (aulast) params.push(["rft.aulast", aulast]);
  if (citation.year != null) params.push(["rft.date", String(citation.year)]);
  if (citation.volume) params.push(["rft.volume", citation.volume]);
  if (citation.issue) params.push(["rft.issue", citation.issue]);
  const spage = firstPage(citation.pages);
  if (spage) params.push(["rft.spage", spage]);

  // Nothing that identifies the article → a resolver link would be useless.
  if (!citation.doi && !citation.pmid && !citation.title) return null;

  const kev = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${base}${base.includes("?") ? "&" : "?"}${kev}`;
}

export function buildLibraryLinks(
  citation: CitationLinkFields,
  settings: LibrarySettingsFields | null,
): LibraryLinks | null {
  if (!settings) return null;
  const links: LibraryLinks = { institutionName: settings.institutionName ?? null };
  let any = false;

  if (settings.ezproxyBaseUrl) {
    if (citation.doi) {
      links.proxiedDoiUrl =
        settings.ezproxyBaseUrl + encodeURIComponent(`https://doi.org/${citation.doi}`);
      any = true;
    }
    if (citation.pmid) {
      links.proxiedPubMedUrl =
        settings.ezproxyBaseUrl +
        encodeURIComponent(`https://pubmed.ncbi.nlm.nih.gov/${citation.pmid}/`);
      any = true;
    }
  }

  if (settings.openUrlBaseUrl) {
    const openUrl = buildOpenUrl(citation, settings.openUrlBaseUrl);
    if (openUrl) {
      links.openUrlLink = openUrl;
      any = true;
    }
  }

  return any ? links : null;
}
