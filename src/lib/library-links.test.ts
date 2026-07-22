import { describe, expect, it } from "vitest";
import { buildLibraryLinks, type CitationLinkFields } from "./library-links";

const SETTINGS = {
  institutionName: "Demo University Library",
  ezproxyBaseUrl: "https://login.ezproxy.demo.edu/login?url=",
  openUrlBaseUrl: "https://demo.edu/openurl",
};

const CITATION: CitationLinkFields = {
  title: "Endobronchial valves for severe emphysema",
  authors: [{ family: "Smith", given: "J" }, { family: "Jones" }],
  year: 2020,
  journal: "Journal of Testing",
  volume: "12",
  issue: "3",
  pages: "101-110",
  doi: "10.1000/xyz123",
  pmid: "12345678",
};

describe("buildLibraryLinks", () => {
  it("returns null without settings or when settings produce no links", () => {
    expect(buildLibraryLinks(CITATION, null)).toBeNull();
    expect(
      buildLibraryLinks(CITATION, {
        institutionName: "X",
        ezproxyBaseUrl: null,
        openUrlBaseUrl: null,
      }),
    ).toBeNull();
    // EZProxy configured but the citation has no doi/pmid, no OpenURL base → nothing.
    expect(
      buildLibraryLinks(
        { title: "T", doi: null, pmid: null },
        { institutionName: null, ezproxyBaseUrl: SETTINGS.ezproxyBaseUrl, openUrlBaseUrl: null },
      ),
    ).toBeNull();
  });

  it("builds EZProxy-prefixed DOI and PubMed links with encoded targets", () => {
    const links = buildLibraryLinks(CITATION, SETTINGS)!;
    expect(links.proxiedDoiUrl).toBe(
      "https://login.ezproxy.demo.edu/login?url=" +
        encodeURIComponent("https://doi.org/10.1000/xyz123"),
    );
    expect(links.proxiedPubMedUrl).toBe(
      "https://login.ezproxy.demo.edu/login?url=" +
        encodeURIComponent("https://pubmed.ncbi.nlm.nih.gov/12345678/"),
    );
    expect(links.institutionName).toBe("Demo University Library");
  });

  it("builds a Z39.88 KEV OpenURL with all available fields", () => {
    const links = buildLibraryLinks(CITATION, SETTINGS)!;
    const url = new URL(links.openUrlLink!);
    expect(url.origin + url.pathname).toBe("https://demo.edu/openurl");
    const params = url.searchParams;
    expect(params.get("url_ver")).toBe("Z39.88-2004");
    expect(params.get("rft_val_fmt")).toBe("info:ofi/fmt:kev:mtx:journal");
    expect(params.get("rft.genre")).toBe("article");
    expect(params.getAll("rft_id")).toEqual([
      "info:doi/10.1000/xyz123",
      "info:pmid/12345678",
    ]);
    expect(params.get("rft.atitle")).toBe(CITATION.title);
    expect(params.get("rft.jtitle")).toBe("Journal of Testing");
    expect(params.get("rft.aulast")).toBe("Smith");
    expect(params.get("rft.date")).toBe("2020");
    expect(params.get("rft.volume")).toBe("12");
    expect(params.get("rft.issue")).toBe("3");
    expect(params.get("rft.spage")).toBe("101");
  });

  it("appends with & when the resolver base already has a query string", () => {
    const links = buildLibraryLinks(CITATION, {
      ...SETTINGS,
      openUrlBaseUrl: "https://demo.edu/openurl?vid=DEMO",
    })!;
    expect(links.openUrlLink).toContain("?vid=DEMO&url_ver=");
  });

  it("omits absent fields and derives aulast from raw author strings", () => {
    const links = buildLibraryLinks(
      { title: "Minimal", authors: [{ raw: "Garcia, M." }], doi: "10.1/a" },
      { institutionName: null, ezproxyBaseUrl: null, openUrlBaseUrl: SETTINGS.openUrlBaseUrl },
    )!;
    const params = new URL(links.openUrlLink!).searchParams;
    expect(params.get("rft.aulast")).toBe("Garcia");
    expect(params.get("rft.jtitle")).toBeNull();
    expect(params.get("rft.date")).toBeNull();
    expect(params.get("rft.spage")).toBeNull();
  });
});
