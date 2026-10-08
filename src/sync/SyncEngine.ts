import { App, TFile, TFolder } from 'obsidian';
import { minimatch } from 'minimatch';
import SparkMD5 from 'spark-md5';
import { Storage, SyncRule, ObsidianGDriveSyncSettings, FileMeta } from '../types';
import { VersioningEngine } from './VersioningEngine';
import { getMimeType } from '../utils/mimeTypes';

interface StateEntry {
    md5Checksum: string;
    modifiedTime: number;
    driveFolderId?: string;
    remoteId?: string;
}
interface SyncState { files: Record<string, StateEntry>; }
interface RemoteFile extends FileMeta { driveFolderId: string; }

export class SyncEngine {
    private syncStatePath = '.obsidian-gdrive-sync.json';
    private state: SyncState = { files: {} };
    private stores = new Map<string, Storage>();
    private operation: Promise<void> | undefined;

    constructor(
        private app: App,
        private storage: Storage,
        private settings: ObsidianGDriveSyncSettings,
        private addConflictNotice: (msg: string) => void,
        private versioning = new VersioningEngine(app)
    ) {}

    private async loadState() {
        if (!await this.app.vault.adapter.exists(this.syncStatePath)) return;
        const value = JSON.parse(await this.app.vault.adapter.read(this.syncStatePath)) as SyncState;
        if (!value || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) {
            throw new Error('Invalid sync state. Restore the state file before syncing.');
        }
        for (const entry of Object.values(value.files)) {
            if (!entry || typeof entry.md5Checksum !== 'string' || !Number.isFinite(entry.modifiedTime) ||
                (entry.driveFolderId !== undefined && typeof entry.driveFolderId !== 'string') ||
                (entry.remoteId !== undefined && typeof entry.remoteId !== 'string')) {
                throw new Error('Invalid file baseline. Restore the state file before syncing.');
            }
        }
        this.state = value;
    }

    private async saveState() {
        await this.app.vault.adapter.write(this.syncStatePath, JSON.stringify(this.state, null, 2));
    }

    private rules(): SyncRule[] {
        return this.settings.syncRules.length ? this.settings.syncRules : [{
            localPattern: '**', driveFolderId: this.settings.driveFolderId, direction: 'two-way'
        }];
    }

    private matchesRule(path: string): SyncRule | undefined {
        return this.rules().find(rule => minimatch(path, rule.localPattern, { dot: true }));
    }

    private storeFor(rootId: string): Storage {
        if (!rootId) throw new Error('A Drive folder ID is required for every sync rule.');
        if (!this.stores.has(rootId)) {
            if (rootId === this.settings.driveFolderId) this.stores.set(rootId, this.storage);
            else if (this.storage.forRoot) this.stores.set(rootId, this.storage.forRoot(rootId));
            else throw new Error('This storage does not support multiple Drive folders.');
        }
        return this.stores.get(rootId)!;
    }

    private excluded(path: string): boolean {
        return path.split('/').some(part => part.startsWith('.')) || path.includes('.conflicted.') ||
            this.settings.ignoredPaths.some(p => path === p || path.startsWith(p + '/'));
    }

    private async getLocalFiles(): Promise<TFile[]> {
        const files: TFile[] = [];
        const traverse = (item: TFile | TFolder) => {
            if (this.excluded(item.path)) return;
            if (item instanceof TFolder) {
                for (const child of item.children) {
                    if (child instanceof TFile || child instanceof TFolder) traverse(child);
                }
            } else if (this.matchesRule(item.path)) files.push(item);
        };
        for (const child of this.app.vault.getRoot().children) {
            if (child instanceof TFile || child instanceof TFolder) traverse(child);
        }
        return files;
    }

    private baseline(path: string, rootId: string): StateEntry | undefined {
        const entry = Object.prototype.hasOwnProperty.call(this.state.files, path) ? this.state.files[path] : undefined;
        // Legacy state belongs to the original main root only.
        return entry && (entry.driveFolderId ?? this.settings.driveFolderId) === rootId ? entry : undefined;
    }

    public sync(): Promise<void> { return this.run('sync'); }
    public pull(targetPath?: string): Promise<void> { return this.run('pull', targetPath); }
    public push(targetPath?: string): Promise<void> { return this.run('push', targetPath); }

    private run(mode: 'sync' | 'pull' | 'push', targetPath?: string): Promise<void> {
        if (this.operation) return this.operation;
        const task = Promise.resolve().then(async () => {
            for (const rule of this.rules()) {
                if (!['two-way', 'upload-only', 'download-only'].includes(rule.direction)) {
                    throw new Error('Invalid sync direction.');
                }
                this.storeFor(rule.driveFolderId);
            }
            await this.loadState();
            await this.versioning.loadCache();
            // Finish and validate the entire listing before any file mutation.
            const remote = await this.fetchRemoteState();
            if (mode !== 'push') await this.pullFiles(remote, targetPath);
            if (mode !== 'pull') await this.pushFiles(remote, targetPath);
            await this.versioning.saveCache();
            this.settings.lastSyncTime = Date.now();
        }).finally(() => { this.operation = undefined; });
        this.operation = task;
        return task;
    }

    private inTarget(path: string, target?: string): boolean {
        return !target || path === target || path.startsWith(target + '/');
    }

    private async pullFiles(remote: Map<string, RemoteFile>, target?: string) {
        for (const [path, meta] of remote) {
            if (!this.inTarget(path, target) || this.excluded(path)) continue;
            const rule = this.matchesRule(path);
            if (!rule || rule.direction === 'upload-only') continue;
            const local = this.app.vault.getAbstractFileByPath(path);
            if (!local) await this.downloadFile(path, meta);
            else if (!(local instanceof TFile)) throw new Error(`A folder occupies the remote file path: ${path}`);
            else {
                const hash = await this.versioning.getHash(local);
                if (hash === meta.md5Checksum) await this.record(path, meta, hash);
                else {
                    const baseline = this.baseline(path, meta.driveFolderId);
                    const localChanged = !baseline || hash !== baseline.md5Checksum;
                    const remoteChanged = !baseline || meta.md5Checksum !== baseline.md5Checksum;
                    if (localChanged && remoteChanged) await this.handleConflict(path, meta, local, rule);
                    else if (remoteChanged) await this.downloadFile(path, meta, local, hash);
                }
            }
        }
    }

    private async pushFiles(remote: Map<string, RemoteFile>, target?: string) {
        for (const file of await this.getLocalFiles()) {
            const path = file.path;
            if (!this.inTarget(path, target)) continue;
            const rule = this.matchesRule(path);
            if (!rule || rule.direction === 'download-only') continue;
            const hash = await this.versioning.getHash(file);
            const meta = remote.get(path);
            if (meta && hash === meta.md5Checksum) { await this.record(path, meta, hash); continue; }
            if (meta) {
                const baseline = this.baseline(path, rule.driveFolderId);
                // Push never silently destroys a differing remote version.
                if (!baseline || meta.md5Checksum !== baseline.md5Checksum) {
                    await this.backup(path, await this.remoteData(meta), 'remote');
                    this.addConflictNotice(`Saved remote conflict copy for ${path}.`);
                }
            }
            const uploaded = await this.uploadFile(path, file, rule.driveFolderId, meta);
            remote.set(path, uploaded);
        }
    }

    private sanitizeName(name: string): string {
        if (!name || name === '.' || name === '..' || name.includes('/')) {
            throw new Error('Drive contains a filename that cannot be mapped safely. Rename it before syncing.');
        }
        return name.replace(/[:\\*?"<>|]/g, '-');
    }

    public async fetchRemoteState(): Promise<Map<string, RemoteFile>> {
        const result = new Map<string, RemoteFile>();
        for (const rootId of new Set(this.rules().map(r => r.driveFolderId))) {
            const store = this.storeFor(rootId);
            const queue = [{ id: rootId, path: '' }];
            const visited = new Set<string>();
            const paths = new Set<string>();
            while (queue.length) {
                const batch = queue.splice(0, 5);
                // Await all in-flight requests before propagating a failed listing.
                const pages = await Promise.allSettled(batch.map(folder => store.list(folder.id)));
                for (let i = 0; i < pages.length; i++) {
                    const page = pages[i]!;
                    if (page.status === 'rejected') throw page.reason;
                    const folder = batch[i]!;
                    if (visited.has(folder.id)) throw new Error('Repeated Drive folder encountered.');
                    visited.add(folder.id);
                    for (const item of page.value) {
                        if (item.trashed) continue;
                        const safeName = this.sanitizeName(item.name);
                        const path = folder.path ? `${folder.path}/${safeName}` : safeName;
                        if (this.excluded(path)) continue;
                        if (paths.has(path)) throw new Error(`Drive filename collision at ${path}. Rename duplicate files before syncing.`);
                        paths.add(path);
                        if (item.id) store.rememberPath?.(path, item.id);
                        if (item.mimeType === 'application/vnd.google-apps.folder') {
                            if (!item.id) throw new Error('A remote folder has no ID.');
                            queue.push({ id: item.id, path });
                        } else if (this.matchesRule(path)?.driveFolderId === rootId) {
                            if (!item.id || !item.md5Checksum) throw new Error(`Remote file cannot be synced as binary content: ${path}`);
                            result.set(path, { ...item, name: path, driveFolderId: rootId });
                        }
                    }
                }
            }
        }
        return result;
    }

    private async remoteData(meta: RemoteFile): Promise<ArrayBuffer> {
        const data = await this.storeFor(meta.driveFolderId).get(meta.id!);
        if (SparkMD5.ArrayBuffer.hash(data) !== meta.md5Checksum) {
            throw new Error(`Remote file changed while downloading: ${meta.name}. Sync again.`);
        }
        return data;
    }

    private async ensureParents(path: string) {
        const parts = path.split('/'); parts.pop();
        let parent = '';
        for (const part of parts) {
            parent = parent ? `${parent}/${part}` : part;
            const existing = await this.app.vault.adapter.stat(parent);
            if (existing && existing.type !== 'folder') throw new Error(`A file occupies the folder path: ${parent}`);
            if (!existing) await this.app.vault.createFolder(parent);
        }
    }

    private async record(path: string, meta: RemoteFile, hash: string) {
        const old = this.baseline(path, meta.driveFolderId);
        if (old?.md5Checksum === hash && old.modifiedTime === meta.modifiedTime &&
            old.remoteId === meta.id && old.driveFolderId === meta.driveFolderId) return;
        this.state.files[path] = { md5Checksum: hash, modifiedTime: meta.modifiedTime,
            remoteId: meta.id, driveFolderId: meta.driveFolderId };
        await this.saveState();
    }

    private async downloadFile(path: string, meta: RemoteFile, expected?: TFile, hash?: string) {
        const data = await this.remoteData(meta);
        await this.ensureParents(path);
        const local = this.app.vault.getAbstractFileByPath(path);
        if (expected) {
            this.versioning.invalidate(path);
            if (!(local instanceof TFile) || await this.versioning.getHash(local) !== hash) {
                throw new Error(`Local file changed while downloading: ${path}. Sync again.`);
            }
        } else if (await this.app.vault.adapter.exists(path)) {
            throw new Error(`Local path appeared while downloading: ${path}. Sync again.`);
        }
        if (local instanceof TFile) await this.app.vault.modifyBinary(local, data);
        else await this.app.vault.createBinary(path, data);
        this.versioning.invalidate(path);
        await this.record(path, meta, SparkMD5.ArrayBuffer.hash(data));
    }

    private async uploadFile(path: string, file: TFile, rootId: string, existing?: RemoteFile): Promise<RemoteFile> {
        // Hash exactly the bytes sent, rather than copying remote metadata into the cache.
        const data = await this.app.vault.readBinary(file);
        const hash = SparkMD5.ArrayBuffer.hash(data);
        const meta = await this.storeFor(rootId).put(path, data, getMimeType(path), existing?.id, existing?.md5Checksum);
        if (meta.md5Checksum && meta.md5Checksum !== hash) throw new Error(`Uploaded checksum mismatch: ${path}`);
        const remote = { ...meta, driveFolderId: rootId };
        this.versioning.invalidate(path);
        await this.record(path, remote, hash);
        return remote;
    }

    private async backup(path: string, data: ArrayBuffer, side: string) {
        const dot = path.lastIndexOf('.');
        const split = dot > path.lastIndexOf('/') ? dot : path.length;
        const stem = path.slice(0, split), ext = path.slice(split);
        let index = 0, backupPath: string;
        do { backupPath = `${stem}.conflicted.${side}.${Date.now()}.${index++}${ext}`; }
        while (await this.app.vault.adapter.exists(backupPath));
        await this.ensureParents(backupPath);
        await this.app.vault.createBinary(backupPath, data);
    }

    private async handleConflict(path: string, meta: RemoteFile, local: TFile, rule: SyncRule) {
        const hash = await this.versioning.getHash(local);
        if (rule.direction === 'two-way' && local.stat.mtime >= meta.modifiedTime) {
            await this.backup(path, await this.remoteData(meta), 'remote');
            Object.assign(meta, await this.uploadFile(path, local, meta.driveFolderId, meta));
        } else {
            await this.backup(path, await this.app.vault.readBinary(local), 'local');
            await this.downloadFile(path, meta, local, hash);
        }
        this.addConflictNotice(`Resolved conflict for ${path}. Both versions were preserved.`);
    }
}
