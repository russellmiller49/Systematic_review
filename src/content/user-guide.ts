export interface GuideStep {
  id: string;
  number: string;
  phase: "Plan" | "Find" | "Decide" | "Extract" | "Synthesize" | "Report";
  title: string;
  summary: string;
  actions: string[];
  remember?: string;
  image?: string;
}

export interface GuideRole {
  role: string;
  bestFor: string;
  access: string;
}

export interface VideoChapter {
  image: string;
  label: string;
  title: string;
  subtitle: string;
  narration: string;
}

export const guideSteps: GuideStep[] = [
  {
    id: "create-project",
    number: "01",
    phase: "Plan",
    title: "Create the workspace",
    summary:
      "Create an organization, start a review project, and choose the review and screening model before work begins.",
    actions: [
      "Create or open an organization from the Organizations page.",
      "Select New project and enter the title, review type, question, and registration details.",
      "Choose single or dual screening, the reviewer count, and whether screening is blinded.",
      "Invite the team from Settings and give each person one or more project roles.",
    ],
    remember: "Roles are cumulative. Give each person only the roles needed for their work.",
    image: "/guide/captures/01-dashboard.jpg",
  },
  {
    id: "protocol",
    number: "02",
    phase: "Plan",
    title: "Define and publish the protocol",
    summary:
      "Record the question, PICO, criteria, outcomes, search methods, exclusion reasons, and analysis plan in one versioned protocol.",
    actions: [
      "Complete the Overview, Criteria, Outcomes, PICO, and Exclusion reasons tabs.",
      "Add full-text exclusion reasons before full-text screening starts.",
      "Publish the protocol to freeze version 1 before screening.",
      "After screening begins, describe why a change is needed; Synthesis records an amendment and a new version.",
    ],
    remember: "Published versions are permanent snapshots. Editing the working protocol never rewrites history.",
    image: "/guide/captures/02-protocol.jpg",
  },
  {
    id: "import",
    number: "03",
    phase: "Find",
    title: "Import search results",
    summary:
      "Bring database exports into the project with a preview-and-commit workflow that preserves source provenance and row errors.",
    actions: [
      "Add a source for each database or search channel.",
      "Upload an RIS, BibTeX, CSV, or NBIB file and review the parse preview.",
      "Correct the source export when errors matter, then upload again; raw records remain inspectable.",
      "Commit the batch to create citations and retain the link back to its source.",
    ],
    remember: "A committed import can be removed only while downstream review work does not depend on it.",
    image: "/guide/captures/03-import.jpg",
  },
  {
    id: "deduplication",
    number: "04",
    phase: "Find",
    title: "Resolve duplicate citations",
    summary:
      "Combine exact identifiers and fuzzy title evidence with a human decision before screening assignments are made.",
    actions: [
      "Run detection after all planned search batches are committed.",
      "Compare each suggested pair and its DOI, PMID, title, author, and year evidence.",
      "Choose the canonical record and merge, or reject the suggestion.",
      "Use Merged citations to review or undo a merge when necessary.",
    ],
    remember: "A merge preserves provenance and history; it does not silently delete the duplicate record.",
    image: "/guide/captures/04-dedup.jpg",
  },
  {
    id: "screening",
    number: "05",
    phase: "Decide",
    title: "Screen independently",
    summary:
      "Assign citations, work through a keyboard-first queue, and let consensus or adjudication move records between stages.",
    actions: [
      "Assign reviewers for title-and-abstract screening, then repeat for full text when records advance.",
      "Use I to include, E to exclude, M for maybe, N for a note, and J or the right arrow to skip.",
      "Reviewers see only their own decisions while blinding is active.",
      "Resolve disagreements in Conflicts; settled decisions lock until an authorized user reopens them with a reason.",
    ],
    remember: "A full-text exclusion always requires one of the project's configured exclusion reasons.",
    image: "/guide/captures/05-screening.jpg",
  },
  {
    id: "full-text",
    number: "06",
    phase: "Decide",
    title: "Retrieve and review full text",
    summary:
      "Track retrieval attempts, attach PDFs, and keep eligibility status and PRISMA reporting synchronized.",
    actions: [
      "Filter reports by retrieval or decision status to focus the queue.",
      "Record publisher, library, interlibrary-loan, or author-contact attempts.",
      "Upload the main PDF and preview it in the workspace.",
      "Complete assigned full-text decisions; included reports automatically create or join studies.",
    ],
    remember: "Mark a report Not retrievable explicitly so it appears in the correct PRISMA box.",
    image: "/guide/captures/06-fulltext.jpg",
  },
  {
    id: "extraction",
    number: "07",
    phase: "Extract",
    title: "Extract with evidence anchors",
    summary:
      "Publish typed forms, collect data in duplicate, resolve disagreements, and keep every value connected to its source.",
    actions: [
      "Build a draft template with text, number, date, select, multiselect, and boolean fields.",
      "Publish the template, assign extractors, and start one form per study and extractor.",
      "Capture a source quote and page, or select text directly in the PDF viewer.",
      "Use Table for the living matrix and Conflicts to adjudicate field-level disagreements.",
    ],
    remember: "Resolved data follows a fixed precedence: adjudicated, then consensus, then a single final value.",
    image: "/guide/captures/07-extraction.jpg",
  },
  {
    id: "risk-of-bias",
    number: "08",
    phase: "Extract",
    title: "Assess risk of bias",
    summary:
      "Use a standard or custom instrument, complete independent domain judgments, and review a traffic-light summary.",
    actions: [
      "Clone a built-in tool—RoB 2, ROBINS-I, QUADAS-2, Newcastle-Ottawa, JBI, or AMSTAR 2—or build your own.",
      "Publish the project copy and assign assessors by study.",
      "Answer signaling questions, record support for each judgment, and complete the assessment.",
      "Review the summary and adjudicate domain or overall disagreements.",
    ],
    remember: "Tool structure freezes after assessments start; create a new copy when the instrument must change.",
    image: "/guide/captures/08-risk-of-bias.jpg",
  },
  {
    id: "analysis",
    number: "09",
    phase: "Synthesize",
    title: "Pool outcomes and inspect uncertainty",
    summary:
      "Map finalized extraction fields to statistical roles and generate transparent, deterministic meta-analysis results.",
    actions: [
      "Create an outcome and choose RR, OR, RD, MD, SMD, proportion, or generic inverse variance.",
      "Map each required statistical role to a numeric extraction field.",
      "Compare fixed and random effects and inspect included, incomplete, disputed, and manually excluded studies.",
      "Download forest and funnel plots; review heterogeneity, prediction intervals, and small-study diagnostics where available.",
    ],
    remember: "Provisional values are visibly optional and remain hidden from users who must stay blinded.",
    image: "/guide/captures/09-analysis.jpg",
  },
  {
    id: "grade",
    number: "10",
    phase: "Synthesize",
    title: "Review GRADE and Summary of Findings",
    summary:
      "Turn pooled evidence into explicit certainty judgments and a report-ready summary without surrendering human judgment.",
    actions: [
      "Generate the deterministic GRADE draft for an outcome.",
      "Review risk of bias, inconsistency, indirectness, imprecision, and publication bias.",
      "Edit judgments and rationales, then mark the assessment reviewed when all sources are current.",
      "Open Summary of Findings to review relative and anticipated absolute effects, certainty, and footnotes.",
    ],
    remember: "Changes to pooled evidence, RoB, or protocol context mark the assessment stale until it is reviewed again.",
    image: "/guide/captures/10-grade.jpg",
  },
  {
    id: "reporting",
    number: "11",
    phase: "Report",
    title: "Freeze, export, and audit",
    summary:
      "Generate PRISMA reporting from live workflow data, preserve submission snapshots, and retain a defensible history.",
    actions: [
      "Review live PRISMA counts and the automatic flow diagram.",
      "Save a labeled snapshot for a protocol submission, abstract, manuscript, or update.",
      "Download the diagram as SVG or PNG and create permitted CSV or JSON exports.",
      "Use Audit trail filters to find who changed an entity, what changed, when, and why.",
    ],
    remember: "Audit and export visibility follows project capabilities and never bypasses reviewer blinding.",
    image: "/guide/captures/12-prisma.jpg",
  },
];

export const guideRoles: GuideRole[] = [
  {
    role: "Owner / Admin",
    bestFor: "Review leads and project coordinators",
    access: "Full control, team roles, assignments, settings, adjudication, exports, and audit.",
  },
  {
    role: "Reviewer",
    bestFor: "Title, abstract, and assigned full-text screening",
    access: "Assignment-gated screening and a blinding-aware view of relevant audit events.",
  },
  {
    role: "Adjudicator",
    bestFor: "Resolving screening, extraction, and RoB disagreements",
    access: "Conflict resolution, full-text management, analysis viewing, and permitted audit history.",
  },
  {
    role: "Extractor",
    bestFor: "Structured data extraction and RoB assessment",
    access: "Assigned extraction forms, RoB work, and the PDFs needed to complete them.",
  },
  {
    role: "Statistician",
    bestFor: "Outcome mapping, meta-analysis, GRADE, and reporting",
    access: "Analysis management, extraction templates, RoB tools, PRISMA snapshots, and exports.",
  },
  {
    role: "Librarian",
    bestFor: "Searches, imports, deduplication, and retrieval",
    access: "Protocol editing, imports, deduplication, full-text management, snapshots, and exports.",
  },
  {
    role: "Panel / Observer",
    bestFor: "Stakeholders who review findings",
    access: "Read-only project, analysis, and permitted audit views.",
  },
  {
    role: "Trainee",
    bestFor: "Supervised review work",
    access: "Assigned screening, extraction, RoB, and full-text tasks without project administration.",
  },
];

export const videoChapters: VideoChapter[] = [
  {
    image: "01-dashboard.jpg",
    label: "Overview",
    title: "From question to certainty",
    subtitle: "One traceable workspace for the entire evidence-synthesis workflow",
    narration:
      "Welcome to Synthesis, a traceable workspace for systematic reviews and meta-analyses. This overview follows a review from its protocol through screening, synthesis, and reporting. What you see is the seeded demonstration project, using the same workflows your team will use.",
  },
  {
    image: "02-protocol.jpg",
    label: "01 · Plan",
    title: "A versioned protocol",
    subtitle: "Question, PICO, criteria, outcomes, methods, and amendments",
    narration:
      "Start by creating a project and assigning team roles. In Protocol, record the review question, narrative and structured PICO, eligibility criteria, outcomes, search plan, exclusion reasons, and analysis plan. Publish a version before screening. Later edits require an amendment note, so the methods history remains visible.",
  },
  {
    image: "03-import.jpg",
    label: "02 · Find",
    title: "Source-aware citation imports",
    subtitle: "Preview and commit RIS, BibTeX, CSV, or NBIB records",
    narration:
      "Add each database as a source, then upload RIS, BibTeX, CSV, or NBIB exports. Synthesis previews every record and preserves parse errors before you commit a batch. The project always knows where each citation came from.",
  },
  {
    image: "04-dedup.jpg",
    label: "03 · Find",
    title: "Human-reviewed deduplication",
    subtitle: "Exact identifiers and fuzzy evidence, with merge undo",
    narration:
      "Run duplicate detection before screening. Exact DOI and PMID matches sit alongside title-based suggestions for human review. Merge a pair, reject it, or undo a merge later; the original provenance is retained.",
  },
  {
    image: "05-screening.jpg",
    label: "04 · Decide",
    title: "Fast, blinded screening",
    subtitle: "Keyboard-first queues, automatic consensus, and adjudication",
    narration:
      "Assign title-and-abstract and full-text work to one or more reviewers. The queue is keyboard first: I includes, E excludes, M marks maybe, N opens a note, and J skips. When blinding is enabled, reviewers cannot see one another's decisions. Disagreements become conflicts for an adjudicator, while agreed decisions advance automatically.",
  },
  {
    image: "06-fulltext.jpg",
    label: "05 · Decide",
    title: "Full-text retrieval in context",
    subtitle: "Attempts, PDFs, eligibility, and exclusion reasons together",
    narration:
      "The full-text workspace tracks retrieval attempts, attached PDFs, and screening status together. Included reports advance to studies. A full-text exclusion must use a configured reason, keeping PRISMA counts and exclusion tables consistent.",
  },
  {
    image: "07-extraction.jpg",
    label: "06 · Extract",
    title: "A living extraction table",
    subtitle: "Versioned forms, duplicate extraction, and evidence anchors",
    narration:
      "Build a typed, versioned extraction template, publish it, and assign extractors. The living table resolves values in a clear order: adjudicated first, then consensus, then a single completed value. Evidence anchors reopen the exact supporting page and quote, and CSV export is always close at hand.",
  },
  {
    image: "08-risk-of-bias.jpg",
    label: "07 · Extract",
    title: "Risk of bias, study by study",
    subtitle: "Standard instruments, independent judgments, and traffic lights",
    narration:
      "For risk of bias, clone a standard instrument or build your own. Synthesis includes RoB 2, ROBINS-I, QUADAS-2, Newcastle-Ottawa, JBI, and AMSTAR 2. Reviewers assess domains independently; the traffic-light summary shows agreement, disagreements, and adjudicated judgments.",
  },
  {
    image: "09-analysis.jpg",
    label: "08 · Synthesize",
    title: "Analysis that stays connected",
    subtitle: "Mapped extraction fields, pooled effects, and diagnostics",
    narration:
      "Map extraction fields to an outcome once, and pooled results refresh as finalized evidence changes. Fixed and random effects, forest plots, prediction intervals, funnel plots, and small-study diagnostics are generated from deterministic statistical code, with incomplete or excluded studies called out.",
  },
  {
    image: "10-grade.jpg",
    label: "09 · Synthesize",
    title: "Human-reviewed GRADE",
    subtitle: "Deterministic draft rules with editable judgments and rationale",
    narration:
      "On the GRADE tab, Synthesis drafts five certainty domains from the pooled evidence and risk-of-bias results. Every judgment and rationale stays human-editable. Mark an assessment reviewed only when the evidence is current; source changes flag it as stale.",
  },
  {
    image: "11-summary-of-findings.jpg",
    label: "10 · Synthesize",
    title: "Summary of Findings",
    subtitle: "Relative effects, absolute effects, certainty, and footnotes",
    narration:
      "The Summary of Findings brings together study counts, participants, relative effects, anticipated absolute effects, and certainty. Download the table as CSV when it is ready for your report.",
  },
  {
    image: "12-prisma.jpg",
    label: "11 · Report",
    title: "PRISMA that updates itself",
    subtitle: "Live counts, frozen snapshots, and publication-ready diagrams",
    narration:
      "PRISMA counts are computed live from the same decisions that drive the workflow. Save a frozen snapshot for a submission, and download the publication-ready flow diagram as SVG or PNG.",
  },
  {
    image: "13-audit.jpg",
    label: "12 · Govern",
    title: "A defensible audit trail",
    subtitle: "Who changed what, when, and why—without breaking blinding",
    narration:
      "Finally, the audit trail records who changed what, when, and why. Role-aware filtering preserves reviewer blinding. Together with capability-gated exports, it gives the review a defensible chain from source record to final conclusion.",
  },
  {
    image: "01-dashboard.jpg",
    label: "Start here",
    title: "Build the review, not the spreadsheet maze",
    subtitle: "Open the full guide for task steps, roles, shortcuts, and troubleshooting",
    narration:
      "That is Synthesis: one connected workspace for planning, screening, extraction, risk assessment, synthesis, and reporting. Open the user guide for task-by-task instructions, role guidance, shortcuts, and troubleshooting.",
  },
];

export const guideFaqs = [
  {
    question: "Why can I see a page but not its edit controls?",
    answer:
      "Project roles grant capabilities independently. Ask an Owner or Admin to add the role that matches the task. A person can hold several roles at once.",
  },
  {
    question: "Why is a screening decision locked?",
    answer:
      "The citation already has a settled stage result. An Owner, Admin, or Adjudicator must reopen it with a reason before decisions can change.",
  },
  {
    question: "Why can’t I exclude a full-text report?",
    answer:
      "Every full-text exclusion requires an active, applicable reason. Add reasons in Protocol → Exclusion reasons, then return to the decision.",
  },
  {
    question: "Why is a study missing from the pooled result?",
    answer:
      "Open Analysis and inspect its row. Synthesis labels missing mappings, incomplete values, unresolved disputes, invalid data, and manual exclusions instead of silently dropping a study.",
  },
  {
    question: "What does a stale GRADE assessment mean?",
    answer:
      "One of its sources changed—pooled data, risk-of-bias judgments, the outcome definition, or relevant protocol context. Regenerate or review the assessment before marking it reviewed again.",
  },
  {
    question: "Can AI make review decisions automatically?",
    answer:
      "No. When configured, AI creates separate suggestions for screening, extraction, RoB, or GRADE. A person must explicitly apply or act on a suggestion; human decision records remain human-authored.",
  },
] as const;
