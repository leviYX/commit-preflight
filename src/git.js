import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
const execute = promisify(execFile);

// 统一执行 Git：参数通过数组传递，不经 shell 拼接，并限制耗时和输出大小。
export async function git(root, args) {
  try {
    const { stdout } = await execute('git', ['-C', root, ...args], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    });
    return stdout;
  } catch (e) {
    // Git 错误可能包含仓库源码或敏感信息，不直接返回 stderr。
    throw new Error(`Git command failed (${e.code ?? e.signal ?? 'unknown'}): git ${args[0]}. Check repository state, Git availability and diff size (32 MiB limit).`);
  }
}
// 支持传入项目子目录；最终统一使用仓库根目录的真实路径。
export async function repositoryRoot(path) {
  if (typeof path !== 'string' || !path) throw new Error('path must be a project directory');
  const root = await git(resolve(path), ['rev-parse', '--show-toplevel']);
  return realpath(root.replace(/\r?\n$/, ''));
}
// staged 使用 --cached 读取暂存区；禁用外部 diff 和 textconv，避免执行仓库配置的转换程序。
export function diffArgs(scope) {
  return ['diff', ...(scope === 'staged' ? ['--cached'] : []), '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--ignore-submodules=none'];
}
// 解析 --numstat -z：用 NUL 分隔记录，兼容文件名中的空格、制表符和换行。
export function parseNumstat(text) {
  const parts = text.split('\0'); const files = [];
  for (let i = 0; i < parts.length && parts[i]; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(parts[i]);
    if (!match) throw new Error('Unexpected Git numstat format');
    let path = match[3], previousPath;
    // 重命名记录的首个路径为空，后续两个字段分别是旧路径和新路径。
    if (!path) { previousPath = parts[++i]; path = parts[++i]; }
    if (!path) throw new Error('Missing path in Git numstat');
    // 二进制文件以 '-' 表示行数：保留文件计数，但不估算文本行数。
    const binary = match[1] === '-';
    files.push({ path, ...(previousPath ? { previousPath } : {}), added: binary ? 0 : Number(match[1]), deleted: binary ? 0 : Number(match[2]), binary });
  }
  return files;
}
