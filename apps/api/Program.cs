using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using H5pLms.Api.Data;
using H5pLms.Api.Models;
using H5pLms.Api.Services;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<H5pOptions>(builder.Configuration.GetSection(H5pOptions.SectionName));
builder.Services.Configure<IntegrationOptions>(builder.Configuration.GetSection(IntegrationOptions.SectionName));
builder.Services.Configure<LrsOptions>(builder.Configuration.GetSection(LrsOptions.SectionName));
builder.Services.AddSingleton<AppDatabase>();
builder.Services.AddSingleton<PackageBuilder>();
builder.Services.AddHttpClient<H5pEngineClient>((services, client) =>
{
    var options = services.GetRequiredService<IOptions<H5pOptions>>().Value;
    // Render's Blueprint service reference exposes an internal address as
    // "host:port". Accept that compact form as well as ordinary HTTP(S) URLs.
    client.BaseAddress = new Uri(NormalizeHttpUrl(options.InternalUrl).TrimEnd('/') + "/");
    client.Timeout = TimeSpan.FromSeconds(30);
});
builder.Services.AddHttpClient<LrsClient>((services, client) =>
{
    var options = services.GetRequiredService<IOptions<LrsOptions>>().Value;
    if (!string.IsNullOrWhiteSpace(options.Endpoint))
    {
        client.BaseAddress = new Uri(options.Endpoint.TrimEnd('/') + "/");
    }
    client.Timeout = TimeSpan.FromSeconds(15);
});

var allowedOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>()
    ?? ["http://localhost:3000"];
builder.Services.AddCors(options => options.AddDefaultPolicy(policy =>
    policy.WithOrigins(allowedOrigins).AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();
app.UseCors();

var database = app.Services.GetRequiredService<AppDatabase>();
await database.InitializeAsync();

app.MapGet("/health", async (H5pEngineClient engine, CancellationToken ct) =>
{
    var engineHealthy = await engine.IsHealthyAsync(ct);
    return Results.Ok(new
    {
        status = engineHealthy ? "healthy" : "degraded",
        api = "ok",
        h5pEngine = engineHealthy ? "ok" : "unavailable",
        timestamp = DateTimeOffset.UtcNow
    });
});

var api = app.MapGroup("/api");

// ---------------------------------------------------------------------------
// External LMS integration: SCORM export + results pull.
// Both sit behind an API key; an unset key disables them rather than exposing
// every learner's results to anyone who can reach the port.
// ---------------------------------------------------------------------------
var integration = api.MapGroup("/integration").AddEndpointFilter(
    async (context, next) =>
    {
        var options = context.HttpContext.RequestServices
            .GetRequiredService<IOptions<IntegrationOptions>>().Value;

        if (string.IsNullOrWhiteSpace(options.ApiKey))
        {
            return Results.Problem(
                "Integration:ApiKey chưa được cấu hình nên các endpoint tích hợp đang tắt.",
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }

        var supplied = context.HttpContext.Request.Headers["X-Api-Key"].ToString();
        return SecretsMatch(supplied, options.ApiKey)
            ? await next(context)
            : Results.Unauthorized();
    });

integration.MapGet("/results", async (
    string? cursor,
    DateTimeOffset? since,
    string? contentId,
    string? userId,
    int? limit,
    AppDatabase db,
    IOptions<IntegrationOptions> integrationOptions,
    CancellationToken ct) =>
{
    var options = integrationOptions.Value;
    var pageSize = Math.Clamp(limit ?? options.DefaultPageSize, 1, options.MaxPageSize);
    var page = await db.ListResultsAsync(cursor, since, contentId, userId, pageSize, ct);
    return Results.Ok(page);
});

// Origins the UI can offer when building a package.
integration.MapGet("/lms-origins", (IOptions<IntegrationOptions> integrationOptions) =>
    Results.Ok(new { origins = integrationOptions.Value.AllowedLmsOrigins }));

integration.MapGet("/contents/{h5pContentId}/package", async (
    string h5pContentId,
    string lmsOrigin,
    string? format,
    AppDatabase db,
    H5pEngineClient engine,
    PackageBuilder packages,
    IOptions<H5pOptions> h5pOptions,
    CancellationToken ct) =>
{
    if (!PackageBuilder.TryParseFormat(format, out var packageFormat))
    {
        return Results.BadRequest(new { error = "format phải là scorm12, scorm2004 hoặc xapi." });
    }

    var content = await db.GetContentAsync(h5pContentId, ct);
    if (content is null) return Results.NotFound();

    if (!Uri.TryCreate(lmsOrigin, UriKind.Absolute, out var lmsUri) ||
        lmsUri.Scheme is not ("http" or "https"))
    {
        return Results.BadRequest(new { error = "lmsOrigin phải là URL http(s) tuyệt đối." });
    }

    var origin = lmsUri.GetLeftPart(UriPartial.Authority);
    if (!packages.IsOriginAllowed(origin))
    {
        return Results.BadRequest(new
        {
            error = $"Origin '{origin}' chưa có trong Integration:AllowedLmsOrigins.",
        });
    }

    // The package runtime appends its own userId/userName from the host, so the
    // launch URL is built without a learner.
    var playerUrl = engine.BuildPlayerLaunchUrl(content.H5pContentId);
    var playerOrigin = new Uri(h5pOptions.Value.PublicUrl).GetLeftPart(UriPartial.Authority);

    var package = packages.Build(content, playerUrl, playerOrigin, packageFormat);
    return Results.File(package, "application/zip", packages.FileNameFor(content, packageFormat));
});

api.MapGet("/contents", (AppDatabase db, CancellationToken ct) => db.ListContentsAsync(ct));

api.MapGet("/contents/{h5pContentId}", async (string h5pContentId, AppDatabase db, CancellationToken ct) =>
{
    var content = await db.GetContentAsync(h5pContentId, ct);
    return content is null ? Results.NotFound() : Results.Ok(content);
});

api.MapPost("/contents", async (
    ContentRegistrationRequest request,
    AppDatabase db,
    H5pEngineClient engine,
    CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(request.H5pContentId))
    {
        return Results.ValidationProblem(new Dictionary<string, string[]>
        {
            [nameof(request.H5pContentId)] = ["H5pContentId là bắt buộc."]
        });
    }

    var mainLibrary = request.MainLibrary ?? await engine.GetMainLibraryAsync(request.H5pContentId, ct);
    var saved = await db.UpsertContentAsync(request with { MainLibrary = mainLibrary }, ct);
    return Results.Ok(saved);
});

api.MapDelete("/contents/{h5pContentId}", async (
    string h5pContentId,
    AppDatabase db,
    H5pEngineClient engine,
    CancellationToken ct) =>
{
    await engine.DeleteAsync(h5pContentId, ct);
    return await db.DeleteContentAsync(h5pContentId, ct) ? Results.NoContent() : Results.NotFound();
});

api.MapGet("/contents/{h5pContentId}/grades", (
    string h5pContentId,
    AppDatabase db,
    CancellationToken ct) => db.ListGradesAsync(h5pContentId, ct));

api.MapGet("/h5p/editor-url", (
    string returnUrl,
    string? contentId,
    string? userId,
    string? userName,
    string? language,
    H5pEngineClient engine) =>
{
    if (!Uri.TryCreate(returnUrl, UriKind.Absolute, out var callbackUri) ||
        callbackUri.Scheme is not ("http" or "https") ||
        !allowedOrigins.Contains(callbackUri.GetLeftPart(UriPartial.Authority), StringComparer.OrdinalIgnoreCase))
    {
        return Results.BadRequest(new { error = "returnUrl không hợp lệ." });
    }

    var url = engine.BuildEditorUrl(contentId, callbackUri.ToString(), userId ?? "demo-author", userName, language);
    return Results.Ok(new { url });
});

api.MapGet("/h5p/player-url/{contentId}", async (
    string contentId,
    string? userId,
    string? userName,
    string? language,
    AppDatabase db,
    H5pEngineClient engine,
    CancellationToken ct) =>
{
    if (await db.GetContentAsync(contentId, ct) is null) return Results.NotFound();
    var url = engine.BuildPlayerUrl(contentId, userId ?? "demo-learner", userName, language);
    return Results.Ok(new { url });
});

api.MapPost("/h5p/xapi", async (
    HttpRequest httpRequest,
    H5pWebhookPayload payload,
    AppDatabase db,
    LrsClient lrs,
    IOptions<H5pOptions> options,
    CancellationToken ct) =>
{
    var suppliedSecret = httpRequest.Headers["X-H5P-Webhook-Secret"].ToString();
    if (!SecretsMatch(suppliedSecret, options.Value.WebhookSecret))
    {
        return Results.Unauthorized();
    }

    if (string.IsNullOrWhiteSpace(payload.ContentId))
    {
        return Results.BadRequest(new { error = "contentId là bắt buộc." });
    }

    var result = payload.Statement.TryGetProperty("result", out var resultNode) ? resultNode : default;
    var score = result.ValueKind == JsonValueKind.Object && result.TryGetProperty("score", out var scoreNode)
        ? scoreNode
        : default;

    var raw = GetDouble(score, "raw");
    var max = GetDouble(score, "max", 1);
    var completed = GetBoolean(result, "completion");
    var success = GetBoolean(result, "success");
    var verb = GetVerb(payload.Statement);

    var grade = await db.SaveGradeAsync(
        payload.ContentId,
        payload.UserId ?? "anonymous",
        raw,
        max,
        completed,
        success,
        verb,
        payload.Statement.GetRawText(),
        ct);

    if (grade is null)
    {
        return Results.NotFound(new { error = "Nội dung chưa được đăng ký trong LMS." });
    }

    // Best effort: the attempt is already persisted, so an LRS outage must not
    // fail the webhook and make the player report an error to the learner.
    var forwarded = await lrs.SendAsync(payload.Statement, payload.UserId ?? "anonymous", ct);

    return Results.Ok(new { grade.Id, grade.ContentId, grade.UserId, grade.ScoreRaw, grade.ScoreMax,
        grade.ScoreScaled, grade.Completed, grade.Success, grade.Verb, grade.AttemptedAt,
        forwardedToLrs = forwarded });
});

app.Run();

static bool SecretsMatch(string supplied, string configured)
{
    if (string.IsNullOrEmpty(supplied) || string.IsNullOrEmpty(configured)) return false;
    var left = SHA256.HashData(Encoding.UTF8.GetBytes(supplied));
    var right = SHA256.HashData(Encoding.UTF8.GetBytes(configured));
    return CryptographicOperations.FixedTimeEquals(left, right);
}

static string NormalizeHttpUrl(string value)
{
    var trimmed = value.Trim();
    return trimmed.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
           trimmed.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
        ? trimmed
        : $"http://{trimmed}";
}

static double GetDouble(JsonElement element, string property, double fallback = 0) =>
    element.ValueKind == JsonValueKind.Object &&
    element.TryGetProperty(property, out var value) &&
    value.TryGetDouble(out var number)
        ? number
        : fallback;

static bool GetBoolean(JsonElement element, string property) =>
    element.ValueKind == JsonValueKind.Object &&
    element.TryGetProperty(property, out var value) &&
    value.ValueKind is JsonValueKind.True;

static string GetVerb(JsonElement statement)
{
    if (statement.TryGetProperty("verb", out var verb) &&
        verb.TryGetProperty("id", out var id))
    {
        return id.GetString()?.Split('/').LastOrDefault() ?? "unknown";
    }

    return "unknown";
}

public partial class Program;
