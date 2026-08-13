using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using H5pLms.Api.Data;
using H5pLms.Api.Models;
using H5pLms.Api.Services;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);

// Enums cross the wire as names ("Score"), not ordinals: the web client and the
// package builder both match on the name, and an ordinal would silently shift if
// a mode were ever inserted.
builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));

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

// Origins the UI can offer when building a package. Each carries whether the
// engine will actually post results to it, so the UI can rule out a choice that
// would produce a package the LMS never hears from.
integration.MapGet("/lms-origins", async (
    IOptions<IntegrationOptions> integrationOptions,
    H5pEngineClient engine,
    CancellationToken ct) =>
{
    var engineOrigins = await engine.GetEmbedOriginsAsync(ct);
    // Null means the engine could not be asked; do not claim it will fail.
    var engineAcceptsAll = engineOrigins is null || engineOrigins.Contains("*");

    var origins = integrationOptions.Value.AllowedLmsOrigins.Select(origin => new
    {
        origin,
        // A "*" entry is only usable when the engine side is wildcarded too.
        engineAccepts = engineAcceptsAll
            || (origin != "*" && engineOrigins!.Contains(origin, StringComparer.OrdinalIgnoreCase))
    });

    return Results.Ok(new { origins, engineOrigins });
});

integration.MapGet("/contents/{h5pContentId}/package", async (
    string h5pContentId,
    string lmsOrigin,
    string? format,
    bool? relayResults,
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

    string origin;
    if (lmsOrigin == "*")
    {
        origin = "*";
    }
    else if (Uri.TryCreate(lmsOrigin, UriKind.Absolute, out var lmsUri) &&
        lmsUri.Scheme is "http" or "https")
    {
        origin = lmsUri.GetLeftPart(UriPartial.Authority);
    }
    else
    {
        return Results.BadRequest(new { error = "lmsOrigin phải là URL http(s) tuyệt đối hoặc \"*\"." });
    }

    if (!packages.IsOriginAllowed(origin))
    {
        return Results.BadRequest(new
        {
            error = $"Origin '{origin}' chưa có trong Integration:AllowedLmsOrigins.",
        });
    }

    // The engine posts results to the embedding page and silently falls back to
    // its own origin for anything it does not recognise, which would leave the
    // LMS with no results at all. Refuse to build a package that would do that.
    var embedOrigins = await engine.GetEmbedOriginsAsync(ct);
    var engineAcceptsAll = embedOrigins is null || embedOrigins.Contains("*");
    if (!engineAcceptsAll &&
        (origin == "*" || !embedOrigins!.Contains(origin, StringComparer.OrdinalIgnoreCase)))
    {
        return Results.BadRequest(new
        {
            error = $"H5P Engine không chấp nhận origin '{origin}', nên kết quả sẽ không tới được LMS. "
                  + $"Thêm origin này vào H5P_ALLOWED_ORIGINS rồi khởi động lại engine. "
                  + $"Engine đang chấp nhận: {string.Join(", ", embedOrigins!)}."
        });
    }

    // The package runtime appends its own userId/userName from the host, so the
    // launch URL is built without a learner. Results go to the host's runtime by
    // default; relayResults=true additionally feeds /api/integration/results.
    var playerUrl = engine.BuildPlayerLaunchUrl(content.H5pContentId, relayResults: relayResults ?? false);
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

api.MapPut("/contents/{h5pContentId}/completion", async (
    string h5pContentId,
    CompletionRuleRequest request,
    AppDatabase db,
    CancellationToken ct) =>
{
    if (!Enum.TryParse<CompletionMode>(request.Mode, ignoreCase: true, out var mode))
    {
        return Results.BadRequest(new { error = "Mode phải là Default, Score hoặc Position." });
    }

    var rule = new CompletionRule(
        mode,
        request.PassRatio ?? CompletionRule.Default.PassRatio,
        request.MinPosition ?? CompletionRule.Default.MinPosition);

    var updated = await db.UpdateCompletionRuleAsync(h5pContentId, rule, ct);
    return updated is null ? Results.NotFound() : Results.Ok(updated);
});

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

    // Distinguish "unknown content" from "rule says this event is not a result",
    // which SaveGradeAsync signals the same way.
    if (await db.GetContentAsync(payload.ContentId, ct) is null)
    {
        return Results.NotFound(new { error = "Nội dung chưa được đăng ký trong LMS." });
    }

    var raw = GetDouble(score, "raw");
    var max = GetDouble(score, "max", 1);
    var completed = GetBoolean(result, "completion");
    var success = GetBoolean(result, "success");
    var verb = GetVerb(payload.Statement);
    var position = GetPosition(payload.Statement);
    var userId = payload.UserId ?? "anonymous";

    var grade = await db.SaveGradeAsync(
        payload.ContentId, userId, raw, max, completed, success, verb, position,
        payload.Statement.GetRawText(), ct);

    // Best effort: the attempt is already persisted, so an LRS outage must not
    // fail the webhook and make the player report an error to the learner.
    var forwarded = await lrs.SendAsync(payload.Statement, userId, ct);

    if (grade is null)
    {
        return Results.Ok(new { recorded = false, verb, position, forwardedToLrs = forwarded });
    }

    return Results.Ok(new { recorded = true, grade.Id, grade.ContentId, grade.UserId, grade.ScoreRaw,
        grade.ScoreMax, grade.ScoreScaled, grade.Completed, grade.Success, grade.Verb, grade.AttemptedAt,
        position, forwardedToLrs = forwarded });
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

/// <summary>
/// H5P reports how far a learner got through the tincanapi "ending-point"
/// extension. Slide-based content types put it on the object definition, some
/// put it on the context, so both are checked.
/// </summary>
static int? GetPosition(JsonElement statement)
{
    const string EndingPoint = "http://id.tincanapi.com/extension/ending-point";

    if (statement.TryGetProperty("object", out var obj) &&
        obj.TryGetProperty("definition", out var definition) &&
        TryReadExtension(definition, EndingPoint, out var fromObject))
    {
        return fromObject;
    }

    if (statement.TryGetProperty("context", out var context) &&
        TryReadExtension(context, EndingPoint, out var fromContext))
    {
        return fromContext;
    }

    return null;

    static bool TryReadExtension(JsonElement owner, string key, out int value)
    {
        value = 0;
        return owner.TryGetProperty("extensions", out var extensions)
            && extensions.ValueKind == JsonValueKind.Object
            && extensions.TryGetProperty(key, out var node)
            && node.ValueKind == JsonValueKind.Number
            && node.TryGetInt32(out value);
    }
}

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
