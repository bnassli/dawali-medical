import { z } from "zod";
import type { FileStorage } from "@/lib/file-storage";
import { actorMismatch, fail, json, prepare, UUID_PATTERN, type ApiDeps } from "@/modules/clinical/api";
import { VisitNotFoundError, VisitNotOpenError } from "@/modules/clinical/service";
import { ForbiddenError } from "@/modules/permissions/service";
import {
  DiagramConflictError,
  DiagramMutationReuseError,
  DiagramNotFoundError,
  InvalidDiagramError,
  PatientFileNotFoundError,
  readPatientFile,
  saveDiagramVersion,
  strokesSchema,
} from "./service";
import { MAX_DIAGRAM_PNG_BYTES } from "./types";

/** base64 of the PNG + the strokes JSON, with room to spare. */
export const MAX_DIAGRAM_BODY_BYTES = Math.ceil(MAX_DIAGRAM_PNG_BYTES * 1.4) + 4 * 1024 * 1024;

const saveBodySchema = z
  .object({
    expectedUserId: z.string().uuid(),
    diagramType: z.enum(["leg", "vein"]),
    expectedVersion: z.number().int().min(0),
    clientMutationId: z.string().uuid(),
    strokes: strokesSchema,
    pngBase64: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/, "Invalid image data."),
  })
  .strict();

function mapError(err: unknown): Response {
  if (err instanceof ForbiddenError) return fail(403, "forbidden", err.message);
  if (err instanceof DiagramConflictError) {
    return fail(409, "conflict", err.message, { currentVersion: err.currentVersion });
  }
  if (err instanceof VisitNotOpenError) return fail(423, "visit_locked", err.message);
  if (err instanceof VisitNotFoundError || err instanceof DiagramNotFoundError || err instanceof PatientFileNotFoundError) {
    return fail(404, "not_found", err.message);
  }
  if (err instanceof InvalidDiagramError || err instanceof DiagramMutationReuseError) {
    return fail(400, "invalid_value", err.message);
  }
  console.error("diagram api: unexpected error", err);
  return fail(500, "internal_error", "Unexpected server error.");
}

/** POST /api/visits/{visitId}/diagrams/{diagramId}: save a new version (never overwrites). */
export async function handleSaveDiagram(
  request: Request,
  params: { visitId: string; diagramId: string },
  deps: ApiDeps,
  storage: FileStorage,
  timeZone: string,
): Promise<Response> {
  const prepared = await prepare(request, deps, MAX_DIAGRAM_BODY_BYTES, saveBodySchema);
  if (!prepared.ok) return prepared.response;
  if (!UUID_PATTERN.test(params.visitId) || !UUID_PATTERN.test(params.diagramId)) {
    return fail(400, "invalid_input", "Invalid visit or diagram id.");
  }
  const { expectedUserId, pngBase64, ...rest } = prepared.body;
  const mismatch = await actorMismatch(deps, prepared.actor, expectedUserId, {
    entityType: "diagram",
    entityId: params.diagramId,
    visitId: params.visitId,
  });
  if (mismatch) return mismatch;
  try {
    const result = await saveDiagramVersion(
      deps.db,
      storage,
      prepared.actor,
      { ...rest, ...params, png: new Uint8Array(Buffer.from(pngBase64, "base64")) },
      timeZone,
    );
    return json(200, { ok: true, ...result });
  } catch (err) {
    return mapError(err);
  }
}

/** GET /api/files/{fileId}: a private patient file, only for signed-in users with clinical.read. */
export async function handleGetFile(
  params: { fileId: string },
  deps: ApiDeps,
  storage: FileStorage,
): Promise<Response> {
  const actor = await deps.resolveActor();
  if (!actor) return fail(401, "unauthenticated", "Your session has expired. Sign in again.");
  if (!UUID_PATTERN.test(params.fileId)) return fail(400, "invalid_input", "Invalid file id.");
  try {
    const file = await readPatientFile(deps.db, storage, actor, params.fileId);
    return new Response(Buffer.from(file.bytes), {
      status: 200,
      headers: {
        "content-type": file.contentType,
        "content-disposition": `inline; filename="${file.fileName}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    return mapError(err);
  }
}
