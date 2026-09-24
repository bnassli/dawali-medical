import type { ZodType } from "zod";
import type { Database } from "@/db/client";
import { auditAccessDenied, ForbiddenError } from "@/modules/permissions/service";
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
  ClinicalExclusionError,
  ClinicalSectionNotFoundError,
  getClinicalSectionForVisit,
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
 * 403 permission denied, cross-origin request or a session that now belongs
 * to a different user than the page was rendered for, 404 unknown
 * visit/field, 409 optimistic-concurrency conflict (or duplicate option, or a
 * value that contradicts another field, `exclusive_value`),
 * 413 body too large, 415 non-JSON body, 423 visit not open (locked).
 */
export const MAX_SAVE_BODY_BYTES = 32 * 1024;
export const MAX_OPTION_BODY_BYTES = 2 * 1024;

export interface ApiDeps {
  db: Database;
  /** Resolves the authenticated actor for this request, or null (=> 401). */
  resolveActor: () => Promise<ActorContext | null>;
  /** Canonical public origin (APP_ORIGIN, already normalised to scheme://host[:port]). */
  appOrigin: string | null;
  /**
   * Development/test only: when appOrigin is not configured, fall back to the
   * request's own origin. MUST be false in production (fail closed).
   */
  allowRequestOrigin: boolean;
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

/** Canonical form (scheme://host[:port], default ports dropped, lower-cased host) or null. */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The origin browsers must present. APP_ORIGIN wins. Without it, dev/test may
 * use the request's own URL origin; production fails closed (null).
 * X-Forwarded-Host / X-Forwarded-Proto / Host are NEVER trusted: a client (or a
 * misconfigured proxy) controls them, so they must not decide who we trust.
 */
export function expectedOriginFor(request: Request, deps: ApiDeps): string | null {
  if (deps.appOrigin) return normalizeOrigin(deps.appOrigin);
  if (deps.allowRequestOrigin) return normalizeOrigin(request.url);
  return null;
}

/**
 * Same-origin check against the canonical origin, comparing scheme + host +
 * port. Browsers send Origin on every POST; if it is absent, Sec-Fetch-Site
 * (set by the browser, not scriptable) must say same-origin. Anything else,
 * including the opaque "null" origin, is rejected.
 */
export function isSameOrigin(request: Request, expectedOrigin: string | null): boolean {
  if (!expectedOrigin) return false;
  const origin = request.headers.get("origin");
  if (origin !== null) {
    return normalizeOrigin(origin) === expectedOrigin;
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
    err instanceof ClinicalSectionNotFoundError ||
    err instanceof ClinicalOptionNotFoundError
  ) {
    return fail(404, "not_found", err.message);
  }
  if (err instanceof DuplicateOptionError) return fail(409, "duplicate_option", err.message);
  // Not a version conflict (no `current`): the value would contradict another field (ADR-027).
  if (err instanceof ClinicalExclusionError) return fail(409, "exclusive_value", err.message);
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
  const expectedOrigin = expectedOriginFor(request, deps);
  if (!expectedOrigin) {
    console.error("clinical api: APP_ORIGIN is not configured; refusing request (fail closed).");
    return {
      ok: false,
      response: fail(403, "origin_not_configured", "The server has no canonical origin configured."),
    };
  }
  if (!isSameOrigin(request, expectedOrigin)) {
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

/**
 * The page was rendered for expectedUserId. If the session now belongs to a
 * different user (someone signed in on the same browser), refuse: text typed
 * as user A must never be saved under user B. Audited; nothing is written.
 */
async function actorMismatch(
  deps: ApiDeps,
  actor: ActorContext,
  expectedUserId: string,
  context: { entityType: string; entityId: string; visitId?: string },
): Promise<Response | null> {
  if (actor.userId === expectedUserId) return null;
  await auditAccessDenied(deps.db, actor, context, {
    reason: "actor_mismatch",
    expectedUserId,
  });
  return fail(
    403,
    "actor_mismatch",
    "You are now signed in as a different user than the one this page was opened for. Nothing was saved.",
  );
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
  const { expectedUserId, ...rest } = prepared.body;
  const mismatch = await actorMismatch(deps, prepared.actor, expectedUserId, {
    entityType: "clinical_entry",
    entityId: params.fieldId,
    visitId: params.visitId,
  });
  if (mismatch) return mismatch;
  const input = saveClinicalEntrySchema.parse({
    ...rest,
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

const SECTION_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

/**
 * GET /api/visits/{visitId}/clinical-sections/{sectionCode}: the CURRENT
 * (never cached) values and options of a section. The page calls it on mount
 * and when it becomes visible again so a page restored from the browser's
 * back/forward cache, or left open for a while, reconciles with the server
 * instead of showing a stale server render. Read-only; requires clinical.read.
 */
export async function handleGetClinicalSection(
  request: Request,
  params: { visitId: string; sectionCode: string },
  deps: ApiDeps,
): Promise<Response> {
  void request;
  const actor = await deps.resolveActor();
  if (!actor) {
    return fail(401, "unauthenticated", "Your session has expired. Sign in again.");
  }
  if (!UUID_PATTERN.test(params.visitId) || !SECTION_CODE_PATTERN.test(params.sectionCode)) {
    return fail(400, "invalid_input", "Invalid visit or section.");
  }
  try {
    const view = await getClinicalSectionForVisit(deps.db, actor, params.visitId, params.sectionCode);
    return json(200, {
      ok: true,
      visitId: view.visit.id,
      visitStatus: view.visit.status,
      fields: view.fields.map((f) => ({
        id: f.id,
        version: f.version,
        value: f.value,
        options: f.options,
        isActive: f.isActive,
      })),
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
  const { expectedUserId, ...rest } = prepared.body;
  const mismatch = await actorMismatch(deps, prepared.actor, expectedUserId, {
    entityType: "clinical_option",
    entityId: params.fieldId,
  });
  if (mismatch) return mismatch;
  const input = addClinicalOptionSchema.parse({ ...rest, fieldId: params.fieldId });
  try {
    const option = await addClinicalOption(deps.db, prepared.actor, input);
    return json(200, { ok: true, option });
  } catch (err) {
    return mapError(err);
  }
}
