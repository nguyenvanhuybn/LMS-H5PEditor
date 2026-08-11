import { createTranslator, DEFAULT_LOCALE, LOCALE_COOKIE, resolveLocale } from "@/lib/i18n";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5050";

/**
 * apiFetch runs outside React, so it reads the locale cookie directly instead
 * of going through the context.
 */
function currentTranslator() {
  if (typeof document === "undefined") return createTranslator(DEFAULT_LOCALE);

  const match = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`));
  return createTranslator(resolveLocale(match ? decodeURIComponent(match[1]) : undefined));
}

export type ContentItem = {
  id: string;
  h5pContentId: string;
  title: string;
  mainLibrary?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  latestScore?: number | null;
};

export type GradeItem = {
  id: string;
  contentId: string;
  userId: string;
  scoreRaw: number;
  scoreMax: number;
  scoreScaled: number;
  completed: boolean;
  success: boolean;
  verb: string;
  attemptedAt: string;
};

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || currentTranslator()("api.requestFailed", { status: response.status }));
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function compactLibraryName(value?: string | null) {
  if (!value) return "H5P Content";
  return value.replace(/^H5P\./, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}
