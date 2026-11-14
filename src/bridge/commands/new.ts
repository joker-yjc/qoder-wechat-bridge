/**
 * /new 处理器：清活动会话指针 + 可选记待用显示名（不立即调 CLI、不耗额度）
 * @module bridge/commands/new
 */
import { sessionNameError } from '../sessions.js';
import type { CommandHandler } from './types.js';

/** /new 命令处理器（变更类，要求空闲） */
export const newCommand: CommandHandler = {
  def: { name: '/new', usage: '/new [名称]', description: '开启新会话（可选命名）' },
  acceptsArgs: true,
  requiresIdle: true,
  handle: async (ctx, text) => {
    const name = text.trim().slice('/new'.length).trim();
    if (name) {
      const nameError = sessionNameError(name);
      if (nameError) {
        await ctx.reply(`${nameError}，请调整后重试。`);
        return true;
      }
    }
    delete ctx.state.sessions[ctx.userId];
    if (name) ctx.pendingNames.set(ctx.userId, name);
    else ctx.pendingNames.delete(ctx.userId);
    ctx.pendingDeletes.delete(ctx.userId);
    ctx.persistState();
    ctx.log.info('新建会话', { userId: ctx.userId, named: Boolean(name) });
    await ctx.reply(
      name ? `已开启新会话「${name}」，下一条消息创建时命名。` : '已开启新会话，下一条消息生效。',
    );
    return true;
  },
};