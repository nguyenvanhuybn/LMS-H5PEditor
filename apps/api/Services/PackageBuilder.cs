using System.Globalization;
using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json;
using H5pLms.Api.Models;
using Microsoft.Extensions.Options;

namespace H5pLms.Api.Services;

public enum PackageFormat
{
    Scorm12,
    Scorm2004,
    XApi
}

/// <summary>
/// Builds a distributable package that wraps the hosted H5P player in an iframe.
///
/// No format bundles the H5P runtime. A self-contained package would run entirely
/// inside the LMS and its results would never reach this API, leaving the results
/// pull endpoint permanently empty. Wrapping the hosted player instead makes every
/// attempt land in both places: the LMS (or LRS) through the package runtime, and
/// this database through the engine's xAPI relay.
/// </summary>
public sealed class PackageBuilder(IOptions<IntegrationOptions> integrationOptions)
{
    private readonly IntegrationOptions _options = integrationOptions.Value;

    /// <summary>
    /// Bump when the package runtime changes behaviour an operator would need to
    /// re-export for. A package already uploaded to an LMS is a frozen copy.
    /// </summary>
    private const string RuntimeVersion = "2026.08.12-outcome-statements";

    public static bool TryParseFormat(string? value, out PackageFormat format)
    {
        format = PackageFormat.Scorm12;
        return value?.ToLowerInvariant() switch
        {
            null or "" or "scorm12" or "scorm-1.2" => true,
            "scorm2004" or "scorm-2004" => Assign(PackageFormat.Scorm2004, out format),
            "xapi" or "tincan" => Assign(PackageFormat.XApi, out format),
            _ => false
        };

        static bool Assign(PackageFormat value, out PackageFormat target)
        {
            target = value;
            return true;
        }
    }

    public bool IsOriginAllowed(string origin) =>
        _options.AllowedLmsOrigins.Contains("*") ||
        _options.AllowedLmsOrigins.Contains(origin, StringComparer.OrdinalIgnoreCase);

    public string FileNameFor(ContentItem content, PackageFormat format)
    {
        var suffix = format switch
        {
            PackageFormat.Scorm12 => "scorm12",
            PackageFormat.Scorm2004 => "scorm2004",
            PackageFormat.XApi => "xapi",
            _ => "package"
        };
        return $"h5p-{content.H5pContentId}-{suffix}.zip";
    }

    public byte[] Build(ContentItem content, string playerUrl, string playerOrigin, PackageFormat format)
    {
        using var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            if (format == PackageFormat.XApi)
            {
                AddEntry(archive, "tincan.xml", BuildTinCanManifest(content, playerOrigin));
            }
            else
            {
                AddEntry(archive, "imsmanifest.xml", BuildScormManifest(content, format));
            }


            AddEntry(archive, "index.html", BuildLauncherPage(content, playerUrl, playerOrigin, format));
            AddEntry(archive, "h5p-launcher.js", LauncherScript);
            AddEntry(archive, "h5p-adapter.js", AdapterScriptFor(format));
        }

        return buffer.ToArray();
    }

    private static void AddEntry(ZipArchive archive, string name, string content)
    {
        var entry = archive.CreateEntry(name, CompressionLevel.Optimal);
        using var stream = entry.Open();
        using var writer = new StreamWriter(stream, new UTF8Encoding(false));
        writer.Write(content);
    }

    // -----------------------------------------------------------------------
    // Manifests
    // -----------------------------------------------------------------------

    private static string BuildScormManifest(ContentItem content, PackageFormat format)
    {
        var id = $"H5P-{content.H5pContentId}";
        var title = WebUtility.HtmlEncode(content.Title);
        var files = """
                      <file href="index.html"/>
                      <file href="h5p-launcher.js"/>
                      <file href="h5p-adapter.js"/>
            """;

        // SCORM 2004 renamed the attribute's casing and moved every namespace.
        if (format == PackageFormat.Scorm2004)
        {
            return $"""
                <?xml version="1.0" encoding="UTF-8"?>
                <manifest identifier="{id}" version="1"
                          xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
                          xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3"
                          xmlns:adlseq="http://www.adlnet.org/xsd/adlseq_v1p3"
                          xmlns:adlnav="http://www.adlnet.org/xsd/adlnav_v1p3"
                          xmlns:imsss="http://www.imsglobal.org/xsd/imsss"
                          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                          xsi:schemaLocation="http://www.imsglobal.org/xsd/imscp_v1p1 imscp_v1p1.xsd
                                              http://www.adlnet.org/xsd/adlcp_v1p3 adlcp_v1p3.xsd
                                              http://www.adlnet.org/xsd/adlseq_v1p3 adlseq_v1p3.xsd
                                              http://www.adlnet.org/xsd/adlnav_v1p3 adlnav_v1p3.xsd
                                              http://www.imsglobal.org/xsd/imsss imsss_v1p0.xsd">
                  <metadata>
                    <schema>ADL SCORM</schema>
                    <schemaversion>2004 4th Edition</schemaversion>
                  </metadata>
                  <organizations default="{id}-org">
                    <organization identifier="{id}-org">
                      <title>{title}</title>
                      <item identifier="{id}-item" identifierref="{id}-res">
                        <title>{title}</title>
                        <adlcp:completionThreshold completedByMeasure="false"/>
                        <imsss:sequencing>
                          <imsss:objectives>
                            <imsss:primaryObjective satisfiedByMeasure="true"
                                                    objectiveID="{id}-obj">
                              <imsss:minNormalizedMeasure>{content.Completion.PassRatio.ToString("0.0###", CultureInfo.InvariantCulture)}</imsss:minNormalizedMeasure>
                            </imsss:primaryObjective>
                          </imsss:objectives>
                        </imsss:sequencing>
                      </item>
                    </organization>
                  </organizations>
                  <resources>
                    <resource identifier="{id}-res" type="webcontent" adlcp:scormType="sco" href="index.html">
                {files}
                    </resource>
                  </resources>
                </manifest>
                """;
        }

        return $"""
            <?xml version="1.0" encoding="UTF-8"?>
            <manifest identifier="{id}" version="1.2"
                      xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
                      xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
                      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                      xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd
                                          http://www.imsglobal.org/xsd/imsmd_rootv1p2p1 imsmd_rootv1p2p1.xsd
                                          http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
              <metadata>
                <schema>ADL SCORM</schema>
                <schemaversion>1.2</schemaversion>
              </metadata>
              <organizations default="{id}-org">
                <organization identifier="{id}-org">
                  <title>{title}</title>
                  <item identifier="{id}-item" identifierref="{id}-res" isvisible="true">
                    <title>{title}</title>
                    <adlcp:masteryscore>{content.Completion.PassPercent}</adlcp:masteryscore>
                  </item>
                </organization>
              </organizations>
              <resources>
                <resource identifier="{id}-res" type="webcontent" adlcp:scormtype="sco" href="index.html">
            {files}
                </resource>
              </resources>
            </manifest>
            """;
    }

    private static string BuildTinCanManifest(ContentItem content, string playerOrigin)
    {
        var title = WebUtility.HtmlEncode(content.Title);
        var activityId = $"{playerOrigin}/h5p/{content.H5pContentId}";

        return $"""
            <?xml version="1.0" encoding="UTF-8"?>
            <tincan xmlns="http://projecttincan.com/tincan.xsd">
              <activities>
                <activity id="{activityId}" type="http://adlnet.gov/expapi/activities/module">
                  <name>{title}</name>
                  <description lang="vi">Nội dung H5P: {title}</description>
                  <launch lang="en-US">index.html</launch>
                </activity>
              </activities>
            </tincan>
            """;
    }

    // -----------------------------------------------------------------------
    // Launcher page
    // -----------------------------------------------------------------------

    private static string BuildLauncherPage(ContentItem content, string playerUrl, string playerOrigin, PackageFormat format)
    {
        var title = WebUtility.HtmlEncode(content.Title);
        var activityId = $"{playerOrigin}/h5p/{content.H5pContentId}";

        return $$"""
            <!doctype html>
            <html lang="vi">
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <title>{{title}}</title>
              <style>
                html, body { margin: 0; height: 100%; background: #fff; font-family: system-ui, sans-serif; }
                #h5p-frame { display: block; border: 0; width: 100%; height: 100%; min-height: 640px; }
                #h5p-status { margin: 0; padding: 10px 14px; font-size: 13px; color: #92400e; background: #fffbeb; display: none; }
              </style>
            </head>
            <body>
              <p id="h5p-status"></p>
              <iframe id="h5p-frame" title="{{title}}" allow="fullscreen; autoplay" src=""></iframe>
              <script>
                window.H5P_PACKAGE_CONFIG = {
                  playerUrl: {{Quote(playerUrl)}},
                  playerOrigin: {{Quote(playerOrigin)}},
                  contentId: {{Quote(content.H5pContentId)}},
                  activityId: {{Quote(activityId)}},
                  title: {{Quote(content.Title)}},
                  format: {{Quote(format.ToString())}},
                  // Printed on launch so an operator can tell which build of the
                  // package an LMS is actually serving, without unzipping it.
                  builtAt: {{Quote(DateTimeOffset.UtcNow.ToString("O"))}},
                  runtime: {{Quote(RuntimeVersion)}},
                  completion: {
                    mode: {{Quote(content.Completion.Mode.ToString().ToLowerInvariant())}},
                    passRatio: {{content.Completion.PassRatio.ToString("0.0###", CultureInfo.InvariantCulture)}},
                    minPosition: {{content.Completion.MinPosition}}
                  }
                };
              </script>
              <script src="h5p-adapter.js"></script>
              <script src="h5p-launcher.js"></script>
            </body>
            </html>
            """;
    }

    // -----------------------------------------------------------------------
    // Runtime: one shared launcher, one adapter per format
    // -----------------------------------------------------------------------

    /// <summary>
    /// Format-independent half: ask the adapter who the learner is, launch the
    /// player for them, and hand every result back to the adapter.
    /// </summary>
    private const string LauncherScript =
        """
        (function () {
          'use strict';

          var config = window.H5P_PACKAGE_CONFIG;
          var adapter = window.H5P_PACKAGE_ADAPTER;

          function showStatus(message) {
            var el = document.getElementById('h5p-status');
            el.textContent = message;
            el.style.display = 'block';
          }

          // Adapters live in their own file and cannot reach showStatus directly.
          window.H5P_PACKAGE_REPORT = showStatus;

          if (window.console) {
            console.info('H5P package runtime ' + config.runtime + ', built ' + config.builtAt +
              ', completion rule ' + JSON.stringify(config.completion));
          }

          var started = adapter.init();
          if (!started.ok) showStatus(started.message);

          var learner = adapter.learner();

          // The host decides whether this is a continuation or a new attempt;
          // the player clears the learner's saved progress when it is new, so a
          // reset in the LMS is not undone by stale server-side state.
          var resumeState = adapter.resume ? adapter.resume() : { resume: true, location: '', state: '' };

          /*
           * The learner's H5P state is JSON; deflate + base64 keeps it inside the
           * host's suspend-data budget far more often than raw text would.
           * Browsers without CompressionStream simply skip the LMS-side copy —
           * the player still has its own server-side state.
           */
          var CAN_COMPRESS = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

          function toBase64(bytes) {
            var binary = '';
            for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            return btoa(binary);
          }

          function fromBase64(text) {
            var binary = atob(text);
            var bytes = new Uint8Array(binary.length);
            for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return bytes;
          }

          function packState(json) {
            if (!CAN_COMPRESS) return Promise.resolve(null);
            var stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
            return new Response(stream).arrayBuffer().then(function (buffer) {
              return toBase64(new Uint8Array(buffer));
            });
          }

          function unpackState(packed) {
            if (!packed || !CAN_COMPRESS) return Promise.resolve(null);
            try {
              var stream = new Blob([fromBase64(packed)]).stream()
                .pipeThrough(new DecompressionStream('deflate-raw'));
              return new Response(stream).text();
            } catch (error) {
              return Promise.resolve(null);
            }
          }

          // Identity comes from the host (LMS or LRS launch parameters). It is
          // asserted by the host and travels through the browser, so downstream
          // consumers should treat it as a label rather than proof of identity.
          // Only make the player wait for us when we actually hold a state to
          // give it; otherwise it would stall for nothing on every launch.
          var hostHasState = Boolean(resumeState.resume && resumeState.state && CAN_COMPRESS);

          var separator = config.playerUrl.indexOf('?') === -1 ? '?' : '&';
          document.getElementById('h5p-frame').src = config.playerUrl + separator +
            'userId=' + encodeURIComponent(learner.id) +
            '&userName=' + encodeURIComponent(learner.name) +
            '&resume=' + (resumeState.resume ? '1' : '0') +
            '&awaitState=' + (hostHasState ? '1' : '0') +
            '&embedOrigin=' + encodeURIComponent(window.location.origin);

          var ENDING_POINT = 'http://id.tincanapi.com/extension/ending-point';

          /* How far the learner got, when the content type reports it at all. */
          function positionOf(statement) {
            var onObject = statement.object && statement.object.definition && statement.object.definition.extensions;
            if (onObject && typeof onObject[ENDING_POINT] === 'number') return onObject[ENDING_POINT];
            var onContext = statement.context && statement.context.extensions;
            if (onContext && typeof onContext[ENDING_POINT] === 'number') return onContext[ENDING_POINT];
            return null;
          }

          /*
           * The completion rule lives here rather than in each adapter, so all
           * three package formats reach the same verdict from the same statement
           * — and the same one H5P Studio reaches server-side.
           */
          function evaluate(statement) {
            var rule = config.completion || { mode: 'default' };
            var verb = (statement.verb && statement.verb.id) || '';

            // A progress ping carries no score, so outside a position rule it must
            // not touch status — but it is still the only signal of where the
            // learner is, which is exactly what a bookmark needs.
            if (verb.indexOf('progressed') !== -1 && rule.mode !== 'position') {
              return {
                record: true,
                bookmarkOnly: true,
                position: positionOf(statement),
                completed: false,
                success: false,
                scored: false,
                score: null
              };
            }

            var result = statement.result || {};
            var score = result.score || {};
            var hasScore = typeof score.raw === 'number';
            var min = typeof score.min === 'number' ? score.min : 0;
            var max = typeof score.max === 'number' ? score.max : 0;
            var scaled = typeof score.scaled === 'number'
              ? score.scaled
              : (hasScore && max > min ? (score.raw - min) / (max - min) : 0);

            var verdict = {
              record: true,
              completed: result.completion === true,
              success: result.success === true,
              // Whether pass/fail carries meaning; without it a plain "finished"
              // event would be reported to the LMS as a failure.
              scored: typeof result.success === 'boolean',
              score: hasScore ? { raw: score.raw, min: min, max: max, scaled: scaled } : null,
              position: positionOf(statement)
            };

            if (rule.mode === 'score') {
              var passed = scaled >= rule.passRatio;
              verdict.completed = verdict.completed || passed;
              verdict.success = passed;
              verdict.scored = true;
            } else if (rule.mode === 'position' && verdict.position !== null) {
              var reached = verdict.position >= rule.minPosition;
              verdict.completed = reached;
              verdict.success = reached;
              verdict.scored = true;
              // Progress short of the target is not a result worth reporting.
              verdict.record = reached || result.completion === true;
            }

            return verdict;
          }

          var latestState = null;
          var packedState = null;
          var stateSequence = 0;

          window.addEventListener('message', function (event) {
            if (event.origin !== config.playerOrigin) return;
            var data = event.data;
            if (!data) return;

            // The player is asking for the copy the host kept for this learner.
            if (data.type === 'h5p-state-request') {
              var frame = document.getElementById('h5p-frame');
              unpackState(resumeState.state).then(function (state) {
                frame.contentWindow.postMessage(
                  { type: 'h5p-state-restore', state: state || '' },
                  config.playerOrigin
                );
              });
              return;
            }

            if (data.type === 'h5p-state' && typeof data.state === 'string') {
              latestState = data.state;
              // Pack as soon as it arrives. On a timer the packed copy lags the
              // learner, and answering then leaving immediately would lose it.
              var sequence = ++stateSequence;
              packState(latestState).then(function (packed) {
                // Ignore a slow compression that finished after a newer one.
                if (packed && sequence === stateSequence) packedState = packed;
              });
              return;
            }

            if (data.type !== 'h5p-result' || !data.statement) return;
            try {
              var verdict = evaluate(data.statement);
              if (!verdict.record) return;
              adapter.record(verdict, data.statement);
            } catch (error) {
              showStatus('Không ghi được kết quả: ' + error.message);
            }
          });

          window.addEventListener('beforeunload', function () {
            // Compression is async and unload will not wait, so the adapter gets
            // the copy packed when the player last reported its state.
            adapter.finish(packedState);
          });
        })();
        """;

    private static string AdapterScriptFor(PackageFormat format) => format switch
    {
        PackageFormat.Scorm2004 => Scorm2004Adapter,
        PackageFormat.XApi => XApiAdapter,
        _ => Scorm12Adapter
    };

    private const string Scorm12Adapter =
        """
        (function () {
          'use strict';

          // Each file is its own IIFE, so the adapter reads the config itself
          // rather than borrowing the launcher's variable.
          var config = window.H5P_PACKAGE_CONFIG;
          var api = null;
          var live = false;
          var startedAt = Date.now();
          var lastVerdict = null;
          var lastPosition = null;

          /* SCORM 1.2 guarantees only 4096 characters of suspend data. */
          var SUSPEND_DATA_LIMIT = 4096;

          /* SCORM 1.2 session time is HHHH:MM:SS.SS. */
          function sessionTime() {
            var total = Math.max(0, (Date.now() - startedAt) / 1000);
            var hours = Math.floor(total / 3600);
            var minutes = Math.floor((total % 3600) / 60);
            var seconds = total % 60;
            function pad(value) { return (value < 10 ? '0' : '') + value; }
            return pad(hours) + ':' + pad(minutes) + ':' + (seconds < 10 ? '0' : '') + seconds.toFixed(2);
          }

          // SCORM 1.2 exposes the API on an ancestor window or on the opener.
          function search(win) {
            var depth = 0;
            while (win && depth < 500) {
              if (win.API) return win.API;
              if (win.parent === win) break;
              win = win.parent;
              depth++;
            }
            return null;
          }

          function get(name) {
            var value = api ? api.LMSGetValue(name) : '';
            return value === null || value === undefined ? '' : String(value);
          }

          window.H5P_PACKAGE_ADAPTER = {
            init: function () {
              api = search(window) || (window.opener ? search(window.opener) : null);
              if (!api) {
                return { ok: false, message: 'Không tìm thấy SCORM API của LMS — kết quả không vào sổ điểm, nhưng vẫn được gửi về H5P Studio.' };
              }
              live = api.LMSInitialize('') === 'true';
              if (!live) return { ok: false, message: 'LMSInitialize thất bại: ' + api.LMSGetLastError() };

              if (get('cmi.core.lesson_status') === 'not attempted') {
                api.LMSSetValue('cmi.core.lesson_status', 'incomplete');
              }
              api.LMSCommit('');
              return { ok: true, message: '' };
            },

            learner: function () {
              var id = get('cmi.core.student_id') || 'scorm-anonymous';
              return { id: id, name: get('cmi.core.student_name') || id };
            },

            /*
             * The LMS owns the attempt: suspend data present means it is handing
             * back a suspended attempt and the learner should carry on, empty
             * means a fresh attempt and the player must start clean.
             */
            resume: function () {
              var raw = get('cmi.suspend_data');
              var parsed = null;
              try { parsed = raw ? JSON.parse(raw) : null; } catch (error) { parsed = null; }
              return {
                resume: raw !== '',
                location: get('cmi.core.lesson_location'),
                state: parsed && parsed.s ? parsed.s : ''
              };
            },

            record: function (verdict) {
              if (!live) return;

              if (verdict.position !== null && verdict.position !== undefined) {
                lastPosition = verdict.position;
                api.LMSSetValue('cmi.core.lesson_location', String(verdict.position));
              }

              // A bookmark update must not disturb status or score.
              if (verdict.bookmarkOnly) {
                api.LMSCommit('');
                return;
              }

              lastVerdict = verdict;

              if (verdict.score) {
                // SCORM 1.2 defines cmi.core.score.raw on a 0..100 scale and the
                // LMS compares it against adlcp:masteryscore, which is a
                // percentage. Reporting the content's own raw points (7 of 10)
                // against a mastery score of 70 would read as a fail, so report
                // the percentage — the same thing Articulate publishes.
                api.LMSSetValue('cmi.core.score.raw', String(Math.round(verdict.score.scaled * 10000) / 100));
                api.LMSSetValue('cmi.core.score.min', '0');
                api.LMSSetValue('cmi.core.score.max', '100');
              }

              var status;
              if (verdict.scored) status = verdict.success ? 'passed' : (verdict.completed ? 'failed' : 'incomplete');
              else status = verdict.completed ? 'completed' : 'incomplete';

              api.LMSSetValue('cmi.core.lesson_status', status);
              api.LMSSetValue('cmi.core.session_time', sessionTime());
              api.LMSCommit('');
            },

            finish: function (packedState) {
              if (!live) return;
              // Time and exit belong to every session, not only scored ones.
              api.LMSSetValue('cmi.core.session_time', sessionTime());

              // Leaving before finishing must suspend the attempt, not end it —
              // that is what makes the LMS hand the attempt back next time.
              var finished = lastVerdict && lastVerdict.completed;
              if (finished) {
                api.LMSSetValue('cmi.core.exit', '');
                api.LMSSetValue('cmi.suspend_data', '');
              } else {
                api.LMSSetValue('cmi.core.exit', 'suspend');

                var payload = { v: 1, contentId: config.contentId, position: lastPosition };
                if (packedState) payload.s = packedState;

                // SCORM 1.2 only guarantees 4096 characters. Rather than write a
                // value the LMS may truncate — which would corrupt the state on
                // the way back — drop the state and keep the marker; the player's
                // server-side copy still resumes the learner.
                var serialised = JSON.stringify(payload);
                if (serialised.length > SUSPEND_DATA_LIMIT && payload.s) {
                  delete payload.s;
                  serialised = JSON.stringify(payload);
                }

                api.LMSSetValue('cmi.suspend_data', serialised);
              }

              api.LMSCommit('');
              api.LMSFinish('');
              live = false;
            }
          };
        })();
        """;

    private const string Scorm2004Adapter =
        """
        (function () {
          'use strict';

          // Each file is its own IIFE, so the adapter reads the config itself
          // rather than borrowing the launcher's variable.
          var config = window.H5P_PACKAGE_CONFIG;
          var api = null;
          var live = false;
          var startedAt = Date.now();
          var lastVerdict = null;
          var lastPosition = null;

          /* SCORM 2004 raises the suspend data budget to 64000 characters. */
          var SUSPEND_DATA_LIMIT = 64000;

          /* SCORM 2004 session time is an ISO 8601 duration. */
          function sessionTime() {
            var total = Math.max(0, (Date.now() - startedAt) / 1000);
            var hours = Math.floor(total / 3600);
            var minutes = Math.floor((total % 3600) / 60);
            var seconds = Math.round((total % 60) * 100) / 100;
            return 'PT' + (hours ? hours + 'H' : '') + (minutes ? minutes + 'M' : '') + seconds + 'S';
          }

          // SCORM 2004 renamed the object and every method on it.
          function search(win) {
            var depth = 0;
            while (win && depth < 500) {
              if (win.API_1484_11) return win.API_1484_11;
              if (win.parent === win) break;
              win = win.parent;
              depth++;
            }
            return null;
          }

          function get(name) {
            var value = api ? api.GetValue(name) : '';
            return value === null || value === undefined ? '' : String(value);
          }

          window.H5P_PACKAGE_ADAPTER = {
            init: function () {
              api = search(window) || (window.opener ? search(window.opener) : null);
              if (!api) {
                return { ok: false, message: 'Không tìm thấy SCORM 2004 API của LMS — kết quả không vào sổ điểm, nhưng vẫn được gửi về H5P Studio.' };
              }
              live = api.Initialize('') === 'true';
              if (!live) return { ok: false, message: 'Initialize thất bại: ' + api.GetLastError() };

              if (get('cmi.completion_status') === 'unknown') {
                api.SetValue('cmi.completion_status', 'incomplete');
              }
              api.Commit('');
              return { ok: true, message: '' };
            },

            learner: function () {
              var id = get('cmi.learner_id') || 'scorm-anonymous';
              return { id: id, name: get('cmi.learner_name') || id };
            },

            resume: function () {
              var raw = get('cmi.suspend_data');
              var parsed = null;
              try { parsed = raw ? JSON.parse(raw) : null; } catch (error) { parsed = null; }
              return {
                // 2004 states it outright rather than inferring from suspend data.
                resume: get('cmi.entry') === 'resume' || raw !== '',
                location: get('cmi.location'),
                state: parsed && parsed.s ? parsed.s : ''
              };
            },

            record: function (verdict) {
              if (!live) return;

              if (verdict.position !== null && verdict.position !== undefined) {
                lastPosition = verdict.position;
                api.SetValue('cmi.location', String(verdict.position));
              }

              // A bookmark update must not disturb status or score.
              if (verdict.bookmarkOnly) {
                api.Commit('');
                return;
              }

              lastVerdict = verdict;

              if (verdict.score) {
                api.SetValue('cmi.score.raw', String(verdict.score.raw));
                api.SetValue('cmi.score.min', String(verdict.score.min));
                api.SetValue('cmi.score.max', String(verdict.score.max));
                // 2004 keeps completion and success apart and adds a 0..1 scaled score.
                api.SetValue('cmi.score.scaled', String(Math.max(0, Math.min(1, verdict.score.scaled))));
              }

              api.SetValue('cmi.completion_status', verdict.completed ? 'completed' : 'incomplete');
              if (verdict.scored) api.SetValue('cmi.success_status', verdict.success ? 'passed' : 'failed');

              api.SetValue('cmi.session_time', sessionTime());
              api.Commit('');
            },

            finish: function (packedState) {
              if (!live) return;
              api.SetValue('cmi.session_time', sessionTime());

              var finished = lastVerdict && lastVerdict.completed;
              if (finished) {
                api.SetValue('cmi.exit', 'normal');
                api.SetValue('cmi.suspend_data', '');
              } else {
                // 'suspend' is what tells the LMS to reopen this attempt later.
                api.SetValue('cmi.exit', 'suspend');

                var payload = { v: 1, contentId: config.contentId, position: lastPosition };
                if (packedState) payload.s = packedState;

                // Writing past the guaranteed budget risks silent truncation,
                // which would corrupt the state on the way back.
                var serialised = JSON.stringify(payload);
                if (serialised.length > SUSPEND_DATA_LIMIT && payload.s) {
                  delete payload.s;
                  serialised = JSON.stringify(payload);
                }

                api.SetValue('cmi.suspend_data', serialised);
              }

              api.Commit('');
              api.Terminate('');
              live = false;
            }
          };
        })();
        """;

    /// <summary>
    /// Tin Can / xAPI launch: the host opens index.html with endpoint, auth and
    /// actor on the query string, and the package posts statements there itself.
    /// </summary>
    private const string XApiAdapter =
        """
        (function () {
          'use strict';

          var config = window.H5P_PACKAGE_CONFIG;
          var launch = {};
          var ready = false;
          var startedAt = Date.now();

          /* xAPI durations are ISO 8601. */
          function elapsed() {
            var total = Math.max(0, (Date.now() - startedAt) / 1000);
            var hours = Math.floor(total / 3600);
            var minutes = Math.floor((total % 3600) / 60);
            var seconds = Math.round((total % 60) * 100) / 100;
            return 'PT' + (hours ? hours + 'H' : '') + (minutes ? minutes + 'M' : '') + seconds + 'S';
          }

          /*
           * The verbs an LMS reads to decide whether a learner finished. H5P's own
           * statements use "answered", which reports detail but never states an
           * outcome, so the outcome is sent as a separate summary statement — the
           * same shape authoring tools like iSpring produce.
           */
          var VERBS = {
            attempted: { id: 'http://adlnet.gov/expapi/verbs/attempted', display: { 'en-US': 'attempted' } },
            initialized: { id: 'http://adlnet.gov/expapi/verbs/initialized', display: { 'en-US': 'initialized' } },
            terminated: { id: 'http://adlnet.gov/expapi/verbs/terminated', display: { 'en-US': 'terminated' } },
            passed: { id: 'http://adlnet.gov/expapi/verbs/passed', display: { 'en-US': 'passed' } },
            failed: { id: 'http://adlnet.gov/expapi/verbs/failed', display: { 'en-US': 'failed' } },
            completed: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } }
          };

          function readLaunchParameters() {
            var params = new URLSearchParams(window.location.search);
            var endpoint = params.get('endpoint') || '';
            if (endpoint && endpoint.charAt(endpoint.length - 1) !== '/') endpoint += '/';

            var actor = null;
            try {
              actor = params.get('actor') ? JSON.parse(params.get('actor')) : null;
            } catch (error) {
              actor = null;
            }

            return {
              endpoint: endpoint,
              auth: params.get('auth') || '',
              registration: params.get('registration') || '',
              activityId: params.get('activity_id') || config.activityId,
              actor: actor
            };
          }

          function actorName(actor) {
            if (!actor) return '';
            if (actor.name) return actor.name;
            if (actor.account && actor.account.name) return actor.account.name;
            if (actor.mbox) return String(actor.mbox).replace('mailto:', '');
            return '';
          }

          var ABSOLUTE_IRI = /^[a-z][a-z0-9+.-]*:/i;

          /*
           * xAPI requires object.id to be an absolute IRI, but H5P emits ids like
           * "3166529484?subContentId=...". Rebase those onto the launch activity
           * so sub-content stays distinguishable and the LRS still accepts it.
           */
          function absoluteObject(object) {
            var result = object ? JSON.parse(JSON.stringify(object)) : {};
            result.objectType = result.objectType || 'Activity';
            result.definition = result.definition || { name: { 'en-US': config.title } };

            if (typeof result.id === 'string' && ABSOLUTE_IRI.test(result.id)) return result;

            var query = typeof result.id === 'string' && result.id.indexOf('?') !== -1
              ? result.id.slice(result.id.indexOf('?') + 1)
              : '';
            var separator = launch.activityId.indexOf('?') === -1 ? '?' : '&';
            result.id = query ? launch.activityId + separator + query : launch.activityId;
            return result;
          }

          /* The activity every summary statement is about. */
          function courseActivity() {
            return {
              id: launch.activityId,
              objectType: 'Activity',
              definition: {
                name: { 'en-US': config.title },
                type: 'http://adlnet.gov/expapi/activities/course'
              }
            };
          }

          function statementContext() {
            var context = {};
            if (launch.registration) context.registration = launch.registration;
            // Grouping ties every statement of this launch to the same activity,
            // which is how a report groups a learner's attempts together.
            context.contextActivities = { grouping: [{ id: launch.activityId, objectType: 'Activity' }] };
            return context;
          }

          function sendSummary(name, result) {
            var statement = {
              actor: launch.actor,
              verb: VERBS[name],
              object: courseActivity(),
              context: statementContext(),
              timestamp: new Date().toISOString()
            };
            if (result) statement.result = result;

            return send(statement).catch(function () { /* summaries are best effort */ });
          }

          function sendLifecycle(name) {
            return sendSummary(name, name === 'terminated' ? { duration: elapsed() } : undefined);
          }

          function send(statement) {
            return fetch(launch.endpoint + 'statements', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': launch.auth,
                'X-Experience-API-Version': '1.0.3'
              },
              body: JSON.stringify(statement)
            }).then(function (response) {
              // An LRS rejects a malformed statement with 4xx and a body saying
              // why. Without this the rejection looks exactly like success and
              // the statement simply never appears in the LRS.
              if (response.ok) return response;
              return response.text().then(function (body) {
                var verb = (statement.verb && statement.verb.id) || '(no verb)';
                if (window.console) {
                  console.error('LRS từ chối statement', verb, response.status, body);
                }
                // The launcher owns the visible status area; it exposes this hook
                // so a rejection is not only visible in the console.
                if (typeof window.H5P_PACKAGE_REPORT === 'function') {
                  window.H5P_PACKAGE_REPORT('LRS từ chối statement ' + verb + ' (' + response.status + ').');
                }
                return response;
              });
            });
          }

          window.H5P_PACKAGE_ADAPTER = {
            init: function () {
              launch = readLaunchParameters();
              if (!launch.endpoint || !launch.auth || !launch.actor) {
                return {
                  ok: false,
                  message: 'Thiếu tham số khởi chạy xAPI (endpoint/auth/actor) — kết quả không gửi được tới LRS, nhưng vẫn được gửi về H5P Studio.'
                };
              }
              ready = true;
              // An LRS report expects the session lifecycle, not only results;
              // this mirrors what a Tin Can package from an authoring tool sends.
              sendLifecycle('initialized');
              sendLifecycle('attempted');
              return { ok: true, message: '' };
            },

            learner: function () {
              var name = actorName(launch.actor) || 'xapi-anonymous';
              var id = (launch.actor && launch.actor.account && launch.actor.account.name) ||
                       (launch.actor && launch.actor.mbox ? String(launch.actor.mbox).replace('mailto:', '') : '') ||
                       name;
              return { id: id, name: name };
            },

            record: function (verdict, statement) {
              if (!ready) return;

              // Re-address H5P's statement to the launch actor and activity: the
              // player has no trusted identity, the LRS launch does.
              var payload = JSON.parse(JSON.stringify(statement));
              payload.actor = launch.actor;
              payload.timestamp = payload.timestamp || new Date().toISOString();
              payload.object = absoluteObject(payload.object);

              // Overwrite the content's own verdict with the configured rule, so
              // the LRS sees the same pass mark the LMS gradebook does.
              if (config.completion && config.completion.mode !== 'default') {
                payload.result = payload.result || {};
                payload.result.completion = verdict.completed;
                payload.result.success = verdict.success;
              }
              if (launch.registration) {
                payload.context = payload.context || {};
                payload.context.registration = launch.registration;
              }

              send(payload).catch(function (error) {
                if (window.console) console.error('Không gửi được statement tới LRS:', error);
              });

              // H5P's own verb ("answered") reports detail but never states an
              // outcome, so an LMS reading the LRS has nothing to key completion
              // off. Follow it with a statement that does.
              // A scored attempt states its outcome even when the content never
              // sets completion: falling below the pass mark is a result the LMS
              // needs, not an absence of one.
              if (verdict.bookmarkOnly) return;
              if (!verdict.scored && !verdict.completed) return;

              var outcome = verdict.scored ? (verdict.success ? 'passed' : 'failed') : 'completed';
              var result = {
                completion: verdict.completed,
                duration: elapsed()
              };
              if (verdict.scored) result.success = verdict.success;

              if (verdict.score) {
                // Percentage scale, the form an LMS gradebook can use directly
                // without knowing how many points this content happens to have.
                var scaled = Math.max(0, Math.min(1, verdict.score.scaled));
                result.score = {
                  scaled: scaled,
                  min: 0,
                  max: 100,
                  raw: Math.round(scaled * 10000) / 100
                };
              }

              sendSummary(outcome, result);
            },

            finish: function () {
              if (!ready) return;
              ready = false;
              // keepalive lets the browser finish the POST during unload.
              try {
                var statement = {
                  actor: launch.actor,
                  verb: VERBS.terminated,
                  object: {
                    id: launch.activityId,
                    objectType: 'Activity',
                    definition: { name: { 'en-US': config.title } }
                  },
                  result: { duration: elapsed() },
                  timestamp: new Date().toISOString()
                };
                if (launch.registration) statement.context = { registration: launch.registration };

                fetch(launch.endpoint + 'statements', {
                  method: 'POST',
                  keepalive: true,
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': launch.auth,
                    'X-Experience-API-Version': '1.0.3'
                  },
                  body: JSON.stringify(statement)
                }).catch(function () {});
              } catch (error) { /* unload must never throw */ }
            }
          };
        })();
        """;

    private static string Quote(string value) => JsonSerializer.Serialize(value);
}
