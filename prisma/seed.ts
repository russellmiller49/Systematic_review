/* eslint-disable no-console */
// Demo dataset (docs/07-test-plan.md §Seed). Everything flows THROUGH the service layer so the
// audit trail is realistic — the only direct prisma access is read-only orchestration lookups
// (finding the ids the services return by relation) and the initial table reset.
//
// Demo review: "Bronchoscopic lung volume reduction with endobronchial valves for severe
// emphysema" — 20 imported citations across 2 sources (PubMed RIS + Embase CSV), 3 duplicate
// pairs (DOI-exact, PMID-exact, fuzzy-title), dedup resolved (→17 active), blinded dual
// title/abstract screening with 3 conflicts (2 adjudicated → INCLUDE, 1 left OPEN), 5 citations
// to full text (3 included → studies, 2 excluded with reasons), dual extraction with 1
// adjudicated field conflict, dual generic-tool RoB with 1 adjudicated domain conflict, and a
// PRISMA snapshot.
import "dotenv/config";
import { prisma } from "@/server/db";
import type { Ctx } from "@/server/auth/session";
import { createUser } from "@/server/services/users";
import * as orgs from "@/server/services/orgs";
import * as projects from "@/server/services/projects";
import * as protocols from "@/server/services/protocols";
import * as imports from "@/server/services/imports";
import * as dedup from "@/server/services/dedup";
import * as screening from "@/server/services/screening";
import * as studiesService from "@/server/services/studies";
import * as fulltext from "@/server/services/fulltext";
import * as analysis from "@/server/services/analysis";
import * as grade from "@/server/services/grade";
import * as extraction from "@/server/services/extraction";
import * as rob from "@/server/services/rob";
import { ensureBuiltinGenericTool } from "@/server/services/rob/builtin";
import { ensureBuiltinStandardTools } from "@/server/services/rob/standard-tools";
import * as prismaReport from "@/server/services/prisma-report";

const PASSWORD = "demo-password-123";

// A small but REAL PDF: valid xref offsets, Helvetica text content, one page per entry in
// `pages`. Starts with the %PDF- magic bytes the upload validator sniffs (R13). Real text
// matters — the evidence viewer extracts a text layer to locate and highlight source quotes,
// so a content-free PDF would leave the demo unable to exercise anchoring. `tag` keeps each
// demo file's bytes unique so content-addressed storage (sha256 dedup) keeps them distinct.
function escapePdfText(line: string): string {
  return line.replace(/[\\()]/g, (c) => `\\${c}`);
}

function demoPdf(tag: string, pages: string[][]): Buffer {
  const objects: string[] = [];
  const pageCount = Math.max(1, pages.length);
  // Object layout: 1 = catalog, 2 = pages, 3 = font, then per page: page obj + content obj.
  const pageObjIds = pages.map((_, i) => 4 + i * 2);
  const contentObjIds = pages.map((_, i) => 5 + i * 2);

  objects[1] = `<</Type/Catalog/Pages 2 0 R>>`;
  objects[2] = `<</Type/Pages/Kids[${pageObjIds.map((id) => `${id} 0 R`).join(" ")}]/Count ${pageCount}>>`;
  objects[3] = `<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>`;
  pages.forEach((lines, i) => {
    const body =
      `BT /F1 11 Tf 72 720 Td 16 TL\n` +
      lines.map((line) => `(${escapePdfText(line)}) Tj T*`).join("\n") +
      `\nET`;
    objects[pageObjIds[i]!] =
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]` +
      `/Resources<</Font<</F1 3 0 R>>>>/Contents ${contentObjIds[i]} 0 R>>`;
    objects[contentObjIds[i]!] = `<</Length ${Buffer.byteLength(body, "utf8")}>>stream\n${body}\nendstream`;
  });

  // Serialize with byte-accurate xref offsets so pdf.js parses without recovery.
  let pdf = `%PDF-1.4\n% ${tag}\n`;
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    const obj = objects[id];
    if (obj === undefined) continue;
    offsets[id] = Buffer.byteLength(pdf, "utf8");
    pdf += `${id} 0 obj${obj}endobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  const size = objects.length;
  pdf += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id += 1) {
    pdf += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer<</Root 1 0 R/Size ${size}>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

// Page text per demo study. Sentences here are the anchors the seeded extraction quotes
// point at, so "View in PDF" locates and highlights them.
const DEMO_PDF_PAGES: Record<string, string[][]> = {
  criner: [
    [
      "A Multicenter Randomized Controlled Trial of Zephyr Endobronchial Valves",
      "",
      "Abstract. Patients with severe heterogeneous emphysema and little collateral",
      "ventilation were randomized to bronchoscopic valve placement or standard care.",
    ],
    [
      "Methods and Results",
      "",
      "A total of 190 participants were randomized in a 2:1 ratio; 128 received valves",
      "and 62 continued standard medical care. Allocation used a computer-generated",
      "sequence with concealed assignment held by an independent center.",
      "The mean age was 64 years and 47% of participants were female.",
      "At 12 months, 60 of 128 patients in the valve arm and 10 of 62 in the control",
      "arm achieved an FEV1 improvement of at least 15%.",
    ],
  ],
  slebos: [
    [
      "Durability of Zephyr Valve Treatment: The LIBERATE Extension",
      "",
      "Abstract. This extension study followed treated participants to assess whether",
      "lung function gains persisted through 12 months of follow-up.",
    ],
    [
      "Methods and Results",
      "",
      "Ninety-seven participants were enrolled, of whom 47 received valve treatment",
      "and 50 served as controls. The mean age was 63 years and 52% were female.",
      "Outcome assessors were blinded to treatment allocation throughout follow-up.",
      "FEV1 response at 12 months was observed in 18 of 47 treated participants",
      "compared with 6 of 50 controls.",
    ],
  ],
  davey_believer: [
    [
      "The BeLieVeR-HIFi Study: Valves in Emphysema with Collateral Ventilation",
      "",
      "Abstract. A randomized sham-controlled trial in patients not preselected for",
      "the absence of interlobar collateral ventilation.",
    ],
  ],
};

// Extraction quotes + PDF pages for the seeded values, keyed by study then field. These
// populate ExtractionValue.sourceQuote/pageNumber so the evidence viewer has real anchors.
const DEMO_QUOTES: Record<string, Record<string, { quote: string; page: number }>> = {
  criner: {
    sample_size: { quote: "A total of 190 participants were randomized in a 2:1 ratio", page: 2 },
    mean_age: { quote: "The mean age was 64 years", page: 2 },
    female_pct: { quote: "47% of participants were female", page: 2 },
    resp_valve_events: {
      quote: "60 of 128 patients in the valve arm",
      page: 2,
    },
    resp_control_events: { quote: "10 of 62 in the control arm", page: 2 },
  },
  slebos: {
    sample_size: { quote: "Ninety-seven participants were enrolled", page: 2 },
    mean_age: { quote: "The mean age was 63 years", page: 2 },
    female_pct: { quote: "52% were female", page: 2 },
    resp_valve_events: {
      quote: "FEV1 response at 12 months was observed in 18 of 47 treated participants",
      page: 2,
    },
    resp_control_events: { quote: "compared with 6 of 50 controls", page: 2 },
  },
};

// --- Citation fixtures --------------------------------------------------------------------

interface CiteSpec {
  key: string;
  pmid?: string;
  doi?: string;
  title: string;
  authors: string[];
  year: number;
  journal: string;
  abstract: string;
  volume?: string;
  pages?: string;
  // Cohort-overlap demo: a trial-registry id (rendered into the abstract, where the
  // parser scans for it) and record-level affiliations (rendered as AD tags).
  nct?: string;
  affiliations?: string[];
}

// PubMed-sourced records (exported as RIS; PMID rides in the AN tag).
const PUBMED: CiteSpec[] = [
  {
    key: "criner",
    pmid: "32000001",
    doi: "10.1056/nejmoa1900101",
    nct: "NCT01796392",
    affiliations: [
      "Department of Thoracic Medicine and Surgery, Temple University, Philadelphia, PA, USA",
      "St. Joseph's Hospital and Medical Center, Phoenix, AZ, USA",
    ],
    title:
      "Endobronchial valves for severe emphysema with little or no collateral ventilation: a randomized controlled trial",
    authors: ["Criner, Gerard J.", "Sue, Richard", "Wright, Shannon"],
    year: 2018,
    journal: "American Journal of Respiratory and Critical Care Medicine",
    volume: "198",
    pages: "1151-1164",
    abstract:
      "Background: Bronchoscopic lung volume reduction with one-way endobronchial valves may benefit patients with severe heterogeneous emphysema. Methods: We randomized 190 patients with severe emphysema and absent collateral ventilation to Zephyr valve placement or standard of care. Results: At 12 months, FEV1 improved by 0.106 L versus controls (p<0.001); pneumothorax occurred in 26.6% of the treatment group. Conclusions: Valve therapy produced clinically meaningful improvements in lung function, dyspnea, and quality of life.",
  },
  {
    // Companion report of the Criner (LIBERATE) cohort: a 24-month follow-up sharing the
    // trial-registry id and lead authors, so cohort detection tier-1 matches it to `criner`.
    // FT-included but deliberately NOT study-linked below → linking it is Case 1 (add the
    // report into the existing Criner study). No DOI, so dedup does not merge it.
    key: "criner_followup",
    pmid: "32000012",
    nct: "NCT01796392",
    affiliations: [
      "Department of Thoracic Medicine and Surgery, Temple University, Philadelphia, PA, USA",
    ],
    title:
      "Zephyr endobronchial valve treatment in heterogeneous emphysema: 24-month durability follow-up of the LIBERATE cohort",
    authors: ["Criner, Gerard J.", "Sue, Richard", "Dransfield, Mark T."],
    year: 2019,
    journal: "American Journal of Respiratory and Critical Care Medicine",
    volume: "200",
    pages: "1354-1362",
    abstract:
      "Rationale: Whether endobronchial valve benefits persist long term is uncertain. Methods: We followed the LIBERATE cohort of patients with severe emphysema and absent collateral ventilation for 24 months after Zephyr valve placement or standard of care. Results: FEV1 and quality-of-life gains were durable at 24 months with no new safety signals. Conclusions: Valve therapy benefits persist through two years in this cohort.",
  },
  {
    key: "slebos",
    pmid: "32000002",
    doi: "10.1164/rccm.201902-0383oc",
    title:
      "Zephyr endobronchial valve treatment in heterogeneous emphysema: 12-month results of the LIBERATE trial extension",
    authors: ["Slebos, Dirk-Jan", "Shah, Pallav L.", "Herth, Felix J. F."],
    year: 2019,
    journal: "Respiration",
    volume: "98",
    pages: "232-241",
    abstract:
      "Rationale: Long-term durability of endobronchial valve therapy remains under study. Objectives: To evaluate 12-month outcomes after Zephyr valve placement in 97 patients with heterogeneous emphysema. Measurements: FEV1, residual volume, 6-minute walk distance, and SGRQ. Main results: Improvements were sustained at 12 months with an acceptable safety profile. Conclusions: Valve therapy benefits persist beyond the initial evaluation window.",
  },
  {
    key: "shah_ease",
    pmid: "32000003",
    title:
      "Airway bypass stents for homogeneous emphysema: long-term follow-up of the EASE cohort",
    authors: ["Shah, Pallav L.", "Cardoso, Paulo F. G."],
    year: 2016,
    journal: "The Lancet Respiratory Medicine",
    abstract:
      "Airway bypass with paclitaxel-eluting stents did not produce durable improvements in homogeneous emphysema. We report extended follow-up of the EASE cohort demonstrating early stent occlusion and loss of any initial physiological benefit by 12 months.",
  },
  {
    key: "deslee",
    pmid: "32000004",
    doi: "10.1016/s2213-2600(19)30253-6",
    title:
      "Endobronchial coils for severe emphysema versus standard care: the ELEVATE randomized trial",
    authors: ["Deslee, Gaetan", "Klooster, Karin", "Valipour, Arschang"],
    year: 2019,
    journal: "The Lancet Respiratory Medicine",
    volume: "7",
    pages: "313-324",
    abstract:
      "Background: Nitinol coils compress emphysematous tissue independent of collateral ventilation. Methods: Multicentre randomized trial of coil treatment versus standard care in 210 patients with severe emphysema. Results: Coil treatment improved residual volume by -0.31 L and SGRQ by -8.1 points at 12 months. Conclusions: Coils offer a valve-independent bronchoscopic option with a distinct adverse-event profile.",
  },
  {
    key: "herth_vapour",
    pmid: "32000005",
    title:
      "Bronchoscopic thermal vapour ablation in upper-lobe predominant emphysema: STEP-UP 6-month interim analysis (conference abstract)",
    authors: ["Herth, Felix J. F.", "Valipour, Arschang"],
    year: 2015,
    journal: "European Respiratory Journal (Congress Abstracts)",
    abstract:
      "Interim conference report: segmental thermal vapour ablation improved FEV1 by 14.7% versus controls at 6 months in upper-lobe predominant emphysema. Full peer-reviewed outcomes to follow.",
  },
  {
    key: "klooster_rehab",
    pmid: "32000006",
    title:
      "Pulmonary rehabilitation added to endobronchial valve therapy on exercise capacity in severe emphysema: a pilot cohort",
    authors: ["Klooster, Karin", "Hartman, Jorine E.", "Slebos, Dirk-Jan"],
    year: 2020,
    journal: "Respiratory Medicine",
    abstract:
      "Pilot prospective cohort (n=32) of pulmonary rehabilitation initiated eight weeks after valve placement. Rehabilitation was associated with additional gains in 6-minute walk distance (+41 m) beyond valve therapy alone. Uncontrolled design; larger trials warranted.",
  },
  {
    key: "nett",
    pmid: "32000007",
    title:
      "Lung volume reduction surgery versus medical therapy for severe emphysema: NETT long-term outcomes",
    authors: ["Fishman, Alfred", "Martinez, Fernando", "Naunheim, Keith"],
    year: 2003,
    journal: "New England Journal of Medicine",
    abstract:
      "The National Emphysema Treatment Trial randomized 1218 patients to lung volume reduction surgery or continued medical therapy. Surgery improved survival in upper-lobe predominant disease with low exercise capacity. This is a surgical, not bronchoscopic, intervention.",
  },
  {
    key: "travaline",
    pmid: "32000008",
    title:
      "One-way valve placement for persistent air leak after secondary spontaneous pneumothorax: a case series",
    authors: ["Travaline, John M.", "Gordon, Robert"],
    year: 2009,
    journal: "Chest",
    abstract:
      "We describe seven patients with persistent air leak managed with one-way endobronchial valves as a compassionate-use intervention. Air leak resolved in five patients within 12 days. Not an emphysema lung-volume-reduction indication.",
  },
  {
    key: "koster_ct",
    pmid: "32000009",
    title:
      "Quantitative CT fissure integrity analysis to predict collateral ventilation: a radiology validation study",
    authors: ["Koster, T. David", "van Rikxoort, Eva M."],
    year: 2016,
    journal: "European Radiology",
    abstract:
      "Fissure completeness on quantitative CT predicted Chartis-measured collateral ventilation with AUC 0.88 in 146 patients screened for valve therapy. A diagnostic accuracy study without treatment outcomes.",
  },
  {
    key: "ingenito",
    pmid: "32000010",
    title: "Sealant-based lung volume reduction in murine elastase-induced emphysema models",
    authors: ["Ingenito, Edward P.", "Tsai, Larry W."],
    year: 2012,
    journal: "American Journal of Physiology - Lung Cellular and Molecular Physiology",
    abstract:
      "Polymeric sealant instillation reduced lung volumes and improved compliance in an elastase mouse model of emphysema. Animal-model study of biologic lung volume reduction feasibility.",
  },
  {
    key: "pietzsch_cost",
    pmid: "32000011",
    title:
      "Cost-effectiveness of endobronchial valve therapy compared with standard care in severe emphysema: a Markov model",
    authors: ["Pietzsch, Jan B.", "Garner, Abigail"],
    year: 2021,
    journal: "International Journal of Chronic Obstructive Pulmonary Disease",
    abstract:
      "A Markov cohort model estimated an incremental cost-effectiveness ratio of $39,000 per QALY for valve therapy versus standard care over 10 years. Economic evaluation without new clinical outcome data.",
  },
];

// Embase-sourced records (exported as CSV). D1/D2/D3 are the duplicate partners of the PubMed
// records above; E-series are unique to Embase.
const EMBASE: CiteSpec[] = [
  {
    // DOI-exact duplicate of `criner` (same DOI, Embase formatting, no PMID column).
    key: "criner_dup",
    doi: "10.1056/NEJMoa1900101",
    title:
      "Endobronchial valves for severe emphysema with little or no collateral ventilation (LIBERATE): a randomised controlled trial",
    authors: ["Criner, G.J.", "Sue, R.", "Wright, S."],
    year: 2018,
    journal: "Am J Respir Crit Care Med",
    volume: "198",
    pages: "1151-1164",
    abstract:
      "Randomised controlled trial of Zephyr endobronchial valves versus standard of care in severe emphysema without collateral ventilation. FEV1 improved significantly at 12 months.",
  },
  {
    // PMID-exact duplicate of `slebos` (same PMID, no DOI column).
    key: "slebos_dup",
    pmid: "32000002",
    title:
      "Zephyr endobronchial valve treatment in heterogeneous emphysema: twelve-month LIBERATE extension results",
    authors: ["Slebos, D.J.", "Shah, P.L.", "Herth, F.J.F."],
    year: 2019,
    journal: "Respiration",
    volume: "98",
    pages: "232-241",
    abstract:
      "Twelve-month outcomes after Zephyr valve placement in heterogeneous emphysema. Improvements in FEV1 and quality of life were sustained.",
  },
  {
    // Fuzzy-title duplicate of `shah_ease` (near-identical title, no shared DOI/PMID).
    key: "shah_dup",
    title:
      "Airway bypass stents for homogeneous emphysema: long term follow up of the EASE trial cohort",
    authors: ["Shah, P.L.", "Cardoso, P.F.G."],
    year: 2016,
    journal: "Lancet Respir Med",
    abstract:
      "Extended follow up of the EASE cohort of airway bypass stenting for homogeneous emphysema, showing early stent occlusion and loss of physiological benefit by twelve months.",
  },
  {
    key: "davey_believer",
    title:
      "Bronchoscopic lung volume reduction with endobronchial valves for patients with heterogeneous emphysema and intact interlobar fissures (BeLieVeR-HIFi): a randomised controlled trial",
    authors: ["Davey, C.", "Zoumot, Z.", "Jordan, S."],
    year: 2015,
    journal: "The Lancet",
    volume: "386",
    pages: "1066-1073",
    abstract:
      "Randomised sham-controlled trial of endobronchial valves in 50 patients with heterogeneous emphysema and intact fissures. Lobar atelectasis was associated with improved FEV1 and exercise capacity at three months.",
  },
  {
    key: "sciurba_vent",
    title:
      "A randomized study of endobronchial valves for advanced emphysema (VENT): efficacy and safety outcomes",
    authors: ["Sciurba, F.C.", "Ernst, A.", "Herth, F.J.F."],
    year: 2010,
    journal: "New England Journal of Medicine",
    volume: "363",
    pages: "1233-1244",
    abstract:
      "The Endobronchial Valve for Emphysema Palliation Trial (VENT) randomized 321 patients with advanced heterogeneous emphysema to valve therapy or medical management, showing modest improvements in FEV1 and 6-minute walk distance with a higher rate of adverse events.",
  },
  {
    key: "valipour_impact",
    doi: "10.1164/rccm.201507-1349oc",
    title:
      "Endobronchial valve therapy in patients with homogeneous emphysema: the IMPACT randomized trial",
    authors: ["Valipour, A.", "Slebos, D.J.", "Herth, F.J.F."],
    year: 2016,
    journal: "American Journal of Respiratory and Critical Care Medicine",
    volume: "194",
    pages: "1073-1082",
    abstract:
      "IMPACT randomized 93 patients with homogeneous emphysema and absent collateral ventilation to Zephyr valves or standard care. Valve therapy significantly improved FEV1, quality of life, and exercise capacity at three months.",
  },
  {
    key: "marchetti_qual",
    title:
      "Patient experiences and treatment burden after bronchoscopic lung volume reduction: a qualitative interview study",
    authors: ["Marchetti, N.", "Duffy, S."],
    year: 2022,
    journal: "Chronic Respiratory Disease",
    abstract:
      "Semi-structured interviews with 18 valve recipients explored expectations, recovery, and pneumothorax anxiety. A qualitative study without quantitative effectiveness outcomes.",
  },
  {
    key: "hopkinson_exercise",
    title:
      "Exercise training and physical activity after endobronchial valve placement: a feasibility study",
    authors: ["Hopkinson, N.S.", "Polkey, M.I."],
    year: 2017,
    journal: "COPD: Journal of Chronic Obstructive Pulmonary Disease",
    abstract:
      "Single-arm feasibility study of a structured exercise programme following valve placement in 21 participants. No comparison group; effectiveness cannot be inferred.",
  },
  {
    key: "come_predictors",
    title:
      "Predictors of clinical response to endobronchial valve therapy: a retrospective registry analysis",
    authors: ["Come, C.E.", "Kramer, M.R."],
    year: 2018,
    journal: "Respirology",
    abstract:
      "Retrospective registry analysis of 214 valve recipients identifying fissure completeness and lobar volume reduction as predictors of clinical response. Registry design without a control arm.",
  },
];

// --- Serializers --------------------------------------------------------------------------

function toRis(specs: CiteSpec[]): string {
  return specs
    .map((r) => {
      // The trial-registry id rides in the abstract (where the parser scans for it),
      // affiliations become AD tags — both feed cohort-overlap detection.
      const abstract = r.nct
        ? `${r.abstract} Registered at ClinicalTrials.gov, ${r.nct}.`
        : r.abstract;
      return [
        "TY  - JOUR",
        `TI  - ${r.title}`,
        ...r.authors.map((a) => `AU  - ${a}`),
        `PY  - ${r.year}`,
        `JO  - ${r.journal}`,
        ...(r.volume ? [`VL  - ${r.volume}`] : []),
        ...(r.pages ? [`SP  - ${r.pages}`] : []),
        `AB  - ${abstract}`,
        ...(r.affiliations ?? []).map((a) => `AD  - ${a}`),
        ...(r.doi ? [`DO  - ${r.doi}`] : []),
        ...(r.pmid ? [`AN  - ${r.pmid}`] : []),
        "ER  - ",
      ].join("\n");
    })
    .join("\n");
}

function csvCell(value: string | number | undefined): string {
  const s = value === undefined ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv(specs: CiteSpec[]): string {
  const headers = ["Title", "Authors", "Year", "Source", "Volume", "Pages", "DOI", "PMID", "Abstract"];
  const rows = specs.map((r) =>
    [
      csvCell(r.title),
      csvCell(r.authors.join("; ")),
      csvCell(r.year),
      csvCell(r.journal),
      csvCell(r.volume),
      csvCell(r.pages),
      csvCell(r.doi),
      csvCell(r.pmid),
      csvCell(r.abstract),
    ].join(","),
  );
  return [headers.map(csvCell).join(","), ...rows].join("\n");
}

// --- Reset --------------------------------------------------------------------------------

async function resetDatabase() {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'`;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

// --- Main ---------------------------------------------------------------------------------

async function main() {
  console.log("Resetting database…");
  await resetDatabase();

  // 1. Users -------------------------------------------------------------------------------
  console.log("Creating users…");
  const owner = await createUser({ email: "owner@demo.test", name: "Olivia Owner", password: PASSWORD });
  const reviewer1 = await createUser({ email: "reviewer1@demo.test", name: "Ravi Reviewer", password: PASSWORD });
  const reviewer2 = await createUser({ email: "reviewer2@demo.test", name: "Rosa Reviewer", password: PASSWORD });
  const adjudicator = await createUser({ email: "adjudicator@demo.test", name: "Ada Adjudicator", password: PASSWORD });

  const ownerCtx: Ctx = { userId: owner.id };
  const r1Ctx: Ctx = { userId: reviewer1.id };
  const r2Ctx: Ctx = { userId: reviewer2.id };
  const adjCtx: Ctx = { userId: adjudicator.id };

  // 2. Org + members ----------------------------------------------------------------------
  console.log("Creating organization + members…");
  const org = await orgs.createOrg(ownerCtx, { name: "Interventional Pulmonology Evidence Group" });
  await orgs.addOrgMember(ownerCtx, org.id, { email: reviewer1.email, role: "MEMBER" });
  await orgs.addOrgMember(ownerCtx, org.id, { email: reviewer2.email, role: "MEMBER" });
  await orgs.addOrgMember(ownerCtx, org.id, { email: adjudicator.email, role: "MEMBER" });

  // 3. Project (dual, blinded) — auto-creates T/A + FULL_TEXT stages and a draft protocol ----
  console.log("Creating project…");
  const project = await projects.createProject(ownerCtx, org.id, {
    title: "Endobronchial valves for severe emphysema: a systematic review and meta-analysis",
    reviewType: "SYSTEMATIC_REVIEW_META_ANALYSIS",
    researchQuestion:
      "In adults with severe emphysema, does bronchoscopic lung volume reduction with one-way endobronchial valves improve lung function and quality of life versus standard care?",
    description:
      "Demo project seeded end-to-end through the service layer: import → dedup → blinded dual screening → full text → extraction → risk of bias → PRISMA.",
    status: "SCREENING",
    registrationPlatform: "PROSPERO",
    registrationId: "CRD42026000123",
    dualScreening: true,
    reviewersPerCitation: 2,
    blindedScreening: true,
  });
  const projectId = project.id;

  // Reviewers double as extractors/assessors; the adjudicator resolves every conflict domain.
  await projects.addProjectMember(ownerCtx, projectId, {
    email: reviewer1.email,
    roles: ["REVIEWER", "EXTRACTOR"],
  });
  await projects.addProjectMember(ownerCtx, projectId, {
    email: reviewer2.email,
    roles: ["REVIEWER", "EXTRACTOR"],
  });
  await projects.addProjectMember(ownerCtx, projectId, {
    email: adjudicator.email,
    roles: ["ADJUDICATOR"],
  });

  // 4. Protocol ----------------------------------------------------------------------------
  console.log("Building protocol…");
  await protocols.updateProtocol(ownerCtx, projectId, {
    background:
      "Severe emphysema causes hyperinflation, dyspnea, and poor quality of life. Bronchoscopic lung volume reduction with one-way endobronchial valves aims to induce lobar collapse in patients without collateral ventilation.",
    reviewQuestion:
      "Does endobronchial valve therapy improve lung function and quality of life versus standard care in severe emphysema?",
    population: "Adults with severe emphysema (GOLD III-IV) and hyperinflation.",
    intervention: "One-way endobronchial valves (bronchoscopic lung volume reduction).",
    comparator: "Standard medical care, sham bronchoscopy, or pulmonary rehabilitation.",
    outcomesNarrative:
      "Primary: change in FEV1 at 12 months. Secondary: SGRQ quality of life, 6-minute walk distance, pneumothorax.",
    studyDesigns: ["Randomized controlled trial"],
    databases: ["MEDLINE (PubMed)", "Embase", "CENTRAL"],
    languageRestrictions: ["English"],
    metaAnalysisPlan:
      "Random-effects meta-analysis of mean differences for FEV1 and SGRQ; I^2 for heterogeneity; sensitivity analysis excluding high risk-of-bias studies.",
  });

  await protocols.createCriterion(ownerCtx, projectId, {
    type: "INCLUSION",
    category: "Population",
    text: "Adults (≥18y) with severe emphysema (GOLD III-IV).",
    order: 0,
  });
  await protocols.createCriterion(ownerCtx, projectId, {
    type: "INCLUSION",
    category: "Intervention",
    text: "One-way endobronchial valve therapy.",
    order: 1,
  });
  await protocols.createCriterion(ownerCtx, projectId, {
    type: "INCLUSION",
    category: "Design",
    text: "Randomized controlled trial with a concurrent comparator.",
    order: 2,
  });
  await protocols.createCriterion(ownerCtx, projectId, {
    type: "EXCLUSION",
    category: "Design",
    text: "Non-randomized, single-arm, animal, or modelling studies; conference abstracts without full outcomes.",
    order: 3,
  });
  await protocols.createCriterion(ownerCtx, projectId, {
    type: "EXCLUSION",
    category: "Intervention",
    text: "Non-valve interventions (coils, vapour, sealant, airway bypass, surgery) as the sole intervention.",
    order: 4,
  });

  await protocols.createOutcome(ownerCtx, projectId, {
    name: "Change in FEV1 at 12 months",
    type: "PRIMARY",
    measure: "Litres (mean difference)",
    timepoint: "12 months",
    order: 0,
  });
  await protocols.createOutcome(ownerCtx, projectId, {
    name: "St. George's Respiratory Questionnaire (SGRQ)",
    type: "SECONDARY",
    measure: "Points (mean difference)",
    timepoint: "12 months",
    order: 1,
  });
  await protocols.createOutcome(ownerCtx, projectId, {
    name: "Pneumothorax",
    type: "SECONDARY",
    measure: "Risk ratio",
    timepoint: "Periprocedural",
    order: 2,
  });

  await protocols.createPico(ownerCtx, projectId, {
    question:
      "In adults with severe emphysema, do endobronchial valves improve FEV1 and quality of life versus standard care?",
    population: "Adults with severe emphysema (GOLD III-IV)",
    intervention: "One-way endobronchial valves",
    comparator: "Standard care / sham",
    outcome: "FEV1, SGRQ, 6MWD, pneumothorax",
    order: 0,
  });

  // Full-text exclusion reasons (used at FT screening + PRISMA). Not under the amendment rule.
  const reasonSpecs = [
    "Wrong population",
    "Wrong intervention",
    "Wrong comparator",
    "Wrong study design",
    "Duplicate or superseded report",
    "Full text not retrievable",
  ];
  const reasons: Record<string, string> = {};
  for (const [i, label] of reasonSpecs.entries()) {
    const reason = await protocols.createExclusionReason(ownerCtx, projectId, {
      label,
      stage: "FULL_TEXT",
      order: i,
    });
    reasons[label] = reason.id;
  }

  console.log("Publishing protocol v1…");
  await protocols.publishProtocol(ownerCtx, projectId);

  // 5. Import (2 sources) ------------------------------------------------------------------
  console.log("Importing citations…");
  const pubmedSource = await imports.createImportSource(ownerCtx, projectId, {
    name: "PubMed (MEDLINE)",
    description: "MEDLINE search exported as RIS.",
  });
  const embaseSource = await imports.createImportSource(ownerCtx, projectId, {
    name: "Embase",
    description: "Embase search exported as CSV.",
  });

  const pubmedBatch = await imports.createBatch(ownerCtx, projectId, {
    filename: "pubmed-medline.ris",
    sourceId: pubmedSource.id,
    format: "RIS",
    content: toRis(PUBMED),
  });
  await imports.commitBatch(ownerCtx, projectId, pubmedBatch.id);

  const embaseBatch = await imports.createBatch(ownerCtx, projectId, {
    filename: "embase.csv",
    sourceId: embaseSource.id,
    format: "CSV",
    content: toCsv(EMBASE),
  });
  await imports.commitBatch(ownerCtx, projectId, embaseBatch.id);

  // Orchestration lookup: map each fixture key → created citation id by exact title. Every
  // fixture title is distinct (the duplicate partners deliberately differ in wording), so this
  // is unambiguous — unlike matching on the shared DOI/PMID of a duplicate pair.
  const allCitations = await prisma.citation.findMany({
    where: { projectId },
    select: { id: true, title: true },
  });
  const citationIdByKey: Record<string, string> = {};
  for (const spec of [...PUBMED, ...EMBASE]) {
    const matches = allCitations.filter((c) => c.title === spec.title);
    if (matches.length !== 1) {
      throw new Error(
        `Seed: expected exactly one imported citation titled "${spec.title}" (found ${matches.length})`,
      );
    }
    citationIdByKey[spec.key] = matches[0]!.id;
  }
  const cid = (key: string) => {
    const id = citationIdByKey[key];
    if (!id) throw new Error(`Seed: no citation id for "${key}"`);
    return id;
  };

  // 6. Deduplication -----------------------------------------------------------------------
  console.log("Running deduplication…");
  await dedup.runDetection(ownerCtx, projectId);
  const groups = await dedup.listGroups(ownerCtx, projectId, { status: "OPEN" });

  // Merge the 3 intended pairs, keeping the PubMed record canonical. Locate each pair's group
  // by the canonical citation's membership among its candidates.
  const mergePairs: { canonical: string; duplicate: string }[] = [
    { canonical: "criner", duplicate: "criner_dup" },
    { canonical: "slebos", duplicate: "slebos_dup" },
    { canonical: "shah_ease", duplicate: "shah_dup" },
  ];
  for (const pair of mergePairs) {
    const canonicalId = cid(pair.canonical);
    const duplicateId = cid(pair.duplicate);
    const group = groups.find((g) =>
      g.candidates.some(
        (c) =>
          (c.citationAId === canonicalId && c.citationBId === duplicateId) ||
          (c.citationAId === duplicateId && c.citationBId === canonicalId),
      ),
    );
    if (!group) {
      console.warn(`  ⚠ no dedup group found for ${pair.canonical} ↔ ${pair.duplicate}; skipping`);
      continue;
    }
    await dedup.mergeGroup(ownerCtx, projectId, group.id, { canonicalCitationId: canonicalId });
  }

  // 7. Title/abstract screening ------------------------------------------------------------
  console.log("Assigning + screening title/abstract…");
  const stages = await screening.listStages(ownerCtx, projectId);
  const taStage = stages.find((s) => s.type === "TITLE_ABSTRACT");
  const ftStage = stages.find((s) => s.type === "FULL_TEXT");
  if (!taStage || !ftStage) throw new Error("Seed: screening stages missing");

  // Dual assignment: both reviewers screen every active citation.
  await screening.createAssignments(ownerCtx, projectId, taStage.id, {
    reviewerIds: [reviewer1.id, reviewer2.id],
    strategy: "all",
  });

  type Dec = "INCLUDE" | "EXCLUDE" | "MAYBE";
  // Per active citation: [reviewer1 decision, reviewer2 decision].
  const taPlan: { key: string; r1: Dec; r2: Dec }[] = [
    { key: "criner", r1: "INCLUDE", r2: "INCLUDE" }, // consensus INCLUDE → FT
    { key: "criner_followup", r1: "INCLUDE", r2: "INCLUDE" }, // consensus INCLUDE → FT (companion report)
    { key: "slebos", r1: "INCLUDE", r2: "INCLUDE" }, // consensus INCLUDE → FT
    { key: "deslee", r1: "INCLUDE", r2: "INCLUDE" }, // consensus INCLUDE → FT (excluded later at FT)
    { key: "davey_believer", r1: "INCLUDE", r2: "EXCLUDE" }, // CONFLICT → adjudicate INCLUDE → FT
    { key: "sciurba_vent", r1: "MAYBE", r2: "INCLUDE" }, // CONFLICT → adjudicate INCLUDE → FT
    { key: "shah_ease", r1: "EXCLUDE", r2: "MAYBE" }, // CONFLICT → left OPEN
    { key: "herth_vapour", r1: "EXCLUDE", r2: "EXCLUDE" },
    { key: "klooster_rehab", r1: "EXCLUDE", r2: "EXCLUDE" },
    { key: "nett", r1: "EXCLUDE", r2: "EXCLUDE" },
    { key: "travaline", r1: "EXCLUDE", r2: "EXCLUDE" },
    { key: "koster_ct", r1: "EXCLUDE", r2: "EXCLUDE" },
    { key: "ingenito", r1: "EXCLUDE", r2: "EXCLUDE" },
    { key: "pietzsch_cost", r1: "EXCLUDE", r2: "EXCLUDE" },
    { key: "valipour_impact", r1: "EXCLUDE", r2: "EXCLUDE" },
    { key: "marchetti_qual", r1: "EXCLUDE", r2: "EXCLUDE" },
    { key: "hopkinson_exercise", r1: "EXCLUDE", r2: "EXCLUDE" },
    { key: "come_predictors", r1: "EXCLUDE", r2: "EXCLUDE" },
  ];

  for (const p of taPlan) {
    await screening.createDecision(r1Ctx, projectId, taStage.id, {
      citationId: cid(p.key),
      decision: p.r1,
      notes: p.r1 === "MAYBE" ? "Unclear from abstract — needs full text." : undefined,
    });
    await screening.createDecision(r2Ctx, projectId, taStage.id, {
      citationId: cid(p.key),
      decision: p.r2,
    });
  }

  // Adjudicate the two RCT conflicts to INCLUDE; leave shah_ease and valipour_impact OPEN.
  console.log("Adjudicating title/abstract conflicts…");
  const { conflicts: taConflicts } = await screening.listConflicts(adjCtx, projectId, {
    stage: "TITLE_ABSTRACT",
    status: "OPEN",
  });
  const conflictByCitation = new Map(taConflicts.map((c) => [c.citation.id, c.id]));
  for (const key of ["davey_believer", "sciurba_vent"]) {
    const conflictId = conflictByCitation.get(cid(key));
    if (!conflictId) throw new Error(`Seed: expected an open T/A conflict for "${key}"`);
    await screening.adjudicateConflict(adjCtx, projectId, conflictId, {
      finalDecision: "INCLUDE",
      reason: "Randomized controlled trial of endobronchial valves — meets inclusion criteria on full review of the abstract.",
    });
  }

  // 8. Full-text stage ---------------------------------------------------------------------
  console.log("Assigning + screening full text…");
  const ftKeys = ["criner", "slebos", "deslee", "davey_believer", "sciurba_vent"];
  await screening.createAssignments(ownerCtx, projectId, ftStage.id, {
    reviewerIds: [reviewer1.id, reviewer2.id],
    strategy: "all",
    citationIds: ftKeys.map(cid),
  });

  // Retrieval + PDFs for the full-text set.
  for (const key of ftKeys) {
    await fulltext.recordRetrievalAttempt(ownerCtx, projectId, cid(key), {
      method: "Publisher website",
      outcome: "RETRIEVED",
      notes: "PDF obtained via institutional subscription.",
    });
  }
  for (const key of ["criner", "slebos", "deslee", "davey_believer"]) {
    await fulltext.uploadFullText(ownerCtx, projectId, {
      citationId: cid(key),
      filename: `${key}.pdf`,
      bytes: demoPdf(`full text for ${key}`, DEMO_PDF_PAGES[key] ?? [["Full text not available."]]),
      label: "Full text (PDF)",
    });
  }

  // FT decisions: 3 include (→ studies), 2 exclude with reasons.
  const ftPlan: { key: string; decision: Dec; reason?: string }[] = [
    { key: "criner", decision: "INCLUDE" },
    { key: "slebos", decision: "INCLUDE" },
    { key: "deslee", decision: "EXCLUDE", reason: "Wrong intervention" }, // coils, not valves
    { key: "davey_believer", decision: "INCLUDE" },
    { key: "sciurba_vent", decision: "EXCLUDE", reason: "Duplicate or superseded report" },
  ];
  for (const p of ftPlan) {
    for (const ctx of [r1Ctx, r2Ctx]) {
      await screening.createDecision(ctx, projectId, ftStage.id, {
        citationId: cid(p.key),
        decision: p.decision,
        exclusionReasonId: p.reason ? reasons[p.reason] : undefined,
      });
    }
  }

  // 9. Studies (auto-created on FT INCLUDE) ------------------------------------------------
  console.log("Configuring studies…");
  const includedKeys = ["criner", "slebos", "davey_believer"];
  const studyIdByKey: Record<string, string> = {};
  for (const key of includedKeys) {
    const link = await prisma.studyReportLink.findFirst({
      where: { citationId: cid(key), study: { projectId } },
      select: { studyId: true },
    });
    if (!link) throw new Error(`Seed: expected an auto-created study for FT-included "${key}"`);
    studyIdByKey[key] = link.studyId;
  }
  // Two studies enter the quantitative synthesis (R4).
  for (const key of ["criner", "slebos"]) {
    await studiesService.updateStudy(ownerCtx, projectId, studyIdByKey[key]!, {
      inQuantitativeSynthesis: true,
      notes: "Zephyr valve RCT with 12-month FEV1 outcome — eligible for meta-analysis.",
    });
  }

  // Companion report: mark it full-text INCLUDE directly, WITHOUT the screening-consensus
  // path that would auto-create a study for it (autoCreateForCitation). This leaves the
  // report full-text-included but not yet study-linked, so the cohort-detection demo can
  // link it into the existing Criner study (Case 1). Direct orchestration write, like the
  // other read/write helpers in this seed.
  await prisma.citationStageResult.create({
    data: {
      stageId: ftStage.id,
      citationId: cid("criner_followup"),
      outcome: "INCLUDE",
      resolvedVia: "SINGLE_REVIEWER",
    },
  });

  // 10. Extraction -------------------------------------------------------------------------
  console.log("Building extraction template + extracting…");
  const template = await extraction.createTemplate(ownerCtx, projectId, {
    name: "Study characteristics & primary outcomes",
    description: "Core data extraction form for the valve meta-analysis.",
  });

  const fieldDefs = [
    {
      key: "study_design",
      label: "Study design",
      type: "SINGLE_SELECT" as const,
      required: true,
      options: [
        { value: "rct", label: "Randomized controlled trial" },
        { value: "nrsi", label: "Non-randomized study" },
        { value: "obs", label: "Observational cohort" },
      ],
    },
    { key: "sample_size", label: "Total sample size", type: "NUMBER" as const, required: true },
    { key: "mean_age", label: "Mean age (years)", type: "NUMBER" as const },
    { key: "female_pct", label: "Female (%)", type: "NUMBER" as const },
    { key: "intervention_arm", label: "Intervention arm", type: "TEXT" as const },
    {
      key: "comorbidities",
      label: "Reported comorbidities",
      type: "MULTI_SELECT" as const,
      options: [
        { value: "gold3", label: "COPD GOLD III" },
        { value: "gold4", label: "COPD GOLD IV" },
        { value: "cvd", label: "Cardiovascular disease" },
        { value: "dm", label: "Diabetes mellitus" },
      ],
    },
    { key: "blinded_outcome", label: "Blinded outcome assessment", type: "BOOLEAN" as const },
    // Binary-outcome counts feeding the seeded meta-analysis (section 12).
    { key: "resp_valve_events", label: "FEV1 responders — valve arm (n)", type: "NUMBER" as const },
    { key: "resp_valve_total", label: "Valve arm total (N)", type: "NUMBER" as const },
    { key: "resp_control_events", label: "FEV1 responders — control arm (n)", type: "NUMBER" as const },
    { key: "resp_control_total", label: "Control arm total (N)", type: "NUMBER" as const },
    {
      key: "primary_outcome_notes",
      label: "Primary outcome notes",
      type: "TEXTAREA" as const,
      required: true,
    },
  ];
  const fieldIdByKey: Record<string, string> = {};
  for (const [i, def] of fieldDefs.entries()) {
    const field = await extraction.createField(ownerCtx, projectId, template.id, {
      key: def.key,
      label: def.label,
      type: def.type,
      required: def.required ?? false,
      options: def.options,
      order: i,
    });
    fieldIdByKey[def.key] = field.id;
  }
  await extraction.publishTemplate(ownerCtx, projectId, template.id);

  const extractStudyKeys = ["criner", "slebos"];
  await extraction.createAssignments(ownerCtx, projectId, {
    templateId: template.id,
    studyIds: extractStudyKeys.map((k) => studyIdByKey[k]!),
    extractorIds: [reviewer1.id, reviewer2.id],
  });

  // Base values per study; reviewer2 disagrees on sample_size for the Criner study (1 conflict).
  const extractionValues: Record<string, Record<string, unknown>> = {
    criner: {
      study_design: "rct",
      sample_size: 190,
      mean_age: 64,
      female_pct: 47,
      intervention_arm: "Zephyr endobronchial valves",
      comorbidities: ["gold3", "gold4"],
      blinded_outcome: false,
      resp_valve_events: 60,
      resp_valve_total: 128,
      resp_control_events: 10,
      resp_control_total: 62,
      primary_outcome_notes: "FEV1 responder analysis (≥15% improvement) at 12 months.",
    },
    slebos: {
      study_design: "rct",
      sample_size: 97,
      mean_age: 63,
      female_pct: 52,
      intervention_arm: "Zephyr valve (LIBERATE extension)",
      comorbidities: ["gold3"],
      blinded_outcome: true,
      resp_valve_events: 18,
      resp_valve_total: 47,
      resp_control_events: 6,
      resp_control_total: 50,
      primary_outcome_notes: "Durability of FEV1 improvement at 12 months.",
    },
  };

  for (const key of extractStudyKeys) {
    const studyId = studyIdByKey[key]!;
    for (const ctx of [r1Ctx, r2Ctx]) {
      const { form } = await extraction.startForm(ctx, projectId, studyId, { templateId: template.id });
      for (const def of fieldDefs) {
        let value = extractionValues[key]![def.key];
        // Introduce one field-level disagreement: reviewer2's Criner sample size.
        if (key === "criner" && def.key === "sample_size" && ctx === r2Ctx) value = 180;
        // Quoted evidence (where the demo PDFs carry a matching sentence) so the
        // evidence viewer can locate and highlight it.
        const evidence = DEMO_QUOTES[key]?.[def.key];
        await extraction.upsertValue(ctx, projectId, form.id, fieldIdByKey[def.key]!, {
          value,
          ...(evidence ? { sourceQuote: evidence.quote, pageNumber: evidence.page } : {}),
        });
      }
      await extraction.completeForm(ctx, projectId, form.id);
    }
  }

  console.log("Adjudicating extraction conflict…");
  // Final value + rationale keyed to the conflicting field, so this stays correct (and typed)
  // if the disagreements above ever change — rather than writing one hardcoded number to
  // whatever conflict happens to come back.
  const extractionFinalValues: Record<string, { value: unknown; reason: string }> = {
    sample_size: {
      value: 190,
      reason:
        "The full text reports 190 randomized participants (CONSORT diagram); 180 was the per-protocol population.",
    },
  };
  const extractionConflicts = await extraction.listConflicts(adjCtx, projectId, { status: "OPEN" });
  for (const conflict of extractionConflicts) {
    const resolution = extractionFinalValues[conflict.field.key];
    if (!resolution) {
      throw new Error(`Seed: no adjudicated value defined for extraction field "${conflict.field.key}"`);
    }
    await extraction.adjudicateConflict(adjCtx, projectId, conflict.id, {
      finalValue: resolution.value,
      reason: resolution.reason,
    });
  }

  // 11. Risk of bias -----------------------------------------------------------------------
  console.log("Cloning RoB tool + assessing…");
  // Seed the shared built-in catalog: the generic tool (cloned below for the demo) plus the
  // standard instruments (RoB 2, ROBINS-I, QUADAS-2, NOS, JBI, AMSTAR 2) for the Tools tab.
  const builtin = await ensureBuiltinGenericTool();
  await ensureBuiltinStandardTools();
  const tool = await rob.cloneTool(ownerCtx, projectId, builtin.id);
  await rob.publishTool(ownerCtx, projectId, tool.id);

  // Load the cloned tool structure (domains + questions) to drive responses/judgments.
  const toolStructure = await prisma.riskOfBiasTool.findFirstOrThrow({
    where: { id: tool.id },
    include: { domains: { orderBy: { order: "asc" }, include: { questions: { orderBy: { order: "asc" } } } } },
  });

  const robStudyKeys = ["criner", "slebos"];
  await rob.createAssignments(ownerCtx, projectId, {
    toolId: tool.id,
    studyIds: robStudyKeys.map((k) => studyIdByKey[k]!),
    assessorIds: [reviewer1.id, reviewer2.id],
  });

  // reviewer1 rates every domain low; reviewer2 flags Selection bias as high on the Criner study
  // → a single domain-level conflict for the adjudicator.
  for (const key of robStudyKeys) {
    const studyId = studyIdByKey[key]!;
    for (const ctx of [r1Ctx, r2Ctx]) {
      const assessment = await rob.startAssessment(ctx, projectId, studyId, { toolId: tool.id });
      const flagsSelection = key === "criner" && ctx === r2Ctx;
      for (const domain of toolStructure.domains) {
        const isSelection = domain.name === "Selection bias";
        for (const question of domain.questions) {
          await rob.putResponse(ctx, projectId, assessment.id, question.id, {
            answer: flagsSelection && isSelection ? "PN" : "Y",
          });
        }
        await rob.putJudgment(ctx, projectId, assessment.id, domain.id, {
          judgment: flagsSelection && isSelection ? "high" : "low",
          support:
            flagsSelection && isSelection
              ? "Allocation concealment was not clearly described."
              : "Adequately addressed per the full text.",
        });
      }
      await rob.updateAssessment(ctx, projectId, assessment.id, { overallJudgment: "low" });
      await rob.completeAssessment(ctx, projectId, assessment.id);
    }
  }

  console.log("Adjudicating risk-of-bias conflict…");
  const robConflicts = await rob.listConflicts(adjCtx, projectId, { status: "OPEN" });
  for (const conflict of robConflicts) {
    await rob.adjudicateConflict(adjCtx, projectId, conflict.id, {
      finalJudgment: "some_concerns",
      reason: "Allocation concealment is partially described; downgrade to some concerns rather than high risk.",
    });
  }

  // 12. Analysis (meta-analysis outcome over the extracted responder counts) ---------------
  console.log("Creating analysis outcome + field mappings…");
  const analysisOutcome = await analysis.createOutcome(ownerCtx, projectId, {
    name: "FEV1 responder (≥15% improvement)",
    timepoint: "12 months",
    measure: "RR",
    direction: "HIGHER_IS_BETTER",
    groupLabels: { g1: "Valve", g2: "Control" },
  });
  await analysis.replaceMappings(ownerCtx, projectId, analysisOutcome.id, {
    mappings: [
      { role: "G1_EVENTS", templateId: template.id, fieldKey: "resp_valve_events" },
      { role: "G1_TOTAL", templateId: template.id, fieldKey: "resp_valve_total" },
      { role: "G2_EVENTS", templateId: template.id, fieldKey: "resp_control_events" },
      { role: "G2_TOTAL", templateId: template.id, fieldKey: "resp_control_total" },
    ],
  });

  // 12b. GRADE draft on the seeded outcome. Expected on this dataset: RoB NOT_SERIOUS (both
  // pooled studies at consensus "low", 100% of weight), inconsistency NOT_SERIOUS (I² = 0),
  // imprecision SERIOUS (287 participants < 400 OIS), publication bias + indirectness
  // review-marked → certainty 4 − 1 = 3 = MODERATE, status DRAFT. One human edit on
  // indirectness demonstrates the HUMAN origin + audit trail.
  console.log("Creating GRADE draft…");
  await grade.generateDraft(ownerCtx, projectId, analysisOutcome.id, {});
  await grade.updateDomainRating(ownerCtx, projectId, analysisOutcome.id, "INDIRECTNESS", {
    rationale:
      "Population, intervention and comparator match the protocol PICO; the outcome is measured at the protocol timepoint.",
  });

  // 13. PRISMA snapshot --------------------------------------------------------------------
  console.log("Creating PRISMA snapshot…");
  await prismaReport.createPrismaSnapshot(ownerCtx, projectId, {
    label: "Initial submission snapshot",
  });

  console.log("\n✅ Seed complete.");
  console.log(`   Org:     ${org.name}`);
  console.log(`   Project: ${projectId}`);
  console.log("   Sign in with any of:");
  console.log("     owner@demo.test / reviewer1@demo.test / reviewer2@demo.test / adjudicator@demo.test");
  console.log(`   Password: ${PASSWORD}`);
}

main()
  .catch((err) => {
    console.error("\n❌ Seed failed:");
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
