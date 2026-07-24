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
    title: "Create the workspace and invite the team",
    summary:
      "Set up the organization, invite collaborators, configure institutional access, and create the right kind of evidence project.",
    actions: [
      "Create or open an organization from the Organizations page.",
      "Invite members as beta testers, Workspace admins, or Workspace owners; each invitation link is single-use and tied to one email.",
      "Optionally configure the institution's EZProxy prefix and OpenURL resolver once for every full-text queue in the organization.",
      "Select New project, choose a single review or guideline structure, then assign the project roles needed for the work.",
    ],
    remember:
      "Organization membership opens the workspace; project roles control access to each review. A member does not automatically gain access to every project.",
    image: "/guide/captures/14-collaboration-and-library.jpg",
  },
  {
    id: "guidelines",
    number: "02",
    phase: "Plan",
    title: "Organize a guideline around PICO questions",
    summary:
      "Use a guideline hub for shared methods, coordination, references, and writing while each PICO question keeps a complete review workflow.",
    actions: [
      "Choose Guideline when creating the top-level project.",
      "Add each PICO question as a new review sub-project; members, review type, screening configuration, and the research question are initialized from the guideline.",
      "Use Add existing project to convert an eligible standalone review without recreating its citations, decisions, evidence, roles, or audit history.",
      "Draft general sections at the guideline level and PICO-specific sections inside each sub-project, then preview the compiled guideline.",
    ],
    remember:
      "References are shared across the guideline family. Full DOCX compilation requires access to every included PICO sub-project so a partial guideline is never exported silently.",
    image: "/guide/captures/15-guideline-hub.jpg",
  },
  {
    id: "collaboration",
    number: "03",
    phase: "Plan",
    title: "Coordinate in chat and assignments",
    summary:
      "Keep questions, decisions, direct messages, and accountable work beside the review instead of scattering them across separate tools.",
    actions: [
      "Use #general for team-wide coordination and create topic channels for focused discussions.",
      "Start direct messages when a conversation should be limited to selected project members.",
      "Use @mentions or @channel to notify the right people, and reply in a thread to keep a question together.",
      "Send an Assignment with assignees and an optional due date; each recipient marks their own task complete from the Assignments tab.",
    ],
    remember:
      "The notification bell collects mentions, direct messages, manuscript comments, and assignments across projects. Unread badges remain scoped to the projects you can access.",
    image: "/guide/captures/16-team-chat.jpg",
  },
  {
    id: "protocol",
    number: "04",
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
    number: "05",
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
    number: "06",
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
    number: "07",
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
    number: "08",
    phase: "Decide",
    title: "Retrieve and review full text",
    summary:
      "Use open-access and institutional routes, track every attempt, attach PDFs, and keep eligibility status and PRISMA reporting synchronized.",
    actions: [
      "Filter reports by retrieval or decision status to focus the queue.",
      "Run open-access PDF retrieval through Unpaywall and Europe PMC, or use the configured DOI, PubMed, and OpenURL library links.",
      "Record publisher, library, interlibrary-loan, or author-contact attempts.",
      "Upload the main PDF and preview it in the workspace.",
      "Complete assigned full-text decisions; included reports automatically create or join studies.",
    ],
    remember: "Mark a report Not retrievable explicitly so it appears in the correct PRISMA box.",
    image: "/guide/captures/06-fulltext.jpg",
  },
  {
    id: "extraction",
    number: "09",
    phase: "Extract",
    title: "Extract with evidence anchors",
    summary:
      "Publish typed forms, collect data in duplicate, resolve disagreements, and keep every value connected to its source.",
    actions: [
      "Build a draft template with text, number, date, select, multiselect, and boolean fields.",
      "Publish the template, assign extractors, and start one form per study and extractor.",
      "Run companion-report detection and link follow-up publications to the correct study before treating reports as independent cohorts.",
      "Capture a source quote and page, or select text directly in the PDF viewer; re-anchor an older quote when the source text has shifted.",
      "Use Table for the living matrix and Conflicts to adjudicate field-level disagreements.",
    ],
    remember: "Resolved data follows a fixed precedence: adjudicated, then consensus, then a single final value.",
    image: "/guide/captures/07-extraction.jpg",
  },
  {
    id: "risk-of-bias",
    number: "10",
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
    number: "11",
    phase: "Synthesize",
    title: "Pool outcomes and inspect uncertainty",
    summary:
      "Map finalized extraction fields to statistical roles and generate transparent, deterministic meta-analysis results.",
    actions: [
      "Create an outcome and choose RR, OR, RD, MD, SMD, proportion, or generic inverse variance.",
      "Map each required statistical role to a numeric extraction field, or scaffold a compatible outcome and fields from the analysis workspace.",
      "Compare fixed and random effects and inspect included, incomplete, disputed, and manually excluded studies.",
      "Download forest and funnel plots; review heterogeneity, prediction intervals, and small-study diagnostics where available.",
    ],
    remember: "Provisional values are visibly optional and remain hidden from users who must stay blinded.",
    image: "/guide/captures/09-analysis.jpg",
  },
  {
    id: "grade",
    number: "12",
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
    id: "references",
    number: "13",
    phase: "Report",
    title: "Build the reference library",
    summary:
      "Manage included studies, methods papers, and background sources in one citation library that feeds the manuscript and interoperates with reference managers.",
    actions: [
      "Import included studies from screening, or add a reference by DOI, PMID, pasted RIS/BibTeX, or manual entry.",
      "Tag and search records, then edit normalized metadata when a source needs correction.",
      "Preview the bibliography in Vancouver, AMA, APA, or NLM style.",
      "Export RIS, BibTeX, CSL-JSON, or formatted text for Word, Zotero, EndNote, Mendeley, and other tools.",
    ],
    remember:
      "A guideline and all of its PICO sub-projects use one shared reference library and one family-wide duplicate check.",
    image: "/guide/captures/17-reference-library.jpg",
  },
  {
    id: "manuscript",
    number: "14",
    phase: "Report",
    title: "Draft and review the manuscript",
    summary:
      "Write section by section with assignments, safe concurrent editing, citations, comments, version history, approval states, and DOCX export.",
    actions: [
      "Assign sections and use Draft, In review, and Approved states to make ownership and readiness visible.",
      "Select Edit to acquire the section lock; autosave and optimistic version checks protect another member's work.",
      "Insert project-library citations, discuss changes in comment threads, and use @mentions to notify collaborators.",
      "Review session versions and restore when needed, then export the manuscript as DOCX with its generated bibliography.",
    ],
    remember:
      "Approved sections are frozen until returned to draft. Guideline hubs can compile their general sections with every accessible PICO manuscript.",
    image: "/guide/captures/18-manuscript.jpg",
  },
  {
    id: "reporting",
    number: "15",
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
    access:
      "Full project control, chat administration and assignments, manuscript management, team roles, adjudication, exports, and audit.",
  },
  {
    role: "Reviewer",
    bestFor: "Title, abstract, and assigned full-text screening",
    access:
      "Assignment-gated screening, chat and notifications, reference and manuscript viewing, comments, and a blinding-aware audit view.",
  },
  {
    role: "Adjudicator",
    bestFor: "Resolving screening, extraction, and RoB disagreements",
    access:
      "Conflict resolution, full-text management, manuscript editing, chat, analysis viewing, and permitted audit history.",
  },
  {
    role: "Extractor",
    bestFor: "Structured data extraction and RoB assessment",
    access:
      "Assigned extraction and RoB work, the PDFs needed to complete it, chat, references, and manuscript comments.",
  },
  {
    role: "Statistician",
    bestFor: "Outcome mapping, meta-analysis, GRADE, and reporting",
    access:
      "Analysis and GRADE management, reference curation, manuscript editing, extraction templates, PRISMA snapshots, and exports.",
  },
  {
    role: "Librarian",
    bestFor: "Searches, imports, deduplication, and retrieval",
    access:
      "Protocol editing, imports, deduplication, full-text and reference management, manuscript editing, snapshots, and exports.",
  },
  {
    role: "Panel / Observer",
    bestFor: "Stakeholders who review findings",
    access:
      "Read-only evidence, analysis, references, manuscript, and permitted audit views, plus participation in project chat.",
  },
  {
    role: "Trainee",
    bestFor: "Supervised review work",
    access:
      "Assigned screening, extraction, RoB, and full-text tasks plus chat, references, and manuscript comments without project administration.",
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

const aiOverviewChapter: VideoChapter = {
  image: "../ai-insert/captures/02-ai-screening.jpg",
  label: "10 · Assist",
  title: "Optional AI, with people in control",
  subtitle: "Separate suggestions, source-linked evidence, and an auditable apply step",
  narration:
    "AI assistance in Synthesis is optional, and it is designed as a second set of eyes—not an automated decision-maker. During title-and-abstract screening, it can score and prioritize citations, then show reviewers a suggested decision and rationale. For extraction and risk of bias, it can read the linked PDF, propose values or domain judgments, and surface supporting quotes with page references. In GRADE, it can draft per-domain rationale from the current pooled results and protocol context. Suggestions stay separate from the authoritative record. A reviewer chooses what to apply, existing work is protected, and accepted changes follow the normal audit trail.",
};

export const updatedVideoChapters: VideoChapter[] = [
  ...videoChapters.slice(0, 10),
  aiOverviewChapter,
  { ...videoChapters[10]!, label: "11 · Synthesize" },
  { ...videoChapters[11]!, label: "12 · Report" },
  { ...videoChapters[12]!, label: "13 · Govern" },
  videoChapters[13]!,
];

export const currentFeatureVideoChapters: VideoChapter[] = [
  {
    image: "16-team-chat.jpg",
    label: "14 · Coordinate",
    title: "Chat, mentions, and accountable assignments",
    subtitle: "Channels, direct messages, threads, due dates, and per-person completion",
    narration:
      "Synthesis now keeps review coordination beside the evidence. Use project channels and direct messages for questions, mentions to bring in the right colleague, and assignment messages with due dates and per-person completion. Unread badges show where attention is needed without exposing another project's activity.",
  },
  {
    image: "21-notifications.jpg",
    label: "15 · Coordinate",
    title: "Notifications that lead back to the work",
    subtitle: "Direct messages, mentions, comments, and assignments in one inbox",
    narration:
      "The notification bell brings direct messages, manuscript mentions, and assigned work into one inbox. Each item links back to its project context, and read state stays synchronized as the team moves between conversations and evidence tasks.",
  },
  {
    image: "19-library-fulltext.jpg",
    label: "16 · Retrieve",
    title: "Open-access and institutional full-text routes",
    subtitle: "Unpaywall, Europe PMC, proxy links, OpenURL, and one retrieval history",
    narration:
      "Configure institutional proxy and OpenURL links once at the organization level. Each full-text record then offers DOI, PubMed, and library resolver routes. Owners can also run legal open-access retrieval through Unpaywall and Europe PMC, with successful files following the same validation and attempt history as manual uploads.",
  },
  {
    image: "17-reference-library.jpg",
    label: "17 · Cite",
    title: "A reference library connected to the manuscript",
    subtitle: "Included studies, external sources, formatted styles, and interoperable exports",
    narration:
      "The reference library brings included studies, methods papers, and background sources together. Add by DOI or PMID, paste RIS or BibTeX, or enter a record manually. Format Vancouver, AMA, APA, or NLM bibliographies and export to reference managers. A guideline family shares one library.",
  },
  {
    image: "18-manuscript.jpg",
    label: "18 · Write",
    title: "Collaborative manuscript drafting",
    subtitle: "Section ownership, safe editing, citations, comments, versions, and DOCX",
    narration:
      "Draft the manuscript section by section with assignments, editing locks, autosave, comments, mentions, version history, and approval states. Insert citations from the project library; the reference list follows first-use order and the selected style. Export the current manuscript as DOCX when the team is ready.",
  },
  {
    image: "15-guideline-hub.jpg",
    label: "19 · Scale",
    title: "Guidelines with complete PICO sub-reviews",
    subtitle: "Shared coordination and writing, with a full review workflow per question",
    narration:
      "For multi-question guidelines, create a guideline hub and add one full review for each PICO question. Teams can also convert an existing standalone review without recreating its evidence or history. The hub holds shared context, chat, references, and general manuscript sections, while each PICO keeps its complete review workflow.",
  },
  {
    image: "20-compiled-guideline.jpg",
    label: "20 · Publish",
    title: "One compiled guideline and bibliography",
    subtitle: "General sections, ordered PICO sections, complete-access checks, and DOCX",
    narration:
      "The compiled preview assembles the guideline's general sections followed by each PICO question, with one bibliography across the family. Full DOCX export is enabled only when the caller can read every included sub-project, so a partial guideline is never produced silently.",
  },
  {
    image: "15-guideline-hub.jpg",
    label: "Start here",
    title: "One workspace, from evidence to publication",
    subtitle: "Review, coordinate, cite, write, and scale to multi-question guidelines",
    narration:
      "That is the current Synthesis workspace: one connected system for evidence review, team coordination, reference management, manuscript development, and multi-question guidelines. Open the user guide for task-by-task instructions, role guidance, shortcuts, and troubleshooting.",
  },
];

export const currentVideoChapters: VideoChapter[] = [
  ...updatedVideoChapters.slice(0, -1),
  ...currentFeatureVideoChapters,
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
  {
    question: "What is the difference between an organization role and a project role?",
    answer:
      "Organization roles control workspace administration and invitations. Project roles grant capabilities inside a specific review. A workspace member can create and own a new project without receiving access to anyone else's existing project.",
  },
  {
    question: "Where do references live in a guideline?",
    answer:
      "The guideline and every PICO sub-project share one family-wide reference library. A librarian working through an authorized PICO can curate that shared pool, and the root guideline audit trail records the change.",
  },
  {
    question: "Why is full guideline export unavailable?",
    answer:
      "The exporter requires manuscript access to every PICO sub-project included in the compilation. This prevents an apparently complete DOCX from silently omitting a question the caller cannot read.",
  },
] as const;
