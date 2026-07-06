import { NextResponse } from "next/server";
import { handleRoute } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { downloadExport } from "@/server/services/exports";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string; jobId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, jobId } = await params;
    const file = await downloadExport(ctx, projectId, jobId);
    return new NextResponse(file.body, {
      status: 200,
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
