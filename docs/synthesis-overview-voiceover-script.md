# Synthesis product overview — voiceover script

This is the base narration used by the original 3:53 product overview. The public guide now uses
the 7:27 current-product render in `public/guide/synthesis-current-overview.mp4`. It preserves the
stabilized overview through the audit-trail chapter, replaces the former closing, and adds team
chat, notifications, institutional/open-access retrieval, references, manuscript drafting,
guideline PICO sub-reviews, and compiled-guideline export.

Exact current timings live in `synthesis-current-overview.en.vtt` and
`synthesis-current-overview.chapters.vtt`; hashes and scene boundaries live in
`synthesis-current-overview.manifest.json`. The base timings below preserve the original
recording reference, followed by the current feature extension.

## Voice direction

- **Tone:** warm, calm, capable, and conversational—an experienced research colleague giving
  someone a tour, not a commercial announcer.
- **Energy:** confident but unhurried. Let the workflow feel manageable.
- **Pacing:** target the chapter durations below. Use short natural pauses between sentences and
  a slightly longer pause at each chapter change.
- **Emphasis:** favor the user benefit at the end of each chapter: traceability, human review,
  consistency, or defensibility.
- **Technical lists:** group related terms into phrases instead of reading every item with equal
  emphasis.

## Pronunciation guide

| Term | Suggested pronunciation |
| --- | --- |
| Synthesis | **SIN-thuh-sis** |
| PICO | **PIE-coh** |
| RIS | **R-I-S** |
| BibTeX | **BIB-tek** |
| NBIB | **EN-bib** |
| DOI | **D-O-I** |
| PMID | **P-M-I-D** |
| RoB 2 | **risk of bias two** |
| ROBINS-I | **ROB-ins eye** |
| QUADAS-2 | **KWA-das two** |
| Newcastle–Ottawa | **NEW-cass-uhl Ottawa** |
| JBI | **J-B-I** |
| AMSTAR 2 | **AM-star two** |
| GRADE | **grade** |
| PRISMA | **PRIZ-muh** |
| CSV / SVG / PNG | Say each letter individually |

## Timed transcript

### 00:00–00:17 — Overview: From question to certainty

*Delivery: welcoming; slight pause after “Synthesis.”*

Welcome to Synthesis, a traceable workspace for systematic reviews and meta-analyses.

This overview follows a review from its protocol through screening, synthesis, and reporting.

What you see is the seeded demonstration project, using the same workflows your team will use.

### 00:17–00:39 — Plan: A versioned protocol

*Delivery: reassuring and methodical.*

Start by creating a project and assigning team roles.

In Protocol, record the review question, narrative and structured PICO, eligibility criteria,
outcomes, search plan, exclusion reasons, and analysis plan.

Publish a version before screening.

Later edits require an amendment note, so the methods history remains visible.

### 00:39–00:54 — Find: Source-aware citation imports

*Delivery: make the file-format list feel light rather than technical.*

Add each database as a source, then upload RIS, BibTeX, CSV, or NBIB exports.

Synthesis previews every record and preserves parse errors before you commit a batch.

The project always knows where each citation came from.

### 00:54–01:08 — Find: Human-reviewed deduplication

*Delivery: emphasize that the person stays in control.*

Run duplicate detection before screening.

Exact DOI and PMID matches sit alongside title-based suggestions for human review.

Merge a pair, reject it, or undo a merge later; the original provenance is retained.

### 01:08–01:30 — Decide: Fast, blinded screening

*Delivery: slightly more energetic for the keyboard workflow.*

Assign title-and-abstract and full-text work to one or more reviewers.

The queue is keyboard first: I includes, E excludes, M marks maybe, N opens a note, and J skips.

When blinding is enabled, reviewers cannot see one another's decisions.

Disagreements become conflicts for an adjudicator, while agreed decisions advance automatically.

### 01:30–01:46 — Decide: Full-text retrieval in context

*Delivery: steady; emphasize consistency at the end.*

The full-text workspace tracks retrieval attempts, attached PDFs, and screening status together.

Included reports advance to studies.

A full-text exclusion must use a configured reason, keeping PRISMA counts and exclusion tables
consistent.

### 01:46–02:05 — Extract: A living extraction table

*Delivery: pause briefly after each precedence level.*

Build a typed, versioned extraction template, publish it, and assign extractors.

The living table resolves values in a clear order: adjudicated first, then consensus, then a
single completed value.

Evidence anchors reopen the exact supporting page and quote, and CSV export is always close at
hand.

### 02:05–02:25 — Extract: Risk of bias, study by study

*Delivery: articulate the instrument names without rushing.*

For risk of bias, clone a standard instrument or build your own.

Synthesis includes RoB 2, ROBINS-I, QUADAS-2, Newcastle-Ottawa, JBI, and AMSTAR 2.

Reviewers assess domains independently; the traffic-light summary shows agreement,
disagreements, and adjudicated judgments.

### 02:25–02:44 — Synthesize: Analysis that stays connected

*Delivery: confident and precise; land on “called out.”*

Map extraction fields to an outcome once, and pooled results refresh as finalized evidence
changes.

Fixed and random effects, forest plots, prediction intervals, funnel plots, and small-study
diagnostics are generated from deterministic statistical code, with incomplete or excluded
studies called out.

### 02:44–02:59 — Synthesize: Human-reviewed GRADE

*Delivery: emphasize “human-editable” and “current.”*

On the GRADE tab, Synthesis drafts five certainty domains from the pooled evidence and
risk-of-bias results.

Every judgment and rationale stays human-editable.

Mark an assessment reviewed only when the evidence is current; source changes flag it as stale.

> **Optional AI feature insert:** splice the 44-second segment in
> `docs/synthesis-ai-insert-script.md` here, immediately before Summary of Findings. This is a
> clean chapter boundary at 02:59.334 in the current video.

### 02:59–03:12 — Synthesize: Summary of Findings

*Delivery: keep the list flowing as a single idea.*

The Summary of Findings brings together study counts, participants, relative effects,
anticipated absolute effects, and certainty.

Download the table as CSV when it is ready for your report.

### 03:12–03:24 — Report: PRISMA that updates itself

*Delivery: give “computed live” a little emphasis.*

PRISMA counts are computed live from the same decisions that drive the workflow.

Save a frozen snapshot for a submission, and download the publication-ready flow diagram as SVG
or PNG.

### 03:24–03:39 — Govern: A defensible audit trail

*Delivery: deliberate and authoritative.*

Finally, the audit trail records who changed what, when, and why.

Role-aware filtering preserves reviewer blinding.

Together with capability-gated exports, it gives the review a defensible chain from source record
to final conclusion.

### 03:39–03:54 — Closing: Build the review, not the spreadsheet maze

*Delivery: warm conclusion; invite rather than sell.*

That is Synthesis: one connected workspace for planning, screening, extraction, risk assessment,
synthesis, and reporting.

Open the user guide for task-by-task instructions, role guidance, shortcuts, and troubleshooting.

## Current feature extension

The current render keeps the original overview through `04:55.267`, then uses this replacement
sequence. Spoken copy is also the source for the on-page transcript in
`src/content/user-guide.ts`.

### 04:55–05:13 — Coordinate: Chat, mentions, and accountable assignments

Synthesis now keeps review coordination beside the evidence. Use project channels and direct
messages for questions, mentions to bring in the right colleague, and assignment messages with
due dates and per-person completion. Unread badges show where attention is needed without
exposing another project's activity.

### 05:13–05:29 — Coordinate: Notifications that lead back to the work

The notification bell brings direct messages, manuscript mentions, and assigned work into one
inbox. Each item links back to its project context, and read state stays synchronized as the team
moves between conversations and evidence tasks.

### 05:29–05:50 — Retrieve: Open-access and institutional full-text routes

Configure institutional proxy and OpenURL links once at the organization level. Each full-text
record then offers DOI, PubMed, and library resolver routes. Owners can also run legal
open-access retrieval through Unpaywall and Europe PMC, with successful files following the same
validation and attempt history as manual uploads.

### 05:50–06:11 — Cite: A reference library connected to the manuscript

The reference library brings included studies, methods papers, and background sources together.
Add by DOI or PMID, paste RIS or BibTeX, or enter a record manually. Format Vancouver, AMA, APA,
or NLM bibliographies and export to reference managers. A guideline family shares one library.

### 06:11–06:31 — Write: Collaborative manuscript drafting

Draft the manuscript section by section with assignments, editing locks, autosave, comments,
mentions, version history, and approval states. Insert citations from the project library; the
reference list follows first-use order and the selected style. Export the current manuscript as
DOCX when the team is ready.

### 06:31–06:52 — Scale: Guidelines with complete PICO sub-reviews

For multi-question guidelines, create a guideline hub and add one full review for each PICO
question. Teams can also convert an existing standalone review without recreating its evidence
or history. The hub holds shared context, chat, references, and general manuscript sections,
while each PICO keeps its complete review workflow.

### 06:52–07:09 — Publish: One compiled guideline and bibliography

The compiled preview assembles the guideline's general sections followed by each PICO question,
with one bibliography across the family. Full DOCX export is enabled only when the caller can
read every included sub-project, so a partial guideline is never produced silently.

### 07:09–07:27 — Closing: One workspace, from evidence to publication

That is the current Synthesis workspace: one connected system for evidence review, team
coordination, reference management, manuscript development, and multi-question guidelines. Open
the user guide for task-by-task instructions, role guidance, shortcuts, and troubleshooting.

## Recording handoff

For the easiest replacement, record each chapter as a separate mono WAV or AIFF file at 48 kHz.
Leave roughly half a second of clean room tone after each chapter. If a natural reading runs
longer than the allotted chapter, keep the comfortable delivery and re-time the corresponding
slide rather than speeding up the voice.
