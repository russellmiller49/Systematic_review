import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HttpClient } from "@/server/http/client";
import { resolveEuropePmcPdf, resolveUnpaywallPdf } from "./sources";

const ORIGINAL_CONTACT_EMAIL = process.env.CONTACT_EMAIL;

function jsonClient(handler: (url: string) => { status?: number; json?: unknown }): HttpClient {
  return {
    fetchJson: async (url) => {
      const r = handler(url);
      return { status: r.status ?? 200, json: r.json ?? null };
    },
    fetchBytes: async () => {
      throw new Error("not used");
    },
  };
}

beforeEach(() => {
  process.env.CONTACT_EMAIL = "test@example.org";
});

afterEach(() => {
  if (ORIGINAL_CONTACT_EMAIL === undefined) delete process.env.CONTACT_EMAIL;
  else process.env.CONTACT_EMAIL = ORIGINAL_CONTACT_EMAIL;
});

describe("resolveUnpaywallPdf", () => {
  it("returns best_oa_location.url_for_pdf and encodes the DOI + email", async () => {
    let requested = "";
    const http = jsonClient((url) => {
      requested = url;
      return { json: { best_oa_location: { url_for_pdf: "https://oa.example/x.pdf" } } };
    });
    const url = await resolveUnpaywallPdf(http, "10.1000/ab c");
    expect(url).toBe("https://oa.example/x.pdf");
    expect(requested).toBe(
      "https://api.unpaywall.org/v2/10.1000%2Fab%20c?email=test%40example.org",
    );
  });

  it("falls back to the first oa_locations entry with a pdf url", async () => {
    const http = jsonClient(() => ({
      json: {
        best_oa_location: { url_for_pdf: null },
        oa_locations: [{ url_for_pdf: null }, { url_for_pdf: "https://oa.example/y.pdf" }],
      },
    }));
    expect(await resolveUnpaywallPdf(http, "10.1/x")).toBe("https://oa.example/y.pdf");
  });

  it("returns null on 404 / no OA / missing contact email", async () => {
    expect(await resolveUnpaywallPdf(jsonClient(() => ({ status: 404 })), "10.1/x")).toBeNull();
    expect(
      await resolveUnpaywallPdf(jsonClient(() => ({ json: { oa_locations: [] } })), "10.1/x"),
    ).toBeNull();
    delete process.env.CONTACT_EMAIL;
    let called = false;
    const http = jsonClient(() => {
      called = true;
      return { json: {} };
    });
    expect(await resolveUnpaywallPdf(http, "10.1/x")).toBeNull();
    expect(called).toBe(false); // source disabled entirely without the email
  });
});

describe("resolveEuropePmcPdf", () => {
  it("prefers PMID search and returns the fullTextPDF url for OA records", async () => {
    let requested = "";
    const http = jsonClient((url) => {
      requested = url;
      return {
        json: { resultList: { result: [{ pmcid: "PMC12345", isOpenAccess: "Y" }] } },
      };
    });
    const url = await resolveEuropePmcPdf(http, { pmid: "999", doi: "10.1/x" });
    expect(url).toBe("https://www.ebi.ac.uk/europepmc/webservices/rest/PMC12345/fullTextPDF");
    expect(requested).toContain(encodeURIComponent("EXT_ID:999 AND SRC:MED"));
  });

  it("falls back to DOI search when no PMID, and honors inEPMC", async () => {
    let requested = "";
    const http = jsonClient((url) => {
      requested = url;
      return { json: { resultList: { result: [{ pmcid: "PMC7", inEPMC: "Y" }] } } };
    });
    const url = await resolveEuropePmcPdf(http, { pmid: null, doi: "10.1/x" });
    expect(url).toContain("PMC7/fullTextPDF");
    expect(requested).toContain(encodeURIComponent('DOI:"10.1/x"'));
  });

  it("returns null for non-OA records, no pmcid, no ids, or bad responses", async () => {
    expect(
      await resolveEuropePmcPdf(
        jsonClient(() => ({ json: { resultList: { result: [{ pmcid: "PMC1" }] } } })),
        { pmid: "1" },
      ),
    ).toBeNull(); // pmcid but not flagged OA
    expect(
      await resolveEuropePmcPdf(
        jsonClient(() => ({ json: { resultList: { result: [{ isOpenAccess: "Y" }] } } })),
        { pmid: "1" },
      ),
    ).toBeNull(); // OA but no pmcid
    expect(await resolveEuropePmcPdf(jsonClient(() => ({ json: {} })), {})).toBeNull();
    expect(
      await resolveEuropePmcPdf(jsonClient(() => ({ status: 500 })), { pmid: "1" }),
    ).toBeNull();
  });
});
