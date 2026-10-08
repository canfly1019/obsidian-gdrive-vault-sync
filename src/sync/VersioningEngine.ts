import { App, TFile } from 'obsidian';
import SparkMD5 from 'spark-md5';

interface HashCacheEntry { md5: string; mtime: number; size: number; }
interface HashCache { files: Record<string, HashCacheEntry>; }

export class VersioningEngine {
    private cachePath = '.obsidian-gdrive-cache.json';
    private cache: HashCache = { files: {} };
    private loaded = false;
    // Disk cache is only a hint: edits made while Obsidian was closed can preserve stat data.
    private trusted = new Set<string>();
    private revisions = new Map<string, number>();

    constructor(private app: App) {}

    invalidate(path: string) {
        for (const key of new Set([...Object.keys(this.cache.files), ...this.revisions.keys(), path])) {
            if (key === path || key.startsWith(path + '/')) {
                this.trusted.delete(key);
                this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
            }
        }
    }

    async loadCache() {
        if (this.loaded) return;
        this.loaded = true;
        try {
            if (await this.app.vault.adapter.exists(this.cachePath)) {
                const value = JSON.parse(await this.app.vault.adapter.read(this.cachePath)) as HashCache;
                if (value && value.files && typeof value.files === 'object') this.cache = value;
            }
        } catch {
            this.cache = { files: {} };
        }
    }

    async saveCache() {
        await this.app.vault.adapter.write(this.cachePath, JSON.stringify(this.cache, null, 2));
    }

    async getHash(file: TFile): Promise<string> {
        const entry = this.cache.files[file.path];
        if (this.trusted.has(file.path) && entry?.mtime === file.stat.mtime && entry.size === file.stat.size) {
            return entry.md5;
        }
        const { path } = file;
        const { mtime, size } = file.stat;
        const revision = this.revisions.get(path) ?? 0;
        const data = await this.app.vault.readBinary(file);
        const md5 = SparkMD5.ArrayBuffer.hash(data);
        if (revision !== (this.revisions.get(path) ?? 0) || mtime !== file.stat.mtime || size !== file.stat.size) {
            throw new Error(`Local file changed while hashing: ${path}. Sync again.`);
        }
        this.updateEntry(path, md5, mtime, size);
        return md5;
    }

    updateEntry(path: string, md5: string, mtime: number, size: number) {
        this.cache.files[path] = { md5, mtime, size };
        this.trusted.add(path);
    }

    async cleanCache(existingPaths: Set<string>) {
        for (const path in this.cache.files) {
            if (!existingPaths.has(path)) {
                delete this.cache.files[path];
                this.trusted.delete(path);
                this.revisions.delete(path);
            }
        }
        await this.saveCache();
    }
}
