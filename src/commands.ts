/**
 * 微信内置命令注册表：/help 的单一事实来源 + 统一分发入口
 * 新增命令：在 bridge/commands/ 加一个处理器模块并登记到 COMMAND_HANDLERS，不改分发主干
 * @module commands
 */
import type { CommandContext, CommandDef, CommandHandler } from './bridge/commands/types.js';
import { helpCommand } from './bridge/commands/help.js';
import { resetCommand } from './bridge/commands/reset.js';
import { statusCommand } from './bridge/commands/status.js';
import { modelCommand } from './bridge/commands/model.js';
import { sessionsCommand } from './bridge/commands/sessions.js';
import { switchCommand } from './bridge/commands/switch.js';
import { newCommand } from './bridge/commands/new.js';
import { renameCommand } from './bridge/commands/rename.js';
import { deleteCommand } from './bridge/commands/delete.js';

export type { CommandContext, CommandDef, CommandHandler } from './bridge/commands/types.js';

/** 全部命令处理器（登记顺序即 /help 展示顺序） */
export const COMMAND_HANDLERS: CommandHandler[] = [
  helpCommand,
  statusCommand,
  modelCommand,
  resetCommand,
  sessionsCommand,
  switchCommand,
  newCommand,
  renameCommand,
  deleteCommand,
];

/** /stop 由 intake 快速路径处理（绕过队列），不入注册表分发，但元数据需进 /help 与 isUnknownCommand */
const STOP_DEF: CommandDef = {
  name: '/stop',
  usage: '/stop',
  description: '强制停止当前正在执行的任务（/cancel 同义）',
};

/** 全部内置命令元数据，由处理器派生 + intake-only 的 /stop */
export const COMMANDS: readonly CommandDef[] = [...COMMAND_HANDLERS.map((handler) => handler.def), STOP_DEF];

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

/**
 * 按命令名前缀查找处理器
 * @param text - 原始命令文本
 * @returns 命中的处理器；未命中返回 undefined
 */
export function findHandler(text: string): CommandHandler | undefined {
  const value = text.trim();
  return COMMAND_HANDLERS.find((handler) =>
    handler.acceptsArgs
      ? value === handler.def.name || value.startsWith(`${handler.def.name} `)
      : value === handler.def.name,
  );
}

/**
 * 统一分发：命中处理器则执行
 * @param ctx - 运行上下文
 * @param text - 原始命令文本
 * @returns true=已处理，false=未命中（交回 isUnknownCommand / Qoder）
 */
export async function dispatchCommand(ctx: CommandContext, text: string): Promise<boolean> {
  const handler = findHandler(text);
  if (!handler) return false;
  return handler.handle(ctx, text);
}