import { NextResponse } from "next/server";
import { handleRoute } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { exportDocx } from "@/server/services/manuscript";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const { filename, buffer } = await exportDocx(ctx, projectId);
    return new NextResponse(Buffer.from(buffer), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
