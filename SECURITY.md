# Security notes

## Supported use

This repository is an integration starter, not a production security baseline.
The Next.js and ASP.NET Core layers keep H5P behind an HTTP boundary so the H5P
engine can be replaced independently.

## Required production controls

- Put all editor, upload and library-management routes behind LMS authentication.
- Issue short-lived, signed launch tokens instead of accepting `userId` from a query string.
- Only trusted administrators may install H5P libraries because libraries contain JavaScript.
- Scan uploads, enforce archive expansion limits, media quotas and an extension allow-list.
- Keep `H5P_WEBHOOK_SECRET` and `H5P_INTERNAL_API_KEY` different and rotate them.
- Restrict CORS and frame ancestors to the deployed LMS origins.
- Review `npm audit` for the community H5P engine before every release. Some current
  transitive advisories have no upstream automatic fix; do not expose the starter as-is.
- Pin and test H5P library upgrades in staging before migrating published content.

## Reporting

Do not commit secrets, student data or real H5P content when reporting an issue.
