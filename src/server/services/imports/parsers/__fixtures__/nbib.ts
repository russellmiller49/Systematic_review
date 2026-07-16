// Golden NBIB / PubMed MEDLINE fixtures — 3 records + malformed variants.
// Continuation lines start with exactly 6 spaces, as in real PubMed exports.

export const NBIB_3 = `PMID- 29787288
OWN - NLM
STAT- MEDLINE
DP  - 2018 Nov 1
TI  - A Multicenter Randomized Controlled Trial of Zephyr Endobronchial Valve Treatment
      in Heterogeneous Emphysema (LIBERATE).
PG  - 1151-1164
LID - 10.1164/rccm.201803-0590OC [doi]
AB  - RATIONALE: This multicenter randomized controlled trial evaluated the
      effectiveness and safety of Zephyr Endobronchial Valve treatment in patients
      with heterogeneous emphysema.
FAU - Criner, Gerard J
AU  - Criner GJ
FAU - Sue, Richard
AU  - Sue R
LA  - eng
JT  - American journal of respiratory and critical care medicine
VI  - 198
IP  - 9
TA  - Am J Respir Crit Care Med

PMID- 25066329
DP  - 2014 Sep
TI  - Non-invasive positive pressure ventilation for the treatment of severe stable
      chronic obstructive pulmonary disease: a prospective, multicentre, randomised,
      controlled clinical trial.
PG  - 698-705
AID - 10.1016/S2213-2600(14)70153-5 [doi]
AID - S2213-2600(14)70153-5 [pii]
AB  - BACKGROUND: Long-term non-invasive positive pressure ventilation might improve
      outcomes in hypercapnic COPD.
FAU - Koehnlein, Thomas
AU  - Koehnlein T
FAU - Windisch, Wolfram
AU  - Windisch W
LA  - eng
JT  - The Lancet. Respiratory medicine
VI  - 2
IP  - 9

PMID- 34059074
DP  - 2021 May 31
TI  - Smoking cessation interventions in pulmonary clinics: a pragmatic cohort study.
PG  - 145
LID - 10.1186/s12931-021-01745-5 [doi]
AU  - Nguyen THL
LA  - eng
JT  - Respiratory research
VI  - 22
`;

// Record 1 is missing its title; record 2 is fine; record 3 is unrecognized garbage.
export const NBIB_MALFORMED = `PMID- 11111111
DP  - 2018 Jan
FAU - Titleless, Terry
AU  - Titleless T
JT  - Journal of Missing Fields

PMID- 22222222
DP  - 2019 Feb
TI  - A valid record among malformed neighbours.
FAU - Doe, Jane
AU  - Doe J
JT  - Journal of Robust Parsing
LID - 10.1000/valid.2 [doi]

this chunk has no MEDLINE tags at all
just some free text
`;

export const NBIB_EMPTY = "";

// AD (affiliations, repeated + continuation) and SI (secondary source id) capture, plus a
// registry id buried in the abstract. AD values repeat across authors on purpose — the
// parser keeps a record-level unique bag.
export const NBIB_AFFILIATIONS = `PMID- 29787288
DP  - 2018 Nov 1
TI  - A Multicenter Randomized Controlled Trial of Zephyr Endobronchial Valve Treatment.
AB  - Randomized trial of valve treatment versus standard care
      (EudraCT 2016-001234-56).
FAU - Criner, Gerard J
AU  - Criner GJ
AD  - Department of Thoracic Medicine and Surgery, Temple University,
      Philadelphia, PA, USA.
FAU - Sue, Richard
AU  - Sue R
AD  - Department of Thoracic Medicine and Surgery, Temple University,
      Philadelphia, PA, USA.
AD  - St. Joseph's Hospital and Medical Center, Phoenix, AZ, USA.
SI  - ClinicalTrials.gov/NCT01796392
JT  - American journal of respiratory and critical care medicine
`;
