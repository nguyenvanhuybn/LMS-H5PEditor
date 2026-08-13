/**
 * Shared helpers for the library bundle tooling.
 *
 * A bundle is a zip of h5p/libraries plus a bundle.json describing exactly which
 * library versions it holds. Its version is content-addressed, so re-packing an
 * unchanged library set produces the same version and deploys stay comparable.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** services/h5p-engine */
export const ENGINE_ROOT = path.resolve(here, '../..');

/** Same resolution rule as the engine itself, so tooling and server agree. */
export const H5P_DATA_PATH = path.resolve(
    process.env.H5P_DATA_PATH || path.resolve(ENGINE_ROOT, 'h5p')
);

export const LIBRARIES_PATH = path.join(H5P_DATA_PATH, 'libraries');
export const BUNDLE_DIR = path.resolve(
    process.env.H5P_BUNDLE_DIR || path.join(ENGINE_ROOT, 'library-bundles')
);

/** Written into the libraries folder to record which bundle produced it. */
export const MARKER_FILE = path.join(LIBRARIES_PATH, '.bundle.json');

export const MANIFEST_ENTRY = 'bundle.json';

/**
 * A library folder is named "<machineName>-<major>.<minor>"; the patch version
 * only exists inside library.json, and it is what upgrades move forward.
 */
export async function readInstalledLibraries() {
    if (!existsSync(LIBRARIES_PATH)) return [];

    const entries = await fs.readdir(LIBRARIES_PATH, { withFileTypes: true });
    const libraries = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        try {
            const raw = await fs.readFile(path.join(LIBRARIES_PATH, entry.name, 'library.json'), 'utf-8');
            const library = JSON.parse(raw);
            libraries.push({
                directory: entry.name,
                machineName: library.machineName,
                majorVersion: Number(library.majorVersion),
                minorVersion: Number(library.minorVersion),
                patchVersion: Number(library.patchVersion ?? 0),
                title: library.title ?? library.machineName,
                runnable: library.runnable === 1 || library.runnable === true
            });
        } catch {
            // A directory without a readable library.json is not a library.
        }
    }

    return libraries.sort((a, b) => a.directory.localeCompare(b.directory));
}

export function versionString(library) {
    return `${library.majorVersion}.${library.minorVersion}.${library.patchVersion}`;
}

/** Returns >0 when a is newer than b, 0 when equal, <0 when older. */
export function compareVersions(a, b) {
    return (a.majorVersion - b.majorVersion)
        || (a.minorVersion - b.minorVersion)
        || (a.patchVersion - b.patchVersion);
}

/**
 * Content-addressed version: the same set of libraries at the same versions
 * always yields the same string, which makes "is this deploy up to date?" a
 * string comparison rather than a directory diff.
 */
export function computeBundleVersion(libraries, today = new Date()) {
    const fingerprint = libraries
        .map((library) => `${library.directory}@${versionString(library)}`)
        .join('\n');
    const digest = createHash('sha256').update(fingerprint).digest('hex').slice(0, 8);
    const date = today.toISOString().slice(0, 10).replace(/-/g, '.');
    return `${date}-${digest}`;
}

export async function sha256OfFile(file) {
    const hash = createHash('sha256');
    await pipeline(createReadStream(file), hash);
    return hash.digest('hex');
}

export async function listFilesRecursively(root, prefix = '') {
    const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) files.push(...await listFilesRecursively(root, relative));
        else if (entry.isFile()) files.push(relative);
    }

    return files;
}

export async function readMarker() {
    try {
        return JSON.parse(await fs.readFile(MARKER_FILE, 'utf-8'));
    } catch {
        return null;
    }
}

export async function writeMarker(manifest) {
    await fs.mkdir(LIBRARIES_PATH, { recursive: true });
    await fs.writeFile(MARKER_FILE, JSON.stringify({
        version: manifest.version,
        restoredAt: new Date().toISOString(),
        libraryCount: manifest.libraries.length
    }, null, 2));
}

/** Newest bundle in BUNDLE_DIR by manifest version, or null when there is none. */
export async function findLatestBundle() {
    if (!existsSync(BUNDLE_DIR)) return null;

    const files = (await fs.readdir(BUNDLE_DIR)).filter((name) => name.endsWith('.zip'));
    if (files.length === 0) return null;

    const bundles = [];
    for (const file of files) {
        const manifestFile = path.join(BUNDLE_DIR, file.replace(/\.zip$/, '.manifest.json'));
        try {
            bundles.push({
                archive: path.join(BUNDLE_DIR, file),
                manifest: JSON.parse(await fs.readFile(manifestFile, 'utf-8'))
            });
        } catch {
            // A zip without its manifest cannot be reasoned about; skip it.
        }
    }

    if (bundles.length === 0) return null;
    bundles.sort((a, b) => a.manifest.version.localeCompare(b.manifest.version));
    return bundles[bundles.length - 1];
}

export async function copyStreamToFile(readStream, destination) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await pipeline(readStream, createWriteStream(destination));
}

export function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
