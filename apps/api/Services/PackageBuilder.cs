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
                    <adlcp:masteryscore>50</adlcp:masteryscore>
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
                  format: {{Quote(format.ToString())}}
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

          var started = adapter.init();
          if (!started.ok) showStatus(started.message);

          var learner = adapter.learner();

          // Identity comes from the host (LMS or LRS launch parameters). It is
          // asserted by the host and travels through the browser, so downstream
          // consumers should treat it as a label rather than proof of identity.
          var separator = config.playerUrl.indexOf('?') === -1 ? '?' : '&';
          document.getElementById('h5p-frame').src = config.playerUrl + separator +
            'userId=' + encodeURIComponent(learner.id) +
            '&userName=' + encodeURIComponent(learner.name) +
            '&embedOrigin=' + encodeURIComponent(window.location.origin);

          window.addEventListener('message', function (event) {
            if (event.origin !== config.playerOrigin) return;
            var data = event.data;
            if (!data || data.type !== 'h5p-result' || !data.statement) return;
            try {
              adapter.record(data.statement);
            } catch (error) {
              showStatus('Không ghi được kết quả: ' + error.message);
            }
          });

          window.addEventListener('beforeunload', function () {
            adapter.finish();
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

          var api = null;
          var live = false;

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

            record: function (statement) {
              if (!live) return;
              var result = statement.result || {};
              var score = result.score || {};

              if (typeof score.raw === 'number') {
                api.LMSSetValue('cmi.core.score.raw', String(score.raw));
                api.LMSSetValue('cmi.core.score.min', String(typeof score.min === 'number' ? score.min : 0));
                api.LMSSetValue('cmi.core.score.max', String(typeof score.max === 'number' ? score.max : 0));
              }

              var status = 'incomplete';
              if (result.success === true) status = 'passed';
              else if (result.success === false && result.completion === true) status = 'failed';
              else if (result.completion === true) status = 'completed';

              api.LMSSetValue('cmi.core.lesson_status', status);
              api.LMSCommit('');
            },

            finish: function () {
              if (!live) return;
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

          var api = null;
          var live = false;

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

            record: function (statement) {
              if (!live) return;
              var result = statement.result || {};
              var score = result.score || {};

              if (typeof score.raw === 'number') {
                var min = typeof score.min === 'number' ? score.min : 0;
                var max = typeof score.max === 'number' ? score.max : 0;
                api.SetValue('cmi.score.raw', String(score.raw));
                api.SetValue('cmi.score.min', String(min));
                api.SetValue('cmi.score.max', String(max));
                // 2004 keeps completion and success apart and adds a 0..1 scaled score.
                var scaled = typeof score.scaled === 'number'
                  ? score.scaled
                  : (max > min ? (score.raw - min) / (max - min) : 0);
                api.SetValue('cmi.score.scaled', String(Math.max(0, Math.min(1, scaled))));
              }

              if (result.completion === true) api.SetValue('cmi.completion_status', 'completed');
              if (result.success === true) api.SetValue('cmi.success_status', 'passed');
              else if (result.success === false && result.completion === true) api.SetValue('cmi.success_status', 'failed');

              api.Commit('');
            },

            finish: function () {
              if (!live) return;
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

          function send(statement) {
            return fetch(launch.endpoint + 'statements', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': launch.auth,
                'X-Experience-API-Version': '1.0.3'
              },
              body: JSON.stringify(statement)
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
              return { ok: true, message: '' };
            },

            learner: function () {
              var name = actorName(launch.actor) || 'xapi-anonymous';
              var id = (launch.actor && launch.actor.account && launch.actor.account.name) ||
                       (launch.actor && launch.actor.mbox ? String(launch.actor.mbox).replace('mailto:', '') : '') ||
                       name;
              return { id: id, name: name };
            },

            record: function (statement) {
              if (!ready) return;

              // Re-address H5P's statement to the launch actor and activity: the
              // player has no trusted identity, the LRS launch does.
              var payload = JSON.parse(JSON.stringify(statement));
              payload.actor = launch.actor;
              payload.timestamp = payload.timestamp || new Date().toISOString();
              payload.object = absoluteObject(payload.object);
              if (launch.registration) {
                payload.context = payload.context || {};
                payload.context.registration = launch.registration;
              }

              send(payload).catch(function (error) {
                if (window.console) console.error('Không gửi được statement tới LRS:', error);
              });
            },

            finish: function () { /* xAPI has no session teardown call */ }
          };
        })();
        """;

    private static string Quote(string value) => JsonSerializer.Serialize(value);
}
