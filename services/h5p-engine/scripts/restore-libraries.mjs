/**
 * Restores a library bundle into h5p/libraries on a fresh environment.
 *
 *   npm run libraries:restore                 # newest bundle in library-bundles/
 *   npm run libraries:restore -- <file.zip>   # a specific bundle
 *   npm run libraries:restore -- --force      # overwrite even newer libraries
 *
 * By default a library already on disk at the same or a newer version is left
 * alone, so restoring never undoes an update an author applied through the
 * editor's Hub button.
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl-promise';
import {
    LIBRARIES_PATH,
    MANIFEST_ENTRY,
    compareVersions,
    copyStreamToFile,
    findLatestBundle,
    formatBytes,
    readInstalledLibraries,
    readMarker,
    versionString,
    writeMarker
} from './lib/bundle.mjs';

async function readManifestFromArchive(archivePath) {
    const zip = await yauzl.open(archivePath);
    try {
        for await (const entry of zip) {
            if (entry.filename !== MANIFEST_ENTRY) continue;
            const stream = await entry.openReadStream();
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        }
    } finally {
        await zip.close();
    }
    throw new Error(`Bundle thiếu ${MANIFEST_ENTRY} — không phải bundle hợp lệ.`);
}

async function main() {
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    const explicit = args.find((arg) => !arg.startsWith('--'));

    let archivePath;
    if (explicit) {
        archivePath = path.resolve(explicit);
        if (!existsSync(archivePath)) {
            console.error(`Không tìm thấy bundle: ${archivePath}`);
            process.exitCode = 1;
            return;
        }
    } else {
        const latest = await findLatestBundle();
        if (!latest) {
            console.error('Không có bundle nào. Chạy "npm run libraries:pack" trước, hoặc chỉ định đường dẫn file .zip.');
            process.exitCode = 1;
            return;
        }
        archivePath = latest.archive;
    }

    const manifest = await readManifestFromArchive(archivePath);
    const marker = await readMarker();

    console.log(`Bundle   : ${path.basename(archivePath)} (phiên bản ${manifest.version}, ${manifest.libraryCount} library)`);
    console.log(`Đích     : ${LIBRARIES_PATH}`);
    console.log(`Hiện tại : ${marker ? `phiên bản ${marker.version} khôi phục lúc ${marker.restoredAt}` : 'chưa từng khôi phục bundle nào'}`);

    const installed = new Map();
    for (const library of await readInstalledLibraries()) installed.set(library.directory, library);

    // Decide per library before touching the disk, so the plan can be reported
    // even when nothing needs doing.
    const wanted = new Map();
    for (const library of manifest.libraries) {
        const current = installed.get(library.directory);
        if (!current) wanted.set(library.directory, 'new');
        else if (force) wanted.set(library.directory, 'forced');
        else if (compareVersions(library, current) > 0) wanted.set(library.directory, 'upgrade');
    }

    if (wanted.size === 0) {
        console.log('');
        console.log('Không có gì phải khôi phục — mọi library đã có bản bằng hoặc mới hơn.');
        await writeMarker(manifest);
        return;
    }

    console.log('');
    console.log(`Sẽ ghi ${wanted.size} library:`);
    for (const [directory, reason] of [...wanted].slice(0, 8)) console.log(`  ${directory} (${reason})`);
    if (wanted.size > 8) console.log(`  … và ${wanted.size - 8} library nữa`);

    await fs.mkdir(LIBRARIES_PATH, { recursive: true });

    // Replace each selected library wholesale: leaving stale files behind from a
    // previous version is how half-upgraded libraries start failing at runtime.
    for (const directory of wanted.keys()) {
        await fs.rm(path.join(LIBRARIES_PATH, directory), { recursive: true, force: true });
    }

    const zip = await yauzl.open(archivePath);
    let written = 0;
    let bytes = 0;

    try {
        for await (const entry of zip) {
            if (entry.filename.endsWith('/')) continue;
            if (!entry.filename.startsWith('libraries/')) continue;

            const relative = entry.filename.slice('libraries/'.length);
            const directory = relative.split('/')[0];
            if (!wanted.has(directory)) continue;

            // Guard against a crafted archive escaping the libraries folder.
            const destination = path.resolve(LIBRARIES_PATH, relative);
            if (!destination.startsWith(LIBRARIES_PATH + path.sep)) {
                throw new Error(`Đường dẫn không hợp lệ trong bundle: ${entry.filename}`);
            }

            await copyStreamToFile(await entry.openReadStream(), destination);
            written++;
            bytes += entry.uncompressedSize ?? 0;
        }
    } finally {
        await zip.close();
    }

    await writeMarker(manifest);

    const after = await readInstalledLibraries();
    console.log('');
    console.log(`Đã khôi phục ${wanted.size} library (${written} file, ${formatBytes(bytes)}).`);
    console.log(`Tổng library trên đĩa: ${after.length}`);
    console.log(`Đánh dấu phiên bản   : ${manifest.version}`);

    const missing = manifest.libraries.filter((library) => !after.some((a) => a.directory === library.directory));
    if (missing.length > 0) {
        console.error(`Thiếu ${missing.length} library sau khi khôi phục: ${missing.slice(0, 5).map((l) => l.directory).join(', ')}`);
        process.exitCode = 1;
        return;
    }

    const runnable = after.filter((library) => library.runnable);
    console.log(`Loại nội dung chạy được: ${runnable.length}`);
    console.log(`Ví dụ: ${runnable.slice(0, 3).map((l) => `${l.machineName} ${versionString(l)}`).join(', ')}`);
}

main().catch((error) => {
    console.error('Khôi phục thất bại:', error);
    process.exitCode = 1;
});
