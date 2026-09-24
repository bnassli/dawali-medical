"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getRequestMeta } from "@/modules/auth/current-actor";
import { loginSchema } from "@/modules/auth/schema";
import { login, AuthenticationError } from "@/modules/auth/service";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/modules/auth/cookie";

export async function loginAction(formData: FormData): Promise<void> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    redirect(`/login?error=${encodeURIComponent("Invalid email or password.")}`);
  }

  const meta = await getRequestMeta();

  try {
    const result = await login(getDb(), parsed.data, meta);
    const cookieStore = await cookies();
    cookieStore.set(
      SESSION_COOKIE_NAME,
      result.token,
      sessionCookieOptions(result.expiresAt),
    );
  } catch (err) {
    if (err instanceof AuthenticationError) {
      redirect(`/login?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  redirect("/patients");
}
