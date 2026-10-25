import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryRoot, git, diffArgs, parseNumstat } from './git.js';
import { discoverChecks } from './checks.js';

// 项目未配置规则时使用这些默认值；锁文件和构建产物默认不计入规模及内容扫描。
export const DEFAULT_POLICY = Object.freeze({
  warnLines: 300, maxLines: 800, warnFiles: 20,
  exclude: Object.freeze(['**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/bun.lock', '**/bun.lockb', '**/dist/**', '**/build/**', '**/coverage/**', '**/vendor/**']),
});
// 配置优先级：默认值 < 仓库根目录配置 < 调用方覆盖值。数组采用整体替换。
export async function readPolicy(root, overrides = {}) {
  let local = {};
  try { local = JSON.parse(await readFile(join(root, '.dsh-preflight.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('Invalid config: .dsh-preflight.json must be readable JSON'); }
  for (const value of [local, overrides]) {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid config: policy must be an object');
    for (const key of Object.keys(value)) if (!(key in DEFAULT_POLICY) || !Object.hasOwn(DEFAULT_POLICY, key)) throw new Error(`Unknown config key: ${key}`);
  }
  const policy = { ...DEFAULT_POLICY, ...local, ...overrides };
  for (const key of ['warnLines', 'maxLines', 'warnFiles']) if (!Number.isSafeInteger(policy[key]) || policy[key] < 0) throw new Error(`Invalid config: ${key} must be a non-negative integer`);
  if (policy.maxLines < policy.warnLines) throw new Error('Invalid config: maxLines must be >= warnLines');
  if (!Array.isArray(policy.exclude) || policy.exclude.some(p => typeof p !== 'string' || !p || /[\[\]{}\\]/.test(p))) throw new Error('Invalid config: exclude must contain simple slash-separated globs (*, **, ?)');
  return policy;
}
// 将简单 glob 转成正则：* 不跨目录，** 可跨目录，**/ 也可匹配零层目录。
function globRegex(pattern) {
  let result = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { i++; if (pattern[i + 1] === '/') { i++; result += '(?:.*/)?'; } else result += '.*'; }
    else if (c === '*') result += '[^/]*';
    else if (c === '?') result += '[^/]';
    else result += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(result + '$');
}
// 提交规模按新增行与删除行之和计算；替换一行通常计两行。
function totals(files) {
  const r = { files: files.length, added: 0, deleted: 0, changed: 0, binaryFiles: 0 };
  for (const f of files) { r.added += f.added; r.deleted += f.deleted; r.binaryFiles += Number(f.binary); }
  r.changed = r.added + r.deleted; return r;
}
// 只扫描 diff 中新增的行，并根据 hunk 头维护新文件中的行号。
function scanPatch(patch, path) {
  const findings = []; let line = 0, inHunk = false;
  for (const row of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) { line = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk) continue;
    if (row[0] === '+') {
      const text = row.slice(1);
      // 仅记录位置、规则和说明，避免将源码片段或疑似凭据值返回给模型。
      const add = (rule, severity, message) => findings.push({ path, line, rule, severity, message });
      if (/^(?:<{7}(?: |$)|={7}$|>{7}(?: |$)|\|{7}(?: |$))/.test(text)) add('conflict-marker', 'error', '疑似未解决的合并冲突标记');
      if (/\bdebugger\s*;?/.test(text)) add('debugger', 'warning', '新增内容含 debugger，请确认是否移除');
      if (/\bconsole\s*\.\s*log\s*\(/.test(text)) add('console-log', 'warning', '新增内容含 console.log，请确认是否为调试残留');
      if (/\b(?:TODO|FIXME)\b/.test(text)) add('todo', 'warning', '新增内容含 TODO/FIXME，请确认是否影响提交');
      const knownSecret = /(?:\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----)/;
      const assignment = /\b(?:api[_-]?key|secret|password|access[_-]?token|auth[_-]?token|token)\b["']?\s*[:=]\s*["']([^"'\r\n]{12,})["']/i.exec(text);
      const literal = assignment?.[1];
      // 排除常见占位符；这属于启发式匹配，仍可能误报或漏报。
      const placeholder = literal && /^(?:\$|\{|<)|(?:example|placeholder|your[_-]|changeme|process\.env|os\.environ)/i.test(literal);
      if (knownSecret.test(text) || (literal && !placeholder)) add('secret', 'error', '疑似硬编码凭据；内容已省略，请在本地核实');
      line++;
    // 上下文行推进新文件行号；删除行不占用新文件行号。
    } else if (row[0] === ' ') line++;
    else if (row.startsWith('diff --git ')) inHunk = false;
  }
  return findings;
}

// 汇总检查入口：默认读取暂存区，不运行项目脚本，也不修改工作区或 index。
export async function preflight({ path, scope = 'staged', policy: overrides = {}, scan = true } = {}) {
  if (!['staged', 'unstaged'].includes(scope)) throw new Error('scope must be staged or unstaged');
  const root = await repositoryRoot(path);
  const policy = await readPolicy(root, overrides);
  const patterns = policy.exclude.map(globRegex);
  const files = parseNumstat(await git(root, [...diffArgs(scope), '--numstat', '-z', '--']));
  for (const f of files) { f.changed = f.added + f.deleted; f.excluded = patterns.some(re => re.test(f.path)); }
  // 同时保留全量统计和排除后的统计，阈值只使用 counted。
  const all = totals(files), counted = totals(files.filter(f => !f.excluded));
  const warnings = [], findings = [];
  if (counted.changed > policy.maxLines) warnings.push({ severity: 'error', rule: 'max-lines', message: `计入规模 ${counted.changed} 行，超过上限 ${policy.maxLines} 行` });
  else if (counted.changed > policy.warnLines) warnings.push({ severity: 'warning', rule: 'warn-lines', message: `计入规模 ${counted.changed} 行，超过提示值 ${policy.warnLines} 行` });
  if (counted.files > policy.warnFiles) warnings.push({ severity: 'warning', rule: 'file-count', message: `计入文件 ${counted.files} 个，超过提示值 ${policy.warnFiles} 个` });
  if (all.binaryFiles) warnings.push({ severity: 'warning', rule: 'binary', message: `${all.binaryFiles} 个二进制文件无法按文本行统计或扫描` });
  // 即使没有扫描到文本冲突标记，也要单独检查 Git index 的未合并状态。
  const unmerged = await git(root, ['ls-files', '--unmerged', '-z']);
  for (const f of new Set(unmerged.split('\0').filter(Boolean).map(r => r.slice(r.indexOf('\t') + 1)))) findings.push({ path: f, line: null, rule: 'unmerged-index', severity: 'error', message: 'Git 暂存区存在未解决的合并冲突' });
  if (scan) for (const f of files) {
    if (f.binary || f.excluded || f.added === 0) continue;
    // 使用 literal pathspec，防止特殊文件名被 Git 当成通配表达式；重命名时包含新旧路径。
    const paths = [...(f.previousPath ? [f.previousPath] : []), f.path].map(p => `:(literal)${p}`);
    findings.push(...scanPatch(await git(root, [...diffArgs(scope), '--unified=0', '--', ...paths]), f.path));
  }
  const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  const untrackedFiles = untracked.split('\0').filter(Boolean).length;
  const issues = [...warnings, ...findings];
  // 状态优先级：错误 > 警告 > 有变更且通过 > 无变更。
  const status = issues.some(f => f.severity === 'error') ? 'fail' : issues.length ? 'warn' : files.length ? 'pass' : 'empty';
  return { root, scope, status, totals: all, counted, excludedFiles: files.filter(f => f.excluded).length, untrackedFiles, files, findings, warnings, policy, scanPerformed: scan,
    availableChecks: (await discoverChecks(root)).checks,
    notes: ['变更行数 = 新增行 + 删除行，包含空行和注释；替换一行通常计 2 行。', '排除文件不计入规模阈值，也不执行内容扫描；二进制文件只计文件数。', '未跟踪文件不在本次 diff 中；检查前请先 git add。', '扫描为文本规则匹配，可能误报；不代表完整安全审计。', '项目脚本读取工作区文件；部分暂存时，其结果不能证明暂存快照通过。'],
  };
}
