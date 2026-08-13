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
import { loadCatalog, localizePlayerModel, localizeSemantics } from './localize-content.js';

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
// "*" opens embedding to every origin: any page may host an exported package
// and receive that learner's results via postMessage.
const H5P_ALLOW_ANY_EMBEDDER = H5P_EMBEDDER_ORIGINS.has('*');
const H5P_CORS_ORIGINS = new Set([...H5P_EMBEDDER_ORIGINS, H5P_SELF_ORIGIN]);

function getEmbedderOrigin(returnUrl) {
    try {
        // Even with the wildcard the postMessage target stays the embedder's
        // exact origin — results are never broadcast with a literal "*".
        const origin = new URL(String(returnUrl)).origin;
        if (H5P_ALLOW_ANY_EMBEDDER || H5P_EMBEDDER_ORIGINS.has(origin)) return origin;
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
        if (!origin || H5P_ALLOW_ANY_EMBEDDER || H5P_CORS_ORIGINS.has(normalizeOrigin(origin))) return callback(null, true);
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
// Where a learner's in-progress state lives, so leaving and coming back resumes
// instead of restarting.
const userDataPath = path.join(h5pBasePath, 'user-data');

// Ensure directories exist
async function ensureDirectories() {
    await fs.mkdir(librariesPath, { recursive: true });
    await fs.mkdir(contentPath, { recursive: true });
    await fs.mkdir(tempPath, { recursive: true });
    await fs.mkdir(userDataPath, { recursive: true });

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
            // The Hub must issue the UUID. Generating one locally makes the
            // Hub reject the catalog request and leaves the editor with no
            // content types.
            uuid: '',
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
let contentUserDataStorage;

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
    // Without this, H5P has nowhere to keep a learner's progress and every
    // relaunch starts from scratch.
    contentUserDataStorage = new H5P.fsImplementations.FileContentUserDataStorage(userDataPath);

    h5pEditor = new H5P.H5PEditor(
        cacheStorage,
        config,
        libraryStorage,
        contentStorage,
        temporaryStorage,
        translationCallback,
        urlGenerator,
        undefined,           // options
        contentUserDataStorage
    );

    // Create a proper H5PPlayer instance for playing content
    h5pPlayer = new H5P.H5PPlayer(
        libraryStorage,
        contentStorage,
        config,
        undefined,           // integrationObjectDefaults
        urlGenerator,
        translationCallback,
        undefined,           // options
        contentUserDataStorage
    );

    // The editor asks for a library's semantics through getLibraryData. H5P's
    // own vi.json files cover only a fraction of the strings, so the catalogue
    // is applied on top of whatever they provide — here rather than in those
    // files, so a Hub update cannot wipe the translations.
    const originalGetLibraryData = h5pEditor.getLibraryData.bind(h5pEditor);
    h5pEditor.getLibraryData = async (machineName, majorVersion, minorVersion, language) => {
        const data = await originalGetLibraryData(machineName, majorVersion, minorVersion, language);
        const catalog = loadCatalog(language);
        if (catalog && data) {
            try {
                if (data.semantics) localizeSemantics(data.semantics, catalog);

                // The editor client deep-merges these language files OVER the
                // semantics after loading, so an untranslated file would undo
                // everything done above. They are JSON strings of the same
                // shape, so the same walker applies.
                for (const key of ['language', 'defaultLanguage']) {
                    if (typeof data[key] !== 'string') continue;
                    try {
                        const parsed = JSON.parse(data[key]);
                        if (localizeSemantics(parsed?.semantics, catalog) > 0) {
                            data[key] = JSON.stringify(parsed);
                        }
                    } catch {
                        // Not JSON — leave whatever it is alone.
                    }
                }
            } catch (error) {
                // Losing a translation is better than losing the editor.
                console.warn(`Could not localise semantics for ${machineName}:`, error.message);
            }
        }
        return data;
    };

    // The model is returned unchanged so the route can localise the content
    // parameters — which needs the request's language — before the HTML is
    // built. renderPlayerHtml() below is the renderer that used to live here;
    // it also omits the download link the default renderer always shows.
    h5pPlayer.setRenderer((model) => model);

    console.log('H5P initialized successfully');
}

/** Builds the player page from a (possibly localised) player model. */
function renderPlayerHtml(model) {
    return `<!doctype html>
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
</html>`;
}

// ============================================================================
// H5P AJAX Routes (handled by @lumieducation/h5p-express)
// ============================================================================

async function setupRoutes() {
    const {
        h5pAjaxExpressRouter,
        contentUserDataExpressRouter,
        finishedDataExpressRouter
    } = await import('@lumieducation/h5p-express');

    // Middleware to set req.user for H5P router
    app.use((req, res, next) => {
        req.user = createUser(req);
        next();
    });

    // The editor appends the page's own query (uiLanguage among it) to every
    // AJAX call, but the h5p endpoints only read `language`. Filling it in here
    // localises even requests built from an ajaxPath that predates the
    // language-in-path fix — e.g. a cached editor page.
    app.use('/h5p/ajax', (req, res, next) => {
        // The ajaxPath already carries ?language=…, and h5peditor.js appends
        // its own language=en to some calls. Express turns the duplicate into
        // an array, which the endpoint rejects as "Language code vi,en is
        // invalid" — a 500 the editor shows as an eternal loading spinner.
        // Keep the first value: that is the page's render language.
        if (Array.isArray(req.query.language)) {
            req.query.language = req.query.language[0];
        } else if (typeof req.query.language === 'string' && req.query.language.includes(',')) {
            req.query.language = req.query.language.split(',')[0];
        }
        if (!req.query.language) {
            req.query.language = resolveLanguage(req);
        }

        // The translations action answers with each library's language file —
        // or English semantics when the file is missing. Untranslated entries
        // would override the localised labels client-side, so run the catalogue
        // over them as well.
        if (req.query.action === 'translations') {
            const catalog = loadCatalog(req.query.language);
            if (catalog) {
                const originalJson = res.json.bind(res);
                res.json = (body) => {
                    try {
                        const entries = body?.data ?? {};
                        for (const [name, raw] of Object.entries(entries)) {
                            if (typeof raw !== 'string') continue;
                            const parsed = JSON.parse(raw);
                            if (localizeSemantics(parsed?.semantics, catalog) > 0) {
                                entries[name] = JSON.stringify(parsed);
                            }
                        }
                    } catch (error) {
                        console.warn('Could not localise translations response:', error.message);
                    }
                    return originalJson(body);
                };
            }
        }

        // The content type list (title/summary/description per library) comes
        // from the H5P Hub in English only; swap what the catalogue covers.
        if (req.query.action === 'content-type-cache') {
            const catalog = loadCatalog(req.query.language);
            if (catalog) {
                const originalJson = res.json.bind(res);
                res.json = (body) => {
                    try {
                        // Titles stay untranslated: they are product names the
                        // author searches by, and only a random subset would
                        // have catalogue hits anyway.
                        for (const lib of body?.libraries ?? []) {
                            for (const key of ['summary', 'description']) {
                                const translated = catalog[lib?.[key]];
                                if (typeof translated === 'string' && translated) lib[key] = translated;
                            }
                        }
                    } catch (error) {
                        console.warn('Could not localise content type cache:', error.message);
                    }
                    return originalJson(body);
                };
            }
        }
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

    // The player's integration already points at /contentUserData and
    // /finishedData; without these routers those calls 404 and progress is lost.
    app.use('/', contentUserDataExpressRouter(h5pEditor.contentUserDataManager, h5pEditor.config));
    app.use('/', finishedDataExpressRouter(h5pEditor.contentUserDataManager, h5pEditor.config));
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

/**
 * Origins this engine will postMessage results to. The package builder checks
 * this before producing a package, so an origin missing from the allow-list is
 * reported at build time instead of silently dropping every result at runtime.
 */
app.get('/api/embed-origins', (req, res) => {
    res.json({ origins: [...H5P_EMBEDDER_ORIGINS] });
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

        // A SCORM/xAPI host owns the attempt lifecycle: when it launches without
        // suspend data it is starting a fresh attempt, and the learner must not
        // silently resume the previous one. Absent the parameter we resume, which
        // is what the LMS's own player wants.
        if (req.query.resume === '0') {
            try {
                await h5pEditor.contentUserDataManager.deleteAllContentUserDataByUser(user.id, user);
            } catch (error) {
                console.warn(`Could not clear saved state for ${user.id}:`, error.message);
            }
        }

        // Default on so the LMS's own player keeps recording results; an export
        // that reports through SCORM turns it off with relay=0.
        const relayResults = req.query.relay !== '0';

        const language = resolveLanguage(req);

        // The renderer is set to return the model, so the content's own UI
        // strings can be localised before the page is built.
        const playerModel = await h5pPlayer.render(
            contentId,
            user,
            language,
            {
                showCopyButton: false,
                showDownloadButton: false,
                showFrame: true,
                showH5PIcon: false,
                showLicenseButton: false,
                // With results going to the host's runtime, H5P must not also
                // post the learner's state back here on a timer — that is the
                // contentUserData traffic an LMS operator sees and does not want.
                readOnlyState: !relayResults
            }
        );

        // Content authored in another language keeps that language's button
        // labels in its own parameters; swap the untouched defaults over so the
        // whole page reads in one language.
        try {
            const replaced = await localizePlayerModel(
                playerModel,
                language,
                (library) => h5pEditor.libraryManager.getSemantics(library)
            );
            if (replaced && H5P_DEBUG) {
                console.log(`Localised ${replaced} UI string(s) to "${language}" for content ${contentId}`);
            }
        } catch (error) {
            // A translation failure must not cost the learner the content.
            console.warn(`Could not localise content ${contentId}:`, error.message);
        }

        let playerHtml = renderPlayerHtml(playerModel);

        if (!relayResults) {
            // setFinished is driven by config, not by render options, so the one
            // remaining call home is switched off in the integration itself.
            playerHtml = playerHtml.replace('"postUserStatistics": true', '"postUserStatistics": false');
        }

        // Inject H5P init and xAPI tracking script before </body>
        const safeContentId = JSON.stringify(contentId);
        const safeUserId = JSON.stringify(user.id);
        // A SCORM package embeds this player from the LMS's own origin, so the
        // postMessage target has to follow the embedder instead of the single
        // configured parent. Unlisted origins fall back to H5P_PARENT_ORIGIN.
        const embedderOrigin = getEmbedderOrigin(req.query.embedOrigin);
        const safeParentOrigin = JSON.stringify(embedderOrigin);
        // Falling back means results would be posted to an origin the embedder
        // is not listening on, and the host would silently record nothing.
        const embedOriginRejected = Boolean(req.query.embedOrigin)
            && normalizeOrigin(String(req.query.embedOrigin)) !== embedderOrigin;
        const safeRejectedOrigin = JSON.stringify(String(req.query.embedOrigin || ''));
        // Absolute, not "/api/xapi-relay": the player is served under the LMS
        // proxy prefix (H5P_BASE_URL), so a root-relative URL would post to the
        // LMS origin instead of the engine and every result would be dropped.
        const safeRelayUrl = JSON.stringify(`${H5P_BASE_URL.replace(/\/$/, '')}/api/xapi-relay`);
        // A SCORM host that keeps the learner's state in cmi.suspend_data hands
        // it back on launch. H5P reads the state during init, so initialisation
        // has to wait for it rather than start and be corrected afterwards.
        const awaitHostState = req.query.awaitState === '1';
        const xapiScript = `
    <script>
        // Debug H5P initialization
        console.log('H5P script loaded, checking H5P object...');
        console.log('H5P:', typeof H5P);
        console.log('H5PIntegration:', typeof H5PIntegration);
        console.log('jQuery:', typeof jQuery);

        var h5pAwaitHostState = ${awaitHostState};
        var h5pRelayResults = ${relayResults};

        if (${embedOriginRejected}) {
            console.error(
                'H5P: origin ' + ${safeRejectedOrigin} + ' is not in H5P_ALLOWED_ORIGINS, so results ' +
                'are being posted to ' + ${safeParentOrigin} + ' and the embedding page will never ' +
                'receive them. Add the origin to H5P_ALLOWED_ORIGINS on the engine.'
            );
        }
        var h5pContentKey = 'cid-' + ${safeContentId};
        var h5pStarted = false;

        // With results going to the host, H5P must not post the learner's state
        // back here. saveFreq cannot simply be turned off — H5P also gates
        // restoring a previous state on it — so the sending functions are
        // replaced instead, keeping H5P's in-memory cache coherent.
        if (!h5pRelayResults && typeof H5P !== 'undefined') {
            H5P.setUserData = function (contentId, dataId, data, extras) {
                var options = { subContentId: 0 };
                if (extras && extras.subContentId !== undefined) options.subContentId = extras.subContentId;

                var serialised;
                try {
                    serialised = JSON.stringify(data);
                } catch (error) {
                    return;
                }

                var content = H5PIntegration.contents['cid-' + contentId];
                if (!content) content = H5PIntegration.contents['cid-' + contentId] = {};
                if (!content.contentUserData) content.contentUserData = {};
                if (!content.contentUserData[options.subContentId]) content.contentUserData[options.subContentId] = {};
                content.contentUserData[options.subContentId][dataId] = serialised;
            };

            H5P.deleteUserData = function () {};

            // Reading falls back to an AJAX call when nothing is preloaded, which
            // is the last request that would still reach this server. The host's
            // copy is seeded into the integration before init, so the cache is
            // the only source that matters here.
            H5P.getUserData = function (contentId, dataId, done, subContentId) {
                if (!subContentId) subContentId = 0;

                var content = (H5PIntegration.contents || {})['cid-' + contentId] || {};
                var preloaded = content.contentUserData;
                var raw = preloaded && preloaded[subContentId] ? preloaded[subContentId][dataId] : undefined;

                if (raw === undefined) return done(undefined, undefined);
                if (raw === 'RESET') return done(undefined, null);

                try {
                    done(undefined, JSON.parse(raw));
                } catch (error) {
                    done(error);
                }
            };
        }

        // H5P core initialises itself on document ready. When the host is going
        // to supply the learner's state we must be the one to start it, or H5P
        // reads the state before the host's copy has arrived. The flag has to be
        // set before document ready, which is why this runs inline.
        if (h5pAwaitHostState && typeof H5P !== 'undefined') {
            H5P.preventInit = true;
        }

        function h5pSeedState(serialisedState) {
            if (!serialisedState) return;
            try {
                var content = H5PIntegration.contents[h5pContentKey];
                if (!content) return;
                // Same shape H5P.getUserData reads: [subContentId][dataType].
                content.contentUserData = [{ state: serialisedState }];
            } catch (error) {
                console.warn('Could not seed H5P state from host:', error);
            }
        }

        function h5pStart() {
            if (h5pStarted) return;
            h5pStarted = true;
            if (typeof H5P !== 'undefined' && H5P.init) {
                console.log('Calling H5P.init...');
                H5P.init(document.body);
            }
        }

        // H5P bundles jQuery as H5P.jQuery and exposes no global, so anything
        // gated on a global "jQuery" would never run.
        function h5pOnReady(callback) {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', callback);
            } else {
                callback();
            }
        }

        // Without the gate H5P starts itself, which is the behaviour every
        // ordinary launch relies on; only the host-state path takes over.
        if (h5pAwaitHostState) {
            h5pOnReady(function () {
                // Ask the host for its copy, but never hang on a host that
                // cannot answer — the server-side state is still there.
                if (window.parent !== window) {
                    window.parent.postMessage({ type: 'h5p-state-request', contentId: ${safeContentId} }, ${safeParentOrigin});
                }
                window.setTimeout(h5pStart, 3000);
            });
        }

        window.addEventListener('message', function (event) {
            if (event.origin !== ${safeParentOrigin}) return;
            if (!event.data || event.data.type !== 'h5p-state-restore') return;
            if (!h5pStarted) h5pSeedState(event.data.state);
            h5pStart();
        });

        // Report the learner's progress upwards so a host can persist it in its
        // own store (cmi.suspend_data) alongside the server-side copy.
        function h5pCurrentState() {
            try {
                var instance = (H5P.instances || [])[0];
                if (!instance || typeof instance.getCurrentState !== 'function') return undefined;
                var state = instance.getCurrentState();
                return state === undefined ? undefined : JSON.stringify(state);
            } catch (error) {
                return undefined;
            }
        }

        var h5pLastSentState;
        function h5pPublishState() {
            if (window.parent === window) return;
            var state = h5pCurrentState();
            if (state === undefined || state === h5pLastSentState) return;
            h5pLastSentState = state;
            window.parent.postMessage({
                type: 'h5p-state',
                contentId: ${safeContentId},
                state: state
            }, ${safeParentOrigin});
        }

        window.setInterval(h5pPublishState, 5000);
        window.addEventListener('beforeunload', h5pPublishState);

        // Track xAPI events
        H5P.externalDispatcher.on('xAPI', function(event) {
            const statement = event.data.statement;

            // Results, plus "progressed" because a completion rule can be set on
            // a step/slide number and that verb is the only carrier of it.
            if (statement.verb && (
                statement.verb.id.includes('completed') ||
                statement.verb.id.includes('answered') ||
                statement.verb.id.includes('passed') ||
                statement.verb.id.includes('failed') ||
                statement.verb.id.includes('progressed')
            )) {
                // An exported package reports through its host's own runtime
                // (the SCORM API, or the LRS it was launched from). Calling home
                // as well would make this server a second, competing system of
                // record, so the embedder can switch it off.
                if (h5pRelayResults) fetch(${safeRelayUrl}, {
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

    // Every AJAX call the editor makes is built by appending to ajaxPath, and
    // h5p-server emits that path without a language. The libraries endpoint
    // reads `req.query.language`, so without this the semantics come back in
    // English however the page itself was rendered — which is what leaves the
    // form full of English labels next to a Vietnamese frame.
    // Global: the integration object is serialised into this page more than
    // once (outer page and nested editor frame), and the editor reads the later
    // copy — patching only the first left the form loading English semantics.
    html = html.replace(
        /("ajaxPath":\s*")([^"]*\/h5p\/ajax\?)(action=)/g,
        `$1$2language=${encodeURIComponent(language)}&$3`
    );

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
