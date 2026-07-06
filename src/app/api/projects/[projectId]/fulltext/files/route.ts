import { handleRoute, created } from "@/server/api-utils";
import { validationError } from "@/server/errors";
import { getCtx } from "@/server/auth/session";
import { uploadFullText, uploadFullTextFieldsSchema } from "@/server/services/fulltext";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string }> };

// POST multipart/form-data: { file, citationId, label? } → upload PDF + link to citation.
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw validationError("Request must be multipart/form-data");
    }

    const fileEntry = form.get("file");
    if (!(fileEntry instanceof Blob)) {
      throw validationError("A PDF file is required in the 'file' field");
    }
    const labelEntry = form.get("label");
    const citationEntry = form.get("citationId");
    const fields = uploadFullTextFieldsSchema.parse({
      citationId: typeof citationEntry === "string" ? citationEntry : undefined,
      label: typeof labelEntry === "string" && labelEntry.length > 0 ? labelEntry : undefined,
    });

    const filename =
      "name" in fileEntry && typeof fileEntry.name === "string" && fileEntry.name.length > 0
        ? fileEntry.name
        : "upload.pdf";
    const bytes = Buffer.from(await fileEntry.arrayBuffer());

    const result = await uploadFullText(ctx, projectId, {
      citationId: fields.citationId,
      label: fields.label,
      filename,
      bytes,
    });
    return created(result);
  });
}
