import { NextResponse, type NextRequest } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth";

// Public routes: the exams API (consumed by the YouTube-description system),
// health check, login page, and auth endpoints. Everything else needs a session.
// /api/description enforces its OWN API key inside the route, so it bypasses the
// dashboard session gate here (listed public) rather than requiring a login cookie.
const PUBLIC_PREFIXES = ["/login", "/api/auth", "/api/exam", "/api/description", "/api/reports", "/api/health", "/_next", "/favicon"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
  if (session) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
