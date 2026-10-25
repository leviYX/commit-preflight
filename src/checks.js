import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { repositoryRoot } from './git.js';
// 只允许显式选择这些常见检查脚本，不接受任意脚本名。
const ALLOWED = ['lint', 'typecheck', 'type-check', 'check', 'test'];
// 优先使用 packageManager 声明，其次识别锁文件；不自动安装依赖。
export async function discoverChecks(root) {
  let pkg;
  try { pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { checks: [], packageManager: 'npm' }; throw new Error('Invalid package.json: expected readable JSON'); }
  const checks = ALLOWED.filter(k => typeof pkg.scripts?.[k] === 'string' && pkg.scripts[k].trim());
  let packageManager = 'npm';
  if (pkg.packageManager) {
    if (typeof pkg.packageManager !== 'string' || !/^(npm|pnpm|yarn|bun)@/.test(pkg.packageManager)) throw new Error('Unsupported packageManager in package.json');
    packageManager = pkg.packageManager.split('@')[0];
  } else {
    const found = [];
    for (const [lock, manager] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']]) {
      try { await access(join(root, lock)); found.push(manager); } catch {}
    }
    // 同时存在多种包管理器的锁文件时，要求项目明确声明，避免猜错执行工具。
    const unique = [...new Set(found)];
    if (unique.length > 1) throw new Error('Multiple package-manager lockfiles; set packageManager in package.json');
    packageManager = unique[0] ?? 'npm';
  }
  return { checks, packageManager };
}
// 脚本读取工作区，而不是暂存快照；项目脚本本身仍可能修改文件。
function runScript(root, manager, script, timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now(); let bytes = 0, timedOut = false, outputLimited = false, spawnError;
    const child = spawn(manager, ['run', script], { cwd: root, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    // macOS/Linux 杀掉整个进程组，避免 npm 等启动的子进程在超时后继续运行。
    function stop() {
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
    }
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    // 只统计输出字节数，不保存或返回原文；超过 1 MiB 就终止脚本。
    const consume = chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) { outputLimited = true; stop(); } };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.on('error', e => { spawnError = e.code ?? 'SPAWN_ERROR'; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ name: script, command: `${manager} run ${script}`, status: timedOut ? 'timeout' : outputLimited ? 'output-limit' : code === 0 && !spawnError ? 'pass' : 'fail', exitCode: code, signal, durationMs: Date.now() - started, outputBytes: bytes, ...(spawnError ? { error: spawnError } : {}), outputOmitted: true });
    });
  });
}
export async function runProjectChecks({ path, checks, timeoutMs = 120_000 } = {}) {
  if (!Array.isArray(checks) || !checks.length || checks.some(k => !ALLOWED.includes(k))) throw new Error(`checks must explicitly list allowed scripts: ${ALLOWED.join(', ')}`);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 300_000) throw new Error('timeoutMs must be an integer between 50 and 300000');
  const root = await repositoryRoot(path); const discovered = await discoverChecks(root);
  // 先确认所有请求的脚本都存在，再开始执行，避免执行到一半才发现输入错误。
  for (const check of checks) if (!discovered.checks.includes(check)) throw new Error(`Requested script not found: ${check}`);
  const results = [];
  // 去重后按顺序执行，避免多个检查同时争用或修改工作区文件。
  for (const check of new Set(checks)) results.push(await runScript(root, discovered.packageManager, check, timeoutMs));
  return { root, status: results.every(r => r.status === 'pass') ? 'pass' : 'fail', packageManager: discovered.packageManager, checks: results, note: '脚本读取工作区，可能产生缓存、快照等副作用。输出可能含凭据，故只返回退出码和状态；详细错误请在本地运行所列命令。' };
}
