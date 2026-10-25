#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { preflight, runProjectChecks } from './index.js';
// 保留的独立命令入口；DSH 图形界面的 /preflight 由 src/dsh.js 注册。
const help = `DSH commit preflight (Node >=22, Git required)
Usage: node src/cli.js --path /absolute/repo [options]
  --scope staged|unstaged  Default staged (index); untracked files excluded
  --json                  Structured report
  --checks lint,test      Explicitly run selected package scripts on working tree
  --timeout-ms 120000     Per-script timeout (50..300000 ms)
  --strict                Treat warnings and empty diff as nonzero (exit 1)
  --help                  Show help
Exit: 0 pass/warn/empty; 1 policy/scan/check failure (or strict); 2 input/runtime error.
Policy file: <repository>/.dsh-preflight.json
`;
// 将结构化报告转换成人类可读的文本，不输出扫描到的源码片段。
function render(r) {
  const labels = { pass: '通过', warn: '需关注', fail: '未通过', empty: '无变更' };
  const out = [`提交前检查：${labels[r.status]} (${r.scope})`, `仓库：${r.root}`, `全部：${r.totals.files} 个文件，新增 ${r.totals.added} 行，删除 ${r.totals.deleted} 行，合计 ${r.totals.changed} 行`, `计入规模：${r.counted.changed} 行 / ${r.counted.files} 个文件；排除 ${r.excludedFiles} 个文件；二进制 ${r.totals.binaryFiles} 个；未跟踪 ${r.untrackedFiles} 个`, `阈值：>${r.policy.warnLines} 行提示，>${r.policy.maxLines} 行失败，>${r.policy.warnFiles} 个文件提示`];
  for (const f of r.files) out.push(`  ${JSON.stringify(f.path)}  +${f.added} -${f.deleted}${f.binary ? ' [binary]' : ''}${f.excluded ? ' [excluded]' : ''}`);
  for (const w of r.warnings) out.push(`[${w.severity}] ${w.message}`);
  for (const f of r.findings) out.push(`[${f.severity}] ${JSON.stringify(f.path)}:${f.line ?? '-'} ${f.message}`);
  out.push(`可运行脚本：${r.availableChecks.join(', ') || '无'}`);
  if (r.projectChecks) { for (const c of r.projectChecks.checks) out.push(`${c.command}: ${c.status} (exit ${c.exitCode ?? '-'}, ${c.durationMs} ms)`); out.push(r.projectChecks.note); }
  out.push(...r.notes); return out.join('\n');
}
try {
  // 严格解析参数，未知选项和位置参数直接报错。
  const { values: v } = parseArgs({ options: { path: { type: 'string', default: process.cwd() }, scope: { type: 'string', default: 'staged' }, json: { type: 'boolean' }, checks: { type: 'string' }, 'timeout-ms': { type: 'string' }, strict: { type: 'boolean' }, help: { type: 'boolean' } }, strict: true, allowPositionals: false });
  if (v.help) console.log(help);
  else {
    if (v['timeout-ms'] !== undefined && (!/^\d+$/.test(v['timeout-ms']) || !v.checks)) throw new Error('--timeout-ms requires --checks and an integer');
    const r = await preflight({ path: v.path, scope: v.scope });
    if (v.checks !== undefined) { r.projectChecks = await runProjectChecks({ path: v.path, checks: v.checks.split(',').map(s => s.trim()), ...(v['timeout-ms'] ? { timeoutMs: Number(v['timeout-ms']) } : {}) }); if (r.projectChecks.status === 'fail') r.status = 'fail'; }
    console.log(v.json ? JSON.stringify(r, null, 2) : render(r));
    // 普通模式只在检查失败时返回 1；严格模式也将警告和空暂存区视为未通过。
    process.exitCode = r.status === 'fail' || (v.strict && ['warn', 'empty'].includes(r.status)) ? 1 : 0;
  }
} catch (e) { console.error(`preflight: ${e.message}`); process.exitCode = 2; }
