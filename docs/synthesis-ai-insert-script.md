# Synthesis overview — AI assistance insert

This optional insert adds a concise explanation of Synthesis's implemented AI features without
changing the current overview. It is designed to be recorded separately and spliced into the
existing video.

## Edit placement

- **Insert after:** Human-reviewed GRADE.
- **Source cut:** `02:59.334`, immediately before Summary of Findings.
- **Target duration:** 44 seconds.
- **New estimated total runtime:** 4:38.
- **Transition in:** use the existing chapter fade, then show `AI assistance · Humans stay in
  control`.
- **Transition out:** fade directly into the existing Summary of Findings chapter.

## Voice direction

Warm, plainspoken, and reassuring. This section should sound like a candid explanation of where
AI helps and where it deliberately stops. Give a small pause before “not an automated
decision-maker” and emphasize “a reviewer chooses.”

## Timed narration and shot list

### 00:00–00:07 — Principle

**Visual:** Product screen with a simple title overlay: `AI assistance · Humans stay in control`.

AI assistance in Synthesis is optional, and it is designed as a second set of eyes—not an
automated decision-maker.

### 00:07–00:16 — Screening

**Visual:** Title-and-abstract screening queue. Highlight the AI likelihood score, suggested
decision, rationale, and the separate human Include, Exclude, and Maybe controls.

During title-and-abstract screening, it can score and prioritize citations, then show reviewers a
suggested decision and rationale.

### 00:16–00:27 — Extraction and risk of bias

**Visual:** Move from an extraction suggestion with its quoted source and page number to a
risk-of-bias domain suggestion with supporting evidence.

For extraction and risk of bias, it can read the linked PDF, propose values or domain judgments,
and surface supporting quotes with page references.

### 00:27–00:34 — GRADE

**Visual:** GRADE domain card with the AI suggestion, rationale, confidence, and Apply control.

In GRADE, it can draft per-domain rationale from the current pooled results and protocol context.

### 00:34–00:44 — Safeguards

**Visual:** Hold on the Apply control, then show the audit trail. End with the on-screen line:
`Suggestions are separate · People decide · Accepted work is traceable`.

Suggestions stay separate from the authoritative record. A reviewer chooses what to apply,
existing work is protected, and accepted changes follow the normal audit trail.

## Accuracy notes for the edit

- AI is optional and appears only when a supported provider is configured on the server.
- Screening AI can score, rank, and explain, but it never creates a screening decision.
- Extraction suggestions can include confidence, quoted evidence, page numbers, and evidence
  anchors. Bulk apply fills only empty fields; it does not overwrite entered values.
- Risk-of-bias suggestions can include domain judgments, rationales, signaling answers, and
  supporting quotes. The assessor applies or dismisses each suggestion.
- GRADE AI drafts per-domain prose suggestions. It does not control deterministic certainty
  arithmetic, and a person must apply and review the judgment.
- Source-version and freshness checks prevent obsolete suggestions from silently becoming the
  authoritative result.

## Caption cues for the standalone insert

```text
00:00:00.080 --> 00:00:07.000
AI assistance in Synthesis is optional, and it is designed as a second set of eyes—not an automated decision-maker.

00:00:07.000 --> 00:00:16.000
During title-and-abstract screening, it can score and prioritize citations, then show reviewers a suggested decision and rationale.

00:00:16.000 --> 00:00:27.000
For extraction and risk of bias, it can read the linked PDF, propose values or domain judgments, and surface supporting quotes with page references.

00:00:27.000 --> 00:00:34.000
In GRADE, it can draft per-domain rationale from the current pooled results and protocol context.

00:00:34.000 --> 00:00:43.800
Suggestions stay separate from the authoritative record. A reviewer chooses what to apply, existing work is protected, and accepted changes follow the normal audit trail.
```

## Revised downstream timestamps

After inserting exactly 44 seconds at `02:59.334`, the existing chapters move to:

| Chapter | New start |
| --- | ---: |
| Summary of Findings | 03:43.334 |
| PRISMA | 03:56.203 |
| Audit trail | 04:07.827 |
| Closing | 04:22.670 |
| New video end | 04:37.731 |
