"use client";

import { Scale, Wrench } from "lucide-react";
import { EmptyState, Skeleton } from "@/components/ui/misc";
import { CreateToolDialog } from "./create-tool-dialog";
import { ToolCard } from "./tool-card";
import type { RobTool } from "./types";

export function ToolsTab({
  projectId,
  tools,
  builtins,
  canManage,
  onChanged,
}: {
  projectId: string;
  tools: RobTool[] | null; // project list (includes published built-ins)
  builtins: RobTool[] | null; // global built-in catalog
  canManage: boolean;
  onChanged: () => void;
}) {
  const projectTools = tools === null ? null : tools.filter((t) => t.projectId !== null);

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-medium">Project tools</h2>
            <p className="text-sm text-muted-foreground">
              Draft tools can be edited freely; publish a tool to assign and assess with it.
            </p>
          </div>
          {canManage && <CreateToolDialog projectId={projectId} onCreated={onChanged} />}
        </div>
        {projectTools === null ? (
          <Skeleton className="h-40" />
        ) : projectTools.length === 0 ? (
          <EmptyState
            icon={Wrench}
            title="No project tools yet"
            description="Use a built-in tool below to clone a ready-made draft into this project, or create your own from scratch."
          />
        ) : (
          <div className="space-y-4">
            {projectTools.map((tool) => (
              <ToolCard
                key={tool.id}
                projectId={projectId}
                tool={tool}
                canManage={canManage}
                onChanged={onChanged}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-medium">Built-in tools</h2>
          <p className="text-sm text-muted-foreground">
            Read-only templates shared by every project. &ldquo;Use this tool&rdquo; clones a
            draft copy you can customize.
          </p>
        </div>
        {builtins === null ? (
          <Skeleton className="h-32" />
        ) : builtins.length === 0 ? (
          <EmptyState
            icon={Scale}
            title="No built-in tools available"
            description="Built-in tools have not been seeded in this environment yet."
          />
        ) : (
          <div className="space-y-4">
            {builtins.map((tool) => (
              <ToolCard
                key={tool.id}
                projectId={projectId}
                tool={tool}
                canManage={canManage}
                onChanged={onChanged}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
