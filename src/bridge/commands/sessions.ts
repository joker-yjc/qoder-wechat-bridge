/**
 * /sessions 处理器：列当前工作目录会话（只读，刷新序号缓存）
 * @module bridge/commands/sessions
 */
import { SessionError, formatSessionList } from '../sessions.js';
import type { CommandHandler } from './types.js';

/** /sessions 命令处理器（只读，不要求空闲） */
export const sessionsCommand: CommandHandler = {
  def: { name: '/sessions', usage: '/sessions', description: '列出当前工作目录的会话' },
  requiresIdle: false,
  handle: async (ctx) => {
    try {
      const catalog = ctx.deps.listSessions(ctx.config.qoderBin, ctx.workdir());
      ctx.catalogs.set(ctx.userId, catalog);
      const activeId = ctx.state.sessions[ctx.userId]?.sessionId;
      await ctx.reply(formatSessionList(catalog, activeId, ctx.config.sessionListLimit));
    } catch (err) {
      const reason = err instanceof SessionError ? err.message : '列出会话失败';
      ctx.log.warn('会话清单获取失败', { userId: ctx.userId, reason });
      await ctx.reply(`无法列出会话：${reason}`);
    }
    return true;
  },
};