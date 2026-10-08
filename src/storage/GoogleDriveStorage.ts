import { FileMeta, Storage } from '../types';
import { GoogleAuth } from '../auth/GoogleAuth';
import { http } from '../utils/http';

interface DriveFile { id: string; name: string; mimeType: string; modifiedTime: string; size?: string; md5Checksum?: string; parents?: string[]; }
interface DriveList { files?: DriveFile[]; nextPageToken?: string; }

export class GoogleDriveStorage implements Storage {
    private readonly driveApiBase = 'https://www.googleapis.com/drive/v3/files';
    private readonly uploadApiBase = 'https://www.googleapis.com/upload/drive/v3/files';

    // A cache from path string to Drive File ID to avoid expensive recursive lookups
    private pathIdCache: Map<string, string> = new Map();

    constructor(
        private auth: GoogleAuth,
        private rootFolderId: string
    ) {
        this.pathIdCache.set('/', this.rootFolderId);
    }

    public rememberPath(path: string, id: string): void {
        this.pathIdCache.set('/' + path, id);
    }

    public forRoot(folderId: string): GoogleDriveStorage {
        return new GoogleDriveStorage(this.auth, folderId);
    }

    private escapeQuery(value: string): string {
        return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }

    private async fetchWithAuth(url: string, options: RequestInit = {}) {
        const token = await this.auth.getAccessToken();
        const headers = new Headers(options.headers || {});
        headers.set('Authorization', `Bearer ${token}`);

        return http(url, { ...options, headers });
    }

    /**
     * Resolves a folder path to a Drive File ID, creating intermediate folders if necessary.
     */
    private async resolvePathToId(path: string, createIfMissing: boolean = false): Promise<string | null> {
        if (path === '/' || path === '') return this.rootFolderId;

        // Strip leading/trailing slashes and split
        const parts = path.replace(/^\/+|\/+$/g, '').split('/');
        let currentParentId = this.rootFolderId;
        let currentPath = '';

        for (const part of parts) {
            currentPath += '/' + part;

            if (this.pathIdCache.has(currentPath)) {
                currentParentId = this.pathIdCache.get(currentPath)!;
                continue;
            }

            // Look it up
            const q = `'${this.escapeQuery(currentParentId)}' in parents and name='${this.escapeQuery(part)}' and trashed=false`;
            const url = `${this.driveApiBase}?q=${encodeURIComponent(q)}&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=nextPageToken,files(id,mimeType)`;
            const response = await this.fetchWithAuth(url);

            if (!response.ok) {
                throw new Error(`Failed to resolve path: ${currentPath}`);
            }

            const data = await response.json() as DriveList;

            if ((data.files?.length ?? 0) > 1 || data.nextPageToken) {
                throw new Error(`Duplicate remote path: ${currentPath}`);
            }
            if (data.files && data.files.length > 0) {
                currentParentId = data.files[0]!.id;
                this.pathIdCache.set(currentPath, currentParentId);
            } else if (createIfMissing) {
                // Create folder
                const createUrl = this.driveApiBase;
                const crResponse = await this.fetchWithAuth(createUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: part,
                        mimeType: 'application/vnd.google-apps.folder',
                        parents: [currentParentId]
                    })
                });

                if (!crResponse.ok) {
                    throw new Error(`Failed to create folder: ${currentPath}`);
                }

                const crData = await crResponse.json() as DriveFile;
                currentParentId = crData.id;
                this.pathIdCache.set(currentPath, currentParentId);
            } else {
                return null; // Not found
            }
        }

        return currentParentId;
    }

    public async list(pathOrId: string): Promise<FileMeta[]> {
        let folderId: string | null = null;
        if (pathOrId.includes('/') || pathOrId === '' || pathOrId === '.') {
            folderId = await this.resolvePathToId(pathOrId);
        } else {
            folderId = pathOrId;
        }
        
        if (!folderId) return []; // Folder does not exist

        const q = `'${this.escapeQuery(folderId)}' in parents and trashed=false`;
        let url = `${this.driveApiBase}?q=${encodeURIComponent(q)}&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size,md5Checksum,parents)&pageSize=1000`;

        let allFiles: FileMeta[] = [];
        let hasNextPage = true;

        while (hasNextPage) {
            const response = await this.fetchWithAuth(url);
            if (!response.ok) {
                throw new Error(`Failed to list files in folder: ${pathOrId}`);
            }

            const data = await response.json() as DriveList;

            if (data.files) {
                allFiles = allFiles.concat(data.files.map((f: DriveFile) => ({
                    id: f.id,
                    name: f.name,
                    mimeType: f.mimeType,
                    modifiedTime: new Date(f.modifiedTime).getTime(),
                    size: parseInt(f.size || '0', 10),
                    md5Checksum: f.md5Checksum,
                    parents: f.parents
                })));
            }

            if (data.nextPageToken) {
                url = `${this.driveApiBase}?q=${encodeURIComponent(q)}&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size,md5Checksum,parents)&pageSize=1000&pageToken=${data.nextPageToken}`;
            } else {
                hasNextPage = false;
            }
        }

        return allFiles;
    }

    public async get(pathOrId: string): Promise<ArrayBuffer> {
        let fileId: string | null = null;
        if (pathOrId.includes('/') || pathOrId === '' || pathOrId === '.') {
            fileId = await this.resolvePathToId(pathOrId);
        } else {
            fileId = pathOrId;
        }

        if (!fileId) throw new Error(`File not found: ${pathOrId}`);

        const url = `${this.driveApiBase}/${fileId}?alt=media`;
        const response = await this.fetchWithAuth(url);

        if (!response.ok) {
            throw new Error(`Failed to download file/ID: ${pathOrId}`);
        }

        return response.arrayBuffer();
    }

    public async put(path: string, data: ArrayBuffer, mimeType = 'text/markdown', existingId?: string, expectedChecksum?: string): Promise<FileMeta> {
        const parts = path.split('/');
        const fileName = parts.pop()!;
        const parentId = await this.resolvePathToId(parts.join('/'), true);
        if (!parentId) throw new Error('Upload parent folder is missing.');
        const fileId = existingId || await this.resolvePathToId(path);
        let etag: string | null = null;
        if (existingId && expectedChecksum) {
            const current = await this.fetchWithAuth(`${this.driveApiBase}/${existingId}?supportsAllDrives=true&fields=md5Checksum,trashed`);
            if (!current.ok) throw new Error('Remote file is no longer available. Sync again.');
            const info = await current.json() as { md5Checksum?: string; trashed?: boolean };
            if (info.trashed || info.md5Checksum !== expectedChecksum) throw new Error('Remote file changed before upload. Sync again.');
            etag = current.headers.get('ETag');
        }
        const fields = 'id,name,mimeType,modifiedTime,size,md5Checksum';
        const url = fileId
            ? `${this.uploadApiBase}/${fileId}?uploadType=resumable&supportsAllDrives=true&fields=${fields}`
            : `${this.uploadApiBase}?uploadType=resumable&supportsAllDrives=true&fields=${fields}`;
        // Name and parent are submitted together with creation. Existing sanitized names
        // retain their original Drive name and are updated by the ID from the scan.
        const response = await this.fetchWithAuth(url, {
            method: fileId ? 'PATCH' : 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': mimeType, ...(etag ? { 'If-Match': etag } : {}) },
            body: JSON.stringify(fileId ? {} : { name: fileName, parents: [parentId] })
        });
        const location = response.headers.get('Location');
        if (!response.ok || !location) throw new Error('Failed to start upload.');
        const uploadUrl = new URL(location);
        if (uploadUrl.origin !== 'https://www.googleapis.com') throw new Error('Unexpected upload session URL.');
        const uploaded = await this.fetchWithAuth(uploadUrl.href, {
            method: 'PUT', headers: { 'Content-Type': mimeType }, body: data
        });
        if (!uploaded.ok) throw new Error(`Failed to upload file: ${uploaded.status}`);
        const meta = await uploaded.json() as DriveFile;
        return { id: meta.id, name: meta.name, mimeType: meta.mimeType,
            modifiedTime: new Date(meta.modifiedTime).getTime(), size: Number(meta.size || 0),
            md5Checksum: meta.md5Checksum };
    }

    public async delete(path: string): Promise<void> {
        const fileId = await this.resolvePathToId(path);
        if (!fileId) return;

        const url = `${this.driveApiBase}/${fileId}`;
        const response = await this.fetchWithAuth(url, { method: 'DELETE' });

        if (!response.ok && response.status !== 404) {
            const errText = await response.text();
            throw new Error(`Failed to delete file ${path}: ${response.status} ${errText}`);
        }
    }

    public async mkdir(path: string): Promise<FileMeta> {
        const folderId = await this.resolvePathToId(path, true);
        if (!folderId) throw new Error(`Failed to create or find folder: ${path}`);
        
        // This is a bit redundant but mkdir is supposed to return the meta
        const url = `${this.driveApiBase}/${folderId}?fields=id,name,mimeType,modifiedTime,size`;
        const response = await this.fetchWithAuth(url);
        if (!response.ok) throw new Error(`Failed to get folder meta for: ${path}`);
        
        const data = await response.json() as DriveFile;
        return {
            id: data.id,
            name: data.name,
            mimeType: data.mimeType,
            modifiedTime: new Date(data.modifiedTime).getTime(),
            size: 0
        };
    }
}
