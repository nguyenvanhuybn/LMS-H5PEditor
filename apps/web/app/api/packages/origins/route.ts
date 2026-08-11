import { INTEGRATION_API_KEY, integrationFetch, missingKeyResponse } from "@/lib/integration";

/** Lists the LMS origins an operator may build a package for. */
export async function GET() {
  if (!INTEGRATION_API_KEY) return missingKeyResponse();

  const response = await integrationFetch("/api/integration/lms-origins");
  if (!response.ok) {
    return Response.json(
      { error: `API tích hợp trả về ${response.status}.` },
      { status: response.status },
    );
  }

  return Response.json(await response.json());
}
