import { buildSync } from 'esbuild';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
export const bytes = value => typeof value === 'string' ? new TextEncoder().encode(value).buffer : value;
export const md5 = data => createHash('md5').update(new Uint8Array(data)).digest('hex');
export const text = data => new TextDecoder().decode(data);
export class TFile { constructor(path, data, mtime) { this.path = path; this.data = bytes(data); this.stat = { mtime, size: this.data.byteLength }; } }
export class TFolder { constructor(path, children = []) { this.path = path; this.children = children; } }
export const Platform = { isMobile: false };
export class Plugin {
  registerEvent() {} registerInterval() {} addSettingTab() {} addRibbonIcon() {} addCommand() {}
  addStatusBarItem() { return { setText() {} }; }
  async loadData() { return {}; } async saveData() {}
}
export class Notice { constructor(message) { this.message = message; } hide() {} }
export const timers = new Map(); let nextTimer = 0;
export const context = vm.createContext({ module: { exports: {} }, require(name) {
  assert.equal(name, 'obsidian'); return { TFile, TFolder, Plugin, Notice, Platform,
    PluginSettingTab: class {}, Setting: class {}, setIcon() {},
    async requestUrl(params) {
      const response = await context.fetch(params.url, { method: params.method, headers: params.headers, body: params.body });
      const arrayBuffer = await response.arrayBuffer();
      return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer, text: text(arrayBuffer) };
    } };
}, console, crypto: webcrypto, TextEncoder, TextDecoder, ArrayBuffer, Uint8Array, DataView,
  URL, URLSearchParams, Headers, Response, atob, btoa,
  window: { setInterval(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearInterval(id) { timers.delete(id); } },
  fetch() { throw new Error('Unexpected network request in offline tests.'); } });
const bundle = buildSync({ stdin: { contents: `
export { SyncEngine } from './src/sync/SyncEngine';
export { VersioningEngine } from './src/sync/VersioningEngine';
export { GoogleAuth } from './src/auth/GoogleAuth';
export { GoogleDriveStorage } from './src/storage/GoogleDriveStorage';
export { default as SyncPlugin } from './src/main';
export { DEFAULT_SETTINGS } from './src/types';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'browser', format: 'cjs', external: ['obsidian'] });
vm.runInContext(bundle.outputFiles[0].text, context);
export const { SyncEngine, VersioningEngine, SyncPlugin, GoogleDriveStorage, GoogleAuth, DEFAULT_SETTINGS } = context.module.exports;
export class Vault {
  constructor(initial = {}) {
    this.files = new Map(); this.hidden = new Map(); this.folders = new Set(['']); this.handlers = new Map();
    this.configDir = '.obsidian'; this.clock = 1000;
    this.adapter = {
      exists: async p => this.files.has(p) || this.hidden.has(p) || this.folders.has(p),
      stat: async p => this.folders.has(p) ? { type: 'folder' } : this.files.has(p) ? { type: 'file' } : null,
      read: async p => { if (!this.hidden.has(p)) throw new Error('Missing state'); return this.hidden.get(p); },
      write: async (p, v) => this.hidden.set(p, v)
    };
    for (const [path, data] of Object.entries(initial)) this.edit(path, data);
  }
  on(event, callback) { if (!this.handlers.has(event)) this.handlers.set(event, []); this.handlers.get(event).push(callback); return {}; }
  emit(event, ...args) { for (const cb of this.handlers.get(event) || []) cb(...args); }
  edit(path, data, mtime = ++this.clock, emit = true) {
    const old = this.files.get(path); this.files.set(path, new TFile(path, data, mtime));
    const parts = path.split('/'); parts.pop(); let parent = '';
    for (const part of parts) { parent = parent ? parent + '/' + part : part; this.folders.add(parent); }
    if (emit) this.emit(old ? 'modify' : 'create', this.files.get(path));
  }
  getRoot() {
    const folders = new Map([...this.folders].map(p => [p, new TFolder(p)]));
    for (const [path, folder] of folders) if (path) folders.get(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '').children.push(folder);
    for (const file of this.files.values()) folders.get(file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '').children.push(file);
    return folders.get('');
  }
  getAbstractFileByPath(p) { return this.files.get(p) || (this.folders.has(p) ? new TFolder(p) : null); }
  async readBinary(file) { return this.files.get(file.path).data.slice(0); }
  async createBinary(path, data) { assert.equal(this.files.has(path), false); this.edit(path, data); return this.files.get(path); }
  async modifyBinary(file, data) { this.edit(file.path, data); }
  async createFolder(path) { this.folders.add(path); }
  content(path) { return text(this.files.get(path).data); }
}
export class Drive {
  constructor(initial = {}, rootId = 'root', roots = new Map()) {
    this.rootId = rootId; this.roots = roots; roots.set(rootId, this);
    this.files = new Map(); this.calls = []; this.clock = 2000; this.seq = 0;
    for (const [path, data] of Object.entries(initial)) this.edit(path, data);
  }
  forRoot(id) { return this.roots.get(id) || new Drive({}, id, this.roots); }
  edit(path, data, mtime = ++this.clock) {
    const old = this.files.get(path); data = bytes(data);
    const meta = { id: old?.id || `${this.rootId}-file-${++this.seq}`, name: path.split('/').pop(),
      mimeType: 'text/markdown', modifiedTime: mtime, md5Checksum: md5(data), size: data.byteLength, data };
    this.files.set(path, meta); return meta;
  }
  async list(id) {
    this.calls.push(['list', id]);
    const folder = id === this.rootId ? '' : id.slice((this.rootId + '-folder-').length);
    const prefix = folder ? folder + '/' : '', found = new Map();
    for (const [path, file] of this.files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length), i = rest.indexOf('/');
      if (i < 0) found.set(rest, { ...file });
      else { const name = rest.slice(0, i); found.set(name, { id: `${this.rootId}-folder-${prefix}${name}`, name, mimeType: 'application/vnd.google-apps.folder' }); }
    }
    return [...found.values()];
  }
  async get(id) { this.calls.push(['get', id]); const file = [...this.files.values()].find(f => f.id === id); assert.ok(file); return file.data.slice(0); }
  async put(path, data, mime, id) {
    this.calls.push(['put', path, id]);
    if (id) { const actual = [...this.files].find(([, f]) => f.id === id); assert.ok(actual); path = actual[0]; }
    return this.edit(path, data);
  }
  content(path) { return text(this.files.get(path).data); }
}
export function make(local = {}, remote = {}, extra = {}) {
  const vault = new Vault(local), drive = new Drive(remote), settings = { ...DEFAULT_SETTINGS, driveFolderId: 'root', syncRules: [], ignoredPaths: [], ...extra };
  const app = { vault }, versioning = new VersioningEngine(app), notices = [];
  vault.on('modify', f => versioning.invalidate(f.path)); vault.on('create', f => versioning.invalidate(f.path));
  const engine = new SyncEngine(app, drive, settings, msg => notices.push(msg), versioning);
  return { vault, drive, settings, app, versioning, engine, notices };
}
