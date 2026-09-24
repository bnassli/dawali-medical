"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getRequestMeta } from "@/modules/auth/current-actor";
import { requireActor } from "@/modules/auth/current-actor";
import { ForbiddenError } from "@/modules/permissions/service";
import { EXTERNAL_ID_SYSTEMS } from "@/modules/patients/constants";
import {
  addDemographicOptionSchema,
  createPatientSchema,
  searchPatientsSchema,
  setPatientActiveSchema,
  updatePatientSchema,
} from "@/modules/patients/schema";
import {
  addDemographicOption,
  createPatient,
  DuplicateDemographicOptionError,
  DuplicateExternalIdError,
  externalIdOf,
  InvalidDemographicOptionError,
  PatientConflictError,
  PatientNotFoundError as PatientRecordNotFoundError,
  searchPatients,
  setPatientActive,
  updatePatient,
  type DemographicOptionView,
} from "@/modules/patients/service";
import { createVisitSchema } from "@/modules/visits/schema";
import { InvalidClinicalValueError } from "@/modules/clinical/service";
import {
  createVisit,
  PatientInactiveError,
  PatientNotFoundError,
} from "@/modules/visits/service";
import {
  PATIENT_FORM_FIELDS,
  type PatientFormState,
  type PatientSearchResult,
} from "./patient-form-types";

function formValue(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
}

/**
 * The Patient Header lives in the patient LAYOUT, which a redirect back to the
 * same patient would otherwise reuse unchanged: re-render it after a change.
 */
function refreshPatient(id: string): void {
  revalidatePath(`/patients/${id}`, "layout");
}

async function currentActor() {
  const actorBase = await requireActor();
  const meta = await getRequestMeta();
  return { ...actorBase, ...meta };
}

/** Every patient form field as submitted (kept on error so nothing typed is lost). */
function readPatientForm(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of PATIENT_FORM_FIELDS) values[key] = formValue(formData, key);
  return values;
}

/** Errors a user can act on; anything else is rethrown (500). */
function userFacingError(err: unknown): string | null {
  if (
    err instanceof DuplicateExternalIdError ||
    err instanceof ForbiddenError ||
    err instanceof InvalidDemographicOptionError ||
    err instanceof PatientConflictError ||
    err instanceof PatientRecordNotFoundError
  ) {
    return err.message;
  }
  return null;
}

export async function createPatientAction(
  _prev: PatientFormState,
  formData: FormData,
): Promise<PatientFormState> {
  const actor = await currentActor();
  const values = readPatientForm(formData);

  const parsed = createPatientSchema.safeParse(values);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", values };
  }

  let patientId: string;
  try {
    patientId = (await createPatient(getDb(), actor, parsed.data)).id;
  } catch (err) {
    const message = userFacingError(err);
    if (message) return { error: message, values };
    throw err;
  }
  redirect(`/patients/${patientId}`);
}

export async function updatePatientAction(
  _prev: PatientFormState,
  formData: FormData,
): Promise<PatientFormState> {
  const actor = await currentActor();
  const values = readPatientForm(formData);
  const id = formValue(formData, "id");

  const parsed = updatePatientSchema.safeParse({
    ...values,
    id,
    expectedVersion: formValue(formData, "expectedVersion"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", values };
  }

  try {
    await updatePatient(getDb(), actor, parsed.data);
  } catch (err) {
    const message = userFacingError(err);
    if (message) return { error: message, values };
    throw err;
  }
  refreshPatient(id);
  redirect(`/patients/${id}?saved=1`);
}

export async function setPatientActiveAction(formData: FormData): Promise<void> {
  const actor = await currentActor();
  const id = formValue(formData, "id");
  const parsed = setPatientActiveSchema.safeParse({
    id,
    isActive: formValue(formData, "isActive") === "true",
    expectedVersion: formValue(formData, "expectedVersion"),
  });
  if (!parsed.success) {
    redirect(`/patients/${id}?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Invalid input")}`);
  }

  try {
    await setPatientActive(getDb(), actor, parsed.data);
  } catch (err) {
    const message = userFacingError(err);
    if (message) redirect(`/patients/${id}?error=${encodeURIComponent(message)}`);
    throw err;
  }
  refreshPatient(id);
  redirect(`/patients/${id}`);
}

/**
 * Patient Search (modal/table). A server action (POST), so names, dates of birth
 * and phone numbers never end up in URLs, browser history or access logs.
 * Returns only the columns the results table shows.
 */
export async function searchPatientsAction(input: unknown): Promise<PatientSearchResult> {
  const actor = await currentActor();
  const parsed = searchPatientsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid search input" };
  }
  try {
    const rows = await searchPatients(getDb(), actor, parsed.data);
    return {
      ok: true,
      rows: rows.map((p) => ({
        id: p.id,
        fileId: externalIdOf(p, EXTERNAL_ID_SYSTEMS.ICARE_FILE_NO),
        lastName: p.lastName,
        firstName: p.firstName,
        middleName: p.middleName,
        dateOfBirth: p.dateOfBirth,
        isActive: p.isActive,
      })),
    };
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message };
    throw err;
  }
}

export type AddDemographicOptionResult =
  | { ok: true; option: DemographicOptionView }
  | { ok: false; error: string };

/** "+ Add New" for Nationality / Preferred Language. */
export async function addDemographicOptionAction(
  input: unknown,
): Promise<AddDemographicOptionResult> {
  const actor = await currentActor();
  const parsed = addDemographicOptionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid option" };
  }
  try {
    return { ok: true, option: await addDemographicOption(getDb(), actor, parsed.data) };
  } catch (err) {
    if (err instanceof ForbiddenError || err instanceof DuplicateDemographicOptionError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

export async function createVisitAction(formData: FormData): Promise<void> {
  const actor = await currentActor();

  const patientId = formValue(formData, "patientId");
  const parsed = createVisitSchema.safeParse({
    patientId,
    reason: formValue(formData, "reason"),
  });

  if (!parsed.success) {
    redirect(
      `/patients/${patientId}?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Invalid input")}`,
    );
  }

  try {
    const visit = await createVisit(getDb(), actor, parsed.data);
    redirect(`/patients/${patientId}/visits/${visit.id}`);
  } catch (err) {
    if (
      err instanceof ForbiddenError ||
      err instanceof PatientNotFoundError ||
      err instanceof PatientInactiveError ||
      err instanceof InvalidClinicalValueError
    ) {
      redirect(`/patients/${patientId}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
}
