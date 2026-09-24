"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getRequestMeta } from "@/modules/auth/current-actor";
import { clearedSessionCookieOptions, SESSION_COOKIE_NAME } from "@/modules/auth/cookie";
import { logout } from "@/modules/auth/service";

export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const meta = await getRequestMeta();

  await logout(getDb(), token, meta);

  cookieStore.set(SESSION_COOKIE_NAME, "", clearedSessionCookieOptions());
  redirect("/login");
}
