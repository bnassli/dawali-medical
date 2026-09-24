import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import type { ActorContext } from "@/modules/permissions/types";
import { SESSION_COOKIE_NAME } from "./cookie";
import { validateSession, type RequestMeta } from "./service";

export async function getRequestMeta(): Promise<RequestMeta> {
  const h = await headers();
  const forwardedFor = h.get("x-forwarded-for");
  const ip = forwardedFor ? forwardedFor.split(",")[0]?.trim() : null;
  return {
    ip: ip ?? null,
    userAgent: h.get("user-agent"),
  };
}

/**
 * Returns the current authenticated actor, or null if there is no valid
 * session. Does not redirect — use requireActor() for that.
 */
export async function getCurrentActor(): Promise<ActorContext | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const meta = await getRequestMeta();
  return validateSession(getDb(), token, meta);
}

/**
 * Server Component / layout guard: redirects to /login when there is no
 * valid session. This is the enforcement point referenced by
 * PROMPT_SPRINT_1's "middleware/layout guard" requirement — every route
 * under the (app) route group calls this via its layout.
 */
export async function requireActor(): Promise<ActorContext> {
  const actor = await getCurrentActor();
  if (!actor) {
    redirect("/login");
  }
  return actor;
}
