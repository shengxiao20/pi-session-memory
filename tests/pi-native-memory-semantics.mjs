/** Validate session-context behavior against an explicit Pi 1.5.2 installation, in memory only.
 * Run: node tests/pi-native-memory-semantics.mjs /absolute/path/to/pi-coding-agent
 * Requires that exact package version. No model calls, user history or persistent writes.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = resolve(process.argv[2]);
const metadata = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
assert.equal(metadata.name, '@earendil-works/pi-coding-agent');
assert.equal(metadata.version, '1.5.2', 'Recheck session-context behavior before validating another Pi version.');
const { SessionManager, buildSessionContext } = await import(pathToFileURL(resolve(packageRoot, 'dist/core/session-manager.js')));
const { readCodemodeStore } = await import(pathToFileURL(resolve(packageRoot, 'dist/extensions/codemode/execute.js')));
const { getVirtualModelState } = await import(pathToFileURL(resolve(packageRoot, 'dist/core/virtual-models.js')));

const timestamp = '2026-01-01T00:00:00.000Z';
const messageEntry = (id, parentId, role, content) => ({
  type: 'message', id, parentId, timestamp,
  message: { role, content: [{ type: 'text', text: content }], timestamp: 1 },
});
const tool = name => ({ name, description: name, parameters: { type: 'object', properties: {} } });
const system = {
  type: 'message', id: 'sys', parentId: null, timestamp,
  message: { role: 'system', content: '', sections: { preamble: 'rule-one' }, toolsAdded: [tool('read')], timestamp: 1 },
};
const patch = {
  type: 'message', id: 'patch', parentId: 'a1', timestamp,
  message: { role: 'system', content: '', sections: { preamble: 'rule-two' },
    toolsAdded: [tool('write')], toolsRemoved: [{ name: 'read' }], timestamp: 2 },
};
const entries = [
  system, messageEntry('u1', 'sys', 'user', 'old-user'), messageEntry('a1', 'u1', 'assistant', 'old-reply'), patch,
  messageEntry('u2', 'patch', 'user', 'recent-user'), messageEntry('a2', 'u2', 'assistant', 'recent-reply'),
  messageEntry('other', 'u1', 'user', 'other-branch'),
  { type: 'context_edit', id: 'edit', parentId: 'a2', timestamp, targetId: 'a1', replacement: null },
  { type: 'custom_message', id: 'injected', parentId: 'edit', timestamp,
    customType: 'note', content: 'injected-message', display: true },
  { type: 'custom', id: 'store', parentId: 'injected', timestamp, customType: 'codemode-store',
    data: { set: { cursor: 42 }, delete: [] } },
  { type: 'custom', id: 'router', parentId: 'store', timestamp, customType: 'pi.virtual-model-state',
    data: { provider: 'test', modelId: 'auto', state: { phase: 'build' } } },
];
const header = { type: 'session', id: 'context-check', version: 3, cwd: '/tmp/pi-native-context-check', timestamp };
const original = JSON.stringify(entries);
const manager = SessionManager.inMemory(header.cwd, undefined, [header, ...entries]);
const content = context => JSON.stringify(context.messages);

const current = content(buildSessionContext(entries, 'router'));
assert.ok(!current.includes('other-branch'));
assert.ok(!current.includes('old-reply'));
assert.ok(current.includes('injected-message'));
assert.ok(!current.includes('cursor') && !current.includes('phase'));
assert.ok(content(buildSessionContext(entries, 'a2')).includes('old-reply'));
assert.deepEqual(readCodemodeStore(manager.getBranch('router')), { cursor: 42 });
assert.deepEqual(readCodemodeStore(manager.getBranch('other')), {});
assert.deepEqual(getVirtualModelState(manager.getBranch('router'), 'test', 'auto'), { phase: 'build' });
assert.equal(getVirtualModelState(manager.getBranch('other'), 'test', 'auto'), undefined);
assert.equal(JSON.stringify(entries), original);

const compactionId = manager.appendCompaction('older-content-summary', 'u2', 123);
const checkpoint = manager.getEntry(compactionId).systemMessage;
assert.equal(checkpoint.sections.preamble, 'rule-two');
assert.deepEqual(checkpoint.toolsAdded.map(item => item.name), ['write']);
const compacted = manager.buildSessionContext();
assert.ok(!content(compacted).includes('old-user'));
assert.ok(content(compacted).includes('older-content-summary'));
assert.ok(content(compacted).includes('recent-user'));
assert.equal(compacted.messages[0].role, 'system');
assert.deepEqual(readCodemodeStore(manager.getBranch()), { cursor: 42 });
assert.deepEqual(getVirtualModelState(manager.getBranch(), 'test', 'auto'), { phase: 'build' });
assert.ok(manager.getEntries().some(entry => entry.id === 'a1'));
console.log('PASS: Pi 1.5.2 active branch, non-destructive edits, custom/custom_message, branch-relative state, compaction system/tool checkpoint and preserved raw entries.');
