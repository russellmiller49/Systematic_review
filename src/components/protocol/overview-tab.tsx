"use client";

// Overview tab: the protocol's core narrative fields (PATCH /protocol).
// Only fields that actually changed are sent; the amendment gate handles the
// 422 that PATCH returns once screening has begun.

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiPatch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/misc";
import { Textarea } from "@/components/ui/textarea";
import type { AmendmentGate } from "./amendment-gate";
import type { AmendmentFields, ProtocolDetail } from "./types";
import { toNullableText } from "./types";

const TEXT_KEYS = [
  "background",
  "reviewQuestion",
  "population",
  "intervention",
  "comparator",
  "outcomesNarrative",
  "setting",
  "searchStrategyNotes",
  "subgroupAnalysisPlan",
  "sensitivityAnalysisPlan",
  "metaAnalysisPlan",
  "gradePlan",
] as const;
const LIST_KEYS = ["studyDesigns", "languageRestrictions", "databases", "grayLiteratureSources"] as const;
const YEAR_KEYS = ["dateRestrictionFrom", "dateRestrictionTo"] as const;

type TextKey = (typeof TEXT_KEYS)[number];
type ListKey = (typeof LIST_KEYS)[number];
type YearKey = (typeof YEAR_KEYS)[number];
type FormKey = TextKey | ListKey | YearKey;
type OverviewForm = Record<FormKey, string>;

type ProtocolPatch = AmendmentFields &
  Partial<Record<TextKey, string | null>> &
  Partial<Record<ListKey, string[]>> &
  Partial<Record<YearKey, number | null>>;

function buildForm(p: ProtocolDetail): OverviewForm {
  const form = {} as OverviewForm;
  for (const key of TEXT_KEYS) form[key] = p[key] ?? "";
  for (const key of LIST_KEYS) form[key] = p[key].join("\n");
  for (const key of YEAR_KEYS) form[key] = p[key] === null ? "" : String(p[key]);
  return form;
}

function toLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildPatch(
  p: ProtocolDetail,
  form: OverviewForm,
): { patch: ProtocolPatch; error: string | null } {
  const patch: ProtocolPatch = {};
  let error: string | null = null;
  for (const key of TEXT_KEYS) {
    const next = toNullableText(form[key]);
    if ((p[key] ?? null) !== next) patch[key] = next;
  }
  for (const key of LIST_KEYS) {
    const next = toLines(form[key]);
    if (JSON.stringify(p[key]) !== JSON.stringify(next)) patch[key] = next;
  }
  for (const key of YEAR_KEYS) {
    const raw = form[key].trim();
    let next: number | null = null;
    if (raw) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1000 || n > 9999) {
        error = "Publication year restrictions must be four-digit years (1000–9999).";
        continue;
      }
      next = n;
    }
    if ((p[key] ?? null) !== next) patch[key] = next;
  }
  return { patch, error };
}

function TextAreaField({
  id,
  label,
  value,
  onChange,
  rows = 3,
  hint,
  placeholder,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  hint?: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function OverviewTab({
  projectId,
  protocol,
  gate,
  onChanged,
}: {
  projectId: string;
  protocol: ProtocolDetail;
  gate: AmendmentGate;
  onChanged: () => void;
}) {
  const [form, setForm] = useState<OverviewForm>(() => buildForm(protocol));
  const [busy, setBusy] = useState(false);

  // Re-sync after saves (parent reloads protocol) or edits made from other tabs.
  useEffect(() => {
    setForm(buildForm(protocol));
  }, [protocol]);

  const dirty = useMemo(() => {
    const { patch, error } = buildPatch(protocol, form);
    return error !== null || Object.keys(patch).length > 0;
  }, [protocol, form]);

  const setField = (key: FormKey) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function save() {
    const { patch, error } = buildPatch(protocol, form);
    if (error) {
      toast.error(error);
      return;
    }
    if (Object.keys(patch).length === 0) return;
    setBusy(true);
    await gate.guard("Update protocol details", async (fields) => {
      await apiPatch(`/api/projects/${projectId}/protocol`, { ...patch, ...fields });
      toast.success("Protocol updated");
      onChanged();
    });
    setBusy(false);
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Background &amp; objectives</CardTitle>
          <CardDescription>Rationale for the review and the question it answers.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <TextAreaField
            id="ov-background"
            label="Background"
            rows={6}
            value={form.background}
            onChange={setField("background")}
          />
          <TextAreaField
            id="ov-review-question"
            label="Review question"
            rows={3}
            value={form.reviewQuestion}
            onChange={setField("reviewQuestion")}
            placeholder="What is the effect of X compared with Y on Z in …?"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scope</CardTitle>
          <CardDescription>
            Narrative PICO and study scope. Add structured entries in the PICO tab and formal
            eligibility rules in the Criteria tab.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 lg:grid-cols-2">
          <TextAreaField
            id="ov-population"
            label="Population"
            value={form.population}
            onChange={setField("population")}
          />
          <TextAreaField
            id="ov-intervention"
            label="Intervention / exposure"
            value={form.intervention}
            onChange={setField("intervention")}
          />
          <TextAreaField
            id="ov-comparator"
            label="Comparator"
            value={form.comparator}
            onChange={setField("comparator")}
          />
          <TextAreaField
            id="ov-outcomes-narrative"
            label="Outcomes (narrative)"
            value={form.outcomesNarrative}
            onChange={setField("outcomesNarrative")}
            hint="Free-text summary — define measurable outcomes in the Outcomes tab."
          />
          <TextAreaField
            id="ov-study-designs"
            label="Study designs"
            value={form.studyDesigns}
            onChange={setField("studyDesigns")}
            hint="One design per line, e.g. RCT."
          />
          <TextAreaField
            id="ov-setting"
            label="Setting"
            rows={2}
            value={form.setting}
            onChange={setField("setting")}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Search strategy</CardTitle>
          <CardDescription>Planned sources and restrictions for the literature search.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 lg:grid-cols-2">
          <TextAreaField
            id="ov-databases"
            label="Databases"
            rows={4}
            value={form.databases}
            onChange={setField("databases")}
            hint="One per line, e.g. PubMed, Embase, CENTRAL."
          />
          <TextAreaField
            id="ov-gray-lit"
            label="Gray literature sources"
            rows={4}
            value={form.grayLiteratureSources}
            onChange={setField("grayLiteratureSources")}
            hint="One per line, e.g. trial registries, conference abstracts."
          />
          <TextAreaField
            id="ov-languages"
            label="Language restrictions"
            value={form.languageRestrictions}
            onChange={setField("languageRestrictions")}
            hint="One per line — leave empty for no restriction."
          />
          <div className="space-y-1.5">
            <Label htmlFor="ov-year-from">Publication years</Label>
            <div className="flex items-center gap-2">
              <Input
                id="ov-year-from"
                type="number"
                min={1000}
                max={9999}
                placeholder="From, e.g. 2000"
                value={form.dateRestrictionFrom}
                onChange={(e) => setField("dateRestrictionFrom")(e.target.value)}
              />
              <span className="text-sm text-muted-foreground">to</span>
              <Input
                id="ov-year-to"
                type="number"
                min={1000}
                max={9999}
                placeholder="To"
                aria-label="Publication year to"
                value={form.dateRestrictionTo}
                onChange={(e) => setField("dateRestrictionTo")(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">Leave empty for no restriction.</p>
          </div>
          <TextAreaField
            id="ov-search-notes"
            label="Search strategy notes"
            rows={4}
            value={form.searchStrategyNotes}
            onChange={setField("searchStrategyNotes")}
            className="lg:col-span-2"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Analysis plans</CardTitle>
          <CardDescription>Pre-specified synthesis, subgroup and certainty plans.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 lg:grid-cols-2">
          <TextAreaField
            id="ov-meta-plan"
            label="Meta-analysis plan"
            rows={4}
            value={form.metaAnalysisPlan}
            onChange={setField("metaAnalysisPlan")}
          />
          <TextAreaField
            id="ov-grade-plan"
            label="GRADE / certainty of evidence plan"
            rows={4}
            value={form.gradePlan}
            onChange={setField("gradePlan")}
          />
          <TextAreaField
            id="ov-subgroup-plan"
            label="Subgroup analyses"
            rows={4}
            value={form.subgroupAnalysisPlan}
            onChange={setField("subgroupAnalysisPlan")}
          />
          <TextAreaField
            id="ov-sensitivity-plan"
            label="Sensitivity analyses"
            rows={4}
            value={form.sensitivityAnalysisPlan}
            onChange={setField("sensitivityAnalysisPlan")}
          />
        </CardContent>
      </Card>

      <div className="sticky bottom-0 z-10 flex items-center justify-end gap-3 border-t border-border bg-background/95 py-3 backdrop-blur">
        {dirty && <span className="text-sm text-muted-foreground">Unsaved changes</span>}
        <Button
          variant="outline"
          onClick={() => setForm(buildForm(protocol))}
          disabled={!dirty || busy}
        >
          Discard
        </Button>
        <Button onClick={() => void save()} disabled={!dirty || busy}>
          {busy && <Spinner />} Save changes
        </Button>
      </div>
    </div>
  );
}
