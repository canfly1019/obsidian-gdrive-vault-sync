import { Plugin, Notice, Platform } from 'obsidian';
import { DEFAULT_SETTINGS, ObsidianGDriveSyncSettings } from './types';
import { ObsidianGDriveSyncSettingTab } from './ui/SettingsTab';
import { GoogleAuth } from './auth/GoogleAuth';
import { GoogleDriveStorage } from './storage/GoogleDriveStorage';
import { SyncEngine } from './sync/SyncEngine';
import { VersioningEngine } from './sync/VersioningEngine';

// Keep the vault lock through plugin reloads, while an older operation finishes.
const lockKey = Symbol.for('obsidian-gdrive-vault-sync.active-operations');
const registry = globalThis as typeof globalThis & { [lockKey]?: WeakMap<object, Promise<void>> };
const activeOperations = registry[lockKey] ??= new WeakMap<object, Promise<void>>();

export default class ObsidianGDriveSyncPlugin extends Plugin {
	settings: ObsidianGDriveSyncSettings;
	public syncEngine: SyncEngine | null = null;
	public statusBarItemEl: HTMLElement | undefined;
	private versioning: VersioningEngine;
	private unloaded = false;

	async onload() {
		this.unloaded = false;
		await this.loadSettings();
		if (this.unloaded) return;
		this.versioning = new VersioningEngine(this.app);
		this.registerEvent(this.app.vault.on('modify', file => this.versioning.invalidate(file.path)));
		this.registerEvent(this.app.vault.on('create', file => this.versioning.invalidate(file.path)));
		this.registerEvent(this.app.vault.on('delete', file => this.versioning.invalidate(file.path)));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			this.versioning.invalidate(oldPath);
			this.versioning.invalidate(file.path);
		}));

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new ObsidianGDriveSyncSettingTab(this.app, this));

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		if (!Platform.isMobile) this.statusBarItemEl = this.addStatusBarItem();
		this.updateStatusBar();

		// Ribbon Icons for manual operations
		this.addRibbonIcon('upload-cloud', 'Push to Google Drive', async () => {
			await this.runPush();
		});

		this.addRibbonIcon('download-cloud', 'Pull from Google Drive', async () => {
			await this.runPull();
		});

		// Commands for Command Palette
		this.addCommand({
			id: 'push-google-drive',
			name: 'Push now',
			callback: async () => {
				await this.runPush();
			}
		});

		this.addCommand({
			id: 'pull-google-drive',
			name: 'Pull now',
			callback: async () => {
				await this.runPull();
			}
		});

		this.addCommand({
			id: 'sync-google-drive',
			name: 'Sync now (full)',
			callback: async () => {
				await this.runSync();
			}
		});

		this.configureInterval();

		if (this.settings.syncMode === 'onOpenClose') {
			// Trigger a sync when app is fully loaded
			this.app.workspace.onLayoutReady(() => {
				if (!this.unloaded) void this.runSync();
			});
		}
	}

	onunload() {
		this.unloaded = true;
		this.clearInterval();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<ObsidianGDriveSyncSettings>);
	}

	async saveSettings() {
		if (this.unloaded) return;
		await this.saveData(this.settings);
		this.updateStatusBar();
	}

	// SettingsTab exposes the active operation and schedule.
	public syncIntervalId: number | undefined = undefined;
	public isSyncing: boolean = false;
	public triggerSync() {
		void this.runSync();
	}

	private initSyncEngine() {
		if (!this.settings.driveFolderId && this.settings.syncRules.length === 0) {
			new Notice("Please configure a Google Drive folder ID in the settings first.");
			return false;
		}

		const snapshot = { ...this.settings, syncRules: this.settings.syncRules.map(rule => ({ ...rule })),
			ignoredPaths: [...this.settings.ignoredPaths] };
		const auth = new GoogleAuth(snapshot, async () => {
			if (this.unloaded || this.settings.authMode !== snapshot.authMode ||
				this.settings.clientId !== snapshot.clientId || this.settings.clientSecret !== snapshot.clientSecret ||
				this.settings.refreshToken !== snapshot.refreshToken ||
				this.settings.serviceAccountJson !== snapshot.serviceAccountJson) return;
			this.settings.accessToken = snapshot.accessToken;
			this.settings.accessTokenExpiry = snapshot.accessTokenExpiry;
			await this.saveSettings();
		});

		// Initialize storage
		const storage = new GoogleDriveStorage(auth, snapshot.driveFolderId);

		// Initialize engine
		this.syncEngine = new SyncEngine(
			this.app,
			storage,
			snapshot,
			(msg) => new Notice(msg, 5000),
			this.versioning ??= new VersioningEngine(this.app)
		);

		return true;
	}

	public runSync(): Promise<void> {
		return this.runOperation('Sync', () => this.syncEngine!.sync());
	}

	public runPush(targetPath?: string): Promise<void> {
		return this.runOperation('Push', () => this.syncEngine!.push(targetPath));
	}

	public runPull(targetPath?: string): Promise<void> {
		return this.runOperation('Pull', () => this.syncEngine!.pull(targetPath));
	}

	private runOperation(label: string, operation: () => Promise<void>): Promise<void> {
		if (this.unloaded) return Promise.resolve();
		const active = activeOperations.get(this.app.vault);
		if (active) return active;
		// Defer engine initialization until the lock is installed.
		const task = Promise.resolve().then(async () => {
			if (this.unloaded || !this.initSyncEngine()) return;
			const notice = new Notice(`${label} in progress...`, 0);
			this.statusBarItemEl?.setText('Syncing...');
			try {
				await operation();
				if (!this.unloaded) this.settings.lastSyncTime = Date.now();
				await this.saveSettings();
				if (!this.unloaded) new Notice(`${label} complete.`);
			} catch (error) {
				console.error(error);
				if (!this.unloaded) {
					new Notice(`${label} failed. See the console for details.`);
					this.statusBarItemEl?.setText('Sync failed');
				}
			} finally {
				notice.hide();
			}
		}).finally(() => {
			if (activeOperations.get(this.app.vault) === task) activeOperations.delete(this.app.vault);
			this.isSyncing = false;
		});
		this.isSyncing = true;
		activeOperations.set(this.app.vault, task);
		return task;
	}

	private clearInterval() {
		if (this.syncIntervalId !== undefined) window.clearInterval(this.syncIntervalId);
		this.syncIntervalId = undefined;
	}

	public configureInterval() {
		this.clearInterval();
		if (this.unloaded || this.settings.syncMode !== 'interval') return;
		const minutes = this.settings.syncIntervalMinutes;
		if (!Number.isFinite(minutes) || minutes < 1) return;
		this.syncIntervalId = window.setInterval(() => { void this.runSync(); }, minutes * 60 * 1000);
		this.registerInterval(this.syncIntervalId);
	}

	public updateStatusBar() {
		if (this.unloaded) return;
		if (this.settings.lastSyncTime > 0) {
			const date = new Date(this.settings.lastSyncTime);
			// Format example: Last Sync: 2/25/2026, 9:25 AM
			const formatter = new Intl.DateTimeFormat('en-US', {
				year: 'numeric', month: 'numeric', day: 'numeric',
				hour: 'numeric', minute: '2-digit', hour12: true
			});
			this.statusBarItemEl?.setText(`Last Sync: ${formatter.format(date)}`);
		} else {
			this.statusBarItemEl?.setText('Not synced yet');
		}
	}
}
