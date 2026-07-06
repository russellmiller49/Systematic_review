"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/misc";

const REVIEW_TYPES = [
  ["SYSTEMATIC_REVIEW", "Systematic review"],
  ["SYSTEMATIC_REVIEW_META_ANALYSIS", "Systematic review with meta-analysis"],
  ["DIAGNOSTIC_TEST_ACCURACY", "Diagnostic test accuracy review"],
  ["SCOPING_REVIEW", "Scoping review"],
  ["RAPID_REVIEW", "Rapid review"],
  ["LIVING_SYSTEMATIC_REVIEW", "Living systematic review"],
  ["GUIDELINE_EVIDENCE_REVIEW", "Guideline evidence review"],
] as const;

export function NewProjectDialog({ orgId, onCreated }: { orgId: string; onCreated?: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    title: "",
    reviewType: "SYSTEMATIC_REVIEW",
    researchQuestion: "",
    description: "",
    registrationPlatform: "",
    registrationId: "",
    dualScreening: true,
    reviewersPerCitation: 2,
    blindedScreening: true,
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const project = await apiPost<{ id: string }>(`/api/orgs/${orgId}/projects`, {
        title: form.title,
        reviewType: form.reviewType,
        researchQuestion: form.researchQuestion || undefined,
        description: form.description || undefined,
        registrationPlatform: form.registrationPlatform || undefined,
        registrationId: form.registrationId || undefined,
        dualScreening: form.dualScreening,
        reviewersPerCitation: form.dualScreening ? form.reviewersPerCitation : 1,
        blindedScreening: form.blindedScreening,
      });
      toast.success("Project created");
      setOpen(false);
      onCreated?.();
      router.push(`/projects/${project.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to create project");
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> New project
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create a review project</DialogTitle>
          <DialogDescription>
            Screening settings can be changed later until screening begins.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="p-title">Project title</Label>
            <Input
              id="p-title"
              required
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="e.g. Bronchoscopic lung volume reduction in severe emphysema"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-type">Review type</Label>
            <Select
              id="p-type"
              value={form.reviewType}
              onChange={(e) => set("reviewType", e.target.value)}
            >
              {REVIEW_TYPES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-q">Research question</Label>
            <Textarea
              id="p-q"
              value={form.researchQuestion}
              onChange={(e) => set("researchQuestion", e.target.value)}
              placeholder="In adults with X, does Y compared with Z improve ...?"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-desc">Description</Label>
            <Textarea
              id="p-desc"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="p-reg">Registration platform</Label>
              <Input
                id="p-reg"
                value={form.registrationPlatform}
                onChange={(e) => set("registrationPlatform", e.target.value)}
                placeholder="PROSPERO"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-regid">Registration ID</Label>
              <Input
                id="p-regid"
                value={form.registrationId}
                onChange={(e) => set("registrationId", e.target.value)}
                placeholder="CRD42026..."
              />
            </div>
          </div>

          <fieldset className="space-y-3 rounded-md border border-border p-4">
            <legend className="px-1 text-sm font-medium">Screening settings</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--color-primary)]"
                checked={form.dualScreening}
                onChange={(e) => set("dualScreening", e.target.checked)}
              />
              Dual screening (two or more independent reviewers per citation)
            </label>
            {form.dualScreening && (
              <div className="space-y-1.5 pl-6">
                <Label htmlFor="p-rev">Reviewers per citation</Label>
                <Select
                  id="p-rev"
                  className="w-24"
                  value={String(form.reviewersPerCitation)}
                  onChange={(e) => set("reviewersPerCitation", Number(e.target.value))}
                >
                  <option value="2">2</option>
                  <option value="3">3</option>
                </Select>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--color-primary)]"
                checked={form.blindedScreening}
                onChange={(e) => set("blindedScreening", e.target.checked)}
              />
              Blinded screening (reviewers cannot see each other&apos;s decisions)
            </label>
          </fieldset>

          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy && <Spinner />} Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
