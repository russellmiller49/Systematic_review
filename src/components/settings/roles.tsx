"use client";

// ProjectRole enum values (prisma/schema.prisma). Members and invitations hold an ARRAY of
// roles, so pickers are checklists rather than single selects.
export const PROJECT_ROLES = [
  "OWNER",
  "ADMIN",
  "REVIEWER",
  "ADJUDICATOR",
  "EXTRACTOR",
  "STATISTICIAN",
  "LIBRARIAN",
  "PANEL_MEMBER",
  "TRAINEE",
  "OBSERVER",
] as const;

export type ProjectRoleValue = (typeof PROJECT_ROLES)[number];

const ROLE_LABELS: Record<ProjectRoleValue, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  REVIEWER: "Reviewer",
  ADJUDICATOR: "Adjudicator",
  EXTRACTOR: "Extractor",
  STATISTICIAN: "Statistician",
  LIBRARIAN: "Librarian",
  PANEL_MEMBER: "Panel member",
  TRAINEE: "Trainee",
  OBSERVER: "Observer",
};

const ROLE_DESCRIPTIONS: Record<ProjectRoleValue, string> = {
  OWNER: "Full control. At least one Owner must remain; add another Owner to transfer ownership.",
  ADMIN: "Full control, including team roles, screening assignments, and project settings.",
  REVIEWER: "Screens only citations assigned to them; cannot configure the review.",
  ADJUDICATOR: "Resolves screening, extraction, and risk-of-bias conflicts.",
  EXTRACTOR: "Completes assigned data extraction and risk-of-bias work.",
  STATISTICIAN: "Manages analysis, extraction templates, and review exports.",
  LIBRARIAN: "Manages searches, imports, deduplication, full text, and protocol details.",
  PANEL_MEMBER: "Read-only access to review findings and analysis.",
  TRAINEE: "Performs supervised screening, extraction, and risk-of-bias work.",
  OBSERVER: "Read-only project access.",
};

export function roleLabel(role: string): string {
  return (ROLE_LABELS as Record<string, string>)[role] ?? role.toLowerCase().replace(/_/g, " ");
}

export function RolesChecklist({
  value,
  onChange,
}: {
  value: string[];
  onChange: (roles: string[]) => void;
}) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      {PROJECT_ROLES.map((role) => (
        <label
          key={role}
          className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-2.5 py-2 text-sm transition-colors hover:bg-muted has-[:checked]:border-primary/40 has-[:checked]:bg-accent"
        >
          <input
            type="checkbox"
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
            checked={value.includes(role)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...value, role] : value.filter((r) => r !== role),
              )
            }
          />
          <span>
            <span className="block font-medium">{ROLE_LABELS[role]}</span>
            <span className="block text-xs leading-snug text-muted-foreground">
              {ROLE_DESCRIPTIONS[role]}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}
