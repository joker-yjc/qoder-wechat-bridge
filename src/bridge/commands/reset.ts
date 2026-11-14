/**
 * /reset 处理器：清空当前会话上下文（断开映射，下条消息开新会话）
 * @module bridge/commands/reset
 */
import type { CommandHandler } from './types.js';

/** /reset 命令处理器 */
export const resetCommand: CommandHandler = {
  def: { name: '/reset', usage: '/reset', description: '清空当前会话上下文' },
  handle: async (ctx) => {
    delete ctx.state.sessions[ctx.userId];
    // 重置后下条消息开新会话，清掉 /new 留下的待用名与 /delete 待确认，避免意外（Minor-5）
    ctx.pendingNames.delete(ctx.userId);
    ctx.pendingDeletes.delete(ctx.userId);
    ctx.persistState();
    await ctx.reply('会话已重置，下一条消息将开启新的 Qoder 会话。');
    return true;
  },
};