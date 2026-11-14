/**
 * /switch 处理器：切换活动会话指针（仅改指针，不触碰会话内容）
 * @module bridge/commands/switch
 */
import { SessionError, resolveSession } from '../sessions.js';
import type { CommandHandler } from './types.js';

/** /switch 命令处理器（变更类，要求空闲） */
export const switchCommand: CommandHandler = {
  def: { name: '/switch', usage: '/switch <序号|id|名称>', description: '切换到指定会话' },
  acceptsArgs: true,
  requiresIdle: true,
  handle: async (ctx, text) => {
    const arg = text.trim().slice('/switch'.length).trim();
    const current = ctx.state.sessions[ctx.userId];
    if (!arg) {
      await ctx.reply(
        `用法：/switch <序号|id|名称>\n当前会话：${current ? current.sessionId : '（尚未创建）'}\n发 /sessions 查看清单。`,
      );
      return true;
    }
    try {
      const isIndex = /^\d+$/.test(arg);
      let catalog = ctx.catalogs.get(ctx.userId);
      if (isIndex) {
        if (!catalog) {
          await ctx.reply('请先发 /sessions 获取序号清单。');
          return true;
        }
      } else {
        catalog = ctx.deps.listSessions(ctx.config.qoderBin, ctx.workdir());
        ctx.catalogs.set(ctx.userId, catalog);
      }
      const resolved = resolveSession(arg, catalog);
      if (!resolved.ok) {
        await ctx.reply(`没找到会话：${arg}（${resolved.reason}）。发 /sessions 查看清单。`);
        return true;
      }
      const entry = resolved.entry;
      if (current?.sessionId === entry.sessionId) {
        await ctx.reply('已在该会话。');
        return true;
      }
      ctx.state.sessions[ctx.userId] = {
        sessionId: entry.sessionId,
        updatedAt: Date.now(),
        turns: current?.turns ?? 0,
      };
      ctx.persistState();
      // 切换后不再创建新会话，清掉 /new 留下的待用名，避免意外命名（Minor-5）
      ctx.pendingNames.delete(ctx.userId);
      ctx.log.info('切换会话', { userId: ctx.userId, sessionId: entry.sessionId });
      await ctx.reply(`已切换到「${entry.name}」[${entry.sessionId.slice(0, 8)}…]，下一条消息续接该会话。`);
    } catch (err) {
      const reason = err instanceof SessionError ? err.message : '切换失败';
      ctx.log.warn('会话切换失败', { userId: ctx.userId, target: arg, reason });
      await ctx.reply(`无法切换会话：${reason}`);
    }
    return true;
  },
};