/**
 * 微信内置命令登记表：/help 的单一事实来源
 * 新增命令时在这里登记，并在 service.ts 的分发处实现
 * @module commands
 */

/** 一条内置命令 */
export interface CommandDef {
  /** 命令名，含斜杠 */
  name: string;
  /** 用法示例 */
  usage: string;
  /** 一句话说明 */
  description: string;
}

/** 全部内置命令 */
export const COMMANDS: readonly CommandDef[] = [
  { name: '/help', usage: '/help', description: '查看可用命令' },
  { name: '/status', usage: '/status', description: '查看工作目录、模型、会话与待补发' },
  {
    name: '/model',
    usage: '/model [序号|名称|default]',
    description: '列出可用模型；带参数则切换，default 恢复 Auto',
  },
  { name: '/reset', usage: '/reset', description: '清空当前会话上下文' },
  { name: '/stop', usage: '/stop', description: '强制停止当前正在执行的任务' },
];

/**
 * 生成 /help 文本
 * @returns 可直接发到微信的文本
 */
export function formatHelp(): string {
  const lines = COMMANDS.map((command) => `${command.usage} — ${command.description}`);
  return ['可用命令：', ...lines, '', '其它内容会直接交给 Qoder 执行。'].join('\n');
}

/**
 * 判断一段文本是否像未知命令
 * 只认纯小写单词形式（/foo），且排除已登记的命令；避免把 /Users/... 这类路径误判
 * @param text - 用户输入
 * @returns 是否是未知命令
 */
export function isUnknownCommand(text: string): boolean {
  const value = text.trim();
  if (!/^\/[a-z][a-z0-9-]{0,23}$/.test(value)) return false;
  return !COMMANDS.some((command) => command.name === value);
}
