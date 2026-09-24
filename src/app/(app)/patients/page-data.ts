import "server-only";

import { cache } from "react";
import { getDb } from "@/db/client";
import { todayIn } from "@/lib/age";
import { getEnv } from "@/lib/env";
import { requireActor } from "@/modules/auth/current-actor";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { getPatientById, listDemographicOptions } from "@/modules/patients/service";
import type { CreatePatientProps } from "./patient-search";

/** Today's date (YYYY-MM-DD) in the clinic time zone. */
export function clinicToday(): string {
  return todayIn(getEnv().APP_TIME_ZONE);
}

/**
 * The patient for the current request, loaded once and shared by the patient
 * layout (header) and the page below it (one permission check / audit per request).
 */
export const loadPatient = cache(async (id: string) => {
  const actor = await requireActor();
  return getPatientById(getDb(), actor, id);
});

/** Demographic option lists for the patient form, loaded once per request. */
export const loadDemographicOptions = cache(async () => {
  const actor = await requireActor();
  return listDemographicOptions(getDb(), actor);
});

/** What the "Create New Patient Record" form needs, or null without patient.create. */
export async function createPatientProps(): Promise<CreatePatientProps | null> {
  const actor = await requireActor();
  if (!actor.permissions.has(PERMISSIONS.PATIENT_CREATE)) return null;
  return {
    options: await loadDemographicOptions(),
    today: clinicToday(),
    canAddOption: actor.permissions.has(PERMISSIONS.PATIENT_OPTION_ADD),
  };
}
