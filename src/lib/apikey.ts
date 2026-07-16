import { env } from "./env";

/** Auth for the description-system endpoints: x-api-key header, Bearer, or ?key=. */
export function descriptionKeyOk(req: Request): boolean {
  if (!env.descriptionApiKey) return false;
  const url = new URL(req.url);
  const provided =
    req.headers.get("x-api-key") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("key") ||
    "";
  return provided === env.descriptionApiKey;
}
