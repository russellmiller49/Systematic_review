"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Layers3, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, apiDelete, apiPut, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Alert, Skeleton, Spinner } from "@/components/ui/misc";
import type { GuidelineScreeningConfiguration } from "@/components/screening/types";

function toggleId(current: Set<string>, id: string) {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function ScreeningPoolSection({
  guidelineId,
  canManage,
}: {
  guidelineId: string;
  canManage: boolean;
}) {
  const [configuration, setConfiguration] =
    useState<GuidelineScreeningConfiguration | null>(null);
  const [name, setName] = useState("Combined abstract screening");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api<GuidelineScreeningConfiguration>(
        `/api/projects/${guidelineId}/screening/pool`,
      );
      setConfiguration(next);
      setName(next.pool?.name ?? "Combined abstract screening");
      setSelected(
        new Set(next.pool?.picos.map((pico) => pico.id) ?? next.allPicos.map((pico) => pico.id)),
      );
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to load screening pool");
      setConfiguration({
        guideline: { id: guidelineId, title: "Guideline" },
        pool: null,
        allPicos: [],
        unpooledPicos: [],
      });
    }
  }, [guidelineId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedPicos = useMemo(
    () => configuration?.allPicos.filter((pico) => selected.has(pico.id)) ?? [],
    [configuration, selected],
  );
  const dirty = Boolean(
    configuration &&
      (name.trim() !== (configuration.pool?.name ?? "Combined abstract screening") ||
        selectedPicos.map((pico) => pico.id).join(":") !==
          (configuration.pool?.picos.map((pico) => pico.id).join(":") ?? "")),
  );

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (selectedPicos.length < 2) {
      toast.error("Choose at least two PICO questions for the combined pool");
      return;
    }
    setBusy(true);
    try {
      await apiPut(`/api/projects/${guidelineId}/screening/pool`, {
        name: name.trim(),
        projectIds: selectedPicos.map((pico) => pico.id),
      });
      toast.success(configuration?.pool ? "Screening pool updated" : "Screening pool created");
      await load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to save screening pool");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await apiDelete(`/api/projects/${guidelineId}/screening/pool`);
      toast.success("Combined pool removed; its PICOs now use individual screening queues");
      setDeleteOpen(false);
      await load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to remove screening pool");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">Combined abstract screening</h2>
      {!configuration ? (
        <Skeleton className="h-72" />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers3 className="h-4 w-4" /> Named PICO pool
            </CardTitle>
            <CardDescription>
              {canManage
                ? "Choose which PICO questions share one title-and-abstract queue. Reviewers see this saved name and cannot change its membership."
                : "Only project owners and admins can change this saved screening pool."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!canManage ? (
              configuration.pool ? (
                <div className="space-y-3">
                  <p className="font-medium">{configuration.pool.name}</p>
                  <div className="flex flex-wrap gap-2">
                    {configuration.pool.picos.map((pico) => (
                      <Badge key={pico.id} variant="secondary">
                        PICO {pico.picoNumber} · {pico.title}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No combined pool is configured.</p>
              )
            ) : configuration.allPicos.length < 2 ? (
              <Alert variant="warning">
                Add at least two PICO questions before creating a combined screening pool.
              </Alert>
            ) : (
              <form className="space-y-4" onSubmit={save}>
                <div className="space-y-1.5">
                  <Label htmlFor="screening-pool-name">Pool name</Label>
                  <Input
                    id="screening-pool-name"
                    required
                    minLength={2}
                    maxLength={120}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="e.g. Shared mTEF abstract screen"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>
                    PICO questions{" "}
                    <span className="font-normal text-muted-foreground">
                      ({selectedPicos.length} combined; {configuration.allPicos.length - selectedPicos.length} individual)
                    </span>
                  </Label>
                  <div className="grid gap-2 md:grid-cols-2">
                    {configuration.allPicos.map((pico) => (
                      <label
                        key={pico.id}
                        className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-3 py-2.5 hover:bg-muted/50"
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 accent-primary"
                          checked={selected.has(pico.id)}
                          onChange={() => setSelected((current) => toggleId(current, pico.id))}
                        />
                        <span className="min-w-0 text-sm">
                          <span className="font-medium">PICO {pico.picoNumber} · {pico.title}</span>
                          {pico.researchQuestion && (
                            <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">
                              {pico.researchQuestion}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                {selectedPicos.length < 2 && (
                  <Alert variant="warning">A combined pool requires at least two PICOs.</Alert>
                )}
                <Alert>
                  Changing or removing the pool does not delete existing assignments or decisions.
                  PICOs removed from the pool return to their individual screening queues.
                </Alert>
                <div className="flex flex-wrap justify-between gap-2">
                  <div>
                    {configuration.pool && (
                      <Button
                        type="button"
                        variant="destructive"
                        onClick={() => setDeleteOpen(true)}
                      >
                        <Trash2 /> Remove combined pool
                      </Button>
                    )}
                  </div>
                  <Button
                    type="submit"
                    disabled={busy || selectedPicos.length < 2 || !name.trim() || (!dirty && Boolean(configuration.pool))}
                  >
                    {busy && <Spinner />} {configuration.pool ? "Save pool" : "Create pool"}
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove the combined screening pool?</DialogTitle>
            <DialogDescription>
              Reviewers will see these PICOs as individual queues again. Existing assignments,
              screening decisions, conflicts, and results will be preserved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void remove()} disabled={busy}>
              {busy && <Spinner />} Remove pool
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
