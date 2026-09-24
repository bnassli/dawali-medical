"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getRequestMeta, requireActor } from "@/modules/auth/current-actor";
import { setClinicalOptionActiveSchema } from "@/modules/clinical/schema";
import { ClinicalOptionNotFoundError, setClinicalOptionActive } from "@/modules/clinical/service";
import { setDemographicOptionActiveSchema } from "@/modules/patients/schema";
import {
  DemographicOptionNotFoundError,
  setDemographicOptionActive,
} from "@/modules/patients/service";
import { ForbiddenError } from "@/modules/permissions/service";

export async function setOptionActiveAction(formData: FormData): Promise<void> {
  const actorBase = await requireActor();
  const actor = { ...actorBase, ...(await getRequestMeta()) };

  const parsed = setClinicalOptionActiveSchema.safeParse({
    optionId: formData.get("optionId"),
    isActive: formData.get("isActive") === "true",
  });
  if (!parsed.success) {
    redirect(`/admin/options?error=${encodeURIComponent("Invalid input")}`);
  }

  try {
    await setClinicalOptionActive(getDb(), actor, parsed.data);
  } catch (err) {
    if (err instanceof ForbiddenError || err instanceof ClinicalOptionNotFoundError) {
      redirect(`/admin/options?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  redirect("/admin/options");
}

/** Retire / reactivate a Nationality or Preferred Language option (ADR-028). */
export async function setDemographicOptionActiveAction(formData: FormData): Promise<void> {
  const actorBase = await requireActor();
  const actor = { ...actorBase, ...(await getRequestMeta()) };

  const parsed = setDemographicOptionActiveSchema.safeParse({
    optionId: formData.get("optionId"),
    isActive: formData.get("isActive") === "true",
  });
  if (!parsed.success) {
    redirect(`/admin/options?error=${encodeURIComponent("Invalid input")}`);
  }

  try {
    await setDemographicOptionActive(getDb(), actor, parsed.data);
  } catch (err) {
    if (err instanceof ForbiddenError || err instanceof DemographicOptionNotFoundError) {
      redirect(`/admin/options?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  redirect("/admin/options");
}
