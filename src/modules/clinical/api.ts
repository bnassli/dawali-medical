import type { ZodType } from "zod";
import type { Database } from "@/db/client";
import { ForbiddenError } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import {
  addClinicalOptionBodySchema,
  saveClinicalEntryBodySchema,
  saveClinicalEntrySchema,
  addClinicalOptionSchema,
} from "./schema";
import {
  addClinicalOption,
  ClinicalConflictError,
  ClinicalFieldNotFoundError,
  ClinicalOptionNotFoundError,
  DuplicateOptionError,
  InvalidClinicalValueError,
  MutationIdReuseError,
  saveClinicalEntry,
  VisitNotFoundError,
  VisitNotOpenError,
} from "./service";

/**
 * Framework-independent HTTP handlers for clinical autosave. They take a
 * standard Request and return a standard Response so they can be exercised
 * directly in tests; the Next.js route files only wire in the session lookup.
 *
 * Status mapping: 401 no/expired session, 400 malformed/invalid input,
 * 403 permission denied or cross-origin request, 404 unknown visit/field,
 * 409 optimistic-concurrency conflict (or duplicate option), 413 body too
 * large, 415 non-JSON body, 423 visit not open (locked).
 */
export const MAX_SAVE_BODY_BYTES = 32 * 1024;
export const MAX_OPTION_BODY_BYTES = 2 * 1024;

export interface ApiDeps {
  db: Database;
  /** Resolves the authenticated actor for this request, or null (=> 401). */
  resolveActor: () => Promise<ActorContext | null>;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function fail(status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
  return json(status, { ok: false, error, message, ...extra });
}

/** Same-origin only: Origin must match the host, or (no Origin) Sec-Fetch-Site must be same-origin. */
export function isSameOrigin(request: Request): boolean {
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    new URL(request.url).host;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}

type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

/** Reads a JSON body while enforcing a hard byte limit (also without Content-Length). */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<BodyResult> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return { ok: false, response: fail(415, "unsupported_media_type", "Expected application/json.") };
  }
  const tooLarge = {
    ok: false as const,
    response: fail(413, "payload_too_large", `Request body exceeds ${maxBytes} bytes.`),
  };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge;

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return tooLarge;
      }
      chunks.push(value);
    }
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: fail(400, "invalid_json", "Body is not valid JSON.") };
  }
}

function mapError(err: unknown): Response {
  if (err instanceof ClinicalConflictError) {
    return fail(409, "conflict", err.message, { current: err.current });
  }
  if (err instanceof ForbiddenError) return fail(403, "forbidden", err.message);
  if (err instanceof VisitNotOpenError) return fail(423, "visit_locked", err.message);
  if (
    err instanceof VisitNotFoundError ||
    err instanceof ClinicalFieldNotFoundError ||
    err instanceof ClinicalOptionNotFoundError
  ) {
    return fail(404, "not_found", err.message);
  }
  if (err instanceof DuplicateOptionError) return fail(409, "duplicate_option", err.message);
  if (err instanceof InvalidClinicalValueError || err instanceof MutationIdReuseError) {
    return fail(400, "invalid_value", err.message);
  }
  console.error("clinical api: unexpected error", err);
  return fail(500, "internal_error", "Unexpected server error.");
}

async function prepare<T>(
  request: Request,
  deps: ApiDeps,
  maxBytes: number,
  schema: ZodType<T>,
): Promise<{ ok: true; actor: ActorContext; body: T } | { ok: false; response: Response }> {
  if (!isSameOrigin(request)) {
    return { ok: false, response: fail(403, "cross_origin", "Cross-origin requests are not allowed.") };
  }
  const actor = await deps.resolveActor();
  if (!actor) {
    return { ok: false, response: fail(401, "unauthenticated", "Your session has expired. Sign in again.") };
  }
  const raw = await readBoundedJson(request, maxBytes);
  if (!raw.ok) return raw;
  const parsed = schema.safeParse(raw.value);
  if (!parsed.success) {
    return {
      ok: false,
      response: fail(400, "invalid_input", parsed.error.issues[0]?.message ?? "Invalid input"),
    };
  }
  return { ok: true, actor, body: parsed.data };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/visits/{visitId}/clinical-entries/{fieldId}. patientId is derived from the visit, never accepted. */
export async function handleSaveClinicalEntry(
  request: Request,
  params: { visitId: string; fieldId: string },
  deps: ApiDeps,
): Promise<Response> {
  const prepared = await prepare(request, deps, MAX_SAVE_BODY_BYTES, saveClinicalEntryBodySchema);
  if (!prepared.ok) return prepared.response;
  if (!UUID_PATTERN.test(params.visitId) || !UUID_PATTERN.test(params.fieldId)) {
    return fail(400, "invalid_input", "Invalid visit or field id.");
  }
  const input = saveClinicalEntrySchema.parse({
    ...prepared.body,
    visitId: params.visitId,
    fieldId: params.fieldId,
  });
  try {
    const result = await saveClinicalEntry(deps.db, prepared.actor, input);
    return json(200, {
      ok: true,
      changed: result.changed,
      replayed: result.replayed,
      version: result.version,
      value: result.value,
    });
  } catch (err) {
    return mapError(err);
  }
}

/** POST /api/clinical/fields/{fieldId}/options ("+ Add New"). */
export async function handleAddClinicalOption(
  request: Request,
  params: { fieldId: string },
  deps: ApiDeps,
): Promise<Response> {
  const prepared = await prepare(request, deps, MAX_OPTION_BODY_BYTES, addClinicalOptionBodySchema);
  if (!prepared.ok) return prepared.response;
  if (!UUID_PATTERN.test(params.fieldId)) {
    return fail(400, "invalid_input", "Invalid field id.");
  }
  const input = addClinicalOptionSchema.parse({ ...prepared.body, fieldId: params.fieldId });
  try {
    const option = await addClinicalOption(deps.db, prepared.actor, input);
    return json(200, { ok: true, option });
  } catch (err) {
    return mapError(err);
  }
}
