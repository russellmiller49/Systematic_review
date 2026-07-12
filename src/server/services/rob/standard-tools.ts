// Built-in seeds for the standard published risk-of-bias / critical-appraisal instruments.
// Data only — the seeding mechanism lives in ./builtin.ts. Each definition follows the
// published instrument's domains, signaling questions/items and judgment scale as closely
// as this data model allows; adaptations are called out in the tool description so
// reviewers know what to expect. Structural edits happen by cloning into a project (R9).

import type { Tx } from "@/server/db";
import { prisma } from "@/server/db";
import { ensureBuiltinTool, type BuiltinToolDef } from "./builtin";

// Answer sets. RoB 2 / ROBINS-I use the published shorthand codes; the legend is in each
// tool's description. Conditional questions add NA (with the condition in the guidance).
const CODES = ["Y", "PY", "PN", "N", "NI"] as const;
const CODES_NA = ["Y", "PY", "PN", "N", "NI", "NA"] as const;
const YES_NO_UNCLEAR = ["Yes", "No", "Unclear"] as const;
const JBI_ANSWERS = ["Yes", "No", "Unclear", "Not applicable"] as const;
const AMSTAR_ANSWERS = ["Yes", "Partial yes", "No"] as const;
const AMSTAR_ANSWERS_META = ["Yes", "Partial yes", "No", "No meta-analysis"] as const;

const GREEN = "#16a34a";
const AMBER = "#d97706";
const ORANGE = "#ea580c";
const RED = "#dc2626";
const SLATE = "#64748b";

const CODE_LEGEND = "Answer codes: Y = yes, PY = probably yes, PN = probably no, N = no, " +
  "NI = no information, NA = not applicable.";

export const ROB2_DEF: BuiltinToolDef = {
  name: "RoB 2",
  description:
    "Cochrane risk-of-bias tool for randomized trials (RoB 2, 2019). Assesses a specific " +
    "result across five domains; this is the 'effect of assignment to intervention' " +
    "(intention-to-treat) variant. " + CODE_LEGEND,
  judgmentScale: [
    { value: "low", label: "Low risk", color: GREEN, severity: 1 },
    { value: "some_concerns", label: "Some concerns", color: AMBER, severity: 2 },
    { value: "high", label: "High risk", color: RED, severity: 3 },
  ],
  defaultAllowedAnswers: CODES,
  domains: [
    {
      name: "Bias arising from the randomization process",
      guidance:
        "Random sequence generation, allocation concealment, and baseline imbalances that " +
        "suggest a problem with randomization.",
      questions: [
        { text: "1.1 Was the allocation sequence random?" },
        {
          text:
            "1.2 Was the allocation sequence concealed until participants were enrolled and " +
            "assigned to interventions?",
        },
        {
          text:
            "1.3 Did baseline differences between intervention groups suggest a problem with " +
            "the randomization process?",
        },
      ],
    },
    {
      name: "Bias due to deviations from intended interventions",
      guidance:
        "Effect of assignment to intervention. Blinding of participants and personnel, " +
        "trial-context deviations, and the appropriateness of the analysis.",
      questions: [
        {
          text: "2.1 Were participants aware of their assigned intervention during the trial?",
        },
        {
          text:
            "2.2 Were carers and people delivering the interventions aware of participants' " +
            "assigned intervention during the trial?",
        },
        {
          text:
            "2.3 Were there deviations from the intended intervention that arose because of " +
            "the trial context?",
          guidance: "Answer only if 2.1 or 2.2 is Y/PY/NI; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
        {
          text: "2.4 Were these deviations likely to have affected the outcome?",
          guidance: "Answer only if 2.3 is Y/PY; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
        {
          text: "2.5 Were these deviations from intended intervention balanced between groups?",
          guidance: "Answer only if 2.4 is Y/PY/NI; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
        {
          text:
            "2.6 Was an appropriate analysis used to estimate the effect of assignment to " +
            "intervention?",
        },
        {
          text:
            "2.7 Was there potential for a substantial impact (on the result) of the failure " +
            "to analyse participants in the group to which they were randomized?",
          guidance: "Answer only if 2.6 is N/PN/NI; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
      ],
    },
    {
      name: "Bias due to missing outcome data",
      guidance:
        "Completeness of outcome data and whether missingness could depend on the true value.",
      questions: [
        {
          text:
            "3.1 Were data for this outcome available for all, or nearly all, participants " +
            "randomized?",
        },
        {
          text:
            "3.2 Is there evidence that the result was not biased by missing outcome data?",
          guidance: "Answer only if 3.1 is N/PN/NI; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
        {
          text: "3.3 Could missingness in the outcome depend on its true value?",
          guidance: "Answer only if 3.2 is N/PN; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
        {
          text: "3.4 Is it likely that missingness in the outcome depended on its true value?",
          guidance: "Answer only if 3.3 is Y/PY/NI; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
      ],
    },
    {
      name: "Bias in measurement of the outcome",
      guidance:
        "Appropriateness of the outcome measure, differential measurement between groups, " +
        "and outcome-assessor blinding.",
      questions: [
        { text: "4.1 Was the method of measuring the outcome inappropriate?" },
        {
          text:
            "4.2 Could measurement or ascertainment of the outcome have differed between " +
            "intervention groups?",
        },
        {
          text:
            "4.3 Were outcome assessors aware of the intervention received by study " +
            "participants?",
          guidance: "Answer only if 4.1 and 4.2 are N/PN/NI; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
        {
          text:
            "4.4 Could assessment of the outcome have been influenced by knowledge of " +
            "intervention received?",
          guidance: "Answer only if 4.3 is Y/PY/NI; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
        {
          text:
            "4.5 Is it likely that assessment of the outcome was influenced by knowledge of " +
            "intervention received?",
          guidance: "Answer only if 4.4 is Y/PY/NI; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
      ],
    },
    {
      name: "Bias in selection of the reported result",
      guidance:
        "Selection of the reported result from multiple eligible measurements or analyses.",
      questions: [
        {
          text:
            "5.1 Were the data that produced this result analysed in accordance with a " +
            "pre-specified analysis plan that was finalized before unblinded outcome data " +
            "were available for analysis?",
        },
        {
          text:
            "5.2 Is the numerical result being assessed likely to have been selected, on the " +
            "basis of the results, from multiple eligible outcome measurements (e.g. scales, " +
            "definitions, time points) within the outcome domain?",
        },
        {
          text:
            "5.3 Is the numerical result being assessed likely to have been selected, on the " +
            "basis of the results, from multiple eligible analyses of the data?",
        },
      ],
    },
  ],
};

export const ROBINS_I_DEF: BuiltinToolDef = {
  name: "ROBINS-I",
  description:
    "Risk Of Bias In Non-randomized Studies of Interventions (ROBINS-I, 2016). Seven " +
    "domains assessed for a specific result. " + CODE_LEGEND,
  judgmentScale: [
    { value: "low", label: "Low", color: GREEN, severity: 1 },
    { value: "moderate", label: "Moderate", color: AMBER, severity: 2 },
    { value: "serious", label: "Serious", color: ORANGE, severity: 3 },
    { value: "critical", label: "Critical", color: RED, severity: 4 },
    { value: "no_information", label: "No information", color: SLATE, severity: 5 },
  ],
  defaultAllowedAnswers: CODES,
  domains: [
    {
      name: "Bias due to confounding",
      guidance:
        "Baseline and time-varying confounding of the intervention effect. Questions 1.4–1.6 " +
        "apply to baseline confounding; 1.7–1.8 apply when follow-up time is split or " +
        "switches are prognostic (time-varying confounding).",
      questions: [
        {
          text:
            "1.1 Is there potential for confounding of the effect of intervention in this " +
            "study?",
          guidance: "If N/PN, the domain can be rated low risk and 1.2–1.8 are NA.",
        },
        {
          text:
            "1.2 Was the analysis based on splitting participants' follow up time according " +
            "to intervention received?",
          guidance: "If Y/PY, answer 1.7–1.8 (baseline and time-varying confounding).",
          allowedAnswers: CODES_NA,
        },
        {
          text:
            "1.3 Were intervention discontinuations or switches likely to be related to " +
            "factors that are prognostic for the outcome?",
          guidance: "If Y/PY, answer 1.7–1.8 (baseline and time-varying confounding).",
          allowedAnswers: CODES_NA,
        },
        {
          text:
            "1.4 Did the authors use an appropriate analysis method that controlled for all " +
            "the important confounding domains?",
          guidance: "Baseline confounding only. NA if time-varying confounding applies.",
          allowedAnswers: CODES_NA,
        },
        {
          text:
            "1.5 Were confounding domains that were controlled for measured validly and " +
            "reliably by the variables available in this study?",
          guidance: "Answer only if 1.4 is Y/PY; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
        {
          text:
            "1.6 Did the authors control for any post-intervention variables that could have " +
            "been affected by the intervention?",
          allowedAnswers: CODES_NA,
        },
        {
          text:
            "1.7 Did the authors use an appropriate analysis method that adjusted for all the " +
            "important confounding domains and for time-varying confounding?",
          guidance: "Time-varying confounding only. NA if only baseline confounding applies.",
          allowedAnswers: CODES_NA,
        },
        {
          text:
            "1.8 Were confounding domains that were adjusted for measured validly and " +
            "reliably by the variables available in this study?",
          guidance: "Answer only if 1.7 is Y/PY; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
      ],
    },
    {
      name: "Bias in selection of participants into the study",
      questions: [
        {
          text:
            "2.1 Was selection of participants into the study (or into the analysis) based on " +
            "participant characteristics observed after the start of intervention?",
        },
        {
          text:
            "2.2 Were the post-intervention variables that influenced selection likely to be " +
            "associated with intervention?",
          guidance: "Answer only if 2.1 is Y/PY; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
        {
          text:
            "2.3 Were the post-intervention variables that influenced selection likely to be " +
            "influenced by the outcome or a cause of the outcome?",
          guidance: "Answer only if 2.2 is Y/PY; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
        {
          text:
            "2.4 Do start of follow-up and start of intervention coincide for most " +
            "participants?",
        },
        {
          text:
            "2.5 Were adjustment techniques used that are likely to correct for the presence " +
            "of selection biases?",
          guidance: "Answer only if 2.2 and 2.3 are Y/PY, or 2.4 is N/PN; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
      ],
    },
    {
      name: "Bias in classification of interventions",
      questions: [
        { text: "3.1 Were intervention groups clearly defined?" },
        {
          text:
            "3.2 Was the information used to define intervention groups recorded at the start " +
            "of the intervention?",
        },
        {
          text:
            "3.3 Could classification of intervention status have been affected by knowledge " +
            "of the outcome or risk of the outcome?",
        },
      ],
    },
    {
      name: "Bias due to deviations from intended interventions",
      guidance:
        "Questions 4.1–4.2 address the effect of assignment; 4.3–4.6 address the effect of " +
        "starting and adhering to intervention.",
      questions: [
        {
          text:
            "4.1 Were there deviations from the intended intervention beyond what would be " +
            "expected in usual practice?",
        },
        {
          text:
            "4.2 Were these deviations from intended intervention unbalanced between groups " +
            "and likely to have affected the outcome?",
          guidance: "Answer only if 4.1 is Y/PY; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
        {
          text: "4.3 Were important co-interventions balanced across intervention groups?",
          allowedAnswers: CODES_NA,
        },
        {
          text: "4.4 Was the intervention implemented successfully for most participants?",
          allowedAnswers: CODES_NA,
        },
        {
          text: "4.5 Did study participants adhere to the assigned intervention regimen?",
          allowedAnswers: CODES_NA,
        },
        {
          text:
            "4.6 Was an appropriate analysis used to estimate the effect of starting and " +
            "adhering to the intervention?",
          guidance: "Answer only if 4.3, 4.4 or 4.5 is N/PN; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
      ],
    },
    {
      name: "Bias due to missing data",
      questions: [
        {
          text: "5.1 Were outcome data available for all, or nearly all, participants?",
        },
        { text: "5.2 Were participants excluded due to missing data on intervention status?" },
        {
          text:
            "5.3 Were participants excluded due to missing data on other variables needed for " +
            "the analysis?",
        },
        {
          text:
            "5.4 Are the proportion of participants and reasons for missing data similar " +
            "across interventions?",
          guidance: "Answer only if 5.1 is N/PN, or 5.2 or 5.3 is Y/PY; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
        {
          text:
            "5.5 Is there evidence that results were robust to the presence of missing data?",
          guidance: "Answer only if 5.1 is N/PN, or 5.2 or 5.3 is Y/PY; otherwise NA.",
          allowedAnswers: CODES_NA,
        },
      ],
    },
    {
      name: "Bias in measurement of outcomes",
      questions: [
        {
          text:
            "6.1 Could the outcome measure have been influenced by knowledge of the " +
            "intervention received?",
        },
        {
          text:
            "6.2 Were outcome assessors aware of the intervention received by study " +
            "participants?",
        },
        {
          text:
            "6.3 Were the methods of outcome assessment comparable across intervention " +
            "groups?",
        },
        {
          text:
            "6.4 Were any systematic errors in measurement of the outcome related to " +
            "intervention received?",
        },
      ],
    },
    {
      name: "Bias in selection of the reported result",
      guidance:
        "Is the reported effect estimate likely to be selected, on the basis of the results, " +
        "from the following?",
      questions: [
        {
          text:
            "7.1 ... multiple outcome measurements within the outcome domain?",
        },
        { text: "7.2 ... multiple analyses of the intervention-outcome relationship?" },
        { text: "7.3 ... different subgroups?" },
      ],
    },
  ],
};

export const QUADAS_2_DEF: BuiltinToolDef = {
  name: "QUADAS-2",
  description:
    "Quality Assessment of Diagnostic Accuracy Studies (QUADAS-2, 2011). Four risk-of-bias " +
    "domains with signalling questions. The applicability-concerns part of QUADAS-2 is not " +
    "modeled as separate judgments — record applicability concerns in each domain's " +
    "'support for judgment' field.",
  judgmentScale: [
    { value: "low", label: "Low risk", color: GREEN, severity: 1 },
    { value: "high", label: "High risk", color: RED, severity: 2 },
    { value: "unclear", label: "Unclear", color: SLATE, severity: 3 },
  ],
  defaultAllowedAnswers: YES_NO_UNCLEAR,
  domains: [
    {
      name: "Patient selection",
      guidance: "Could the selection of patients have introduced bias?",
      questions: [
        { text: "Was a consecutive or random sample of patients enrolled?" },
        { text: "Was a case-control design avoided?" },
        { text: "Did the study avoid inappropriate exclusions?" },
      ],
    },
    {
      name: "Index test",
      guidance: "Could the conduct or interpretation of the index test have introduced bias?",
      questions: [
        {
          text:
            "Were the index test results interpreted without knowledge of the results of the " +
            "reference standard?",
        },
        { text: "If a threshold was used, was it pre-specified?" },
      ],
    },
    {
      name: "Reference standard",
      guidance:
        "Could the reference standard, its conduct, or its interpretation have introduced " +
        "bias?",
      questions: [
        {
          text: "Is the reference standard likely to correctly classify the target condition?",
        },
        {
          text:
            "Were the reference standard results interpreted without knowledge of the results " +
            "of the index test?",
        },
      ],
    },
    {
      name: "Flow and timing",
      guidance: "Could the patient flow have introduced bias?",
      questions: [
        {
          text:
            "Was there an appropriate interval between index test(s) and reference standard?",
        },
        { text: "Did all patients receive a reference standard?" },
        { text: "Did all patients receive the same reference standard?" },
        { text: "Were all patients included in the analysis?" },
      ],
    },
  ],
};

// Star-earning options are marked ★; the full official option wording is in each item's
// guidance. The overall judgment uses the AHRQ Good/Fair/Poor thresholds.
export const NOS_COHORT_DEF: BuiltinToolDef = {
  name: "Newcastle-Ottawa Scale (cohort studies)",
  description:
    "Newcastle-Ottawa Scale for assessing the quality of cohort studies. Each item's " +
    "star-earning options are marked ★ (Comparability can earn up to two stars). Overall " +
    "quality rating per AHRQ thresholds: Good / Fair / Poor. For case-control studies, " +
    "clone and adapt the Selection and Exposure items.",
  judgmentScale: [
    { value: "good", label: "Good quality", color: GREEN, severity: 1 },
    { value: "fair", label: "Fair quality", color: AMBER, severity: 2 },
    { value: "poor", label: "Poor quality", color: RED, severity: 3 },
  ],
  defaultAllowedAnswers: YES_NO_UNCLEAR,
  domains: [
    {
      name: "Selection",
      guidance: "Maximum one star per item.",
      questions: [
        {
          text: "1. Representativeness of the exposed cohort",
          guidance:
            "a) truly representative of the average in the community ★; b) somewhat " +
            "representative of the average in the community ★; c) selected group of users " +
            "(e.g. nurses, volunteers); d) no description of the derivation of the cohort.",
          allowedAnswers: [
            "★ Truly representative",
            "★ Somewhat representative",
            "Selected group",
            "No description",
          ],
        },
        {
          text: "2. Selection of the non-exposed cohort",
          guidance:
            "a) drawn from the same community as the exposed cohort ★; b) drawn from a " +
            "different source; c) no description of the derivation of the non-exposed cohort.",
          allowedAnswers: ["★ Same community", "Different source", "No description"],
        },
        {
          text: "3. Ascertainment of exposure",
          guidance:
            "a) secure record (e.g. surgical records) ★; b) structured interview ★; " +
            "c) written self report; d) no description.",
          allowedAnswers: [
            "★ Secure record",
            "★ Structured interview",
            "Written self report",
            "No description",
          ],
        },
        {
          text:
            "4. Demonstration that outcome of interest was not present at start of study",
          guidance: "a) yes ★; b) no.",
          allowedAnswers: ["★ Yes", "No"],
        },
      ],
    },
    {
      name: "Comparability",
      guidance: "A maximum of two stars can be allotted in this category.",
      questions: [
        {
          text: "1. Comparability of cohorts on the basis of the design or analysis",
          guidance:
            "a) study controls for the most important factor ★; b) study controls for any " +
            "additional factor ★. Select the highest applicable option.",
          allowedAnswers: [
            "★★ Most important + additional factor",
            "★ Most important factor",
            "Not controlled",
          ],
        },
      ],
    },
    {
      name: "Outcome",
      guidance: "Maximum one star per item.",
      questions: [
        {
          text: "1. Assessment of outcome",
          guidance:
            "a) independent blind assessment ★; b) record linkage ★; c) self report; " +
            "d) no description.",
          allowedAnswers: [
            "★ Independent blind assessment",
            "★ Record linkage",
            "Self report",
            "No description",
          ],
        },
        {
          text: "2. Was follow-up long enough for outcomes to occur?",
          guidance: "a) yes (adequate follow-up period for the outcome of interest) ★; b) no.",
          allowedAnswers: ["★ Yes", "No"],
        },
        {
          text: "3. Adequacy of follow up of cohorts",
          guidance:
            "a) complete follow up — all subjects accounted for ★; b) subjects lost to " +
            "follow up unlikely to introduce bias (small number lost, or description of " +
            "those lost provided) ★; c) follow up rate low and no description of those " +
            "lost; d) no statement.",
          allowedAnswers: [
            "★ Complete follow up",
            "★ Small loss, unlikely to bias",
            "High loss, not described",
            "No statement",
          ],
        },
      ],
    },
  ],
};

export const JBI_RCT_DEF: BuiltinToolDef = {
  name: "JBI Checklist for Randomized Controlled Trials",
  description:
    "JBI critical appraisal checklist for randomized controlled trials (13 items), grouped " +
    "by the bias domains used in the JBI guidance. Item numbers follow the published " +
    "checklist. Other JBI checklists (cohort, case-control, cross-sectional, …) can be " +
    "created with the tool builder or by cloning and adapting this one.",
  judgmentScale: [
    { value: "low", label: "Low risk", color: GREEN, severity: 1 },
    { value: "some_concerns", label: "Some concerns", color: AMBER, severity: 2 },
    { value: "high", label: "High risk", color: RED, severity: 3 },
    { value: "unclear", label: "Unclear", color: SLATE, severity: 4 },
  ],
  defaultAllowedAnswers: JBI_ANSWERS,
  domains: [
    {
      name: "Selection and allocation",
      questions: [
        {
          text:
            "1. Was true randomization used for assignment of participants to treatment " +
            "groups?",
        },
        { text: "2. Was allocation to treatment groups concealed?" },
        { text: "3. Were treatment groups similar at the baseline?" },
      ],
    },
    {
      name: "Administration of intervention/exposure",
      questions: [
        { text: "4. Were participants blind to treatment assignment?" },
        { text: "5. Were those delivering treatment blind to treatment assignment?" },
        {
          text:
            "7. Were treatment groups treated identically other than the intervention of " +
            "interest?",
        },
      ],
    },
    {
      name: "Assessment, detection and measurement of the outcome",
      questions: [
        { text: "6. Were outcomes assessors blind to treatment assignment?" },
        { text: "10. Were outcomes measured in the same way for treatment groups?" },
        { text: "11. Were outcomes measured in a reliable way?" },
      ],
    },
    {
      name: "Participant retention",
      questions: [
        {
          text:
            "8. Was follow up complete and if not, were differences between groups in terms " +
            "of their follow up adequately described and analyzed?",
        },
        {
          text: "9. Were participants analyzed in the groups to which they were randomized?",
        },
      ],
    },
    {
      name: "Statistical conclusion validity and trial design",
      questions: [
        { text: "12. Was appropriate statistical analysis used?" },
        {
          text:
            "13. Was the trial design appropriate, and any deviations from the standard RCT " +
            "design (individual randomization, parallel groups) accounted for in the conduct " +
            "and analysis of the trial?",
        },
      ],
    },
  ],
};

export const AMSTAR_2_DEF: BuiltinToolDef = {
  name: "AMSTAR 2",
  description:
    "AMSTAR 2 (2017): critical appraisal of systematic reviews of randomized and " +
    "non-randomized studies of interventions. 16 items; critical domains are items 2, 4, " +
    "7, 9, 11, 13 and 15. The overall judgment rates confidence in the results of the " +
    "review: High / Moderate / Low / Critically low.",
  judgmentScale: [
    { value: "high", label: "High confidence", color: GREEN, severity: 1 },
    { value: "moderate", label: "Moderate confidence", color: AMBER, severity: 2 },
    { value: "low", label: "Low confidence", color: ORANGE, severity: 3 },
    { value: "critically_low", label: "Critically low confidence", color: RED, severity: 4 },
  ],
  defaultAllowedAnswers: AMSTAR_ANSWERS,
  domains: [
    {
      name: "Appraisal items",
      guidance:
        "Critical domains: items 2, 4, 7, 9, 11, 13 and 15. More than one non-critical " +
        "weakness lowers confidence to Moderate; one critical flaw → Low; more than one " +
        "critical flaw → Critically low.",
      questions: [
        {
          text:
            "1. Did the research questions and inclusion criteria for the review include the " +
            "components of PICO?",
        },
        {
          text:
            "2. Did the report of the review contain an explicit statement that the review " +
            "methods were established prior to the conduct of the review and did the report " +
            "justify any significant deviations from the protocol?",
          guidance: "Critical domain.",
        },
        {
          text:
            "3. Did the review authors explain their selection of the study designs for " +
            "inclusion in the review?",
        },
        {
          text: "4. Did the review authors use a comprehensive literature search strategy?",
          guidance: "Critical domain.",
        },
        { text: "5. Did the review authors perform study selection in duplicate?" },
        { text: "6. Did the review authors perform data extraction in duplicate?" },
        {
          text:
            "7. Did the review authors provide a list of excluded studies and justify the " +
            "exclusions?",
          guidance: "Critical domain.",
        },
        {
          text:
            "8. Did the review authors describe the included studies in adequate detail?",
        },
        {
          text:
            "9. Did the review authors use a satisfactory technique for assessing the risk " +
            "of bias (RoB) in individual studies that were included in the review?",
          guidance: "Critical domain.",
        },
        {
          text:
            "10. Did the review authors report on the sources of funding for the studies " +
            "included in the review?",
        },
        {
          text:
            "11. If meta-analysis was performed, did the review authors use appropriate " +
            "methods for statistical combination of results?",
          guidance: "Critical domain.",
          allowedAnswers: AMSTAR_ANSWERS_META,
        },
        {
          text:
            "12. If meta-analysis was performed, did the review authors assess the potential " +
            "impact of RoB in individual studies on the results of the meta-analysis or " +
            "other evidence synthesis?",
          allowedAnswers: AMSTAR_ANSWERS_META,
        },
        {
          text:
            "13. Did the review authors account for RoB in individual studies when " +
            "interpreting/discussing the results of the review?",
          guidance: "Critical domain.",
        },
        {
          text:
            "14. Did the review authors provide a satisfactory explanation for, and " +
            "discussion of, any heterogeneity observed in the results of the review?",
        },
        {
          text:
            "15. If they performed quantitative synthesis, did the review authors carry out " +
            "an adequate investigation of publication bias (small study bias) and discuss " +
            "its likely impact on the results of the review?",
          guidance: "Critical domain.",
          allowedAnswers: AMSTAR_ANSWERS_META,
        },
        {
          text:
            "16. Did the review authors report any potential sources of conflict of " +
            "interest, including any funding they received for conducting the review?",
        },
      ],
    },
  ],
};

export const STANDARD_TOOL_DEFS: BuiltinToolDef[] = [
  ROB2_DEF,
  ROBINS_I_DEF,
  QUADAS_2_DEF,
  NOS_COHORT_DEF,
  JBI_RCT_DEF,
  AMSTAR_2_DEF,
];

/** Idempotently seed every standard instrument (plus nothing else). Safe to re-run. */
export async function ensureBuiltinStandardTools(client: Tx = prisma) {
  const tools = [];
  for (const def of STANDARD_TOOL_DEFS) {
    tools.push(await ensureBuiltinTool(def, client));
  }
  return tools;
}
