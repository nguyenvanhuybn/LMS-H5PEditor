using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using H5pLms.Api.Models;
using Microsoft.Extensions.Options;

namespace H5pLms.Api.Services;

/// <summary>
/// Forwards xAPI statements to an external LRS. Failures are logged and
/// swallowed: a learner's attempt is already stored locally by the time this
/// runs, and losing the LRS copy must not turn into a failed webhook that H5P
/// would surface to the learner.
/// </summary>
public sealed class LrsClient(HttpClient httpClient, IOptions<LrsOptions> options, ILogger<LrsClient> logger)
{
    private readonly LrsOptions _options = options.Value;

    public bool IsEnabled =>
        _options.Enabled && !string.IsNullOrWhiteSpace(_options.Endpoint);

    public async Task<bool> SendAsync(JsonElement statement, string userId, CancellationToken cancellationToken)
    {
        if (!IsEnabled) return false;

        try
        {
            var payload = Normalise(statement, userId);
            using var request = new HttpRequestMessage(HttpMethod.Post, "statements")
            {
                Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json")
            };
            request.Headers.Add("X-Experience-API-Version", "1.0.3");

            if (!string.IsNullOrEmpty(_options.Username))
            {
                var credentials = Convert.ToBase64String(
                    Encoding.UTF8.GetBytes($"{_options.Username}:{_options.Password}"));
                request.Headers.Authorization = new AuthenticationHeaderValue("Basic", credentials);
            }

            using var response = await httpClient.SendAsync(request, cancellationToken);
            if (response.IsSuccessStatusCode) return true;

            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            logger.LogWarning("LRS rejected statement ({Status}): {Body}", (int)response.StatusCode, body);
            return false;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            logger.LogWarning(ex, "Could not forward statement to the LRS.");
            return false;
        }
    }

    /// <summary>
    /// H5P statements omit the actor (the player has no trusted identity) and a
    /// timestamp, both of which an LRS requires. Fill them from what the LMS
    /// told us without touching anything the statement already carries.
    /// </summary>
    private JsonNode Normalise(JsonElement statement, string userId)
    {
        var node = JsonNode.Parse(statement.GetRawText())?.AsObject()
            ?? throw new JsonException("xAPI statement is not a JSON object.");

        if (node["actor"] is null)
        {
            node["actor"] = new JsonObject
            {
                ["objectType"] = "Agent",
                ["account"] = new JsonObject
                {
                    ["homePage"] = _options.ActorHomePage,
                    ["name"] = userId
                }
            };
        }

        node["timestamp"] ??= DateTimeOffset.UtcNow.ToString("O");
        return node;
    }
}
