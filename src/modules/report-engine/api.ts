import { z } from "zod";
import type { FileStorage } from "@/lib/file-storage";
import { actorMismatch, fail, json, prepare, UUID_PATTERN, type ApiDeps } from "@/modules/clinical/api";
import { VisitNotFoundError, VisitNotOpenError } from "@/modules/clinical/service";
import { ForbiddenError } from "@/modules/permissions/service";
import {
  InvalidReportError,
  reportContentSchema,
  ReportConflictError,
  ReportMutationReuseError,
  ReportNotFoundError,
  saveReportVersion,
} from "./service";

export const MAX_REPORT_BODY_BYTES = 256 * 1024;

const bodySchema = z
  .object({
    expectedUserId: z.string().uuid(),
    templateCode: z.string().regex(/^[a-z_]{1,40}$/),
    expectedVersion: z.number().int().min(0),
    clientMutationId: z.string().uuid(),
    action: z.enum(["draft", "finalize"]),
    content: reportContentSchema,
  })
  .strict();

/** POST /api/visits/{visitId}/report/{reportId}: save a draft, or finalize / amend (new .docx). */
export async function handleSaveReport(
  request: Request,
  params: { visitId: string; reportId: string },
  deps: ApiDeps,
  storage: FileStorage,
  timeZone: string,
): Promise<Response> {
  const prepared = await prepare(request, deps, MAX_REPORT_BODY_BYTES, bodySchema);
  if (!prepared.ok) return prepared.response;
  if (!UUID_PATTERN.test(params.visitId) || !UUID_PATTERN.test(params.reportId)) {
    return fail(400, "invalid_input", "Invalid visit or report id.");
  }
  const { expectedUserId, ...rest } = prepared.body;
  const mismatch = await actorMismatch(deps, prepared.actor, expectedUserId, {
    entityType: "report",
    entityId: params.reportId,
    visitId: params.visitId,
  });
  if (mismatch) return mismatch;
  try {
    const result = await saveReportVersion(deps.db, storage, prepared.actor, { ...rest, ...params }, timeZone);
    return json(200, { ok: true, ...result });
  } catch (err) {
    if (err instanceof ForbiddenError) return fail(403, "forbidden", err.message);
    if (err instanceof ReportConflictError) return fail(409, "conflict", err.message, { currentVersion: err.currentVersion });
    if (err instanceof VisitNotOpenError) return fail(423, "visit_locked", err.message);
    if (err instanceof VisitNotFoundError || err instanceof ReportNotFoundError) return fail(404, "not_found", err.message);
    if (err instanceof InvalidReportError || err instanceof ReportMutationReuseError) return fail(400, "invalid_value", err.message);
    console.error("report api: unexpected error", err);
    return fail(500, "internal_error", "Unexpected server error.");
  }
}
