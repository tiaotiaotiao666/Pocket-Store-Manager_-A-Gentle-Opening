export function buildHandoff({ from, to, summary = [], payload = null }) {
  const lines = [
    `# 会话交接 · ${to}`,
    '',
    `来自「${from}」的产出已经确认，交接给「${to}」。新会话开始前请先阅读本交接。`,
    '',
    '## 已确认内容',
    ...(summary.length ? summary.map((item) => `- ${item}`) : ['- （无额外摘要）']),
  ];
  if (payload) {
    lines.push('', '## 关键数据', '```json', JSON.stringify(payload, null, 2), '```');
  }
  lines.push('', '> 状态说明：新会话是在上一阶段确认后开启的，请沿用以上结论继续，不要重复询问已确认的信息。');
  return lines.join('\n');
}