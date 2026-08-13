using System.Text;
using H5pLms.Api.Models;
using H5pLms.Api.Services;
using Microsoft.Data.Sqlite;

namespace H5pLms.Api.Data;

public sealed class AppDatabase(IConfiguration configuration)
{
    private readonly string _connectionString = configuration.GetConnectionString("Default")
        ?? "Data Source=data/h5p-lms.db";

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        var builder = new SqliteConnectionStringBuilder(_connectionString);
        var path = builder.DataSource;
        if (!string.IsNullOrWhiteSpace(path))
        {
            var fullPath = Path.GetFullPath(path);
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        }

        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS h5p_contents (
                id TEXT PRIMARY KEY,
                h5p_content_id TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                main_library TEXT NULL,
                status TEXT NOT NULL DEFAULT 'published',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS h5p_grades (
                id TEXT PRIMARY KEY,
                content_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                score_raw REAL NOT NULL,
                score_max REAL NOT NULL,
                score_scaled REAL NOT NULL,
                completed INTEGER NOT NULL,
                success INTEGER NOT NULL,
                verb TEXT NOT NULL,
                statement_json TEXT NOT NULL,
                attempted_at TEXT NOT NULL,
                FOREIGN KEY(content_id) REFERENCES h5p_contents(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS ix_h5p_grades_content
                ON h5p_grades(content_id, attempted_at DESC);
            CREATE INDEX IF NOT EXISTS ix_h5p_grades_user
                ON h5p_grades(user_id, attempted_at DESC);
            PRAGMA optimize;
            """;
        await command.ExecuteNonQueryAsync(cancellationToken);

        await AddColumnIfMissingAsync(connection, "h5p_contents", "completion_mode", "TEXT NOT NULL DEFAULT 'Default'", cancellationToken);
        await AddColumnIfMissingAsync(connection, "h5p_contents", "pass_ratio", "REAL NOT NULL DEFAULT 0.5", cancellationToken);
        await AddColumnIfMissingAsync(connection, "h5p_contents", "min_position", "INTEGER NOT NULL DEFAULT 1", cancellationToken);
    }

    /// <summary>
    /// SQLite has no "ADD COLUMN IF NOT EXISTS", and databases created before the
    /// completion rule existed must keep working, so check the table first.
    /// </summary>
    private static async Task AddColumnIfMissingAsync(
        SqliteConnection connection,
        string table,
        string column,
        string definition,
        CancellationToken cancellationToken)
    {
        await using var probe = connection.CreateCommand();
        probe.CommandText = $"SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = $column;";
        probe.Parameters.AddWithValue("$column", column);
        var exists = Convert.ToInt64(await probe.ExecuteScalarAsync(cancellationToken)) > 0;
        if (exists) return;

        await using var alter = connection.CreateCommand();
        alter.CommandText = $"ALTER TABLE {table} ADD COLUMN {column} {definition};";
        await alter.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<ContentItem>> ListContentsAsync(CancellationToken cancellationToken)
    {
        var items = new List<ContentItem>();
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT c.id, c.h5p_content_id, c.title, c.main_library, c.status,
                   c.created_at, c.updated_at,
                   c.completion_mode, c.pass_ratio, c.min_position,
                   COUNT(g.id) AS attempt_count,
                   (SELECT g2.score_scaled
                      FROM h5p_grades g2
                     WHERE g2.content_id = c.id
                     ORDER BY g2.attempted_at DESC LIMIT 1) AS latest_score
              FROM h5p_contents c
              LEFT JOIN h5p_grades g ON g.content_id = c.id
             GROUP BY c.id
             ORDER BY c.updated_at DESC;
            """;

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            items.Add(ReadContent(reader));
        }

        return items;
    }

    public async Task<ContentItem?> GetContentAsync(string h5pContentId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT c.id, c.h5p_content_id, c.title, c.main_library, c.status,
                   c.created_at, c.updated_at,
                   c.completion_mode, c.pass_ratio, c.min_position,
                   COUNT(g.id) AS attempt_count,
                   (SELECT g2.score_scaled
                      FROM h5p_grades g2
                     WHERE g2.content_id = c.id
                     ORDER BY g2.attempted_at DESC LIMIT 1) AS latest_score
              FROM h5p_contents c
              LEFT JOIN h5p_grades g ON g.content_id = c.id
             WHERE c.h5p_content_id = $h5pContentId
             GROUP BY c.id;
            """;
        command.Parameters.AddWithValue("$h5pContentId", h5pContentId);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? ReadContent(reader) : null;
    }

    public async Task<ContentItem> UpsertContentAsync(
        ContentRegistrationRequest request,
        CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var id = Guid.NewGuid().ToString("N");
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO h5p_contents
                (id, h5p_content_id, title, main_library, status, created_at, updated_at)
            VALUES
                ($id, $h5pContentId, $title, $mainLibrary, 'published', $now, $now)
            ON CONFLICT(h5p_content_id) DO UPDATE SET
                title = excluded.title,
                main_library = COALESCE(excluded.main_library, h5p_contents.main_library),
                updated_at = excluded.updated_at;
            """;
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$h5pContentId", request.H5pContentId);
        command.Parameters.AddWithValue("$title", string.IsNullOrWhiteSpace(request.Title) ? "Nội dung chưa đặt tên" : request.Title.Trim());
        command.Parameters.AddWithValue("$mainLibrary", (object?)request.MainLibrary ?? DBNull.Value);
        command.Parameters.AddWithValue("$now", now.ToString("O"));
        await command.ExecuteNonQueryAsync(cancellationToken);

        return (await GetContentAsync(request.H5pContentId, cancellationToken))!;
    }

    public async Task<ContentItem?> UpdateCompletionRuleAsync(
        string h5pContentId,
        CompletionRule rule,
        CancellationToken cancellationToken)
    {
        var normalised = rule.Normalised();

        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE h5p_contents
               SET completion_mode = $mode,
                   pass_ratio = $passRatio,
                   min_position = $minPosition,
                   updated_at = $now
             WHERE h5p_content_id = $h5pContentId;
            """;
        command.Parameters.AddWithValue("$mode", normalised.Mode.ToString());
        command.Parameters.AddWithValue("$passRatio", normalised.PassRatio);
        command.Parameters.AddWithValue("$minPosition", normalised.MinPosition);
        command.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O"));
        command.Parameters.AddWithValue("$h5pContentId", h5pContentId);

        var affected = await command.ExecuteNonQueryAsync(cancellationToken);
        return affected == 0 ? null : await GetContentAsync(h5pContentId, cancellationToken);
    }

    public async Task<bool> DeleteContentAsync(string h5pContentId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await using var deleteGrades = connection.CreateCommand();
        deleteGrades.Transaction = (SqliteTransaction)transaction;
        deleteGrades.CommandText = "DELETE FROM h5p_grades WHERE content_id IN (SELECT id FROM h5p_contents WHERE h5p_content_id = $id);";
        deleteGrades.Parameters.AddWithValue("$id", h5pContentId);
        await deleteGrades.ExecuteNonQueryAsync(cancellationToken);

        await using var deleteContent = connection.CreateCommand();
        deleteContent.Transaction = (SqliteTransaction)transaction;
        deleteContent.CommandText = "DELETE FROM h5p_contents WHERE h5p_content_id = $id;";
        deleteContent.Parameters.AddWithValue("$id", h5pContentId);
        var affected = await deleteContent.ExecuteNonQueryAsync(cancellationToken);

        await transaction.CommitAsync(cancellationToken);
        return affected > 0;
    }

    public async Task<IReadOnlyList<GradeItem>> ListGradesAsync(string h5pContentId, CancellationToken cancellationToken)
    {
        var items = new List<GradeItem>();
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT g.id, g.content_id, g.user_id, g.score_raw, g.score_max,
                   g.score_scaled, g.completed, g.success, g.verb, g.attempted_at
              FROM h5p_grades g
              JOIN h5p_contents c ON c.id = g.content_id
             WHERE c.h5p_content_id = $h5pContentId
             ORDER BY g.attempted_at DESC;
            """;
        command.Parameters.AddWithValue("$h5pContentId", h5pContentId);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            items.Add(new GradeItem(
                reader.GetString(0), reader.GetString(1), reader.GetString(2),
                reader.GetDouble(3), reader.GetDouble(4), reader.GetDouble(5),
                reader.GetBoolean(6), reader.GetBoolean(7), reader.GetString(8),
                DateTimeOffset.Parse(reader.GetString(9))));
        }

        return items;
    }

    /// <summary>
    /// Keyset pagination over attempts, oldest first, so an LMS can poll with the
    /// previous page's cursor and never re-read or skip a row. Ordering by
    /// (attempted_at, id) keeps it stable when several attempts share a timestamp.
    /// </summary>
    public async Task<ResultPage> ListResultsAsync(
        string? cursor,
        DateTimeOffset? since,
        string? h5pContentId,
        string? userId,
        int limit,
        CancellationToken cancellationToken)
    {
        var filters = new List<string>();
        var parameters = new Dictionary<string, object>();

        if (TryDecodeCursor(cursor, out var cursorAt, out var cursorId))
        {
            filters.Add("(g.attempted_at > $cursorAt OR (g.attempted_at = $cursorAt AND g.id > $cursorId))");
            parameters["$cursorAt"] = cursorAt.ToString("O");
            parameters["$cursorId"] = cursorId;
        }
        else if (since.HasValue)
        {
            filters.Add("g.attempted_at >= $since");
            parameters["$since"] = since.Value.ToString("O");
        }

        if (!string.IsNullOrWhiteSpace(h5pContentId))
        {
            filters.Add("c.h5p_content_id = $h5pContentId");
            parameters["$h5pContentId"] = h5pContentId;
        }

        if (!string.IsNullOrWhiteSpace(userId))
        {
            filters.Add("g.user_id = $userId");
            parameters["$userId"] = userId;
        }

        var where = filters.Count > 0 ? "WHERE " + string.Join(" AND ", filters) : string.Empty;

        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        // One extra row tells us whether another page exists without a second query.
        command.CommandText = $"""
            SELECT g.id, c.h5p_content_id, c.title, c.main_library, g.user_id,
                   g.score_raw, g.score_max, g.score_scaled, g.completed, g.success,
                   g.verb, g.attempted_at
              FROM h5p_grades g
              JOIN h5p_contents c ON c.id = g.content_id
              {where}
             ORDER BY g.attempted_at ASC, g.id ASC
             LIMIT $limit;
            """;
        foreach (var (key, value) in parameters) command.Parameters.AddWithValue(key, value);
        command.Parameters.AddWithValue("$limit", limit + 1);

        var items = new List<ResultItem>();
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
            {
                items.Add(new ResultItem(
                    reader.GetString(0),
                    reader.GetString(1),
                    reader.GetString(2),
                    reader.IsDBNull(3) ? null : reader.GetString(3),
                    reader.GetString(4),
                    reader.GetDouble(5),
                    reader.GetDouble(6),
                    reader.GetDouble(7),
                    reader.GetBoolean(8),
                    reader.GetBoolean(9),
                    reader.GetString(10),
                    DateTimeOffset.Parse(reader.GetString(11))));
            }
        }

        var hasMore = items.Count > limit;
        if (hasMore) items.RemoveAt(items.Count - 1);

        var last = items.Count > 0 ? items[^1] : null;
        var nextCursor = last is null ? cursor : EncodeCursor(last.AttemptedAt, last.Id);

        return new ResultPage(items, nextCursor, hasMore);
    }

    private static string EncodeCursor(DateTimeOffset attemptedAt, string id) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes($"{attemptedAt:O}|{id}"));

    private static bool TryDecodeCursor(string? cursor, out DateTimeOffset attemptedAt, out string id)
    {
        attemptedAt = default;
        id = string.Empty;
        if (string.IsNullOrWhiteSpace(cursor)) return false;

        try
        {
            var parts = Encoding.UTF8.GetString(Convert.FromBase64String(cursor)).Split('|', 2);
            if (parts.Length != 2 || !DateTimeOffset.TryParse(parts[0], out attemptedAt)) return false;
            id = parts[1];
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    /// <summary>
    /// Applies the content's completion rule to what H5P reported. Returns null
    /// when the content is not registered, and null when the rule says this
    /// event is not worth recording (a progress ping short of the target).
    /// </summary>
    public async Task<GradeItem?> SaveGradeAsync(
        string h5pContentId,
        string userId,
        double raw,
        double max,
        bool completed,
        bool success,
        string verb,
        int? position,
        string statementJson,
        CancellationToken cancellationToken)
    {
        var content = await GetContentAsync(h5pContentId, cancellationToken);
        if (content is null) return null;

        var scaled = max > 0 ? Math.Clamp(raw / max, 0, 1) : 0;
        var verdict = CompletionEvaluator.Evaluate(content.Completion, verb, scaled, completed, success, position);
        if (!verdict.Record) return null;

        completed = verdict.Completed;
        success = verdict.Success;

        var id = Guid.NewGuid().ToString("N");
        var attemptedAt = DateTimeOffset.UtcNow;

        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO h5p_grades
                (id, content_id, user_id, score_raw, score_max, score_scaled,
                 completed, success, verb, statement_json, attempted_at)
            VALUES
                ($id, $contentId, $userId, $raw, $max, $scaled,
                 $completed, $success, $verb, $json, $attemptedAt);
            """;
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$contentId", content.Id);
        command.Parameters.AddWithValue("$userId", userId);
        command.Parameters.AddWithValue("$raw", raw);
        command.Parameters.AddWithValue("$max", max);
        command.Parameters.AddWithValue("$scaled", scaled);
        command.Parameters.AddWithValue("$completed", completed);
        command.Parameters.AddWithValue("$success", success);
        command.Parameters.AddWithValue("$verb", verb);
        command.Parameters.AddWithValue("$json", statementJson);
        command.Parameters.AddWithValue("$attemptedAt", attemptedAt.ToString("O"));
        await command.ExecuteNonQueryAsync(cancellationToken);

        return new GradeItem(id, content.Id, userId, raw, max, scaled, completed, success, verb, attemptedAt);
    }

    private async Task<SqliteConnection> OpenAsync(CancellationToken cancellationToken)
    {
        var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA foreign_keys = ON;";
        await command.ExecuteNonQueryAsync(cancellationToken);
        return connection;
    }

    private static ContentItem ReadContent(SqliteDataReader reader) => new(
        reader.GetString(0),
        reader.GetString(1),
        reader.GetString(2),
        reader.IsDBNull(3) ? null : reader.GetString(3),
        reader.GetString(4),
        DateTimeOffset.Parse(reader.GetString(5)),
        DateTimeOffset.Parse(reader.GetString(6)),
        reader.GetInt32(10),
        reader.IsDBNull(11) ? null : reader.GetDouble(11),
        Enum.TryParse<CompletionMode>(reader.GetString(7), ignoreCase: true, out var mode) ? mode : CompletionMode.Default,
        reader.GetDouble(8),
        reader.GetInt32(9));
}
