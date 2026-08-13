using H5pLms.Api.Models;

namespace H5pLms.Api.Services;

/// <summary>
/// Turns what H5P reported into the completion verdict the operator configured.
///
/// The same rule is compiled into the SCORM/xAPI packages, so a learner working
/// inside an external LMS is judged by exactly these conditions.
/// </summary>
public static class CompletionEvaluator
{
    /// <param name="Record">
    /// False for progress pings that have not reached the target position — those
    /// would otherwise fill the results table with one row per slide.
    /// </param>
    public readonly record struct Verdict(bool Completed, bool Success, bool Record);

    public static Verdict Evaluate(
        CompletionRule rule,
        string verb,
        double scaledScore,
        bool reportedCompletion,
        bool reportedSuccess,
        int? position)
    {
        var normalised = rule.Normalised();
        var isProgress = verb.Equals("progressed", StringComparison.OrdinalIgnoreCase);

        // Only a position rule has any use for progress pings. Recording them in
        // the other modes would add a result row for every slide turn, and they
        // carry no score, so they would look like failed attempts.
        if (isProgress && normalised.Mode != CompletionMode.Position)
        {
            return new Verdict(reportedCompletion, reportedSuccess, Record: false);
        }

        switch (normalised.Mode)
        {
            case CompletionMode.Score:
                // Reaching the pass mark counts as finishing, even if the content
                // itself never sets completion (a quiz answered above threshold).
                var passed = scaledScore >= normalised.PassRatio;
                return new Verdict(reportedCompletion || passed, passed, Record: true);

            case CompletionMode.Position:
                if (position is null)
                {
                    // Content type reports no position; fall back rather than
                    // silently marking everyone incomplete forever.
                    return new Verdict(reportedCompletion, reportedSuccess, Record: true);
                }

                var reached = position.Value >= normalised.MinPosition;
                return new Verdict(reached, reached, Record: reached || reportedCompletion);

            default:
                return new Verdict(reportedCompletion, reportedSuccess, Record: true);
        }
    }
}
