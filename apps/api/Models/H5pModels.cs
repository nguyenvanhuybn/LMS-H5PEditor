using System.Text.Json;
using System.Text.Json.Serialization;

namespace H5pLms.Api.Models;

/// <summary>How an attempt is judged complete for a piece of content.</summary>
public enum CompletionMode
{
    /// <summary>Take completion and success straight from the H5P statement.</summary>
    Default,

    /// <summary>Scaled score must reach <see cref="CompletionRule.PassRatio"/>.</summary>
    Score,

    /// <summary>
    /// Learner must reach a step/slide number. Only content types that emit an
    /// xAPI "progressed" statement carrying an ending-point can report this.
    /// </summary>
    Position
}

/// <summary>
/// The completion rule travels with the content: the API applies it when a
/// result arrives, and the SCORM/xAPI packages carry it so the LMS reaches the
/// same verdict on its own.
/// </summary>
public sealed record CompletionRule(
    CompletionMode Mode = CompletionMode.Default,
    double PassRatio = 0.5,
    int MinPosition = 1)
{
    public static CompletionRule Default { get; } = new();

    /// <summary>Percentage form, which is what SCORM 1.2 masteryscore expects.</summary>
    public int PassPercent => (int)Math.Round(Math.Clamp(PassRatio, 0, 1) * 100);

    public CompletionRule Normalised() => this with
    {
        PassRatio = Math.Clamp(PassRatio, 0, 1),
        MinPosition = Math.Max(1, MinPosition)
    };
}

public sealed record ContentItem(
    string Id,
    string H5pContentId,
    string Title,
    string? MainLibrary,
    string Status,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    int AttemptCount = 0,
    double? LatestScore = null,
    CompletionMode CompletionMode = CompletionMode.Default,
    double PassRatio = 0.5,
    int MinPosition = 1)
{
    public CompletionRule Completion => new(CompletionMode, PassRatio, MinPosition);
}

public sealed record CompletionRuleRequest(
    string Mode,
    double? PassRatio,
    int? MinPosition);

public sealed record ContentRegistrationRequest(
    string H5pContentId,
    string? Title,
    string? MainLibrary);

public sealed record GradeItem(
    string Id,
    string ContentId,
    string UserId,
    double ScoreRaw,
    double ScoreMax,
    double ScoreScaled,
    bool Completed,
    bool Success,
    string Verb,
    DateTimeOffset AttemptedAt);

/// <summary>One recorded attempt, shaped for consumption by an external LMS.</summary>
public sealed record ResultItem(
    string Id,
    string H5pContentId,
    string ContentTitle,
    string? MainLibrary,
    string UserId,
    double ScoreRaw,
    double ScoreMax,
    double ScoreScaled,
    bool Completed,
    bool Success,
    string Verb,
    DateTimeOffset AttemptedAt);

/// <summary>
/// A page of results plus the cursor to resume from. An LMS polls with the
/// previous NextCursor to receive only what it has not seen yet.
/// </summary>
public sealed record ResultPage(
    IReadOnlyList<ResultItem> Items,
    string? NextCursor,
    bool HasMore);

public sealed record H5pWebhookPayload(
    [property: JsonPropertyName("contentId")] string? ContentId,
    [property: JsonPropertyName("userId")] string? UserId,
    [property: JsonPropertyName("statement")] JsonElement Statement);

public sealed record H5pOptions
{
    public const string SectionName = "H5p";
    public string InternalUrl { get; init; } = "http://localhost:3001";
    public string PublicUrl { get; init; } = "http://localhost:3001";
    public string WebhookSecret { get; init; } = "dev-only-change-me";
    public string InternalApiKey { get; init; } = "dev-internal-key-change-me";

    /// <summary>
    /// Languages the H5P engine can render the editor/player in. Keep in sync
    /// with H5P_SUPPORTED_LANGUAGES on the engine; the first entry is the default.
    /// </summary>
    public string[] SupportedLanguages { get; init; } = ["vi", "en"];

    public string DefaultLanguage => SupportedLanguages.FirstOrDefault() ?? "en";
}

/// <summary>Settings for external LMS integration (SCORM export + results pull).</summary>
public sealed record IntegrationOptions
{
    public const string SectionName = "Integration";

    /// <summary>
    /// Key an external LMS presents in X-Api-Key. Empty disables the
    /// integration endpoints entirely rather than leaving them open.
    /// </summary>
    public string ApiKey { get; init; } = string.Empty;

    /// <summary>
    /// Origins allowed to embed the SCORM wrapper. The generated package posts
    /// results from the player iframe to one of these, so an unlisted origin is
    /// rejected at export time instead of failing silently in the LMS.
    /// </summary>
    public string[] AllowedLmsOrigins { get; init; } = [];

    public int MaxPageSize { get; init; } = 500;
    public int DefaultPageSize { get; init; } = 100;
}

/// <summary>Optional forwarding of xAPI statements to an external LRS.</summary>
public sealed record LrsOptions
{
    public const string SectionName = "Lrs";

    public bool Enabled { get; init; }

    /// <summary>Base xAPI endpoint, e.g. https://lrs.example.com/data/xAPI.</summary>
    public string Endpoint { get; init; } = string.Empty;

    public string Username { get; init; } = string.Empty;
    public string Password { get; init; } = string.Empty;

    /// <summary>Used to build an actor account IRI when the statement has no actor.</summary>
    public string ActorHomePage { get; init; } = "http://localhost:3000";
}
