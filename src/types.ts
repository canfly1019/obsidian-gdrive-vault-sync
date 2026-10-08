export type SyncDirection = 'two-way' | 'upload-only' | 'download-only';

export interface SyncRule {
    localPattern: string;
    driveFolderId: string;
    direction: SyncDirection;
}

export type SyncMode = 'manual' | 'onOpenClose' | 'interval';

export interface ObsidianGDriveSyncSettings {
    driveFolderId: string;
    syncMode: SyncMode;
    syncIntervalMinutes: number;
    syncRules: SyncRule[];
    authMode: 'oauth' | 'service-account';
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    accessToken: string;
    accessTokenExpiry: number;
    serviceAccountJson: string;
    lastSyncTime: number;
    ignoredPaths: string[];
}

export const DEFAULT_SETTINGS: ObsidianGDriveSyncSettings = {
    driveFolderId: '',
    syncMode: 'manual',
    syncIntervalMinutes: 30,
    syncRules: [],
    authMode: 'oauth',
    clientId: '',
    clientSecret: '',
    refreshToken: '',
    accessToken: '',
    accessTokenExpiry: 0,
    serviceAccountJson: '',
    lastSyncTime: 0,
    ignoredPaths: []
};

export interface FileMeta {
    id?: string;
    name: string;
    mimeType?: string;
    modifiedTime: number;
    size: number;
    md5Checksum?: string;
    trashed?: boolean;
    parents?: string[];
}

export interface Storage {
    forRoot?(folderId: string): Storage;
    rememberPath?(path: string, id: string): void;
    list(path: string): Promise<FileMeta[]>;
    get(path: string): Promise<ArrayBuffer>;
    put(path: string, data: ArrayBuffer, mimeType?: string, existingId?: string, expectedChecksum?: string): Promise<FileMeta>;
    delete(path: string): Promise<void>;
    mkdir(path: string): Promise<FileMeta>;
}
