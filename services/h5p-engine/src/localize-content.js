/**
 * Localises the UI strings a content type shows to learners.
 *
 * H5P stores those strings inside each content's own parameters: the editor
 * copies them out of the library's semantics defaults at creation time and the
 * player never looks at them again. Content authored while the editor was in
 * English therefore keeps English buttons forever, no matter what language the
 * player is opened in — which is the "half Vietnamese, half English" effect.
 *
 * This module rewrites those parameters on the way to the player. It only
 * touches a value that still equals the English default, so anything the author
 * deliberately typed is left exactly as written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CATALOG_DIR = path.resolve(__dirname, '../translations/runtime');

/** Widgets whose "default" is a machine value rather than copy. */
const NON_TEXT_WIDGETS = new Set(['colorSelector', 'showWhen', 'none']);

const catalogCache = new Map();
const pathsCache = new Map();

/**
 * Loads the English → target-language table for a language, or null when the
 * language has no catalog (English itself, or one nobody has translated).
 */
export function loadCatalog(language) {
    const key = String(language || '').toLowerCase();
    if (catalogCache.has(key)) return catalogCache.get(key);

    let catalog = null;
    if (/^[a-z]{2}(-[a-z]{2})?$/.test(key) && key !== 'en') {
        const file = path.join(CATALOG_DIR, `${key}.json`);
        try {
            catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn(`Could not read runtime translations for "${key}":`, error.message);
            }
            catalog = null;
        }
    }

    catalogCache.set(key, catalog);
    return catalog;
}

/**
 * True when a semantics field holds copy shown to learners. Decided from the
 * schema rather than the value: a colour picker's "#000000" and a select's
 * "auto" are defaults too, and translating them would corrupt the content.
 */
export function isTranslatableField(field) {
    if (!field || field.type !== 'text') return false;
    if (Array.isArray(field.options) && field.options.length) return false;
    if (field.widget && NON_TEXT_WIDGETS.has(field.widget)) return false;
    if (/colou?r/i.test(field.name || '')) return false;

    const value = field.default;
    if (typeof value !== 'string' || !value.trim()) return false;
    if (/^#[0-9a-f]{3,8}$/i.test(value.trim())) return false;
    if (!/[a-z]/i.test(value)) return false;
    // Markup carrying no words is a layout default, not copy.
    if (!value.replace(/<[^>]*>/g, '').trim()) return false;
    return true;
}

/**
 * Walks a semantics tree and records, for every field that holds copy, the
 * English default keyed by its dotted parameter path. Lists ("list" type) use a
 * "*" segment because every entry shares one schema.
 */
export function collectPaths(semantics, into = new Map(), prefix = '') {
    if (!Array.isArray(semantics)) return into;

    for (const field of semantics) {
        if (!field || !field.name) continue;
        const at = prefix + field.name;

        if (isTranslatableField(field)) into.set(at, field.default);
        if (Array.isArray(field.fields)) collectPaths(field.fields, into, `${at}.`);

        // A list's schema lives in "field" and applies to every element. That
        // wrapper carries a name of its own, but list entries are stored
        // without it, so it must not become a path segment.
        if (field.field) {
            const item = field.field;
            if (Array.isArray(item.fields)) {
                collectPaths(item.fields, into, `${at}.*.`);
            } else if (isTranslatableField(item)) {
                // A list of bare scalars: the element has no key at all.
                into.set(`${at}.*`, item.default);
            }
        }
    }

    return into;
}

/** Cached per library so repeated plays do not re-walk the same semantics. */
function pathsFor(libraryKey, semantics) {
    if (pathsCache.has(libraryKey)) return pathsCache.get(libraryKey);
    const paths = collectPaths(semantics);
    pathsCache.set(libraryKey, paths);
    return paths;
}

/**
 * Applies the catalog to one content's parameters.
 *
 * Returns the number of strings replaced so callers can log whether a content
 * actually needed anything, without having to diff the objects.
 */
export function localizeParams(params, semantics, catalog, libraryKey = 'unknown') {
    if (!params || !catalog || !Array.isArray(semantics)) return 0;

    const paths = pathsFor(libraryKey, semantics);
    if (!paths.size) return 0;

    let replaced = 0;

    const walk = (node, prefix) => {
        if (!node || typeof node !== 'object') return;

        if (Array.isArray(node)) {
            // Every element of a list shares the schema recorded under "*".
            for (const item of node) walk(item, prefix);
            return;
        }

        for (const [key, value] of Object.entries(node)) {
            const at = prefix + key;

            if (typeof value === 'string') {
                const englishDefault = paths.get(at) ?? paths.get(`${prefix}*.${key}`);
                // Only an untouched default may be swapped; author text stays.
                if (englishDefault !== undefined && value === englishDefault) {
                    const translated = catalog[value];
                    if (typeof translated === 'string' && translated && translated !== value) {
                        node[key] = translated;
                        replaced += 1;
                    }
                }
                continue;
            }

            if (Array.isArray(value)) {
                const scalarDefault = paths.get(`${at}.*`);
                value.forEach((item, index) => {
                    if (typeof item === 'string') {
                        if (scalarDefault !== undefined && item === scalarDefault) {
                            const translated = catalog[item];
                            if (typeof translated === 'string' && translated && translated !== item) {
                                value[index] = translated;
                                replaced += 1;
                            }
                        }
                        return;
                    }
                    walk(item, `${at}.*.`);
                });
                continue;
            }

            if (value && typeof value === 'object') walk(value, `${at}.`);
        }
    };

    walk(params, '');
    return replaced;
}

/**
 * Localises an editor semantics tree in place: the labels, descriptions and
 * placeholders an author sees, plus the defaults that will be copied into any
 * content they create.
 *
 * H5P ships a vi.json for only some libraries and, where it exists, it is
 * mostly still English. Applying the catalogue here rather than editing those
 * files keeps the translations when a library is updated from the Hub.
 */
export function localizeSemantics(semantics, catalog) {
    if (!Array.isArray(semantics) || !catalog) return 0;

    let replaced = 0;

    const visit = (fields) => {
        if (!Array.isArray(fields)) return;

        for (const field of fields) {
            if (!field || typeof field !== 'object') continue;

            for (const key of ['label', 'description', 'placeholder', 'entity']) {
                const value = field[key];
                if (typeof value !== 'string' || !value.trim()) continue;
                const translated = catalog[value];
                if (typeof translated === 'string' && translated && translated !== value) {
                    field[key] = translated;
                    replaced += 1;
                }
            }

            // The default is what ends up inside new content, so translating it
            // here is what makes freshly authored content start out localised.
            if (isTranslatableField(field)) {
                const translated = catalog[field.default];
                if (typeof translated === 'string' && translated && translated !== field.default) {
                    field.default = translated;
                    replaced += 1;
                }
            }

            if (Array.isArray(field.fields)) visit(field.fields);
            if (field.field) visit([field.field]);
            // Select options carry their own human-readable labels.
            if (Array.isArray(field.options)) {
                for (const option of field.options) {
                    if (option && typeof option === 'object' && typeof option.label === 'string') {
                        const translated = catalog[option.label];
                        if (typeof translated === 'string' && translated && translated !== option.label) {
                            option.label = translated;
                            replaced += 1;
                        }
                    }
                }
            }
        }
    };

    visit(semantics);
    return replaced;
}

/**
 * Localises every content entry in a player model in place.
 *
 * `getSemantics` is injected rather than imported so this module stays free of
 * the H5P editor instance and can be unit-tested with plain objects.
 */
export async function localizePlayerModel(model, language, getSemantics) {
    const catalog = loadCatalog(language);
    if (!catalog || !model?.integration?.contents) return 0;

    let total = 0;

    for (const entry of Object.values(model.integration.contents)) {
        if (!entry || typeof entry.jsonContent !== 'string') continue;

        // "H5P.MarkTheWords 1.11" — the form the integration uses.
        const library = String(entry.library || '');
        const match = /^(\S+)\s+(\d+)\.(\d+)$/.exec(library);
        if (!match) continue;

        let semantics;
        try {
            semantics = await getSemantics({
                machineName: match[1],
                majorVersion: Number(match[2]),
                minorVersion: Number(match[3]),
            });
        } catch (error) {
            console.warn(`Could not load semantics for ${library}:`, error.message);
            continue;
        }

        let params;
        try {
            params = JSON.parse(entry.jsonContent);
        } catch {
            continue;
        }

        const replaced = localizeParams(params, semantics, catalog, library);
        if (replaced) {
            entry.jsonContent = JSON.stringify(params);
            total += replaced;
        }
    }

    return total;
}

