/**
 * /help 处理器：列出可用命令
 * @module bridge/commands/help
 */
import { formatHelp } from '../../commands.js';
import type { CommandHandler } from './types.js';

/** /help 命令处理器 */
export const helpCommand: CommandHandler = {
  def: { name: '/help', usage: '/help', description: '查看可用命令' },
  handle: async (ctx) => {
    await ctx.reply(formatHelp());
    return true;
  },
};