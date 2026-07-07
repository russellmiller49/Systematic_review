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
    <div className="grid grid-cols-2 gap-1.5">
      {PROJECT_ROLES.map((role) => (
        <label
          key={role}
          className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm transition-colors hover:bg-muted has-[:checked]:border-primary/40 has-[:checked]:bg-accent"
        >
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-primary"
            checked={value.includes(role)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...value, role] : value.filter((r) => r !== role),
              )
            }
          />
          {ROLE_LABELS[role]}
        </label>
      ))}
    </div>
  );
}
