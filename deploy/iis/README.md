# Deploy H5P Studio on IIS

This package runs IIS only as the public HTTPS reverse proxy. Three local processes run behind it:

| Service | Loopback port | Public IIS path |
| --- | ---: | --- |
| Next.js frontend | 3000 | `/` |
| ASP.NET API | 5050 | `/backend` |
| H5P Engine | 3001 | `/h5p-engine` |

Keeping browser calls on the same IIS origin avoids CORS entirely.

## 1. Build the package

On the build machine, from the repository root:

```powershell
.\deploy\iis\build-iis.ps1
```

The result is `.runtime\iis-package.zip`. The build compiles the browser API URL as `/backend`, so it does not need the production domain at build time.

## 2. Prepare the Windows Server

Install these prerequisites:

1. IIS with URL Rewrite 2.1 and Application Request Routing (ARR). In IIS Manager, enable **Application Request Routing Cache > Server Proxy Settings > Enable Proxy**.
2. Node.js 20 LTS.
3. .NET 8 ASP.NET Core Runtime (the .NET Hosting Bundle is also suitable).
4. NSSM, or an equivalent Windows service manager, for the two Node.js processes and the API.

Create `C:\H5P\app` and `C:\H5P\data`, then extract the package into `C:\H5P\app`.

## 3. Configure secrets and domain

Edit these files in `C:\H5P\app\scripts` before starting anything:

- `run-api.cmd`: replace `h5p.example.com`, `CHANGE_ME_WEBHOOK_SECRET`, `CHANGE_ME_INTERNAL_API_KEY`, and `CHANGE_ME_INTEGRATION_API_KEY`.
- `run-engine.cmd`: use the same webhook and internal API secrets as `run-api.cmd`, and the same domain.
- `run-web.cmd`: use the same integration API key as `run-api.cmd`.

Generate three independent secrets, for example:

```powershell
1..3 | ForEach-Object { [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)) }
```

Initialize persistent H5P storage once:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
C:\H5P\app\scripts\seed-h5p-data.ps1
```

## 4. Run background services

Example NSSM setup from an elevated PowerShell prompt:

```powershell
nssm install H5pStudioApi C:\H5P\app\scripts\run-api.cmd
nssm install H5pStudioEngine C:\H5P\app\scripts\run-engine.cmd
nssm install H5pStudioWeb C:\H5P\app\scripts\run-web.cmd
nssm start H5pStudioApi
nssm start H5pStudioEngine
nssm start H5pStudioWeb
```

Verify locally before IIS:

```powershell
Invoke-WebRequest http://127.0.0.1:5050/health
Invoke-WebRequest http://127.0.0.1:3001/health
Invoke-WebRequest http://127.0.0.1:3000/
```

## 5. Configure IIS and TLS

1. Create an IIS website bound to your real hostname on ports 80 and 443, then install its TLS certificate.
2. Set the website physical path to `C:\H5P\app\iis`.
3. The shipped `web.config` forwards `/backend/*`, `/h5p-engine/*`, and all remaining paths to the local services. It also permits H5P uploads up to 110 MB.
4. Confirm the application pool is **No Managed Code**.

After DNS and TLS are ready, open `https://YOUR_DOMAIN/`, then test `https://YOUR_DOMAIN/backend/health` and create a small H5P item.

## Updates and backup

Before updating, back up `C:\H5P\data`. It contains `h5p-lms.db` plus H5P content and libraries. Stop the three NSSM services, replace `C:\H5P\app`, preserve `C:\H5P\data`, run the seed script again (it does not overwrite existing core/editor folders), then start the services.
