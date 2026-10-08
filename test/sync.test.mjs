import test from 'node:test';
import assert from 'node:assert/strict';
import { make, SyncEngine, VersioningEngine, SyncPlugin, Vault, Drive, text, Platform, timers, GoogleDriveStorage, GoogleAuth, context, bytes } from './helpers.mjs';
const copies = t => [...t.vault.files].filter(([p]) => p.includes('.conflicted.')).map(([, f]) => text(f.data));

test('remote-wins conflict preserves the locally edited bytes', async () => {
  const t = make({ 'note.md': 'base' }, { 'note.md': 'base' }); await t.engine.sync();
  t.vault.edit('note.md', 'local', 3000); t.drive.edit('note.md', 'remote', 4000); await t.engine.sync();
  assert.equal(t.vault.content('note.md'), 'remote'); assert.deepEqual(copies(t), ['local']);
});
test('local-wins conflict preserves remote bytes and uploads only once', async () => {
  const t = make({ 'note.md': 'base' }, { 'note.md': 'base' }); await t.engine.sync();
  t.vault.edit('note.md', 'local', 4000); t.drive.edit('note.md', 'remote', 3000); t.drive.calls = [];
  await t.engine.sync(); assert.equal(t.drive.content('note.md'), 'local'); assert.deepEqual(copies(t), ['remote']);
  assert.equal(t.drive.calls.filter(c => c[0] === 'put').length, 1);
});
test('upload-only never downloads remote files; differing remote bytes are backed up', async () => {
  const t = make({ 'local.md': 'local' }, { 'remote.md': 'remote', 'local.md': 'old' }, {
    syncRules: [{ localPattern: '**', driveFolderId: 'root', direction: 'upload-only' }]
  }); await t.engine.sync();
  assert.equal(t.vault.files.has('remote.md'), false); assert.equal(t.drive.content('local.md'), 'local'); assert.deepEqual(copies(t), ['old']);
});
test('download-only does not upload even when local conflict is newer', async () => {
  const t = make({ 'note.md': 'local' }, { 'note.md': 'remote' }, {
    syncRules: [{ localPattern: '**', driveFolderId: 'root', direction: 'download-only' }]
  }); t.vault.files.get('note.md').stat.mtime = 10000; await t.engine.sync();
  assert.equal(t.vault.content('note.md'), 'remote'); assert.deepEqual(copies(t), ['local']); assert.equal(t.drive.calls.some(c => c[0] === 'put'), false);
});
test('same size and mtime edit is detected by modify event', async () => {
  const t = make({ 'note.md': 'before' }, { 'note.md': 'before' }); await t.engine.sync();
  t.vault.edit('note.md', 'after!', t.vault.files.get('note.md').stat.mtime); await t.engine.sync();
  assert.equal(t.drive.content('note.md'), 'after!');
});
test('persisted hash cache is revalidated after restart even if stat data is unchanged', async () => {
  const t = make({ 'note.md': 'before' }, { 'note.md': 'before' }); await t.engine.sync();
  t.vault.edit('note.md', 'after!', t.vault.files.get('note.md').stat.mtime, false);
  const engine = new SyncEngine(t.app, t.drive, t.settings, () => {}); await engine.sync();
  assert.equal(t.drive.content('note.md'), 'after!');
});
test('100 warm unchanged files require no file reads or transfers', async () => {
  const files = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`${i}.md`, 'same']));
  const t = make(files, files); await t.engine.sync(); let reads = 0;
  const original = t.vault.readBinary.bind(t.vault); t.vault.readBinary = f => { reads++; return original(f); }; t.drive.calls = [];
  let baselineWrites = 0; const write = t.vault.adapter.write; t.vault.adapter.write = (p, data) => { if (p === '.obsidian-gdrive-sync.json') baselineWrites++; return write(p, data); };
  await t.engine.sync(); assert.equal(reads, 0); assert.equal(baselineWrites, 0); assert.equal(t.drive.calls.filter(c => c[0] !== 'list').length, 0);
});
test('per-file baseline detects an edit with an older timestamp', async () => {
  const t = make({ 'note.md': 'base' }, { 'note.md': 'base' }); await t.engine.sync();
  t.vault.edit('note.md', 'local', 1); t.drive.edit('note.md', 'remote', 2); await t.engine.sync();
  assert.deepEqual(copies(t), ['local']);
});
test('rules upload and download full vault paths in their own Drive root', async () => {
  const t = make({ 'Agents/local.md': 'local' }, { 'Agents/wrong.md': 'wrong root' }, {
    syncRules: [{ localPattern: 'Agents/**', driveFolderId: 'agent', direction: 'two-way' }]
  }); const agent = t.drive.forRoot('agent'); agent.edit('Agents/remote.md', 'remote'); await t.engine.sync();
  assert.equal(agent.content('Agents/local.md'), 'local'); assert.equal(t.drive.files.has('Agents/local.md'), false);
  assert.equal(t.vault.content('Agents/remote.md'), 'remote'); assert.equal(t.vault.files.has('Agents/wrong.md'), false);
});
test('sanitized filename collision aborts before any transfer', async () => {
  const t = make({ 'local.md': 'local' }, { 'A:B.md': 'first', 'A?B.md': 'second' });
  await assert.rejects(t.engine.sync(), /collision/); assert.equal(t.drive.calls.some(c => c[0] !== 'list'), false); assert.equal(t.vault.files.size, 1);
});
test('sanitized folder collision aborts before any transfer', async () => {
  const t = make({}, { 'A:B/first.md': 'first', 'A?B/second.md': 'second' });
  await assert.rejects(t.engine.sync(), /collision/); assert.equal(t.vault.files.size, 0);
});
test('sanitized single file is updated by ID without creating a duplicate', async () => {
  const t = make({}, { 'A:B.md': 'base' }); await t.engine.sync(); t.vault.edit('A-B.md', 'edited'); await t.engine.sync();
  assert.equal(t.drive.content('A:B.md'), 'edited'); assert.equal(t.drive.files.size, 1);
});
test('ignored folders and hidden config are excluded from transfers', async () => {
  const t = make({ 'hidden/local.md': 'local', '.obsidian/config.json': 'private' }, { 'hidden/remote.md': 'remote', '.ssh/key': 'private' }, { ignoredPaths: ['hidden'] });
  await t.engine.sync(); assert.equal(t.drive.calls.filter(c => c[0] !== 'list').length, 0); assert.equal(t.vault.files.size, 2);
});
test('remote bytes changing during download are rejected before overwrite', async () => {
  const t = make({}, { 'note.md': 'base' }); const original = t.drive.get.bind(t.drive);
  t.drive.get = async id => { t.drive.edit('note.md', 'new'); return original(id); };
  await assert.rejects(t.engine.sync(), /Remote file changed/); assert.equal(t.vault.files.size, 0);
});
test('local edit during remote download is preserved and causes a retry', async () => {
  const t = make({ 'note.md': 'base' }, { 'note.md': 'base' }); await t.engine.sync(); t.drive.edit('note.md', 'remote');
  const original = t.drive.get.bind(t.drive); t.drive.get = async id => { t.vault.edit('note.md', 'edit during download'); return original(id); };
  await assert.rejects(t.engine.sync(), /Local file changed/); assert.equal(t.vault.content('note.md'), 'edit during download');
});
test('three overlapping engine operations are coalesced', async () => {
  const t = make({ 'note.md': 'base' }); await Promise.all([t.engine.sync(), t.engine.push(), t.engine.pull()]);
  assert.equal(t.drive.calls.filter(c => c[0] === 'put').length, 1);
});
test('plugin guard coalesces sync, push and pull across instances sharing a vault', async () => {
  const vault = new Vault(); let active = 0, max = 0, runs = 0;
  const work = async () => { runs++; max = Math.max(max, ++active); await new Promise(r => setTimeout(r, 5)); active--; };
  const plugins = [new SyncPlugin(), new SyncPlugin()];
  for (const p of plugins) { p.app = { vault }; p.settings = {}; p.initSyncEngine = () => { p.syncEngine = { sync: work, push: work, pull: work }; return true; }; p.saveSettings = async () => {}; }
  await Promise.all([plugins[0].runSync(), plugins[0].runPush(), plugins[1].runPull()]); assert.equal(max, 1); assert.equal(runs, 1);
  await plugins[1].runPull(); assert.equal(runs, 2);
});
test('interval reconfiguration replaces the existing timer and unload clears it', () => {
  timers.clear(); const p = new SyncPlugin(); p.settings = { syncMode: 'interval', syncIntervalMinutes: 1 };
  p.configureInterval(); p.configureInterval(); assert.equal(timers.size, 1); p.onunload(); assert.equal(timers.size, 0);
});
test('mobile startup skips the unsupported status bar and modify hook invalidates cache', async () => {
  Platform.isMobile = true;
  try {
    const p = new SyncPlugin(); p.app = { vault: new Vault({ 'note.md': 'before' }), workspace: { onLayoutReady() {} } };
    p.addStatusBarItem = () => { throw new Error('Mobile has no status bar'); }; await p.onload();
    await p.versioning.loadCache(); const file = p.app.vault.files.get('note.md'); const before = await p.versioning.getHash(file);
    p.app.vault.edit('note.md', 'after!', file.stat.mtime); const after = await p.versioning.getHash(p.app.vault.files.get('note.md'));
    assert.notEqual(before, after); p.onunload();
  } finally { Platform.isMobile = false; }
});
test('corrupt baseline fails instead of silently restarting conflict detection', async () => {
  const t = make({ 'note.md': 'local' }, { 'note.md': 'remote' }); t.vault.hidden.set('.obsidian-gdrive-sync.json', 'broken');
  await assert.rejects(t.engine.sync()); assert.equal(t.drive.calls.length, 0); assert.equal(t.vault.content('note.md'), 'local');
});
test('failed remote listing settles its batch and aborts before mutations', async () => {
  const t = make({ 'local.md': 'local' }, { 'one/a.md': 'a', 'two/b.md': 'b' }); let completed = false;
  const list = t.drive.list.bind(t.drive);
  t.drive.list = async id => { if (id.endsWith('one')) throw new Error('listing failed'); if (id.endsWith('two')) { await new Promise(r => setTimeout(r, 5)); completed = true; } return list(id); };
  await assert.rejects(t.engine.sync(), /listing failed/); assert.equal(completed, true); assert.equal(t.drive.calls.some(c => c[0] !== 'list'), false);
});
test('Drive upload submits name and parent atomically and supports empty content', async () => {
  const calls = []; context.fetch = async (url, options) => {
    calls.push([String(url), options]);
    if (options.method === 'GET' || !options.method) return new Response(JSON.stringify({ files: [] }), { status: 200 });
    if (options.method === 'POST') return new Response('', { status: 200, headers: { Location: 'https://www.googleapis.com/upload/session' } });
    return new Response(JSON.stringify({ id: 'file', name: 'empty.md', modifiedTime: '2026-03-20T00:00:00Z', size: '0', md5Checksum: 'd41d8cd98f00b204e9800998ecf8427e' }), { status: 200 });
  };
  try {
    const store = new GoogleDriveStorage({ getAccessToken: async () => 'test-token' }, 'root'); await store.put('empty.md', bytes(''));
    const start = calls.find(([, o]) => o.method === 'POST'); assert.deepEqual(JSON.parse(start[1].body), { name: 'empty.md', parents: ['root'] });
    assert.equal(calls.at(-1)[1].body.byteLength, 0); assert.equal(calls.some(([, o]) => o.method === 'PATCH'), false);
  } finally { context.fetch = () => { throw new Error('Unexpected network'); }; }
});

test('mapped Drive folder ID is reused for new files inside a sanitized folder', async () => {
  const calls = []; context.fetch = async (url, options) => {
    calls.push([String(url), options]);
    if (options.method === 'GET') return new Response(JSON.stringify({ files: [] }), { status: 200 });
    if (options.method === 'POST') return new Response('', { status: 200, headers: { Location: 'https://www.googleapis.com/upload/session' } });
    return new Response(JSON.stringify({ id: 'file', name: 'new.md', modifiedTime: '2026-03-20T00:00:00Z', size: '0' }), { status: 200 });
  };
  try {
    const store = new GoogleDriveStorage({ getAccessToken: async () => 'test-token' }, 'root'); store.rememberPath('A-B', 'original-folder');
    await store.put('A-B/new.md', bytes('')); const start = calls.find(([, o]) => o.method === 'POST');
    assert.deepEqual(JSON.parse(start[1].body), { name: 'new.md', parents: ['original-folder'] });
    assert.equal(calls.filter(([, o]) => o.method === 'POST').length, 1);
  } finally { context.fetch = () => { throw new Error('Unexpected network'); }; }
});
test('existing sanitized file upload keeps its original name and uses optimistic preflight', async () => {
  const calls = []; context.fetch = async (url, options) => {
    calls.push([String(url), options]);
    if (options.method === 'GET') return new Response(JSON.stringify({ md5Checksum: 'old' }), { status: 200, headers: { ETag: 'version' } });
    if (options.method === 'PATCH') return new Response('', { status: 200, headers: { Location: 'https://www.googleapis.com/upload/session' } });
    return new Response(JSON.stringify({ id: 'known', name: 'A:B.md', modifiedTime: '2026-03-20T00:00:00Z', size: '0' }), { status: 200 });
  };
  try {
    const store = new GoogleDriveStorage({ getAccessToken: async () => 'test-token' }, 'root'); await store.put('A-B.md', bytes(''), 'text/markdown', 'known', 'old');
    const start = calls.find(([, o]) => o.method === 'PATCH'); assert.ok(start[0].includes('/known?'));
    assert.deepEqual(JSON.parse(start[1].body), {}); assert.equal(start[1].headers['if-match'], 'version');
  } finally { context.fetch = () => { throw new Error('Unexpected network'); }; }
});
test('remote change before upload aborts before any write request', async () => {
  const calls = []; context.fetch = async (url, options) => { calls.push(options.method); return new Response(JSON.stringify({ md5Checksum: 'new' }), { status: 200 }); };
  try {
    const store = new GoogleDriveStorage({ getAccessToken: async () => 'test-token' }, 'root');
    await assert.rejects(store.put('note.md', bytes(''), 'text/markdown', 'known', 'old'), /changed/); assert.deepEqual(calls, ['GET']);
  } finally { context.fetch = () => { throw new Error('Unexpected network'); }; }
});
test('quotes and backslashes in filenames are escaped for Drive path queries', async () => {
  let query; context.fetch = async url => { query = new URL(url).searchParams.get('q'); return new Response(JSON.stringify({ files: [] }), { status: 200 }); };
  try {
    const store = new GoogleDriveStorage({ getAccessToken: async () => 'test-token' }, 'root'); await store.resolvePathToId("it's\\safe.md");
    assert.ok(query.includes("name='it\\'s\\\\safe.md'"));
  } finally { context.fetch = () => { throw new Error('Unexpected network'); }; }
});
test('unloaded plugin does not persist its stale settings after active sync finishes', async () => {
  const p = new SyncPlugin(); p.app = { vault: new Vault() }; let writes = 0;
  p.initSyncEngine = () => { p.syncEngine = { sync: async () => { p.onunload(); } }; return true; };
  p.saveData = async () => { writes++; }; await p.runSync(); assert.equal(writes, 0);
});
test('actual production bundle loads on mobile without Node globals', async () => {
  const { readFileSync } = await import('node:fs'); const { default: vm } = await import('node:vm');
  const previous = context.module; context.module = { exports: {} }; Platform.isMobile = true;
  try { vm.runInContext(readFileSync('main.js', 'utf8'), context); assert.equal(typeof context.module.exports.default, 'function'); }
  finally { context.module = previous; Platform.isMobile = false; }
});

test('parallel folder listings share a single OAuth refresh', async () => {
  let refreshes = 0, saves = 0;
  context.fetch = async () => { refreshes++; await new Promise(r => setTimeout(r, 5)); return new Response(JSON.stringify({ access_token: 'test-access', expires_in: 3600 }), { status: 200 }); };
  try {
    const auth = new GoogleAuth({ authMode: 'oauth', accessToken: '', accessTokenExpiry: 0, clientId: 'test-client', clientSecret: 'test-secret', refreshToken: 'test-refresh' }, async () => { saves++; });
    const tokens = await Promise.all(Array.from({ length: 5 }, () => auth.getAccessToken()));
    assert.equal(new Set(tokens).size, 1); assert.equal(refreshes, 1); assert.equal(saves, 1);
  } finally { context.fetch = () => { throw new Error('Unexpected network'); }; }
});
test('invalid service-account token endpoint is rejected before sending credentials', async () => {
  let calls = 0; context.fetch = async () => { calls++; throw new Error('Must not send credentials'); };
  try {
    const auth = new GoogleAuth({ authMode: 'service-account', serviceAccountJson: JSON.stringify({ client_email: 'test', private_key: 'test', token_uri: 'https://unexpected.example/token' }) }, async () => {});
    await assert.rejects(auth.getAccessToken()); assert.equal(calls, 0);
  } finally { context.fetch = () => { throw new Error('Unexpected network'); }; }
});
