"use client";

import { useState } from "react";
import { Archive } from "lucide-react";
import { toast } from "sonner";
import { apiPatch, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Alert, Spinner } from "@/components/ui/misc";
import type { ProjectDetail } from "./types";

// Archiving is a status flip (updateProjectSchema accepts status) — data is preserved and
// the change is audited like any other project update.
export function DangerZone({
  projectId,
  project,
  onChanged,
}: {
  projectId: string;
  project: ProjectDetail;
  onChanged: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const archived = project.status === "ARCHIVED";

  async function archive() {
    setBusy(true);
    try {
      await apiPatch(`/api/projects/${projectId}`, { status: "ARCHIVED" });
      toast.success("Project archived");
      setConfirmOpen(false);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to archive project");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium text-exclude">Danger zone</h2>
      <Card className="border-exclude/30">
        <CardContent className="p-5">
          {archived ? (
            <Alert variant="info">
              This project is archived. Restore it by changing the status in Project details
              above.
            </Alert>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium">Archive this project</p>
                <p className="text-sm text-muted-foreground">
                  Marks the project as archived for all members. Data is preserved and the
                  change is recorded in the audit trail.
                </p>
              </div>
              <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                <DialogTrigger asChild>
                  <Button variant="destructive">
                    <Archive /> Archive project
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Archive &ldquo;{project.title}&rdquo;?</DialogTitle>
                    <DialogDescription>
                      The project moves to Archived status for all members. You can restore it
                      later by changing the status back in Project details.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setConfirmOpen(false)}>
                      Cancel
                    </Button>
                    <Button variant="destructive" onClick={archive} disabled={busy}>
                      {busy && <Spinner />} Archive
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
