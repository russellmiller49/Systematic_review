"use client";

// Renders the PRISMA 2020 flow diagram for a set of report counts (live or snapshot).
// The on-screen preview is the exact SVG users download — a fixed light "manuscript"
// palette on a white card, not a themed UI surface (see diagram-layout.ts).

import { useMemo, useState } from "react";
import { FileDown, ImageDown } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import {
  buildPrismaDiagramLayout,
  prismaDiagramSvg,
  type DiagramCountRow,
} from "./diagram-layout";

function triggerDownload(url: string, fileName: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function PrismaDiagram({
  counts,
  fileBase,
}: {
  counts: DiagramCountRow[];
  fileBase: string;
}) {
  const [pngBusy, setPngBusy] = useState(false);

  const { svg, width, height } = useMemo(() => {
    const layout = buildPrismaDiagramLayout(counts);
    return { svg: prismaDiagramSvg(layout), width: layout.width, height: layout.height };
  }, [counts]);
  const dataUri = useMemo(
    () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    [svg],
  );

  function downloadSvg() {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    triggerDownload(url, `${fileBase}.svg`);
    URL.revokeObjectURL(url);
  }

  function downloadPng() {
    setPngBusy(true);
    const scale = 3; // print-friendly resolution
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas unavailable");
        ctx.scale(scale, scale);
        ctx.drawImage(image, 0, 0);
        canvas.toBlob((blob) => {
          setPngBusy(false);
          if (!blob) {
            toast.error("Failed to render PNG — download the SVG instead");
            return;
          }
          const url = URL.createObjectURL(blob);
          triggerDownload(url, `${fileBase}.png`);
          URL.revokeObjectURL(url);
        }, "image/png");
      } catch {
        setPngBusy(false);
        toast.error("Failed to render PNG — download the SVG instead");
      }
    };
    image.onerror = () => {
      setPngBusy(false);
      toast.error("Failed to render PNG — download the SVG instead");
    };
    image.src = dataUri;
  }

  return (
    <figure className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-border bg-white p-3">
        {/* Data-URI SVG: next/image adds nothing here, and the preview must match the file. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={dataUri}
          alt="PRISMA 2020 flow diagram"
          className="mx-auto h-auto w-full"
          style={{ maxWidth: width }}
        />
      </div>
      <figcaption className="flex items-center gap-2">
        <span className="mr-auto text-xs text-muted-foreground">
          PRISMA 2020 flow diagram for new systematic reviews
        </span>
        <Button variant="outline" size="sm" onClick={downloadSvg}>
          <FileDown /> SVG
        </Button>
        <Button variant="outline" size="sm" disabled={pngBusy} onClick={downloadPng}>
          {pngBusy ? <Spinner /> : <ImageDown />} PNG
        </Button>
      </figcaption>
    </figure>
  );
}
