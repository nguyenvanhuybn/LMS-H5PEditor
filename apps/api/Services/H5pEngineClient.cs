using System.Net;
using System.Text.Json;
using H5pLms.Api.Models;
using Microsoft.Extensions.Options;

namespace H5pLms.Api.Services;

public sealed class H5pEngineClient(HttpClient httpClient, IOptions<H5pOptions> options)
{
    private readonly H5pOptions _options = options.Value;

    private HttpRequestMessage CreateRequest(HttpMethod method, string url)
    {
        var request = new HttpRequestMessage(method, url);
        request.Headers.Add("X-H5P-Internal-Key", _options.InternalApiKey);
        return request;
    }

    /// <summary>
    /// Origins the engine will post results to. Null when the engine cannot be
    /// asked, which callers must treat as "unknown" rather than "none".
    /// </summary>
    public async Task<string[]?> GetEmbedOriginsAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var response = await httpClient.GetAsync("api/embed-origins", cancellationToken);
            if (!response.IsSuccessStatusCode) return null;

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var json = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
            if (!json.RootElement.TryGetProperty("origins", out var origins)) return null;

            return origins.EnumerateArray()
                .Select(item => item.GetString())
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Select(value => value!)
                .ToArray();
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            return null;
        }
    }

    public async Task<bool> IsHealthyAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var response = await httpClient.GetAsync("health", cancellationToken);
            return response.IsSuccessStatusCode;
        }
        catch (HttpRequestException)
        {
            return false;
        }
    }

    public async Task<string?> GetMainLibraryAsync(string contentId, CancellationToken cancellationToken)
    {
        using var request = CreateRequest(HttpMethod.Get, $"api/content/{Uri.EscapeDataString(contentId)}");
        using var response = await httpClient.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode) return null;

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var json = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        return json.RootElement.TryGetProperty("mainLibrary", out var value) ? value.GetString() : null;
    }

    public async Task DeleteAsync(string contentId, CancellationToken cancellationToken)
    {
        using var request = CreateRequest(HttpMethod.Delete, $"api/content/{Uri.EscapeDataString(contentId)}");
        using var response = await httpClient.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode && response.StatusCode != HttpStatusCode.NotFound)
        {
            throw new HttpRequestException($"H5P Engine trả về {(int)response.StatusCode} khi xóa nội dung.");
        }
    }

    /// <summary>
    /// Falls back to the engine's own default when the caller asks for a language
    /// the engine is not configured to serve.
    /// </summary>
    public string ResolveLanguage(string? language)
    {
        if (string.IsNullOrWhiteSpace(language)) return _options.DefaultLanguage;

        var normalized = language.Trim().ToLowerInvariant();
        return _options.SupportedLanguages.Contains(normalized, StringComparer.OrdinalIgnoreCase)
            ? normalized
            : _options.DefaultLanguage;
    }

    public string BuildPlayerUrl(string contentId, string userId, string? userName, string? language = null)
    {
        var query = $"userId={Uri.EscapeDataString(userId)}&userName={Uri.EscapeDataString(userName ?? userId)}&uiLanguage={Uri.EscapeDataString(ResolveLanguage(language))}";
        return $"{_options.PublicUrl.TrimEnd('/')}/play/{Uri.EscapeDataString(contentId)}?{query}";
    }

    /// <summary>
    /// Player URL with no learner attached, for embedders that supply the learner
    /// themselves at runtime (the SCORM wrapper reads it from the LMS API).
    /// </summary>
    /// <param name="relayResults">
    /// Whether the player should also post results back to this API. An exported
    /// package normally reports through its host's runtime instead, and having
    /// two systems of record for the same attempt causes more confusion than it
    /// solves.
    /// </param>
    public string BuildPlayerLaunchUrl(string contentId, string? language = null, bool relayResults = false)
    {
        var query = $"uiLanguage={Uri.EscapeDataString(ResolveLanguage(language))}&relay={(relayResults ? "1" : "0")}";
        return $"{_options.PublicUrl.TrimEnd('/')}/play/{Uri.EscapeDataString(contentId)}?{query}";
    }

    public string BuildEditorUrl(string? contentId, string returnUrl, string userId, string? userName, string? language = null)
    {
        var path = string.IsNullOrWhiteSpace(contentId)
            ? "/new"
            : $"/edit/{Uri.EscapeDataString(contentId)}";
        var query = $"returnUrl={Uri.EscapeDataString(returnUrl)}&userId={Uri.EscapeDataString(userId)}&userName={Uri.EscapeDataString(userName ?? userId)}&uiLanguage={Uri.EscapeDataString(ResolveLanguage(language))}";
        return $"{_options.PublicUrl.TrimEnd('/')}{path}?{query}";
    }
}
