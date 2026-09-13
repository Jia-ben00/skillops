// 分析器：上下文开销（常驻税 + 触发税）
/**
 * 口径：
 * - 常驻税 listingTax = tokens(名称 + 描述)，每轮对话都会加载（工具列表预算通常为上下文窗口的 ~1%）
 * - 触发税 triggerTax = tokens(SKILL.md 正文)，被调用时才加载（渐进式披露）
 * - 官方建议：描述 ≤ 1536 字符、SKILL.md ≤ 500 行
 */

export function analyzeContext(skill, budgets) {
  const issues = [];
  const add = (id, severity, message, detail) =>
    issues.push({ id, severity, skill: skill.name, skillDir: skill.dir, message, detail });

  const descChars = skill.description.length;
  if (!skill.hasDescription) {
    add('QUALITY_NO_DESCRIPTION', 'warn', '缺少 description，模型无法判断何时触发', `描述字符数: 0`);
  } else if (descChars > budgets.descChars) {
    add(
      'CONTEXT_DESC_OVER',
      'warn',
      `描述超长（${descChars} 字符 > 上限 ${budgets.descChars}），每轮对话都在烧 token`,
      `估算常驻税 ${skill.listingTax} tokens/轮`,
    );
  }
  if (skill.lines > budgets.skillLines) {
    add(
      'CONTEXT_LINES_OVER',
      'warn',
      `SKILL.md 共 ${skill.lines} 行（> 上限 ${budgets.skillLines}），触发时全量加载成本高`,
      `估算触发税 ${skill.triggerTax} tokens/次`,
    );
  }
  if (skill.listingTax > budgets.listingTax && skill.listingTax > 0) {
    add(
      'CONTEXT_LISTING_TAX',
      'info',
      `常驻税偏高（估算 ${skill.listingTax} tokens/轮 > 预算 ${budgets.listingTax}）`,
      '建议精简名称与描述',
    );
  }
  if (skill.triggerTax > budgets.triggerTax) {
    add(
      'CONTEXT_TRIGGER_TAX',
      'warn',
      `触发税偏高（估算 ${skill.triggerTax} tokens/次 > 预算 ${budgets.triggerTax}）`,
      '建议把模板/脚本拆到 supporting files，按需读取',
    );
  }
  if (skill.sizeBytes > 50 * 1024) {
    add('CONTEXT_HEAVY', 'info', `技能目录偏重（SKILL.md ${(skill.sizeBytes / 1024).toFixed(0)} KB）`, '检查是否有大文件混入');
  }
  if (skill.inlineScriptTokens > 3000) {
    add(
      'CONTEXT_INLINE_SCRIPT',
      'warn',
      `SKILL.md 内联脚本过多（估算 ${skill.inlineScriptTokens} tokens）`,
      '内联脚本每次触发都会加载，建议外置为脚本文件',
    );
  }
  return issues;
}
