/**
 * Universal H5P Server using @lumieducation/h5p-server
 *
 * Provides:
 * - H5P content player (view/play content)
 * - H5P content editor (create/edit content)
 * - Content management API
 * - xAPI events via postMessage (for iframe embedding)
 * - Optional webhook for xAPI events (pass ?webhookUrl=...)
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fileUpload from 'express-fileupload';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import * as H5P from '@lumieducation/h5p-server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Configuration from environment
const PORT = process.env.PORT || process.env.H5P_PORT || 3000;
const H5P_BASE_URL = process.env.H5P_BASE_URL || `http://localhost:${PORT}`;
const H5P_ALLOWED_ORIGINS = (process.env.H5P_ALLOWED_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
const H5P_PARENT_ORIGIN = process.env.H5P_PARENT_ORIGIN || H5P_ALLOWED_ORIGINS[0] || 'http://localhost:3000';
// Render service references use the private-network "host:port" form. Make
// it usable as a fetch URL while keeping ordinary HTTP(S) URLs unchanged.
const normalizeHttpUrl = (value) => /^https?:\/\//i.test(value) ? value : `http://${value}`;
const H5P_WEBHOOK_URL = normalizeHttpUrl(process.env.H5P_WEBHOOK_URL || 'http://localhost:5050/api/h5p/xapi');
const H5P_WEBHOOK_SECRET = process.env.H5P_WEBHOOK_SECRET || 'dev-only-change-me';
const H5P_INTERNAL_API_KEY = process.env.H5P_INTERNAL_API_KEY || 'dev-internal-key-change-me';
const H5P_MAX_UPLOAD_MB = Number(process.env.H5P_MAX_UPLOAD_MB || 100);
const H5P_DEBUG = process.env.H5P_DEBUG === 'true';

// Languages the LMS may request for the editor/player iframe. The first entry
// is the default when the caller sends nothing or something unsupported.
const H5P_SUPPORTED_LANGUAGES = (process.env.H5P_SUPPORTED_LANGUAGES || 'vi,en')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
const H5P_DEFAULT_LANGUAGE = H5P_SUPPORTED_LANGUAGES[0] || 'en';

// Read from `uiLanguage` rather than `language`: the H5P editor template appends
// this page's entire query string to every AJAX URL it builds, and h5peditor.js
// appends its own `language` parameter on top — sharing the name would send
// `language` twice and h5p-server rejects the resulting "vi,vi".
// `language`/`lang` stay accepted so the endpoints remain usable by hand.
// Anything outside the allow-list is refused, which also keeps the value safe to
// interpolate into file paths further down.
function resolveLanguage(req) {
    const requested = req.query.uiLanguage ?? req.query.language ?? req.query.lang;
    const value = Array.isArray(requested) ? requested[0] : requested;
    if (typeof value !== 'string') return H5P_DEFAULT_LANGUAGE;

    const normalized = value.trim().toLowerCase();
    return H5P_SUPPORTED_LANGUAGES.includes(normalized) ? normalized : H5P_DEFAULT_LANGUAGE;
}

function normalizeOrigin(value) {
    try {
        return new URL(value).origin;
    } catch {
        return value;
    }
}

const H5P_SELF_ORIGIN = normalizeOrigin(H5P_BASE_URL);
const H5P_EMBEDDER_ORIGINS = new Set(H5P_ALLOWED_ORIGINS.map(normalizeOrigin));
const H5P_CORS_ORIGINS = new Set([...H5P_EMBEDDER_ORIGINS, H5P_SELF_ORIGIN]);

function getEmbedderOrigin(returnUrl) {
    try {
        const origin = new URL(String(returnUrl)).origin;
        if (H5P_EMBEDDER_ORIGINS.has(origin)) return origin;
    } catch {}

    return normalizeOrigin(H5P_PARENT_ORIGIN);
}

// Storage paths (configurable for Docker deployment).
// Must be absolute: the dev script passes a CWD-relative H5P_DATA_PATH, and
// res.sendFile() rejects relative paths.
const H5P_DATA_PATH = path.resolve(process.env.H5P_DATA_PATH || path.resolve(__dirname, '../h5p'));

// H5P's editor bootstrap appends the whole page query string to every AJAX URL
// it builds, and h5peditor.js appends parameters of its own. When the two agree
// on a name, Express parses the repeat as an array and h5p-server rejects the
// joined value (e.g. "Language code vi,vi is invalid."). Keep the first value of
// any repeated parameter; requests without duplicates are left untouched.
app.use((req, res, next) => {
    const queryStart = req.url.indexOf('?');
    if (queryStart === -1) return next();

    const seen = new Set();
    const deduped = new URLSearchParams();
    let hasDuplicates = false;

    for (const [key, value] of new URLSearchParams(req.url.slice(queryStart + 1))) {
        if (seen.has(key)) {
            hasDuplicates = true;
            continue;
        }
        seen.add(key);
        deduped.append(key, value);
    }

    if (hasDuplicates) req.url = `${req.url.slice(0, queryStart)}?${deduped}`;
    next();
});

// Allow configured LMS origins and the engine's own origin. Font and AJAX
// requests inside the H5P iframe can include the engine origin in Origin.
app.use(cors({
    origin(origin, callback) {
        if (!origin || H5P_CORS_ORIGINS.has(normalizeOrigin(origin))) return callback(null, true);
        return callback(new Error('Origin is not allowed by H5P Engine CORS policy.'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Apply bodyParser conditionally
// Skip bodyParser ONLY for multipart/form-data requests (file uploads)
// Allow it for JSON requests (like POST action=libraries)
app.use((req, res, next) => {
    const contentType = req.get('content-type') || '';
    // Skip bodyParser for multipart/form-data (file uploads)
    if (contentType.includes('multipart/form-data')) {
        return next();
    }
    bodyParser.json({ limit: '500mb' })(req, res, next);
});
app.use((req, res, next) => {
    const contentType = req.get('content-type') || '';
    // Skip bodyParser for multipart/form-data (file uploads)
    if (contentType.includes('multipart/form-data')) {
        return next();
    }
    bodyParser.urlencoded({ extended: true, limit: '500mb' })(req, res, next);
});

// Paths for H5P storage (defined early for static file serving)
const h5pBasePath = H5P_DATA_PATH;

// Serve H5P core, editor, content, libraries and temp files BEFORE other routes
app.use('/h5p/core', express.static(path.join(h5pBasePath, 'core')));
app.use('/h5p/editor', express.static(path.join(h5pBasePath, 'editor')));
app.use('/h5p/content', express.static(path.join(h5pBasePath, 'content')));
app.use('/h5p/libraries', express.static(path.join(h5pBasePath, 'libraries')));

// Temp files: H5P stores them in user-specific subdirectories but generates URLs without user prefix
// So we need to search across all user directories.
// The editor's filesPath carries no userId, so the built-in H5P temp route
// would resolve the request to the "anonymous" user and answer 404 — which the
// browser reports as "Video format not supported". This handler must therefore
// find the file, and must never swallow a sendFile() failure.
app.use('/temp-files', async (req, res, next) => {
    const tempDir = path.join(h5pBasePath, 'temp');

    let requestedPath;
    try {
        // req.path is mount-relative and still percent-encoded, e.g. /videos/video-abc123.mp4
        requestedPath = decodeURIComponent(req.path).replace(/^[\\/]+/, '');
    } catch {
        return next();
    }

    // Keep every lookup inside tempDir even if the URL contains "..".
    const resolveInsideTempDir = (...segments) => {
        const candidate = path.resolve(tempDir, ...segments);
        return candidate === tempDir || candidate.startsWith(tempDir + path.sep) ? candidate : null;
    };

    const candidates = [];
    const directPath = resolveInsideTempDir(requestedPath);
    if (directPath) candidates.push(directPath);

    // Fall back to searching the per-user subdirectories H5P actually writes to.
    try {
        const entries = await fs.readdir(tempDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const userPath = resolveInsideTempDir(entry.name, requestedPath);
            if (userPath) candidates.push(userPath);
        }
    } catch {}

    let match;
    for (const candidate of candidates) {
        try {
            if ((await fs.stat(candidate)).isFile()) {
                match = candidate;
                break;
            }
        } catch {}
    }

    if (!match) return next(); // Not found, continue to next handler

    // Outside the try/catch above on purpose: sendFile() throws synchronously on
    // a bad path and reports async failures through this callback.
    res.sendFile(match, (error) => {
        if (!error) return;
        console.error(`Failed to send temporary file ${match}:`, error.message);
        if (!res.headersSent) next(error);
    });
});

// Additional H5P paths
const librariesPath = path.join(h5pBasePath, 'libraries');
const contentPath = path.join(h5pBasePath, 'content');
const tempPath = path.join(h5pBasePath, 'temp');
const configPath = path.join(h5pBasePath, 'config.json');
const cachePath = path.join(h5pBasePath, 'cache.json');

// Ensure directories exist
async function ensureDirectories() {
    await fs.mkdir(librariesPath, { recursive: true });
    await fs.mkdir(contentPath, { recursive: true });
    await fs.mkdir(tempPath, { recursive: true });

    // Create default config if not exists
    try {
        await fs.access(configPath);
    } catch {
        const defaultConfig = {
            contentTypeCacheRefreshInterval: 86400000,
            contentUserStateSaveInterval: 5000,
            enableLrsContentTypes: true,
            fetchingDisabled: 0,
            hubRegistrationEndpoint: 'https://api.h5p.org/v1/sites',
            hubContentTypesEndpoint: 'https://api.h5p.org/v1/content-types/',
            sendUsageStatistics: false,
            uuid: crypto.randomUUID(),
            siteType: 'local',
            libraryConfig: {}
        };
        await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2));
    }

    // The convenience H5P.fs() factory uses an in-memory cache. That makes the
    // Hub catalog disappear on every engine restart and leaves only installed
    // libraries when api.h5p.org is temporarily unavailable. Keep the last
    // successful Hub response on disk so the editor can use stale data during
    // an upstream outage.
    try {
        await fs.access(cachePath);
    } catch {
        await fs.writeFile(cachePath, '{}');
    }
}

// Create a simple user object (in production, get from session/auth)
function createUser(req) {
    const readValue = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback;
    return {
        id: readValue(req.query.userId || req.body?.userId, 'anonymous').slice(0, 128),
        name: readValue(req.query.userName || req.body?.userName, 'Anonymous User').slice(0, 200),
        email: readValue(req.query.userEmail || req.body?.userEmail, 'anonymous@example.com').slice(0, 254),
        type: 'local'
    };
}

// Initialize H5P
let h5pEditor;
let h5pPlayer;

// h5p-server asks for translations by i18next-style key ("namespace:key").
// Returning the key unchanged is what makes the editor render labels such as
// "metadata-semantics:title" instead of "Title", so resolve them against the
// translation files shipped with @lumieducation/h5p-server.
// Resolved through the package itself so it survives any node_modules layout.
const H5P_TRANSLATIONS_PATH = (() => {
    try {
        const packageJson = createRequire(import.meta.url).resolve('@lumieducation/h5p-server/package.json');
        return path.join(path.dirname(packageJson), 'build', 'assets', 'translations');
    } catch {
        return path.resolve(__dirname, '../node_modules/@lumieducation/h5p-server/build/assets/translations');
    }
})();
// Our own translations, consulted before the bundled ones. This is where
// languages h5p-server does not ship (Vietnamese, for one) live; dropping a
// `<namespace>/<language>.json` file in here is all it takes to add more.
const H5P_LOCAL_TRANSLATIONS_PATH = path.resolve(__dirname, '../translations');
const H5P_FALLBACK_LANGUAGE = 'en';
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

// `${namespace}/${language}` -> flat key/value map, or null when unavailable.
const translationCache = new Map();

function flattenTranslations(source, prefix = '', target = {}) {
    for (const [key, value] of Object.entries(source)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            flattenTranslations(value, fullKey, target);
        } else if (typeof value === 'string') {
            target[fullKey] = value;
        }
    }
    return target;
}

function loadTranslationNamespace(namespace, language) {
    const cacheKey = `${namespace}/${language}`;
    if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

    let entries = null;
    for (const root of [H5P_LOCAL_TRANSLATIONS_PATH, H5P_TRANSLATIONS_PATH]) {
        try {
            const file = path.join(root, namespace, `${language}.json`);
            entries = flattenTranslations(JSON.parse(readFileSync(file, 'utf-8')));
            break;
        } catch {
            // Namespace or language not present here; try the next root.
        }
    }

    translationCache.set(cacheKey, entries);
    return entries;
}

function translationCallback(key, language) {
    const separatorIndex = key.indexOf(':');
    if (separatorIndex === -1) return key;

    const namespace = key.slice(0, separatorIndex);
    const entryKey = key.slice(separatorIndex + 1);
    if (!SAFE_PATH_SEGMENT.test(namespace)) return key;

    // e.g. "en-GB" -> try "en-GB", then "en", then the fallback language.
    const base = typeof language === 'string' ? language.split(/[-_]/)[0] : undefined;
    for (const candidate of [language, base, H5P_FALLBACK_LANGUAGE]) {
        if (!candidate || !SAFE_PATH_SEGMENT.test(candidate)) continue;
        const value = loadTranslationNamespace(namespace, candidate)?.[entryKey];
        if (typeof value === 'string') return value;
    }

    return key;
}

async function initH5P() {
    await ensureDirectories();

    // Without this directory every editor label falls back to its raw i18next
    // key, so fail loudly rather than silently shipping "metadata-semantics:title".
    if (!existsSync(H5P_TRANSLATIONS_PATH)) {
        console.warn(`H5P translations not found at ${H5P_TRANSLATIONS_PATH}; editor labels will show raw keys.`);
    }

    const config = await new H5P.H5PConfig(
        new H5P.fsImplementations.JsonStorage(configPath)
    ).load();

    // Set base URL for content
    config.baseUrl = H5P_BASE_URL;

    // Configure URLs for core and editor assets (served via express.static)
    config.coreUrl = '/h5p/core';
    config.editorLibraryUrl = '/h5p/editor';

    // Configure AJAX paths to use /h5p prefix (where h5pAjaxExpressRouter is mounted)
    config.ajaxUrl = '/h5p/ajax';
    config.librariesUrl = '/h5p/libraries';
    config.contentUrl = '/h5p/content';
    config.playUrl = '/h5p/play';
    config.downloadUrl = '/h5p/download';
    config.temporaryFilesUrl = '/temp-files';

    const urlGenerator = new H5P.UrlGenerator(config, {
        queryParamGenerator: (user) => ({ userId: user.id }),
        protectAjax: false,
        protectContentUserData: false,
        protectSetFinished: false
    });

    // Instantiate the editor directly because H5P.fs() hardcodes a volatile
    // InMemoryStorage for Hub metadata.
    const contentStorage = new H5P.fsImplementations.FileContentStorage(contentPath);
    const libraryStorage = new H5P.fsImplementations.FileLibraryStorage(librariesPath);

    const cacheStorage = await H5P.fsImplementations.JsonStorage.create(cachePath);
    const temporaryStorage = new H5P.fsImplementations.DirectoryTemporaryFileStorage(tempPath);

    h5pEditor = new H5P.H5PEditor(
        cacheStorage,
        config,
        libraryStorage,
        contentStorage,
        temporaryStorage,
        translationCallback,
        urlGenerator
    );

    // Create a proper H5PPlayer instance for playing content
    h5pPlayer = new H5P.H5PPlayer(
        libraryStorage,
        contentStorage,
        config,
        undefined,           // integrationObjectDefaults
        urlGenerator,
        translationCallback
    );

    // Custom renderer that omits the download link (default renderer always shows it)
    h5pPlayer.setRenderer((model) => `<!doctype html>
<html class="h5p-iframe">
<head>
    <meta charset="utf-8">
    ${model.styles.map((style) => `<link rel="stylesheet" href="${style}"/>`).join('\n    ')}
    ${model.scripts.map((script) => `<script src="${script}"></script>`).join('\n    ')}
    <script>
        window.H5PIntegration = ${JSON.stringify(model.integration, null, 2)};
    </script>
</head>
<body>
    <div class="h5p-content" data-content-id="${model.contentId}"></div>
</body>
</html>`);

    console.log('H5P initialized successfully');
}

// ============================================================================
// H5P AJAX Routes (handled by @lumieducation/h5p-express)
// ============================================================================

async function setupRoutes() {
    const { h5pAjaxExpressRouter } = await import('@lumieducation/h5p-express');

    // Middleware to set req.user for H5P router
    app.use((req, res, next) => {
        req.user = createUser(req);
        next();
    });

    // Add request logging for debugging
    app.use('/h5p/ajax', (req, res, next) => {
        if (!H5P_DEBUG) return next();
        console.log(`[H5P AJAX] ${req.method} ${req.path} action=${req.query.action}`);
        console.log(`  Content-Type: ${req.get('content-type')}`);
        console.log(`  Body present: ${!!req.body}`);
        console.log(`  Body:`, req.body);
        next();
    });

    // Add file upload middleware for H5P AJAX routes
    // The H5P controller expects req.files to be populated by express-fileupload
    app.use('/h5p/ajax', fileUpload({
        limits: { fileSize: H5P_MAX_UPLOAD_MB * 1024 * 1024 },
        useTempFiles: true,
        tempFileDir: tempPath
    }));

    // Mount the H5P AJAX router at root level
    // The router uses config URLs (e.g., /h5p/ajax, /h5p/libraries) internally
    // So we mount at '/' to avoid double-prefixing
    app.use(
        '/',
        h5pAjaxExpressRouter(
            h5pEditor,
            path.join(h5pBasePath, 'core'),        // H5P core files
            path.join(h5pBasePath, 'editor'),      // H5P editor files
            undefined,                              // routeOptions (use defaults)
            'en'                                    // languageOverride
        )
    );

}

// Global error handler for H5P routes - must be added after setupRoutes()
async function addErrorHandlers() {
    app.use((err, req, res, next) => {
        if (req.path.startsWith('/h5p')) {
            console.error('=== H5P Error ===');
            console.error('Message:', err.message);
            console.error('Stack:', err.stack);
            console.error('Request:', req.method, req.path);
            console.error('Query:', req.query);
            console.error('Body:', req.body);
            console.error('================');
        }

        // Send error response
        if (!res.headersSent) {
            res.status(err.status || 500).json({
                error: err.message || 'Internal server error'
            });
        }
    });
}

// ============================================================================
// Content Management API
// ============================================================================

// The management API is server-to-server only. Editor/player pages remain public
// in this development starter and should be placed behind the LMS gateway in production.
app.use((req, res, next) => {
    const isManagementRequest = req.path === '/api/content' || req.path.startsWith('/api/content/');
    if (!isManagementRequest || !H5P_INTERNAL_API_KEY) return next();
    if (req.get('X-H5P-Internal-Key') !== H5P_INTERNAL_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});

// List all content
app.get('/api/content', async (req, res) => {
    try {
        const contentIds = await h5pEditor.contentManager.listContent();
        const contentList = await Promise.all(
            contentIds.map(async (id) => {
                try {
                    const metadata = await h5pEditor.contentManager.getContentMetadata(id, createUser(req));
                    return {
                        id,
                        title: metadata.title || 'Untitled',
                        mainLibrary: metadata.mainLibrary,
                        embedTypes: metadata.embedTypes
                    };
                } catch {
                    return { id, title: 'Unknown', error: true };
                }
            })
        );
        res.json({ content: contentList.filter(c => !c.error) });
    } catch (error) {
        console.error('Error listing content:', error);
        res.json({ content: [] });
    }
});

// Get single content metadata
app.get('/api/content/:contentId', async (req, res) => {
    try {
        const metadata = await h5pEditor.contentManager.getContentMetadata(
            req.params.contentId,
            createUser(req)
        );
        res.json({ id: req.params.contentId, ...metadata });
    } catch (error) {
        res.status(404).json({ error: 'Content not found' });
    }
});

// Delete content
app.delete('/api/content/:contentId', async (req, res) => {
    try {
        await h5pEditor.contentManager.deleteContent(req.params.contentId, createUser(req));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// Player Endpoint - Renders H5P content for viewing
// ============================================================================

// Browser events are relayed server-side so the LMS webhook secret never reaches the browser.
app.post('/api/xapi-relay', async (req, res) => {
    try {
        const { contentId, userId, statement } = req.body || {};
        if (!contentId || !userId || !statement || !H5P_WEBHOOK_URL) {
            return res.status(400).json({ error: 'Invalid xAPI payload' });
        }

        const response = await fetch(H5P_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-H5P-Webhook-Secret': H5P_WEBHOOK_SECRET
            },
            body: JSON.stringify({ contentId, userId, statement })
        });

        if (!response.ok) {
            const detail = await response.text();
            console.error(`LMS webhook rejected xAPI event (${response.status}):`, detail);
            return res.status(502).json({ error: 'LMS webhook rejected the event' });
        }

        return res.status(204).end();
    } catch (error) {
        console.error('Failed to relay xAPI event:', error);
        return res.status(502).json({ error: 'Failed to relay xAPI event' });
    }
});

app.get('/play/:contentId', async (req, res) => {
    try {
        const user = createUser(req);
        const contentId = req.params.contentId;
        // h5pPlayer.render() returns complete HTML with the default renderer
        let playerHtml = await h5pPlayer.render(
            contentId,
            user,
            resolveLanguage(req),
            {
                showCopyButton: false,
                showDownloadButton: false,
                showFrame: true,
                showH5PIcon: false,
                showLicenseButton: false
            }
        );

        // Inject H5P init and xAPI tracking script before </body>
        const safeContentId = JSON.stringify(contentId);
        const safeUserId = JSON.stringify(user.id);
        // A SCORM package embeds this player from the LMS's own origin, so the
        // postMessage target has to follow the embedder instead of the single
        // configured parent. Unlisted origins fall back to H5P_PARENT_ORIGIN.
        const safeParentOrigin = JSON.stringify(getEmbedderOrigin(req.query.embedOrigin));
        // Absolute, not "/api/xapi-relay": the player is served under the LMS
        // proxy prefix (H5P_BASE_URL), so a root-relative URL would post to the
        // LMS origin instead of the engine and every result would be dropped.
        const safeRelayUrl = JSON.stringify(`${H5P_BASE_URL.replace(/\/$/, '')}/api/xapi-relay`);
        const xapiScript = `
    <script>
        // Debug H5P initialization
        console.log('H5P script loaded, checking H5P object...');
        console.log('H5P:', typeof H5P);
        console.log('H5PIntegration:', typeof H5PIntegration);
        console.log('jQuery:', typeof jQuery);

        // H5P auto-initializes on jQuery ready, but let's make sure
        if (typeof jQuery !== 'undefined') {
            jQuery(document).ready(function() {
                console.log('jQuery ready, H5P.init exists:', typeof H5P !== 'undefined' && typeof H5P.init);
                console.log('H5P contents:', H5PIntegration.contents);
                if (typeof H5P !== 'undefined' && H5P.init) {
                    console.log('Calling H5P.init...');
                    H5P.init(document.body);
                }
            });
        }

        // Track xAPI events
        H5P.externalDispatcher.on('xAPI', function(event) {
            const statement = event.data.statement;

            // Only track completion and answered events
            if (statement.verb && (
                statement.verb.id.includes('completed') ||
                statement.verb.id.includes('answered') ||
                statement.verb.id.includes('passed') ||
                statement.verb.id.includes('failed')
            )) {
                fetch(${safeRelayUrl}, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contentId: ${safeContentId},
                        userId: ${safeUserId},
                        statement: statement
                    })
                })
                    .then(function (response) {
                        if (!response.ok) {
                            console.error('xAPI relay rejected the event:', response.status);
                        }
                    })
                    .catch(err => console.error('Failed to send results:', err));

                // Always post to parent window if in iframe
                if (window.parent !== window) {
                    window.parent.postMessage({
                        type: 'h5p-result',
                        contentId: ${safeContentId},
                        userId: ${safeUserId},
                        statement: statement
                    }, ${safeParentOrigin});
                }
            }
        });
    </script>`;

        // Inject xAPI script before </body>
        playerHtml = playerHtml.replace('</body>', xapiScript + '\n</body>');

        res.send(playerHtml);
    } catch (error) {
        console.error('Error rendering player:', error);
        res.status(500).send(`Error: ${error.message}`);
    }
});

// ============================================================================
// Editor Endpoints - For creating/editing H5P content
// ============================================================================

// Edit existing content (GET - show editor)
app.get('/edit/:contentId', async (req, res) => {
    try {
        const user = createUser(req);
        const language = resolveLanguage(req);
        const editorHtml = await h5pEditor.render(
            req.params.contentId,
            language,
            user
        );

        res.send(wrapEditorHtml(editorHtml, req.params.contentId, req.query.returnUrl, language));
    } catch (error) {
        console.error('Error rendering editor:', error);
        res.status(500).send(`Error: ${error.message}`);
    }
});

// Edit existing content (POST - save from built-in form or our JSON handler)
app.post('/edit/:contentId', fileUpload({ useTempFiles: true, tempFileDir: tempPath }), async (req, res) => {
    try {
        const user = createUser(req);
        const contentId = req.params.contentId;
        // Handle both JSON (from our form handler) and multipart form data
        const library = req.body?.library;
        const parameters = req.body?.params || req.body?.parameters;
        const returnUrl = req.query.returnUrl;

        if (!library || !parameters) {
            console.log('Missing data. Body:', req.body);
            return res.status(400).send('Missing library or parameters');
        }

        // The form sends params as: {"params": {...actual content...}, "metadata": {...}}
        const fullParams = typeof parameters === 'string' ? JSON.parse(parameters) : parameters;
        // Extract the actual content parameters and metadata separately
        const contentParams = fullParams.params || fullParams;
        const metadata = fullParams.metadata || { title: 'Untitled' };

        await h5pEditor.saveOrUpdateContentReturnMetaData(
            contentId,
            contentParams,  // Just the content parameters, not the wrapper
            metadata,
            library,
            user
        );

        // Build redirect URL
        let redirectUrl = `/edit/${contentId}`;
        if (returnUrl) {
            const url = new URL(returnUrl);
            url.searchParams.set('contentId', contentId);
            url.searchParams.set('title', metadata.title);
            redirectUrl = url.toString();
        }

        // Always return JSON for the client-side interception to catch
        console.log('Content updated successfully, returning JSON with redirectUrl:', redirectUrl);
        return res.json({ success: true, contentId, redirectUrl });
    } catch (error) {
        console.error('Error saving content:', error);
        res.status(500).send(`Error: ${error.message}`);
    }
});

// Create new content (GET - show editor)
app.get('/new', async (req, res) => {
    try {
        const user = createUser(req);
        const language = resolveLanguage(req);
        const editorHtml = await h5pEditor.render(
            undefined,  // No content ID = new content
            language,
            user
        );

        res.send(wrapEditorHtml(editorHtml, null, req.query.returnUrl, language));
    } catch (error) {
        console.error('Error rendering editor:', error);
        res.status(500).send(`Error: ${error.message}`);
    }
});

// Create new content (POST - save from built-in form)
// Use fileUpload middleware since form uses multipart/form-data
app.post('/new', fileUpload({ useTempFiles: true, tempFileDir: tempPath }), async (req, res) => {
    try {
        const user = createUser(req);
        // Form fields come from req.body when using express-fileupload
        const library = req.body?.library;
        const parameters = req.body?.params || req.body?.parameters;
        const returnUrl = req.query.returnUrl;

        if (!library || !parameters) {
            console.log('Missing data. Body:', req.body);
            return res.status(400).send('Missing library or parameters');
        }

        // The form sends params as: {"params": {...actual content...}, "metadata": {...}}
        const fullParams = typeof parameters === 'string' ? JSON.parse(parameters) : parameters;
        // Extract the actual content parameters and metadata separately
        const contentParams = fullParams.params || fullParams;
        const metadata = fullParams.metadata || { title: 'Untitled' };

        const savedId = await h5pEditor.saveOrUpdateContentReturnMetaData(
            undefined,
            contentParams,  // Just the content parameters, not the wrapper
            metadata,
            library,
            user
        );

        // Build redirect URL
        let redirectUrl = `/edit/${savedId.id}`;
        if (returnUrl) {
            const url = new URL(returnUrl);
            url.searchParams.set('contentId', savedId.id);
            url.searchParams.set('title', metadata.title);
            redirectUrl = url.toString();
        }

        // Always return JSON for the client-side interception to catch
        console.log('Content saved successfully, returning JSON with redirectUrl:', redirectUrl);
        return res.json({ success: true, contentId: savedId.id, redirectUrl });

    } catch (error) {
        console.error('Error saving new content:', error);
        res.status(500).send(`Error: ${error.message}`);
    }
});

// Save content (called from editor via AJAX)
app.post('/api/save', async (req, res) => {
    try {
        const user = createUser(req);
        const { contentId, library, params, metadata } = req.body;

        const savedId = await h5pEditor.saveOrUpdateContentReturnMetaData(
            contentId || undefined,
            params,
            metadata || { title: 'Untitled' },
            library,
            user
        );

        res.json({
            success: true,
            contentId: savedId.id,
            metadata: savedId.metadata
        });
    } catch (error) {
        console.error('Error saving content:', error);
        res.status(500).json({ error: error.message });
    }
});

// Strings for the chrome this file adds around the H5P editor. H5P's own
// strings come from its language files; these are ours.
const EDITOR_CHROME_STRINGS = {
    en: { save: 'Save', create: 'Create', cancel: 'Cancel' },
    vi: { save: 'Lưu', create: 'Tạo', cancel: 'Huỷ' }
};

// Helper function to wrap editor HTML with cancel button and styling
function wrapEditorHtml(editorHtml, contentId, returnUrl, language = H5P_DEFAULT_LANGUAGE) {
    // Add styling and a cancel button (the built-in Create/Save button handles saving)

    const embedderOrigin = getEmbedderOrigin(returnUrl);
    const chrome = EDITOR_CHROME_STRINGS[language] || EDITOR_CHROME_STRINGS[H5P_FALLBACK_LANGUAGE];

    const customStyles = `
    <style>
        html, body { width: 100%; min-width: 0; margin: 0; }
        body { padding: 20px; box-sizing: border-box; }
        #h5p-content-form, .h5p-create, .h5p-editor-iframe {
            width: 100% !important;
            max-width: none !important;
            min-width: 0 !important;
            box-sizing: border-box;
        }
        .h5p-editor-iframe { display: block; }
        .h5p-editor-buttons {
            display: flex;
            gap: 10px;
            margin-top: 20px;
        }
        .btn-cancel {
            padding: 10px 20px; font-size: 16px; cursor: pointer;
            border: none; border-radius: 4px;
            background: #ccc; color: #333;
        }
        .btn-cancel:hover { background: #bbb; }
        /* Style the built-in save button */
        #save-h5p {
            padding: 10px 20px !important;
            font-size: 16px !important;
            background: #21759b !important;
            color: white !important;
            border: none !important;
            border-radius: 4px !important;
            cursor: pointer !important;
        }
        #save-h5p:hover { background: #1e6a8d !important; }
        /* Hide the original button location */
        #h5p-content-form > input#save-h5p { display: none; }
    </style>`;

    const cancelScript = `
    <div class="h5p-editor-buttons">
        <button type="button" id="save-h5p-clone" class="button button-primary button-large" style="padding: 10px 20px; font-size: 16px; background: #21759b; color: white; border: none; border-radius: 4px; cursor: pointer;">${contentId ? chrome.save : chrome.create}</button>
        <button type="button" class="btn-cancel" onclick="cancelH5PEdit()">${chrome.cancel}</button>
    </div>
    <script>
        const h5pReturnUrl = ${JSON.stringify(returnUrl || null)};
        const h5pContentId = ${JSON.stringify(contentId || null)};
        const h5pEmbedderOrigin = ${JSON.stringify(embedderOrigin)};

        function cancelH5PEdit() {
            if (h5pReturnUrl) {
                window.location.href = h5pReturnUrl;
            } else {
                window.history.back();
            }
        }

        // Make cloned save button trigger the original save
        document.getElementById('save-h5p-clone').addEventListener('click', function() {
            document.getElementById('save-h5p').click();
        });

        // Keep the cross-origin LMS iframe in sync with the editor's real height.
        (function() {
            let lastHeight = 0;
            let scheduled = false;

            function notifyParentOfHeight() {
                scheduled = false;
                const height = Math.ceil(Math.max(
                    document.documentElement.scrollHeight,
                    document.body ? document.body.scrollHeight : 0
                ));

                if (height === lastHeight || window.parent === window) return;
                lastHeight = height;
                window.parent.postMessage({
                    type: 'h5p-frame-resize',
                    height: height
                }, h5pEmbedderOrigin);
            }

            function scheduleResize() {
                if (scheduled) return;
                scheduled = true;
                window.requestAnimationFrame(notifyParentOfHeight);
            }

            window.addEventListener('load', scheduleResize);
            window.addEventListener('resize', scheduleResize);
            new ResizeObserver(scheduleResize).observe(document.documentElement);
            new MutationObserver(scheduleResize).observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true
            });
            scheduleResize();
        })();

        // Intercept XHR and fetch responses to detect successful saves and redirect
        (function() {
            // Intercept XMLHttpRequest
            const originalXHROpen = XMLHttpRequest.prototype.open;
            const originalXHRSend = XMLHttpRequest.prototype.send;

            XMLHttpRequest.prototype.open = function(method, url) {
                this._url = url;
                this._method = method;
                return originalXHROpen.apply(this, arguments);
            };

            XMLHttpRequest.prototype.send = function() {
                const xhr = this;
                xhr.addEventListener('load', function() {
                    console.log('XHR completed:', xhr._method, xhr._url, 'Status:', xhr.status);
                    try {
                        const response = JSON.parse(xhr.responseText);
                        console.log('XHR response:', response);
                        if (response.success && response.redirectUrl) {
                            console.log('Save successful, redirecting to:', response.redirectUrl);
                            window.location.href = response.redirectUrl;
                        }
                    } catch (e) {
                        // Not JSON, ignore
                    }
                });
                return originalXHRSend.apply(this, arguments);
            };

            // Also intercept fetch in case H5P uses that
            const originalFetch = window.fetch;
            window.fetch = function(url, options) {
                console.log('Fetch:', options?.method || 'GET', url);
                return originalFetch.apply(this, arguments).then(response => {
                    // Clone response so we can read it
                    const clonedResponse = response.clone();
                    clonedResponse.json().then(data => {
                        console.log('Fetch response:', data);
                        if (data.success && data.redirectUrl) {
                            console.log('Save successful via fetch, redirecting to:', data.redirectUrl);
                            window.location.href = data.redirectUrl;
                        }
                    }).catch(() => {});
                    return response;
                });
            };
        })();
    </script>`;

    // Inject styles after <head> and cancel button/script before </body>
    let html = editorHtml;
    html = html.replace('</head>', customStyles + '</head>');
    html = html.replace('</body>', cancelScript + '</body>');

    // H5P's editor runtime copies H5PEditor and H5PIntegration from its parent.
    // When the rendered editor is the LMS iframe itself, seed those values on
    // the same-origin parent before h5peditor.js executes.
    const parentBridge = `<script>
        try {
            window.parent['H5PEditor'] = window.H5PEditor;
            window.parent['H5PIntegration'] = window.H5PIntegration;
        } catch (error) {
            console.warn('H5P parent bridge is unavailable.', error);
        }
    </script>`;
    html = html.replace(
        /(<script[^>]+src="[^"]*\/h5peditor\.js[^"]*"[^>]*>)/i,
        parentBridge + '$1'
    );

    // Fix cross-origin frame access errors by wrapping parent access in try-catch
    // The H5P library tries to access parent properties which causes cross-origin errors

    // Fix H5PIntegration. H5P's template prefers the parent window's copy, but
    // the parent here is the LMS page and the bridge above is what puts a copy
    // there in the first place. Reading it back would resurrect the *previous*
    // render — including its language — whenever the LMS remounts this iframe,
    // so the freshly rendered object always wins.
    html = html.replace(
        /window\.H5PIntegration\s*=\s*parent\.H5PIntegration\s*\|\|/g,
        'window.H5PIntegration ='
    );

    // Fix H5PEditor references to parent
    html = html.replace(
        /parent\.H5PEditor/g,
        '(function() { try { return parent.H5PEditor; } catch(e) { return window.H5PEditor; } })()'
    );

    // Add a script to ensure H5PEditor is available
    const crossOriginFix = `
    <script>
        // Prevent cross-origin errors when H5P libraries try to access parent
        (function() {
            // Create safe wrapper for parent access
            var safeParent = {};
            try {
                // Try to access parent - this will fail if cross-origin
                if (parent && parent.H5PEditor) {
                    safeParent = parent;
                }
            } catch(e) {
                // Cross-origin error - use window instead
                safeParent = window;
            }

            // Make sure H5PEditor is accessible
            if (window.H5PEditor && !window.H5PEditor.instances) {
                window.H5PEditor.instances = [];
            }
        })();
    </script>`;

    html = html.replace('</head>', crossOriginFix + '</head>');

    // Change button text from "Create" to "Save" when editing existing content
    if (contentId) {
        html = html.replace('value="Create"', `value="${chrome.save}"`);
    }

    // h5p-server only swaps h5p/editor/language/en.js for a language on its own
    // hardcoded allow-list (assets/editorLanguages.json), which has no Vietnamese
    // entry. Point the script tag at our file whenever we actually ship one.
    if (language !== 'en' && existsSync(path.join(h5pBasePath, 'editor', 'language', `${language}.js`))) {
        html = html.replace('language/en.js', `language/${language}.js`);
    }

    return html;
}

// ============================================================================
// Content Hub / Content Type Selection
// ============================================================================

// Get available content types (for content picker)
app.get('/api/content-types', async (req, res) => {
    try {
        const contentTypes = await h5pEditor.getContentTypeCache(createUser(req));
        res.json({ contentTypes: contentTypes.libraries || [] });
    } catch (error) {
        console.error('Error getting content types:', error);
        res.json({ contentTypes: [] });
    }
});

// ============================================================================
// Health Check
// ============================================================================

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'h5p-server' });
});

// ============================================================================
// Start Server
// ============================================================================

async function start() {
    try {
        await initH5P();
        await setupRoutes();
        await addErrorHandlers();

        app.listen(PORT, () => {
            console.log(`H5P Server running on http://localhost:${PORT}`);
            console.log(`  - Player: http://localhost:${PORT}/play/:contentId`);
            console.log(`  - Editor: http://localhost:${PORT}/edit/:contentId`);
            console.log(`  - New Content: http://localhost:${PORT}/new`);
            console.log(`  - Content API: http://localhost:${PORT}/api/content`);
        });
    } catch (error) {
        console.error('Failed to start H5P server:', error);
        process.exit(1);
    }
}

start();
