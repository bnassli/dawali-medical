import "server-only";
import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { SESSION_COOKIE_NAME } from "@/modules/auth/cookie";
import { validateSession } from "@/modules/auth/service";
import type { ApiDeps } from "@/modules/clinical/api";

/** Real dependencies for API route handlers: DB + cookie-session lookup (never redirects; unauthenticated => 401). */
export function apiDeps(request: NextRequest): ApiDeps {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const meta = {
    ip: forwardedFor ? (forwardedFor.split(",")[0]?.trim() ?? null) : null,
    userAgent: request.headers.get("user-agent"),
  };
  return {
    db: getDb(),
    resolveActor: () =>
      validateSession(getDb(), request.cookies.get(SESSION_COOKIE_NAME)?.value, meta),
  };
}
