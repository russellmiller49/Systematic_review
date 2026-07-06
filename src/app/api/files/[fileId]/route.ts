import { NextResponse } from "next/server";
import { handleRoute } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { getFileForServing, sanitizeFilename } from "@/server/services/fulltext";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ fileId: string }> };

// GET → stream the PDF bytes. Permission = membership in the file's project (R13);
// headers per R13 (nosniff, inline disposition with sanitized filename).
export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { fileId } = await params;
    const { file, bytes } = await getFileForServing(ctx, fileId);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `inline; filename="${sanitizeFilename(file.filename)}"`,
        "Content-Length": String(bytes.length),
      },
    });
  });
}
