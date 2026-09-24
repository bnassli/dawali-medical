import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/modules/auth/cookie";

/**
 * Lightweight, edge-safe first line of defense: if there is no session
 * cookie at all, redirect to /login immediately without hitting the
 * database. This is defense-in-depth only — the authoritative check (token
 * hash lookup, expiry, revocation, active-user check) happens in
 * src/app/(app)/layout.tsx via requireActor(), because that check needs a
 * real Postgres connection which the Edge middleware runtime cannot open.
 */
export function proxy(request: NextRequest) {
  const hasSessionCookie = request.cookies.has(SESSION_COOKIE_NAME);

  if (!hasSessionCookie) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all routes except:
     * - /login (the login page itself)
     * - Next.js internals (_next/static, _next/image)
     * - static files (favicon, images, etc.)
     */
    "/((?!login|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
