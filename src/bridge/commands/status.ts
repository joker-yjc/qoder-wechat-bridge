/**
 * /status 处理器：查看工作目录、模型、会话与待补发
 * @module bridge/commands/status
 */
import type { CommandHandler } from './types.js';
import { activeSession } from '../../config.js';

/** /status 命令处理器 */
export const statusCommand: CommandHandler = {
  def: { name: '/status', usage: '/status', description: '查看工作目录、模型、会话与待补发' },
  handle: async (ctx) => {
    const record = activeSession(ctx.state, ctx.userId, ctx.config.qoderBin);
    const lines = [
      `工作目录：${ctx.workdir()}${ctx.config.cwd.trim() ? '' : '（全局）'}`,
      `后端：${ctx.config.qoderBin}`,
      `模型：${ctx.state.models[ctx.userId] ?? ctx.config.qoderModel ?? 'Auto（默认）'}`,
      `Qoder 会话：${record ? record.sessionId : '（尚未创建）'}`,
      `累计轮次：${record?.turns ?? 0}`,
      `待补发：${ctx.state.outbox.filter((item) => item.toUserId === ctx.userId).length} 条`,
      `隔离区：${ctx.state.quarantine.length} 条`,
      `下行额度：${ctx.state.quota.streak > 0 ? `连续 ${ctx.state.quota.streak} 个窗口耗尽` : '正常'}`,
    ];
    await ctx.reply(lines.join('\n'));
    return true;
  },
};