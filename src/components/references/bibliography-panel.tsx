"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Download } from "lucide-react";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/misc";
import type { BibliographyResponse, StyleOption } from "./types";

// Formatted-bibliography preview: pick a CSL style, copy (plain + rich text) or download.
export function BibliographyPanel({
  projectId,
  styles,
  reloadKey,
}: {
  projectId: string;
  styles: StyleOption[];
  reloadKey: number;
}) {
  const [styleId, setStyleId] = useState(styles[0]?.id ?? "vancouver");
  const [data, setData] = useState<BibliographyResponse | null>(null);

  const load = useCallback(async () => {
    setData(null);
    try {
      setData(
        await apiPost<BibliographyResponse>(`/api/projects/${projectId}/references/bibliography`, {
          styleId,
        }),
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to format the bibliography");
      setData({ styleId, numeric: true, entries: [] });
    }
  }, [projectId, styleId]);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  async function copyBibliography() {
    if (!data || data.entries.length === 0) return;
    const text = data.entries
      .map((e) => (data.numeric ? `${e.index}. ${e.text}` : e.text))
      .join("\n\n");
    const html = data.entries
      .map((e) => `<p>${data.numeric ? `${e.index}. ` : ""}${e.html}</p>`)
      .join("");
    try {
      if (typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([text], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      toast.success("Bibliography copied — paste it into Word or your editor");
    } catch {
      toast.error("Could not access the clipboard");
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">Formatted bibliography</CardTitle>
            <CardDescription>
              Preview the reference list in a citation style; copy it or download it as text.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select
              aria-label="Citation style"
              className="w-44"
              value={styleId}
              onChange={(e) => setStyleId(e.target.value)}
            >
              {styles.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyBibliography()}
              disabled={!data || data.entries.length === 0}
            >
              <Copy /> Copy
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                window.open(
                  `/api/projects/${projectId}/references/export?format=bibliography&styleId=${styleId}`,
                  "_blank",
                )
              }
            >
              <Download /> .txt
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {data === null ? (
          <Skeleton className="h-32" />
        ) : data.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No references to format yet.</p>
        ) : (
          <ol className="space-y-2 text-sm leading-relaxed">
            {data.entries.map((entry) => (
              <li key={entry.referenceId} className="flex gap-2">
                {data.numeric && (
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {entry.index}.
                  </span>
                )}
                {/* citeproc output from validated CSL (italics/small-caps markup only) */}
                <span dangerouslySetInnerHTML={{ __html: entry.html }} />
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
