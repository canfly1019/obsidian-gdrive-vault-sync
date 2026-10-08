import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

// Upstream's sample lint configuration already rejects its existing UI. Keep the
// full `npm run lint` report available, and fail CI for any additional violations.
const baseline = JSON.parse(readFileSync(new URL('./lint-baseline.json', import.meta.url), 'utf8'));
const result = spawnSync(process.execPath, ['node_modules/eslint/bin/eslint.js', 'src', 'manifest.json', '--format', 'json'], { encoding: 'utf8' });
if (result.error || (result.status !== 0 && result.status !== 1)) {
    process.stderr.write(result.stderr || String(result.error));
    process.exit(1);
}
const counts = new Map();
for (const file of JSON.parse(result.stdout)) {
    const path = relative(process.cwd(), file.filePath).replaceAll('\\', '/');
    for (const message of file.messages) {
        if (message.severity !== 2) continue;
        const key = `${path}|${message.ruleId}|${message.message}`;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
}
let added = 0, inherited = 0;
for (const [key, count] of counts) {
    inherited += count;
    const extra = Math.max(0, count - (baseline.errors[key] || 0));
    if (extra) { added += extra; process.stderr.write(`${extra} additional error(s): ${key}\n`); }
}
console.log(`Lint: ${added} added errors; ${inherited} inherited errors remain (run npm run lint for the full report).`);
process.exitCode = added ? 1 : 0;
