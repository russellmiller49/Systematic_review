import { created, handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { invalidState, validationError } from "@/server/errors";
import {
  createBatch,
  createBatchSchema,
  listBatches,
  MAX_IMPORT_BYTES,
} from "@/server/services/imports";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    return ok(await listBatches(ctx, projectId));
  });
}

// Multipart form: file (required), sourceId (required), format (optional — auto-detected).
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw validationError("Request must be multipart/form-data with a 'file' field");
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw validationError("A 'file' upload field is required");
    // Cheap pre-check on the declared size; the service re-checks the decoded text.
    if (file.size > MAX_IMPORT_BYTES) {
      throw invalidState("Import file exceeds the 20 MB limit");
    }
    const sourceId = form.get("sourceId");
    const format = form.get("format");

    const input = createBatchSchema.parse({
      filename: file.name || "import",
      sourceId: typeof sourceId === "string" ? sourceId : "",
      format: typeof format === "string" && format.length > 0 ? format : undefined,
      content: await file.text(),
    });
    return created(await createBatch(ctx, projectId, input));
  });
}
