// Shapes consumed from GET /api/projects/[projectId] — only the fields the settings UI uses.

export interface ScreeningStageRow {
  id: string;
  type: "TITLE_ABSTRACT" | "FULL_TEXT";
  reviewersPerCitation: number;
  blinded: boolean;
  maybeGeneratesConflict: boolean;
  unblindedAt: string | null;
}

export interface ProjectDetail {
  id: string;
  title: string;
  reviewType: string;
  researchQuestion: string | null;
  description: string | null;
  status: string;
  registrationPlatform: string | null;
  registrationId: string | null;
  myRoles: string[];
  screeningStages: ScreeningStageRow[];
}
