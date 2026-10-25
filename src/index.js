import { preflight } from './report.js';
import { runProjectChecks } from './checks.js';
export { preflight, runProjectChecks };
export const name = 'commit-preflight';
// starter 接口使用完整 JSON Schema；正式 DSH 的参数格式由原生入口转换。
const common = {
  path: { type: 'string', description: 'Absolute path to a directory in the Git repository.' },
  scope: { type: 'string', enum: ['staged', 'unstaged'], description: 'Default staged: next ordinary commit. Unstaged excludes the index and untracked files.' },
};
// 保留 starter 兼容注册入口；工具实现共享同一套统计、扫描和脚本逻辑。
export function apply(ctx) {
  if (typeof ctx?.tool?.define !== 'function') throw new Error('commit-preflight requires ctx.tool.define');
  ctx.tool.define({ name: 'git_changes', description: 'Read Git diff statistics: additions, deletions, commit size, file exclusions and configurable thresholds. Does not scan source or run scripts.', parameters: { type: 'object', properties: common, required: ['path'], additionalProperties: false }, handler: args => preflight({ ...args, scan: false }) });
  ctx.tool.define({ name: 'scan_changes', description: 'Inspect commit size and scan added lines for conflict markers, debug remnants and possible secrets. Reports locations without source snippets. No scripts are executed.', parameters: { type: 'object', properties: common, required: ['path'], additionalProperties: false }, handler: args => preflight({ ...args, scan: true }) });
  ctx.tool.define({ name: 'run_project_check', description: 'Explicitly run selected allowlisted package.json scripts on the working tree (not an isolated staged snapshot). Scripts can modify generated files. Returns exit codes without raw output.', parameters: { type: 'object', properties: { path: common.path, checks: { type: 'array', minItems: 1, items: { type: 'string', enum: ['lint', 'typecheck', 'type-check', 'check', 'test'] } }, timeoutMs: { type: 'integer', minimum: 50, maximum: 300000, description: 'Per-script timeout, default 120000 ms.' } }, required: ['path', 'checks'], additionalProperties: false }, handler: runProjectChecks });
}
