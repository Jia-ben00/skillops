// Eval 可视化报告：自包含单文件 HTML（内联 CSS + SVG，无外部依赖，可离线打开）
//
// 视觉风格与 src/report.js 保持一致，便于将来把 eval 维度融合进主报告。
import { VERDICT_LABEL, verdictExplanation } from './runner.js';
import { VERSION } from '../../version.js';

const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const VERDICT_COLOR = { useful: '#059669', decorative: '#d97706', harmful: '#dc2626' };

/** 核心图：A 组 vs B 组通过率并排条形图 */
function abBars(skills) {
  const rows = skills
    .map((s) => {
      const color = VERDICT_COLOR[s.verdict] || '#64748b';
      const a = Math.round(s.treatment.rate * 100);
      const b = Math.round(s.control.rate * 100);
      return `<div style="margin-bottom:14px;">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px;">
          <span style="font-size:13px;font-weight:600;color:#1e293b;">${esc(s.skill)}</span>
          <span style="font-size:12px;font-weight:700;color:${color};">${s.lift > 0 ? '+' : ''}${s.lift}pp ${esc(VERDICT_LABEL[s.verdict] || s.verdict)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
          <span style="width:96px;font-size:11px;color:#475569;text-align:right;">注入技能</span>
          <div style="flex:1;background:#f1f5f9;border-radius:4px;height:14px;position:relative;">
            <div style="width:${a}%;height:14px;border-radius:4px;background:${color};"></div>
          </div>
          <span style="width:76px;font-size:11px;color:#334155;font-variant-numeric:tabular-nums;">${s.treatment.passed}/${s.treatment.total} · ${a}%</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="width:96px;font-size:11px;color:#475569;text-align:right;">不注入（裸跑）</span>
          <div style="flex:1;background:#f1f5f9;border-radius:4px;height:14px;position:relative;">
            <div style="width:${b}%;height:14px;border-radius:4px;background:#94a3b8;"></div>
          </div>
          <span style="width:76px;font-size:11px;color:#334155;font-variant-numeric:tabular-nums;">${s.control.passed}/${s.control.total} · ${b}%</span>
        </div>
      </div>`;
    })
    .join('');
  return `<h3 style="font-size:14px;margin:22px 0 12px;color:#0f172a;">A/B 对照结果（唯一自变量：是否注入 SKILL.md）</h3>${rows}`;
}

/** lift 排行：以 0 为基准的双向条形图 */
function liftChart(skills) {
  const maxAbs = Math.max(1, ...skills.map((s) => Math.abs(s.lift)));
  const rows = skills
    .map((s) => {
      const pct = (Math.abs(s.lift) / maxAbs) * 50; // 单侧最多占一半宽度
      const color = VERDICT_COLOR[s.verdict] || '#64748b';
      const bar =
        s.lift >= 0
          ? `<div style="position:absolute;left:50%;width:${Math.max(1, pct)}%;height:16px;background:${color};border-radius:0 4px 4px 0;"></div>`
          : `<div style="position:absolute;right:50%;width:${Math.max(1, pct)}%;height:16px;background:${color};border-radius:4px 0 0 4px;"></div>`;
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <div style="width:170px;font-size:12px;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(s.dir)}">${esc(s.skill)}</div>
        <div style="flex:1;position:relative;height:16px;background:#f8fafc;border-radius:4px;">
          <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:#cbd5e1;"></div>
          ${bar}
        </div>
        <div style="width:72px;text-align:right;font-size:12px;color:#334155;font-variant-numeric:tabular-nums;">${s.lift > 0 ? '+' : ''}${s.lift}pp</div>
      </div>`;
    })
    .join('');
  return `<h3 style="font-size:14px;margin:22px 0 10px;color:#0f172a;">技能 lift 排行（相对 0 基准）</h3>
    <div style="font-size:11px;color:#64748b;margin-bottom:8px;">中轴线为 0pp：向右为提升、向左为拖后腿。色标同判定（绿=有效 / 橙=装饰品 / 红=有害）。</div>${rows}`;
}

/** 逐任务明细矩阵 */
function taskMatrix(skills) {
  const taskIds = skills.length ? skills[0].tasks.map((t) => ({ id: t.taskId, title: t.title })) : [];
  const head = taskIds.map((t) => `<th style="padding:6px 8px;font-size:11px;color:#64748b;text-align:center;" title="${esc(t.id)}">${esc(t.title)}</th>`).join('');
  const rows = skills
    .map((s) => {
      const color = VERDICT_COLOR[s.verdict] || '#64748b';
      const cells = s.tasks
        .map((t) => {
          const a = Math.round(t.treatment.rate * 100);
          const b = Math.round(t.control.rate * 100);
          const bg = t.lift > 0 ? '#d1fae5' : t.lift < 0 ? '#fee2e2' : '#f1f5f9';
          const fg = t.lift > 0 ? '#065f46' : t.lift < 0 ? '#991b1b' : '#475569';
          return `<td style="padding:6px 8px;text-align:center;background:${bg};color:${fg};font-size:11px;font-variant-numeric:tabular-nums;" title="${esc(t.title)}｜A ${t.treatment.passed}/${t.treatment.total} vs B ${t.control.passed}/${t.control.total}${t.reasons.length ? '｜' + esc(t.reasons[0]) : ''}">
            ${a}% <span style="color:#94a3b8;">/</span> ${b}%
          </td>`;
        })
        .join('');
      return `<tr style="border-bottom:1px solid #f1f5f9;">
        <td style="padding:6px 8px;font-size:12px;font-weight:600;color:${color};white-space:nowrap;">${esc(s.skill)}</td>
        ${cells}
      </tr>`;
    })
    .join('');
  return `<h3 style="font-size:14px;margin:22px 0 10px;color:#0f172a;">逐任务明细（单元格：注入后通过率 / 裸跑通过率）</h3>
    <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;min-width:640px;">
      <thead><tr style="text-align:left;border-bottom:2px solid #e2e8f0;">
        <th style="padding:6px 8px;font-size:12px;color:#64748b;">技能</th>${head}
      </tr></thead><tbody>${rows}</tbody>
    </table></div>`;
}

/** 需要处理的技能清单 */
function actionList(result) {
  const targets = result.skills.filter((s) => s.verdict !== 'useful');
  if (!targets.length) {
    return `<h3 style="font-size:14px;margin:22px 0 10px;color:#0f172a;">需要处理的技能</h3>
      <p style="font-size:13px;color:#059669;">全部技能都产生了可测量的正向提升，无需处理。</p>`;
  }
  const rows = targets
    .map((s) => {
      const color = VERDICT_COLOR[s.verdict] || '#64748b';
      const worst = s.tasks.filter((t) => t.lift < 0).slice(0, 3);
      const detail = worst
        .map(
          (t) => `<li style="font-size:11px;color:#64748b;">「${esc(t.title)}」A ${t.treatment.passed}/${t.treatment.total} vs B ${t.control.passed}/${t.control.total}（${t.lift}pp）</li>`,
        )
        .join('');
      return `<div style="padding:10px 0;border-bottom:1px solid #f1f5f9;">
        <div style="font-size:13px;color:#1e293b;">
          <span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;background:${color};color:#fff;font-weight:600;">${esc(VERDICT_LABEL[s.verdict] || s.verdict)}</span>
          <strong style="margin-left:6px;">${esc(s.skill)}</strong>
          <span style="font-size:12px;color:#64748b;">— ${esc(verdictExplanation(s.lift, result.config.threshold))}</span>
        </div>
        ${detail ? `<ul style="margin:6px 0 0 18px;padding:0;">${detail}</ul>` : ''}
      </div>`;
    })
    .join('');
  return `<h3 style="font-size:14px;margin:22px 0 10px;color:#0f172a;">需要处理的技能（${targets.length} 个）</h3>${rows}`;
}

/**
 * 生成 eval 自包含 HTML 报告
 * @param {object} result runEval 输出
 * @param {{title?:string, scope?:string, version?:string}} opts
 */
export function buildEvalReport(result, opts = {}) {
  const t = result.totals;
  const title = opts.title || 'SkillOps 技能效能对照实验报告';
  const useful = t.skillCount - t.decorativeCount - t.harmfulCount;

  const cards = [
    { label: '被测技能', value: t.skillCount, color: '#0f172a' },
    { label: '有效（lift ≥ 阈值）', value: useful, color: '#059669' },
    { label: '装饰品（无显著提升）', value: t.decorativeCount, color: '#d97706' },
    { label: '有害（拖后腿）', value: t.harmfulCount, color: '#dc2626' },
    { label: '平均 lift', value: `${t.avgLift > 0 ? '+' : ''}${t.avgLift}pp`, color: '#0e7490' },
  ]
    .map(
      (c) => `<div style="flex:1;min-width:130px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;">
        <div style="font-size:12px;color:#64748b;">${esc(c.label)}</div>
        <div style="font-size:20px;font-weight:700;color:${c.color};margin-top:4px;font-variant-numeric:tabular-nums;">${esc(c.value)}</div>
      </div>`,
    )
    .join('');

  const backendNote =
    result.backend === 'mock'
      ? '本次使用 <strong>mock 确定性后端</strong>：它不调用任何模型，用于验证实验框架本身的正确性。真实提升幅度需用 <code style="background:#f1f5f9;padding:1px 4px;border-radius:3px;">--agent "&lt;你的 Agent CLI&gt;"</code> 复测。'
      : `本次使用真实 Agent CLI 后端：<code style="background:#f1f5f9;padding:1px 4px;border-radius:3px;">${esc(result.backend)}</code>。`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
</head>
<body style="margin:0;font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif;background:#f1f5f9;color:#0f172a;">
<div style="max-width:1020px;margin:0 auto;padding:20px 16px 48px;">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">
    <div>
      <h1 style="font-size:22px;margin:0 0 4px;">${esc(title)}</h1>
      <div style="font-size:12px;color:#64748b;">
        生成时间 ${esc(new Date(result.generatedAt).toLocaleString('zh-CN'))} · 工具 v${esc(opts.version || VERSION)} · 范围：${esc(opts.scope || '当前扫描范围')}
      </div>
      <div style="font-size:12px;color:#475569;margin-top:6px;">
        任务集 <strong>${esc(result.taskset.name)}</strong>（${result.taskset.taskCount} 个任务） ·
        每条件重复 ${result.config.repeat} 次 · 判定阈值 ${result.config.threshold}pp
      </div>
    </div>
  </div>

  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:18px;">${cards}</div>

  ${abBars(result.skills)}
  ${liftChart(result.skills)}
  ${actionList(result)}
  ${taskMatrix(result.skills)}

  <div style="margin-top:28px;padding:12px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;font-size:12px;color:#78350f;line-height:1.8;">
    <strong>实验口径与限制：</strong><br>
    1. <strong>对照组设计</strong>：A 组把 SKILL.md 完整注入模型上下文，B 组不注入任何技能内容。同一任务、同一后端、同一初始工作区、同一随机种子序列，唯一自变量是「是否注入技能」。<br>
    2. <strong>客观判定</strong>：每个任务配一条判定命令，以退出码 + 输出片段断言裁决成败，全程无人工阅读环节，因此结论可复现、可进 CI。<br>
    3. <strong>lift 含义</strong>：A 组通过率 − B 组通过率（百分点）。|lift| 小于阈值判为「装饰品」，负向超过阈值判为「有害」。<br>
    4. <strong>⚠️ lift 是相对量，不是技能的绝对评分</strong>：它衡量的是「该技能在这套任务集上带来的增益」。
       一个业内公认的好技能，如果任务集里没有考它擅长的动作，lift 就会接近 0——这不代表技能无用，只代表<strong>这套任务没考到它</strong>。
       要让结论更有外部效度，应扩充任务集覆盖面，或按技能类型分组评测。<br>
    5. <strong>提高可信度</strong>：单次运行（<code style="background:#f1f5f9;padding:1px 4px;border-radius:3px;">--repeat 1</code>）噪声很大，
       建议 <code style="background:#f1f5f9;padding:1px 4px;border-radius:3px;">--repeat 5</code> 以上；真实模型还有采样随机性，需更多重复才能稳定结论。<br>
    6. ${backendNote}
  </div>
</div>
</body>
</html>`;
}
