/**
 * 回传层：文本分片
 * @module bridge/reply
 */

/**
 * 把长文本切成不超过 max 字符的片段
 * 优先按空行、再按换行、最后硬切，尽量不把一句话劈开
 * @param text - 原始文本
 * @param max - 单条最大字符数
 * @returns 片段数组
 */
export function chunkText(text: string, max: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= max) return [trimmed];

  const chunks: string[] = [];
  const paragraphs = trimmed.split(/\n{2,}/);
  let current = '';

  /** 把 current 收尾 */
  const flush = (): void => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  /** 逐段硬切 */
  const hardSplit = (block: string): void => {
    let rest = block;
    while (rest.length > max) {
      chunks.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    if (rest) current = rest;
  };

  for (const p of paragraphs) {
    if (!p) continue;
    if (p.length > max) {
      flush();
      hardSplit(p);
      continue;
    }
    const candidate = current ? `${current}\n\n${p}` : p;
    if (candidate.length > max) {
      flush();
      current = p;
    } else {
      current = candidate;
    }
  }
  flush();

  // 二次保险：按行再拆一次超长块
  return chunks.flatMap((c) => {
    if (c.length <= max) return [c];
    const lines = c.split('\n');
    const out: string[] = [];
    let buf = '';
    for (const line of lines) {
      if (line.length > max) {
        if (buf) out.push(buf);
        buf = '';
        for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
        continue;
      }
      const next = buf ? `${buf}\n${line}` : line;
      if (next.length > max) {
        if (buf) out.push(buf);
        buf = line;
      } else {
        buf = next;
      }
    }
    if (buf) out.push(buf);
    return out;
  });
}
