import { SignJWT, jwtVerify } from "jose";
import { env } from "./env";

const COOKIE = "auditor_session";
const secret = new TextEncoder().encode(env.auth.secret);

export const SESSION_COOKIE = COOKIE;

export async function createSessionToken(email: string): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);
}

export async function verifySessionToken(token: string | undefined): Promise<{ email: string } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    return { email: String(payload.email ?? "") };
  } catch {
    return null;
  }
}

export function checkCredentials(email: string, password: string): boolean {
  // Single-admin auth. Constant-ish comparison; fine for one credential pair.
  return (
    email.trim().toLowerCase() === env.auth.adminEmail.trim().toLowerCase() &&
    password === env.auth.adminPassword &&
    env.auth.adminPassword.length > 0
  );
}
