"use client";

// "Generate outcome fields" — scaffolds a measure's NUMBER fields onto a DRAFT
// template plus the matching analysis outcome and its role mappings, in one server
// transaction (POST /analysis/scaffold; analysis.manage + extraction.templates).

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiPost } from "@/lib/api";
import {
  apiErrorMessages,
  MEASURE_OPTIONS,
  PROPORTION_TRANSFORM_LABELS,
  type EffectDirection,
  type EffectMeasure,
  type ProportionTransform,
} from "@/components/analysis/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, Spinner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import type { Template } from "./types";

const KEY_PREFIX_RE = /^[a-z][a-z0-9_]*$/;

// Mirrors scaffoldFieldSpecs in src/server/services/analysis/scaffold.ts (preview only —
// the server is authoritative).
const KEY_SUFFIXES: Record<EffectMeasure, string[]> = {
  RR: ["g1_events", "g1_total", "g2_events", "g2_total"],
  OR: ["g1_events", "g1_total", "g2_events", "g2_total"],
  RD: ["g1_events", "g1_total", "g2_events", "g2_total"],
  MD: ["g1_mean", "g1_sd", "g1_n", "g2_mean", "g2_sd", "g2_n"],
  SMD: ["g1_mean", "g1_sd", "g1_n", "g2_mean", "g2_sd", "g2_n"],
  PROPORTION: ["g1_events", "g1_total"],
  GENERIC_IV: ["effect_estimate", "effect_se", "effect_ci_low", "effect_ci_up"],
};

/** "All-cause mortality (12 mo)" -> "all_cause_mortality_12_mo" (valid field-key prefix). */
function suggestKeyPrefix(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^[^a-z]+|_+$/g, "")
    .slice(0, 40);
  return slug || "outcome";
}

export function ScaffoldOutcomeDialog({
  projectId,
  template,
  open,
  onOpenChange,
  onScaffolded,
}: {
  projectId: string;
  template: Template;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onScaffolded: () => void;
}) {
  const [name, setName] = useState("");
  const [measure, setMeasure] = useState<EffectMeasure>("RR");
  const [keyPrefix, setKeyPrefix] = useState("");
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [timepoint, setTimepoint] = useState("");
  const [direction, setDirection] = useState<EffectDirection>("LOWER_IS_BETTER");
  const [transform, setTransform] = useState<ProportionTransform>("LOGIT");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setName("");
    setMeasure("RR");
    setKeyPrefix("");
    setPrefixTouched(false);
    setTimepoint("");
    setDirection("LOWER_IS_BETTER");
    setTransform("LOGIT");
    setErrors([]);
  }, [open]);

  // Auto-suggest the key prefix from the name until the user edits it themselves.
  function onNameChange(next: string) {
    setName(next);
    if (!prefixTouched) setKeyPrefix(suggestKeyPrefix(next));
  }

  const effectivePrefix = keyPrefix.trim();
  const prefixValid = KEY_PREFIX_RE.test(effectivePrefix);
  const previewKeys = useMemo(
    () => KEY_SUFFIXES[measure].map((suffix) => `${effectivePrefix || "…"}_${suffix}`),
    [measure, effectivePrefix],
  );
  const collisions = useMemo(() => {
    const existing = new Set(template.fields.map((f) => f.key));
    return previewKeys.filter((key) => existing.has(key));
  }, [previewKeys, template.fields]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || !prefixValid) return;
    setBusy(true);
    setErrors([]);
    try {
      await apiPost(`/api/projects/${projectId}/analysis/scaffold`, {
        templateId: template.id,
        measure,
        name: trimmedName,
        keyPrefix: effectivePrefix,
        ...(timepoint.trim() ? { timepoint: timepoint.trim() } : {}),
        direction,
        ...(measure === "PROPORTION" ? { proportionTransform: transform } : {}),
      });
      toast.success(
        `Outcome "${trimmedName}" created with ${previewKeys.length} fields on ${template.name}`,
      );
      onOpenChange(false);
      onScaffolded();
    } catch (err) {
      setErrors(apiErrorMessages(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Generate outcome fields</DialogTitle>
          <DialogDescription>
            Adds the NUMBER fields this measure needs to draft template &ldquo;{template.name}
            &rdquo; (v{template.version}), creates the analysis outcome, and maps the fields to
            its statistical roles — all in one step.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          {errors.length > 0 && (
            <Alert variant="error">
              <ul className="list-inside list-disc space-y-0.5">
                {errors.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </Alert>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="so-name">Outcome name</Label>
            <Input
              id="so-name"
              required
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="e.g. Pneumothorax rate"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="so-measure">Effect measure</Label>
              <Select
                id="so-measure"
                value={measure}
                onChange={(e) => setMeasure(e.target.value as EffectMeasure)}
              >
                {MEASURE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="so-timepoint">Timepoint (optional)</Label>
              <Input
                id="so-timepoint"
                value={timepoint}
                onChange={(e) => setTimepoint(e.target.value)}
                placeholder="e.g. 12 months"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="so-direction">Direction</Label>
              <Select
                id="so-direction"
                value={direction}
                onChange={(e) => setDirection(e.target.value as EffectDirection)}
              >
                <option value="LOWER_IS_BETTER">Lower is better (e.g. mortality)</option>
                <option value="HIGHER_IS_BETTER">Higher is better (e.g. cure)</option>
              </Select>
            </div>
            {measure === "PROPORTION" && (
              <div className="space-y-1.5">
                <Label htmlFor="so-transform">Proportion transform</Label>
                <Select
                  id="so-transform"
                  value={transform}
                  onChange={(e) => setTransform(e.target.value as ProportionTransform)}
                >
                  {(Object.keys(PROPORTION_TRANSFORM_LABELS) as ProportionTransform[]).map(
                    (t) => (
                      <option key={t} value={t}>
                        {PROPORTION_TRANSFORM_LABELS[t]}
                      </option>
                    ),
                  )}
                </Select>
              </div>
            )}
          </div>
          {measure === "GENERIC_IV" && (
            <p className="text-xs text-muted-foreground">
              Extractors enter estimates on the pooling scale (log-transform ratio measures
              first) plus a standard error or both 95% CI bounds.
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="so-prefix">Field key prefix</Label>
            <Input
              id="so-prefix"
              required
              value={keyPrefix}
              onChange={(e) => {
                setPrefixTouched(true);
                setKeyPrefix(e.target.value);
              }}
              placeholder="e.g. pneumothorax"
            />
            {!prefixValid && effectivePrefix !== "" && (
              <p className="text-xs text-exclude">
                Must start with a lowercase letter and use only a–z, 0–9, _.
              </p>
            )}
            <p className="font-mono text-xs text-muted-foreground">{previewKeys.join(", ")}</p>
            {collisions.length > 0 && (
              <p className="text-xs text-exclude">
                Already on this template: {collisions.join(", ")} — pick a different prefix.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || !name.trim() || !prefixValid || collisions.length > 0}
            >
              {busy && <Spinner />} Generate fields
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
