"use server";

import { getDb } from "@/db/client";
import { getRequestMeta, requireActor } from "@/modules/auth/current-actor";
import {
  addClinicalOptionSchema,
  saveClinicalEntrySchema,
} from "@/modules/clinical/schema";
import {
  addClinicalOption,
  ClinicalFieldNotFoundError,
  DuplicateOptionError,
  InvalidClinicalValueError,
  saveClinicalEntry,
  VisitNotFoundError,
  VisitNotOpenError,
} from "@/modules/clinical/service";
import { ForbiddenError } from "@/modules/permissions/service";

export type SaveEntryResult =
  | { ok: true; changed: boolean; version: number | null }
  | { ok: false; error: string };

export type AddOptionResult =
  | { ok: true; option: { id: string; label: string; isActive: boolean } }
  | { ok: false; error: string };

const USER_FACING_ERRORS = [
  ForbiddenError,
  VisitNotFoundError,
  VisitNotOpenError,
  ClinicalFieldNotFoundError,
  InvalidClinicalValueError,
  DuplicateOptionError,
] as const;

function toErrorMessage(err: unknown): string | null {
  for (const cls of USER_FACING_ERRORS) {
    if (err instanceof cls) return err.message;
  }
  return null;
}

// Server actions receive untrusted input: always re-validate here.
export async function saveEntryAction(input: unknown): Promise<SaveEntryResult> {
  const actorBase = await requireActor();
  const actor = { ...actorBase, ...(await getRequestMeta()) };

  const parsed = saveClinicalEntrySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const result = await saveClinicalEntry(getDb(), actor, parsed.data);
    return { ok: true, changed: result.changed, version: result.entry?.version ?? null };
  } catch (err) {
    const message = toErrorMessage(err);
    if (message) return { ok: false, error: message };
    throw err;
  }
}

export async function addOptionAction(input: unknown): Promise<AddOptionResult> {
  const actorBase = await requireActor();
  const actor = { ...actorBase, ...(await getRequestMeta()) };

  const parsed = addClinicalOptionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const option = await addClinicalOption(getDb(), actor, parsed.data);
    return { ok: true, option };
  } catch (err) {
    const message = toErrorMessage(err);
    if (message) return { ok: false, error: message };
    throw err;
  }
}
