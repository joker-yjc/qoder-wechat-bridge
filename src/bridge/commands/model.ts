/**
 * /model 处理器：列出可用模型；带参数则切换，default 恢复 Auto
 * @module bridge/commands/model
 */
import { formatModelList, resolveModel } from '../../models.js';
import type { CommandHandler } from './types.js';

/** /model 命令处理器 */
export const modelCommand: CommandHandler = {
  def: {
    name: '/model',
    usage: '/model [序号|名称|default]',
    description: '列出可用模型；带参数则切换，default 恢复 Auto',
  },
  acceptsArgs: true,
  handle: async (ctx, text) => {
    const arg = text.trim().slice('/model'.length).trim();
    if (!arg) {
      const catalog = ctx.deps.listModels(ctx.config.qoderBin);
      await ctx.reply(formatModelList(catalog, ctx.state.models[ctx.userId] ?? ctx.config.qoderModel));
      return true;
    }
    if (['default', 'auto', '默认'].includes(arg.toLowerCase())) {
      delete ctx.state.models[ctx.userId];
      ctx.persistState();
      await ctx.reply('已恢复默认模型（Auto）。');
      return true;
    }
    const catalog = ctx.deps.listModels(ctx.config.qoderBin);
    const resolved = resolveModel(arg, catalog);
    if (!resolved.ok) {
      await ctx.reply(`未找到模型：${arg}\n发送 /model 查看可用列表。`);
      return true;
    }
    ctx.state.models[ctx.userId] = resolved.option.id;
    ctx.persistState();
    await ctx.reply(`已切换模型：${resolved.option.label}\n下一条任务起生效。`);
    return true;
  },
};