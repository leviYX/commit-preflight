import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('native bundle registers DSH tools and direct preflight command', async t => {
  try { await import('@deepseek-ai/dsh-tools'); } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('Native integration requires the DSH host packages'); return;
  }
  const native = await import('../src/dsh.js');
  const { Context } = await import('@deepseek-ai/cordis');
  const { ToolRuntime } = await import('@deepseek-ai/dsh-tools');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const ctx = new Context();
  ctx.provide('systemPrompt', { tools() {} });
  const runtime = new ToolRuntime(ctx);
  const definitions = new Map();
  let command;
  native.apply({
    tools: { register(definition) { runtime.register(definition); definitions.set(definition.name, definition); } },
    inject(services, callback) { callback({ commands: { register(value) { command = value; } } }); },
  });
  assert.deepEqual(native.inject, ['tools']);
  assert.deepEqual([...definitions.keys()], ['git_changes', 'scan_changes', 'run_project_check']);
  for (const definition of definitions.values()) {
    assert.equal(typeof definition.execute, 'function');
    assert.equal(typeof definition.output.render, 'function');
    assert.ok(definition.parameters.properties.path);
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh native-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'app.js'), 'export {};\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  const report = await runtime.get('scan_changes').execute({ path: dir });
  assert.equal(report.totals.added, 1);
  assert.equal(report.status, 'pass');
  const direct = await command.handler({ rawInput: dir });
  assert.equal(direct.kind, 'success');
  assert.equal(JSON.parse(direct.text).totals.added, 1);
  const agent = { session: { header: { cwd: dir } } };
  const current = await command.handler({ rawInput: '  ', agent });
  assert.equal(current.kind, 'success', 'empty input must use the selected project');
  assert.equal(JSON.parse(current.text).totals.added, 1);
  const override = await command.handler({ rawInput: dir, agent: { session: { header: { cwd: '/missing-selected-project' } } } });
  assert.equal(override.kind, 'success', 'explicit path overrides the selected project');
  const invalid = await command.handler({ rawInput: '', agent: { session: { header: { cwd: '/missing-selected-project' } } } });
  assert.equal(invalid.kind, 'error', 'invalid selected project must not fall back to process.cwd');
  for (const agent of [undefined, {}, { session: { header: {} } }]) {
    const missing = await command.handler({ rawInput: '', agent });
    assert.equal(missing.kind, 'error');
    assert.match(missing.text, /选择项目/);
  }
  assert.match(command.input.hint, /可选/);
  assert.equal(runtime.schemas().length, 3);
  assert.equal(command.name, 'preflight');
  assert.equal((await command.handler({ rawInput: '' })).kind, 'error');
  assert.equal((await command.handler({ rawInput: '/definitely/nonexistent/repository' })).kind, 'error');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.exports['.'], './src/dsh.js');
});
