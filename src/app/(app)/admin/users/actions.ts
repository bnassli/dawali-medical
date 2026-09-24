"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getRequestMeta, requireActor } from "@/modules/auth/current-actor";
import { ForbiddenError } from "@/modules/permissions/service";
import { createUserSchema, setUserActiveSchema } from "@/modules/users/schema";
import { createUser, DuplicateEmailError, setUserActive } from "@/modules/users/service";

export async function createUserAction(formData: FormData): Promise<void> {
  const actorBase = await requireActor();
  const meta = await getRequestMeta();
  const actor = { ...actorBase, ...meta };

  const roleCodes = formData.getAll("roleCodes").filter((v): v is string => typeof v === "string");

  const parsed = createUserSchema.safeParse({
    email: formData.get("email"),
    displayName: formData.get("displayName"),
    password: formData.get("password"),
    roleCodes,
  });

  if (!parsed.success) {
    redirect(
      `/admin/users?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Invalid input")}`,
    );
  }

  try {
    await createUser(getDb(), actor, parsed.data);
  } catch (err) {
    if (err instanceof DuplicateEmailError || err instanceof ForbiddenError) {
      redirect(`/admin/users?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  redirect("/admin/users");
}

export async function setUserActiveAction(formData: FormData): Promise<void> {
  const actorBase = await requireActor();
  const meta = await getRequestMeta();
  const actor = { ...actorBase, ...meta };

  const parsed = setUserActiveSchema.safeParse({
    userId: formData.get("userId"),
    isActive: formData.get("isActive") === "true",
  });

  if (!parsed.success) {
    redirect(`/admin/users?error=${encodeURIComponent("Invalid input")}`);
  }

  try {
    await setUserActive(getDb(), actor, parsed.data);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      redirect(`/admin/users?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  redirect("/admin/users");
}
