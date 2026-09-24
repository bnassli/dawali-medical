"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getRequestMeta } from "@/modules/auth/current-actor";
import { requireActor } from "@/modules/auth/current-actor";
import { ForbiddenError } from "@/modules/permissions/service";
import { createPatientSchema, updatePatientSchema } from "@/modules/patients/schema";
import {
  createPatient,
  DuplicateExternalIdError,
  updatePatient,
} from "@/modules/patients/service";
import { createVisitSchema } from "@/modules/visits/schema";
import { InvalidClinicalValueError } from "@/modules/clinical/service";
import { createVisit, PatientNotFoundError } from "@/modules/visits/service";

function formValue(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
}

export async function createPatientAction(formData: FormData): Promise<void> {
  const actorBase = await requireActor();
  const meta = await getRequestMeta();
  const actor = { ...actorBase, ...meta };

  const parsed = createPatientSchema.safeParse({
    firstName: formValue(formData, "firstName"),
    lastName: formValue(formData, "lastName"),
    middleName: formValue(formData, "middleName"),
    dateOfBirth: formValue(formData, "dateOfBirth"),
    sex: formValue(formData, "sex"),
    phone: formValue(formData, "phone"),
    email: formValue(formData, "email"),
    icareFileNo: formValue(formData, "icareFileNo"),
  });

  if (!parsed.success) {
    redirect(
      `/patients/new?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Invalid input")}`,
    );
  }

  try {
    const patient = await createPatient(getDb(), actor, parsed.data);
    redirect(`/patients/${patient.id}`);
  } catch (err) {
    if (err instanceof DuplicateExternalIdError || err instanceof ForbiddenError) {
      redirect(`/patients/new?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
}

export async function updatePatientAction(formData: FormData): Promise<void> {
  const actorBase = await requireActor();
  const meta = await getRequestMeta();
  const actor = { ...actorBase, ...meta };

  const id = formValue(formData, "id");
  const parsed = updatePatientSchema.safeParse({
    id,
    firstName: formValue(formData, "firstName"),
    lastName: formValue(formData, "lastName"),
    middleName: formValue(formData, "middleName"),
    dateOfBirth: formValue(formData, "dateOfBirth"),
    sex: formValue(formData, "sex"),
    phone: formValue(formData, "phone"),
    email: formValue(formData, "email"),
  });

  if (!parsed.success) {
    redirect(
      `/patients/${id}?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Invalid input")}`,
    );
  }

  try {
    await updatePatient(getDb(), actor, parsed.data);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      redirect(`/patients/${id}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  redirect(`/patients/${id}`);
}

export async function createVisitAction(formData: FormData): Promise<void> {
  const actorBase = await requireActor();
  const meta = await getRequestMeta();
  const actor = { ...actorBase, ...meta };

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
      err instanceof InvalidClinicalValueError
    ) {
      redirect(`/patients/${patientId}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
}
