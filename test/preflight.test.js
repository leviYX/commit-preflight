import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const api = await import('../src/index.js').catch(() => ({}));
const git = (p, ...a) => execFileSync('git', ['-C', p, ...a], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
function repo(t, initial = true) {
 const p = mkdtempSync(join(tmpdir(), 'dsh preflight-')); t.after(() => rmSync(p, { recursive: true, force: true }));
 git(p, 'init', '-q'); git(p, 'config', 'user.email', 'test@example.invalid'); git(p, 'config', 'user.name', 'Test');
 if (initial) { put(p, 'app.js', 'export const value = 1;\n'); git(p, 'add', '.'); git(p, 'commit', '-qm', 'initial'); } return p;
}
function put(p, f, text) { mkdirSync(join(p, f, '..'), { recursive: true }); writeFileSync(join(p, f), text); }
async function report(p, options = {}) { assert.equal(typeof api.preflight, 'function', 'preflight API must exist'); return api.preflight({ path: p, ...options }); }
test('index excludes unstaged edits and untracked files', async t => {
 const p = repo(t); put(p, 'app.js', 'export const value = 2;\nexport const second = 3;\n'); git(p, 'add', '.'); put(p, 'app.js', 'debugger;\n'); put(p, 'new.js', 'debugger;\n');
 const r = await report(p); assert.equal(r.scope, 'staged'); assert.equal(r.totals.added, 2); assert.equal(r.totals.deleted, 1); assert.equal(r.totals.changed, 3); assert.equal(r.status, 'pass'); assert.equal(r.untrackedFiles, 1); assert.equal(r.findings.length, 0);
 const u = await report(p, { scope: 'unstaged' }); assert.equal(u.totals.added, 1); assert.equal(u.totals.deleted, 2); assert.ok(u.findings.some(f => f.rule === 'debugger'));
});
test('first commit handles unicode, tabs, newlines and leading dash paths', async t => {
 const p = repo(t, false); for (const f of ['中文.js', 'a\tb.js', 'a\nb.js', '-x.js']) put(p, f, 'export {};\n'); git(p, 'add', '.');
 const r = await report(p); assert.equal(r.totals.files, 4); assert.equal(r.totals.added, 4); assert.ok(r.files.some(f => f.path === 'a\nb.js'));
});
test('rename preserves zero changed lines; binary files are counted', async t => {
 const p = repo(t); git(p, 'mv', 'app.js', 'renamed.js'); writeFileSync(join(p, 'image.bin'), Buffer.from([0, 1, 2])); git(p, 'add', '.');
 const r = await report(p); assert.equal(r.totals.files, 2); assert.equal(r.totals.changed, 0); assert.equal(r.totals.binaryFiles, 1); assert.equal(r.files.find(f => f.path === 'renamed.js').previousPath, 'app.js');
});
test('lockfiles stay visible but are excluded from size policy', async t => {
 const p = repo(t); put(p, 'package-lock.json', '{}\n'.repeat(10)); put(p, 'app.js', 'one\ntwo\n'); git(p, 'add', '.'); put(p, '.dsh-preflight.json', JSON.stringify({ warnLines: 3, maxLines: 5 }));
 const r = await report(p); assert.equal(r.totals.changed, 13); assert.equal(r.counted.changed, 3); assert.equal(r.status, 'pass'); assert.equal(r.files.find(f => f.path === 'package-lock.json').excluded, true);
});
test('policy boundaries use added plus deleted lines, strictly greater', async t => {
 const p = repo(t); put(p, 'app.js', 'a\nb\nc\n'); git(p, 'add', '.');
 assert.equal((await report(p, { policy: { warnLines: 3, maxLines: 5 } })).status, 'warn'); assert.equal((await report(p, { policy: { warnLines: 2, maxLines: 3 } })).status, 'fail'); assert.equal((await report(p, { policy: { warnLines: 4, maxLines: 4 } })).status, 'pass');
});
test('scan additions at exact locations and never expose secret values', async t => {
 const p = repo(t); const secret = 'ghp_' + 'a'.repeat(36); put(p, 'app.js', `export const value = 1;\ndebugger;\nconsole.log('x');\n// TODO remove\n<<<<<<< branch\nconst token = '${secret}';\n`); git(p, 'add', '.');
 const r = await report(p); assert.equal(r.status, 'fail'); for (const rule of ['debugger', 'console-log', 'todo', 'conflict-marker', 'secret']) assert.ok(r.findings.some(f => f.rule === rule), rule); assert.equal(r.findings.find(f => f.rule === 'debugger').line, 2); assert.ok(!JSON.stringify(r).includes(secret));
});
test('deleted risky lines do not produce findings', async t => {
 const p = repo(t); put(p, 'app.js', 'debugger;\n'); git(p, 'add', '.'); git(p, 'commit', '-qm', 'debug'); put(p, 'app.js', 'export {};\n'); git(p, 'add', '.'); assert.equal((await report(p)).findings.length, 0);
});
test('empty index and invalid inputs are explicit', async t => {
 const p = repo(t); assert.equal((await report(p)).status, 'empty'); await assert.rejects(() => report(p, { scope: 'anything' }), /scope/i);
 put(p, '.dsh-preflight.json', '{broken'); await assert.rejects(() => report(p), /config|配置/i); put(p, '.dsh-preflight.json', JSON.stringify({ maxLines: -1 })); await assert.rejects(() => report(p), /maxLines/);
 const other = mkdtempSync(join(tmpdir(), 'not-git-')); t.after(() => rmSync(other, { recursive: true, force: true })); await assert.rejects(() => report(other), /Git|git/);
});
test('custom exclusions and file count thresholds apply', async t => {
 const p = repo(t); put(p, 'generated/x.js', 'debugger;\n'); put(p, 'test.js', 'export {};\n'); git(p, 'add', '.');
 const r = await report(p, { policy: { exclude: ['generated/**'], warnFiles: 0 } }); assert.equal(r.counted.files, 1); assert.equal(r.status, 'warn'); assert.equal(r.findings.length, 0);
});
test('nested path resolves to root; index remains unchanged', async t => {
 const p = repo(t); put(p, 'nested/a.js', 'export {};\n'); git(p, 'add', '.'); const before = git(p, 'diff', '--cached', '--binary'); const r = await report(join(p, 'nested')); assert.equal(r.root, realpathSync(p)); assert.equal(git(p, 'diff', '--cached', '--binary'), before);
});
test('project checks discover and run only explicit allowlisted scripts', async t => {
 const p = repo(t); put(p, 'package.json', JSON.stringify({ scripts: { lint: 'node -e "process.exit(0)"', test: 'node -e "process.exit(2)"', deploy: 'node -e "process.exit(0)"' } })); assert.deepEqual((await report(p)).availableChecks, ['lint', 'test']); assert.equal(typeof api.runProjectChecks, 'function');
 const r = await api.runProjectChecks({ path: p, checks: ['lint', 'test'] }); assert.equal(r.status, 'fail'); assert.equal(r.checks[0].status, 'pass'); assert.equal(r.checks[1].exitCode, 2); await assert.rejects(() => api.runProjectChecks({ path: p, checks: ['deploy'] }), /allow|允许/i);
});
test('checks bound execution time and suppress sensitive output', async t => {
 const p = repo(t); put(p, 'package.json', JSON.stringify({ scripts: { test: `node -e "console.log('secret-value');setTimeout(()=>{},10000)"` } })); assert.equal(typeof api.runProjectChecks, 'function');
 const r = await api.runProjectChecks({ path: p, checks: ['test'], timeoutMs: 100 }); assert.equal(r.status, 'fail'); assert.equal(r.checks[0].status, 'timeout'); assert.ok(!JSON.stringify(r).includes('secret-value'));
});
test('plugin registers three starter-compatible tools', async t => {
 const p = repo(t); const defs = []; assert.equal(typeof api.apply, 'function'); api.apply({ tool: { define: d => defs.push(d) } }); assert.deepEqual(defs.map(d => d.name), ['git_changes', 'scan_changes', 'run_project_check']); for (const d of defs) { assert.equal(typeof d.handler, 'function'); assert.equal(d.parameters.type, 'object'); } assert.equal((await defs[0].handler({ path: p })).status, 'empty'); assert.throws(() => api.apply({}), /tool/);
});
test('CLI supports JSON, exit codes, help and rejects unknown options', t => {
 const p = repo(t); const cli = new URL('../src/cli.js', import.meta.url).pathname; const run = (...a) => spawnSync(process.execPath, [cli, ...a], { encoding: 'utf8' });
 const r = run('--path', p, '--json'); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).status, 'empty'); put(p, 'app.js', '<<<<<<< branch\n'); git(p, 'add', '.'); assert.equal(run('--path', p).status, 1); assert.equal(run('--oops').status, 2); assert.match(run('--help').stdout, /staged/);
});
test('unresolved merge conflicts fail even without a literal conflict marker scan', async t => {
 const p = repo(t); const base = git(p, 'branch', '--show-current').trim(); git(p, 'checkout', '-qb', 'other'); put(p, 'app.js', 'other\n'); git(p, 'add', '.'); git(p, 'commit', '-qm', 'other'); git(p, 'checkout', '-q', base); put(p, 'app.js', 'main\n'); git(p, 'add', '.'); git(p, 'commit', '-qm', 'main'); assert.throws(() => git(p, 'merge', 'other'));
 const r = await report(p, { scan: false }); assert.equal(r.status, 'fail'); assert.ok(r.findings.some(f => f.rule === 'unmerged-index'));
});
test('multiple hunks retain new-file line numbers', async t => {
 const p = repo(t); const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`); put(p, 'app.js', lines.join('\n') + '\n'); git(p, 'add', '.'); git(p, 'commit', '-qm', 'lines'); lines[1] = 'debugger;'; lines[35] = 'console.log(1);'; put(p, 'app.js', lines.join('\n') + '\n'); git(p, 'add', '.');
 const r = await report(p); assert.deepEqual(r.findings.map(f => f.line), [2, 36]);
});
test('output floods terminate checks, and missing scripts do not run others', async t => {
 const p = repo(t); put(p, 'package.json', JSON.stringify({ scripts: { test: 'node -e "process.stdout.write(\'x\'.repeat(2000000))"', lint: 'node -e "process.exit(0)"' } }));
 const r = await api.runProjectChecks({ path: p, checks: ['test'] }); assert.equal(r.status, 'fail'); assert.equal(r.checks[0].status, 'output-limit'); await assert.rejects(() => api.runProjectChecks({ path: p, checks: ['lint', 'typecheck'] }), /not found/);
});
test('package manager declaration wins over lockfile inference', async t => {
 const p = repo(t); put(p, 'package.json', JSON.stringify({ packageManager: 'pnpm@9.0.0', scripts: { test: 'echo ok' } })); put(p, 'yarn.lock', '');
 const { discoverChecks } = await import('../src/checks.js'); assert.equal((await discoverChecks(p)).packageManager, 'pnpm'); put(p, 'package.json', JSON.stringify({ scripts: {} })); put(p, 'pnpm-lock.yaml', ''); await assert.rejects(() => discoverChecks(p), /Multiple/);
});
test('strict CLI fails warnings and empty scope; JSON includes check failures', t => {
 const p = repo(t); const cli = new URL('../src/cli.js', import.meta.url).pathname; const run = (...a) => spawnSync(process.execPath, [cli, '--path', p, ...a], { encoding: 'utf8' });
 assert.equal(run('--strict').status, 1); put(p, 'app.js', 'console.log(1);\n'); git(p, 'add', '.'); assert.equal(run().status, 0); assert.equal(run('--strict').status, 1);
 put(p, 'package.json', JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } })); const r = run('--json', '--checks', 'test'); assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).projectChecks.status, 'fail');
});
