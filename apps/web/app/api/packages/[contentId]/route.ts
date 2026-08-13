import {
  INTEGRATION_API_KEY,
  integrationFetch,
  isPackageFormat,
  missingKeyResponse,
} from "@/lib/integration";

/**
 * Streams a package built by the ASP.NET integration API.
 *
 * This exists so the browser can trigger a download without ever holding the
 * integration key. Note it inherits the app's current posture: the app has no
 * sign-in yet, so anyone who can reach it can download packages — the same as
 * for creating and deleting content.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ contentId: string }> },
) {
  if (!INTEGRATION_API_KEY) return missingKeyResponse();

  const { contentId } = await params;
  const requested = new URL(request.url).searchParams;
  const format = requested.get("format") ?? "scorm12";
  const lmsOrigin = requested.get("lmsOrigin");

  if (!isPackageFormat(format)) {
    return Response.json({ error: "format không hợp lệ." }, { status: 400 });
  }
  if (!lmsOrigin) {
    return Response.json({ error: "Thiếu lmsOrigin." }, { status: 400 });
  }

  // Off unless asked: the host's own runtime is the system of record for an
  // exported package.
  const relayResults = requested.get("relayResults") === "true";
  const query = new URLSearchParams({ format, lmsOrigin, relayResults: String(relayResults) });
  const response = await integrationFetch(
    `/api/integration/contents/${encodeURIComponent(contentId)}/package?${query}`,
  );

  if (!response.ok) {
    // Pass the API's own message through so the operator sees the real reason
    // (unlisted origin, unknown content) instead of a generic failure.
    const detail = await response.text();
    return new Response(detail || `API tích hợp trả về ${response.status}.`, {
      status: response.status,
      headers: { "Content-Type": response.headers.get("content-type") ?? "text/plain" },
    });
  }

  return new Response(response.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition":
        response.headers.get("content-disposition") ?? `attachment; filename="h5p-${contentId}-${format}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
