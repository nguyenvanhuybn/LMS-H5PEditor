/**
 * Server-only helpers for talking to the ASP.NET integration API.
 *
 * The integration key must never reach the browser: it also unlocks every
 * learner's results. Route handlers in this folder hold it and proxy the call.
 */
import "server-only";

/** Server-side base URL; falls back to the public one for single-host setups. */
export const API_INTERNAL_URL =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5050";

export const INTEGRATION_API_KEY = process.env.INTEGRATION_API_KEY ?? "";

export const PACKAGE_FORMATS = ["scorm12", "scorm2004", "xapi"] as const;
export type PackageFormat = (typeof PACKAGE_FORMATS)[number];

export function isPackageFormat(value: unknown): value is PackageFormat {
  return typeof value === "string" && (PACKAGE_FORMATS as readonly string[]).includes(value);
}

export function integrationFetch(path: string, init?: RequestInit) {
  return fetch(`${API_INTERNAL_URL}${path}`, {
    ...init,
    headers: { "X-Api-Key": INTEGRATION_API_KEY, ...init?.headers },
    cache: "no-store",
  });
}

export function missingKeyResponse() {
  return Response.json(
    { error: "INTEGRATION_API_KEY chưa được cấu hình cho ứng dụng web." },
    { status: 503 },
  );
}
