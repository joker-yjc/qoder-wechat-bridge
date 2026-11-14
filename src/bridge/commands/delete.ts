/**
 * /delete 处理器：两步确认删除会话（破坏性操作）
 * 第一步 /delete <目标> 记待确认；第二步 /delete yes <序号> 才真删
 * @module bridge/commands/delete
 */
import { SESSION_DELETE_TIMEOUT_MS, SessionError, resolveSession } from '../sessions.js';
import type { CommandHandler } from './types.js';

/** 待确认删除的有效期 */
const CONFIRM_TTL_MS = 60_000;

/** /delete 命令处理器（变更类，要求空闲） */
export const deleteCommand: CommandHandler = {
  def: { name: '/delete', usage: '/delete <序号|id|名称>', description: '删除会话（需 /delete yes 确认）' },
  acceptsArgs: true,
  requiresIdle: true,
  handle: async (ctx, text) => {
    const arg = text.trim().slice('/delete'.length).trim();
    const bin = ctx.config.qoderBin;
    const cwd = ctx.workdir();

    // 第二步：/delete yes <序号>
    const confirm = /^yes\s+(\d+)$/.exec(arg);
    if (confirm) {
      const pending = ctx.pendingDeletes.get(ctx.userId);
      if (!pending) {
        await ctx.reply('没有待确认的删除。先发 /delete <序号|id|名称>。');
        return true;
      }
      if (Date.now() > pending.expiresAt) {
        ctx.pendingDeletes.delete(ctx.userId);
        await ctx.reply('删除确认已过期，请重新发 /delete。');
        return true;
      }
      if (Number(confirm[1]) !== pending.index) {
        await ctx.reply(`序号不匹配。待确认的是序号 ${pending.index}「${pending.name}」。`);
        return true;
      }
      try {
        // 按 sessionId 重新取当前序号，避免两步之间活跃排序漂移
        const catalog = ctx.deps.listSessions(bin, cwd);
        const entry = catalog.find((e) => e.sessionId === pending.sessionId);
        ctx.pendingDeletes.delete(ctx.userId);
        if (!entry) {
          await ctx.reply('该会话已不存在。');
          return true;
        }
        const result = await ctx.deps.deleteSession({
          bin,
          cwd,
          index: entry.index,
          timeoutMs: SESSION_DELETE_TIMEOUT_MS,
        });
        // 任何结果都失效缓存：CLI 可能已删但报失败/超时（F-3）
        ctx.catalogs.delete(ctx.userId);
        if (!result.ok) {
          await ctx.reply(`删除失败：${result.error}`);
          return true;
        }
        // 后验：重新列会话，按 sessionId 是否消失判定，覆盖含括号名/重名/名截断（F-1 更稳做法）
        const after = ctx.deps.listSessions(bin, cwd);
        if (after.some((e) => e.sessionId === pending.sessionId)) {
          await ctx.reply('删除未生效，请发 /sessions 核对。');
          return true;
        }
        if (ctx.state.sessions[ctx.userId]?.sessionId === pending.sessionId) {
          delete ctx.state.sessions[ctx.userId];
          ctx.pendingNames.delete(ctx.userId);
          ctx.persistState();
        }
        ctx.log.info('删除会话', { userId: ctx.userId, sessionId: pending.sessionId });
        await ctx.reply(`已删除「${pending.name}」。`);
      } catch (err) {
        ctx.catalogs.delete(ctx.userId);
        const reason = err instanceof SessionError ? err.message : '请稍后重试';
        ctx.log.warn('会话删除失败', { userId: ctx.userId, sessionId: pending.sessionId, reason });
        await ctx.reply(`删除失败：${reason}`);
      }
      return true;
    }

    // 第一步：/delete <目标>
    if (!arg) {
      await ctx.reply('用法：/delete <序号|id|名称>，再发 /delete yes <序号> 确认。');
      return true;
    }
    if (arg.toLowerCase() === 'yes') {
      await ctx.reply('请带序号：/delete yes <序号>。');
      return true;
    }
    try {
      const catalog = ctx.deps.listSessions(bin, cwd);
      ctx.catalogs.set(ctx.userId, catalog);
      const resolved = resolveSession(arg, catalog);
      if (!resolved.ok) {
        await ctx.reply(`没找到会话：${arg}（${resolved.reason}）。发 /sessions 查看清单。`);
        return true;
      }
      const entry = resolved.entry;
      ctx.pendingDeletes.set(ctx.userId, {
        sessionId: entry.sessionId,
        name: entry.name,
        index: entry.index,
        expiresAt: Date.now() + CONFIRM_TTL_MS,
      });
      await ctx.reply(
        `将删除「${entry.name}」[${entry.sessionId.slice(0, 8)}…]，不可恢复。\n确认请发 /delete yes ${entry.index}（60 秒内有效）。`,
      );
    } catch (err) {
      const reason = err instanceof SessionError ? err.message : '请稍后重试';
      ctx.log.warn('会话删除解析失败', { userId: ctx.userId, target: arg, reason });
      await ctx.reply(`无法删除会话：${reason}`);
    }
    return true;
  },
};