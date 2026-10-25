import { defineTool } from '@deepseek-ai/dsh-tools';
import { apply as registerStarterTools } from './index.js';
import { preflight } from './report.js';
export const name = 'commit-preflight';
// 声明必须先有 tools 服务；commands 服务通过下方的可选注入单独注册。
export const inject = ['tools'];

export function apply(ctx) {
  // 复用核心工具定义，将 starter 参数格式转换成当前 DSH 的 defineTool 格式。
  registerStarterTools({ tool: { define(tool) {
    const required = new Set(tool.parameters.required);
    const parameters = Object.fromEntries(Object.entries(tool.parameters.properties).map(([key, spec]) => {
      // 宿主仅支持部分 Schema 关键字；长度和数值范围继续由核心函数校验。
      const { minItems, minimum, maximum, ...supported } = spec;
      return [key, { ...supported, ...(required.has(key) ? { required: true } : {}) }];
    }));
    ctx.tools.register(defineTool({
      name: tool.name,
      description: tool.description,
      parameters,
      timeoutMs: 1800000,
      execute: args => tool.handler(args),
      // 保留结构化结果，同时提供 DSH 展示工具结果时使用的文本渲染器。
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      },
    }));
  } } });
  // commands 服务存在时，注册直接执行的斜杠命令，无需经过模型推理。
  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register({
      name: 'preflight',
      description: 'Check staged commit size and added lines. Does not run project scripts.',
      input: { hint: '可选：项目绝对路径（默认当前项目）' },
      async handler({ rawInput, agent }) {
        // 显式路径优先，否则读取本次命令所属会话的项目，避免会话间串用路径。
        const path = rawInput.trim() || agent?.session?.header?.cwd;
        // 未选项目时给出提示，不回退到 DSH 进程的启动目录。
        if (!path) return { kind: 'error', text: '请先在 DSH 中选择项目，或输入 /preflight /absolute/path/to/repository 指定项目（路径含空格时无需引号）。' };
        try {
          const report = await preflight({ path });
          return { kind: 'success', text: JSON.stringify(report, null, 2) };
        } catch (error) {
          return { kind: 'error', text: error.message };
        }
      },
    });
  });
}
