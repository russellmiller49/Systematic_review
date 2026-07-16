// Golden RIS fixtures — realistic PubMed-style export (5 records) + malformed variants.

export const RIS_PUBMED_5 = `TY  - JOUR
TI  - Bronchoscopic lung volume reduction with endobronchial valves for severe emphysema: a randomized controlled trial
AU  - Criner, Gerard J.
AU  - Sue, Richard
AU  - Wright, Shawn
PY  - 2018/09/15
JF  - American Journal of Respiratory and Critical Care Medicine
VL  - 198
IS  - 9
SP  - 1151
EP  - 1164
AB  - RATIONALE: Bronchoscopic lung volume reduction with endobronchial valves has been
      proposed for patients with severe heterogeneous emphysema. OBJECTIVES: To evaluate
      the effectiveness and safety of Zephyr valves versus standard of care.
DO  - 10.1164/rccm.201803-0590OC
UR  - https://pubmed.ncbi.nlm.nih.gov/29787288/
LA  - eng
ER  -

TY  - JOUR
TI  - Effect of Müller maneuver training on diaphragm function in COPD: the RESPIRE-2 study
AU  - Müller, Jürgen
A1  - García-López, María
PY  - 2020
JO  - Thorax
VL  - 75
IS  - 4
SP  - 331-339
AB  - Diaphragm dysfunction is common in chronic obstructive pulmonary disease.
DO  - https://doi.org/10.1136/thoraxjnl-2019-213456
UR  - https://thorax.bmj.com/content/75/4/331
ER  -

TY  - JOUR
T1  - Pulmonary rehabilitation following exacerbations of chronic obstructive pulmonary disease
A1  - Puhan, Milo A.
A1  - Gimeno-Santos, Elena
Y1  - 2016/12/08
T2  - Cochrane Database of Systematic Reviews
IS  - 12
AB  - Guidelines have provided positive recommendations for pulmonary rehabilitation
      after exacerbations of COPD.
DO  - 10.1002/14651858.CD005305.pub4
ER  -

TY  - JOUR
TI  - Nocturnal non-invasive ventilation in stable hypercapnic COPD
AU  - Koehnlein, Thomas
PY  - 2014
JF  - The Lancet Respiratory Medicine
VL  - 2
IS  - 9
SP  - 698
EP  - 705
DO  - 10.1016/S2213-2600(14)70153-5
ER  -

TY  - JOUR
TI  - Smoking cessation interventions in pulmonary clinics: a pragmatic cohort study
AU  - Nguyen, Thi Hoang Lan
PY  - 2021
JO  - Respiratory Research
VL  - 22
SP  - 145
AB  - Smoking cessation remains the only intervention shown to slow decline in FEV1.
UR  - https://respiratory-research.biomedcentral.com/articles/10.1186/s12931-021-01745-5
ER  -
`;

// Same content with a UTF-8 BOM and CRLF line endings (Windows export).
export const RIS_BOM_CRLF = "\uFEFF" + RIS_PUBMED_5.replace(/\n/g, "\r\n");

// One good record, one missing its title, one unterminated at EOF.
export const RIS_MALFORMED = `TY  - JOUR
TI  - A valid record among malformed neighbours
AU  - Doe, Jane
PY  - 2019
JO  - Journal of Robust Parsing
DO  - 10.1000/valid.1
ER  -

TY  - JOUR
AU  - Titleless, Terry
PY  - 2018
JO  - Journal of Missing Fields
ER  -

TY  - JOUR
TI  - This record never terminates
AU  - Endless, Eva
PY  - 2022
`;

// Garbage that is not a RIS block at all, followed by a valid record.
export const RIS_STRAY_CONTENT = `This file was exported from SomeTool v2.1

TY  - JOUR
TI  - Valid record after stray header text
AU  - Fine, Frank
PY  - 2015
ER  -
`;

export const RIS_EMPTY = "";

// AD + C1 affiliation capture and registry-id extraction from AD values and the abstract.
export const RIS_AFFILIATIONS = `TY  - JOUR
TI  - Endobronchial valve therapy durability at 24 months: the LIBERATE follow-up
AU  - Criner, Gerard J.
AU  - Dransfield, Mark T.
PY  - 2019
JO  - American Journal of Respiratory and Critical Care Medicine
AD  - Temple University, Philadelphia, PA, USA. gerard.criner@tuhs.temple.edu
AD  - Temple University, Philadelphia, PA, USA. gerard.criner@tuhs.temple.edu
C1  - University of Alabama at Birmingham, Birmingham, AL, USA
AB  - Durability of the treatment effect through 24 months
      (ClinicalTrials.gov number, NCT01796392; also ISRCTN04761234).
ER  -
`;
