/**
 * Packs h5p/libraries into a versioned, self-describing zip:
 *
 *   library-bundles/h5p-libraries-<version>.zip
 *   library-bundles/h5p-libraries-<version>.manifest.json
 *
 * Ship the pair with the deployment and run libraries:restore there; no machine
 * ever has to re-download the content types from the Hub.
 */
import fs from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import {
    BUNDLE_DIR,
    LIBRARIES_PATH,
    MANIFEST_ENTRY,
    computeBundleVersion,
    formatBytes,
    listFilesRecursively,
    readInstalledLibraries,
    sha256OfFile,
    versionString
} from './lib/bundle.mjs';

async function main() {
    if (!existsSync(LIBRARIES_PATH)) {
        console.error(`Không tìm thấy ${LIBRARIES_PATH}. Chạy "npm run libraries:sync" trước.`);
        process.exitCode = 1;
        return;
    }

    const libraries = await readInstalledLibraries();
    if (libraries.length === 0) {
        console.error('Chưa có library nào để đóng gói.');
        process.exitCode = 1;
        return;
    }

    const version = computeBundleVersion(libraries);
    const baseName = `h5p-libraries-${version}`;
    const archivePath = path.join(BUNDLE_DIR, `${baseName}.zip`);
    const manifestPath = path.join(BUNDLE_DIR, `${baseName}.manifest.json`);

    await fs.mkdir(BUNDLE_DIR, { recursive: true });

    if (existsSync(archivePath) && !process.argv.includes('--force')) {
        console.log(`Bundle ${version} đã tồn tại — thư viện không đổi kể từ lần đóng gói trước.`);
        console.log(`  ${archivePath}`);
        console.log('Dùng --force nếu muốn tạo lại.');
        return;
    }

    const manifest = {
        version,
        createdAt: new Date().toISOString(),
        libraryCount: libraries.length,
        runnableCount: libraries.filter((library) => library.runnable).length,
        libraries: libraries.map((library) => ({
            directory: library.directory,
            machineName: library.machineName,
            majorVersion: library.majorVersion,
            minorVersion: library.minorVersion,
            patchVersion: library.patchVersion,
            title: library.title,
            runnable: library.runnable
        }))
    };

    console.log(`Đang đóng gói ${libraries.length} library thành ${baseName}.zip…`);

    const zip = new yazl.ZipFile();
    // The manifest travels inside the archive too, so a bundle that gets copied
    // around on its own is still self-describing.
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), MANIFEST_ENTRY);

    let fileCount = 0;
    for (const library of libraries) {
        const files = await listFilesRecursively(path.join(LIBRARIES_PATH, library.directory));
        for (const relative of files) {
            zip.addFile(
                path.join(LIBRARIES_PATH, library.directory, relative),
                `libraries/${library.directory}/${relative}`
            );
            fileCount++;
        }
    }
    zip.end();

    await new Promise((resolve, reject) => {
        const output = createWriteStream(archivePath);
        output.on('close', resolve);
        output.on('error', reject);
        zip.outputStream.on('error', reject);
        zip.outputStream.pipe(output);
    });

    const { size } = await fs.stat(archivePath);
    manifest.archive = {
        file: path.basename(archivePath),
        bytes: size,
        fileCount,
        sha256: await sha256OfFile(archivePath)
    };

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    console.log('');
    console.log(`Đã tạo bundle ${version}`);
    console.log(`  archive : ${archivePath} (${formatBytes(size)}, ${fileCount} file)`);
    console.log(`  manifest: ${manifestPath}`);
    console.log(`  sha256  : ${manifest.archive.sha256}`);
    console.log(`  library : ${manifest.libraryCount} (${manifest.runnableCount} loại nội dung chạy được)`);
    console.log('');
    console.log('Ví dụ vài mục:');
    for (const library of libraries.filter((l) => l.runnable).slice(0, 5)) {
        console.log(`  ${library.machineName} ${versionString(library)}`);
    }
}

main().catch((error) => {
    console.error('Đóng gói thất bại:', error);
    process.exitCode = 1;
});
