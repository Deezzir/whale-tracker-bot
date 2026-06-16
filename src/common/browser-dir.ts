import { mkdtemp, rm, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import Logger from './logger';

const logger = new Logger('BrowserDir');
const DIR_PREFIX = 'puppeteer_dev_profile-';

export function createBrowserDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), DIR_PREFIX));
}

export async function removeBrowserDir(dir: string | null | undefined): Promise<void> {
    if (!dir) return;
    await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch((error) =>
        logger.warn(`Failed to remove browser dir ${dir}: ${error}`)
    );
}

export async function sweepOrphanBrowserDirs(): Promise<void> {
    const base = tmpdir();
    const entries = await readdir(base).catch(() => [] as string[]);
    const orphans = entries.filter((name) => name.startsWith(DIR_PREFIX));
    if (orphans.length === 0) return;

    await Promise.all(orphans.map((name) => removeBrowserDir(join(base, name))));
    logger.info(`Swept ${orphans.length} orphan browser dir(s)`);
}
