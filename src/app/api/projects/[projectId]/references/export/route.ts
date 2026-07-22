import { NextResponse } from "next/server";
import { handleRoute } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { exportReferences, exportReferencesSchema } from "@/server/services/references";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const url = new URL(req.url);
    const query = exportReferencesSchema.parse(Object.fromEntries(url.searchParams));
    const { filename, contentType, body } = await exportReferences(ctx, projectId, query);
    return new NextResponse(body, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
