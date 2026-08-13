/**
 * Installs or updates every content type the H5P Hub offers.
 *
 * Run it whenever you want to refresh what the bundle will contain:
 *   npm run libraries:sync
 *
 * It talks to the Hub directly rather than through the running engine, so it
 * works in a build step with no server up. Dependencies come along with each
 * content type, which is why the library count ends up well above the number of
 * content types.
 */
import path from 'node:path';
import * as H5P from '@lumieducation/h5p-server';
import {
    H5P_DATA_PATH,
    compareVersions,
    readInstalledLibraries,
    versionString
} from './lib/bundle.mjs';

const user = {
    id: 'library-sync',
    name: 'Library sync',
    email: 'library-sync@localhost',
    type: 'local',
    canInstallRecommended: true,
    canUpdateAndInstallLibraries: true,
    canCreateRestricted: true
};

async function createEditor() {
    const config = await new H5P.H5PConfig(
        new H5P.fsImplementations.JsonStorage(path.join(H5P_DATA_PATH, 'config.json'))
    ).load();

    // The Hub refuses to answer when fetching is switched off.
    config.fetchingDisabled = 0;

    return new H5P.H5PEditor(
        await H5P.fsImplementations.JsonStorage.create(path.join(H5P_DATA_PATH, 'cache.json')),
        config,
        new H5P.fsImplementations.FileLibraryStorage(path.join(H5P_DATA_PATH, 'libraries')),
        new H5P.fsImplementations.FileContentStorage(path.join(H5P_DATA_PATH, 'content')),
        new H5P.fsImplementations.DirectoryTemporaryFileStorage(path.join(H5P_DATA_PATH, 'temp')),
        (key) => key
    );
}

/**
 * Keyed by directory, not machine name: H5P installs several major.minor
 * versions of the same library side by side (H5P.Audio-1.2 next to H5P.Audio-1.5)
 * because different content types depend on different majors. Keying by machine
 * name would make those siblings look like version changes.
 */
function byDirectory(libraries) {
    const map = new Map();
    for (const library of libraries) map.set(library.directory, library);
    return map;
}

function machineNames(libraries) {
    return new Set(libraries.map((library) => library.machineName));
}

async function main() {
    const onlyRecommended = process.argv.includes('--recommended-only');

    console.log(`Thư mục dữ liệu H5P : ${H5P_DATA_PATH}`);
    const editor = await createEditor();

    console.log('Đang lấy danh sách content type từ H5P Hub…');
    const cache = await editor.contentTypeCache.forceUpdate();
    if (!cache) {
        console.error('Không lấy được danh sách từ Hub. Kiểm tra kết nối tới api.h5p.org rồi chạy lại.');
        process.exitCode = 1;
        return;
    }

    const candidates = cache.filter((entry) => !onlyRecommended || entry.isRecommended);
    console.log(`Hub trả về ${cache.length} content type${onlyRecommended ? `, lọc còn ${candidates.length} mục khuyến nghị` : ''}.`);

    const beforeLibraries = await readInstalledLibraries();
    const beforeByDirectory = byDirectory(beforeLibraries);
    const beforeMachineNames = machineNames(beforeLibraries);
    const failures = [];
    let installed = 0;
    let updated = 0;
    let unchanged = 0;

    for (const [position, entry] of candidates.entries()) {
        const label = `[${String(position + 1).padStart(2, ' ')}/${candidates.length}] ${entry.machineName}`;
        try {
            const results = await editor.installLibraryFromHub(entry.machineName, user);
            const changed = results.filter((result) => result.type !== 'none');

            if (changed.length === 0) {
                unchanged++;
                console.log(`${label}: đã có bản mới nhất`);
                continue;
            }

            if (beforeMachineNames.has(entry.machineName)) updated++;
            else installed++;

            const summary = changed
                .map((result) => `${result.newVersion?.machineName ?? entry.machineName} ${result.type}`)
                .slice(0, 4)
                .join(', ');
            console.log(`${label}: ${changed.length} library thay đổi (${summary}${changed.length > 4 ? ', …' : ''})`);
        } catch (error) {
            failures.push({ machineName: entry.machineName, message: error.message });
            console.warn(`${label}: THẤT BẠI — ${error.message}`);
        }
    }

    const after = await readInstalledLibraries();

    console.log('');
    console.log('Tổng kết');
    console.log(`  content type cài mới : ${installed}`);
    console.log(`  content type cập nhật: ${updated}`);
    console.log(`  đã là bản mới nhất   : ${unchanged}`);
    console.log(`  thất bại             : ${failures.length}`);
    console.log(`  tổng library trên đĩa: ${after.length}`);

    if (failures.length > 0) {
        console.log('');
        console.log('Các content type không cài được:');
        for (const failure of failures) console.log(`  - ${failure.machineName}: ${failure.message}`);
        // Partial success is still useful, but the exit code must not claim success.
        process.exitCode = 1;
    }

    const runnable = after.filter((library) => library.runnable);
    console.log('');
    console.log(`Có ${runnable.length} library chạy được, ví dụ: ${runnable.slice(0, 3).map((l) => `${l.machineName} ${versionString(l)}`).join(', ')}`);

    // Same directory moving backwards would mean the Hub rolled a patch back.
    for (const library of after) {
        const previous = beforeByDirectory.get(library.directory);
        if (previous && compareVersions(library, previous) < 0) {
            console.warn(`Cảnh báo: ${library.directory} lùi từ ${versionString(previous)} về ${versionString(library)}`);
        }
    }
}

main().catch((error) => {
    console.error('Sync thất bại:', error);
    process.exitCode = 1;
});
