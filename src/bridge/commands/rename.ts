/**
 * /rename 处理器：给当前活动会话改名（R1 受支持路径 -r -n -p）
 * @module bridge/commands/rename
 */
import { SessionError, sessionNameError } from '../sessions.js';
import type { CommandHandler } from './types.js';
import { activeSession } from '../../config.js';

/** /rename 命令处理器（变更类，要求空闲） */
export const renameCommand: CommandHandler = {
  def: { name: '/rename', usage: '/rename <名称>', description: '重命名当前会话' },
  acceptsArgs: true,
  requiresIdle: true,
  handle: async (ctx, text) => {
    const name = text.trim().slice('/rename'.length).trim();
    const current = activeSession(ctx.state, ctx.userId, ctx.config.qoderBin);
    if (!current) {
      await ctx.reply('当前没有会话，先发消息创建后再 /rename。');
      return true;
    }
    if (!name) {
      await ctx.reply('用法：/rename <名称>');
      return true;
    }
    const nameError = sessionNameError(name);
    if (nameError) {
      await ctx.reply(`${nameError}，请调整后重试。`);
      return true;
    }
    try {
      const result = await ctx.deps.renameSession({
        bin: ctx.config.qoderBin,
        cwd: ctx.workdir(),
        sessionId: current.sessionId,
        name,
        timeoutMs: ctx.config.qoderTimeoutMs,
        permissionMode: ctx.config.permissionMode,
      });
      if (result.ok) await ctx.reply(`已把当前会话重命名为「${name}」。`);
      else await ctx.reply(`重命名失败：${result.error}`);
    } catch (err) {
      const reason = err instanceof SessionError ? err.message : '请稍后重试';
      ctx.log.warn('会话重命名失败', { userId: ctx.userId, sessionId: current.sessionId, reason });
      await ctx.reply(`重命名失败：${reason}`);
    }
    return true;
  },
};