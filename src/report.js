// 可视化报告生成：自包含单文件 HTML（内联 CSS + SVG，无外部依赖，可离线打开）
import { humanAge } from './util.js';

const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const GRADE_COLOR = { A: '#059669', B: '#2563eb', C: '#d97706', D: '#dc2626' };
const SEVERITY_CHIP = {
  error: 'background:#dc2626;color:#fff;',
  warn: 'background:#d97706;color:#fff;',
  info: 'background:#64748b;color:#fff;',
};

function gradeBadge(grade, score) {
  return `<span style="display:inline-block;min-width:46px;text-align:center;padding:4px 10px;border-radius:8px;background:${GRADE_COLOR[grade] || '#64748b'};color:#fff;font-weight:700;font-size:18px;">${esc(grade)}</span>
  <div style="font-size:12px;color:#64748b;margin-top:4px;">综合分 ${esc(score)} / 100</div>`;
}

function scoreBars(skills) {
  const rows = skills
    .map((s) => {
      const color = GRADE_COLOR[s.grade] || '#64748b';
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <div style="width:180px;font-size:12px;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(s.dir)}">${esc(s.name)}</div>
        <div style="flex:1;background:#f1f5f9;border-radius:6px;height:16px;position:relative;">
          <div style="width:${Math.max(2, s.score)}%;height:16px;border-radius:6px;background:${color};"></div>
        </div>
        <div style="width:64px;text-align:right;font-size:12px;color:#334155;font-variant-numeric:tabular-nums;">${s.score} ${esc(s.grade)}</div>
      </div>`;
    })
    .join('');
  return `<h3 style="font-size:14px;margin:22px 0 10px;color:#0f172a;">技能健康分（按体检问题扣分）</h3>${rows}`;
}

function taxBars(skills) {
  const max = Math.max(1, ...skills.map((s) => s.listingTax + s.triggerTax));
  const rows = skills
    .map((s) => {
      const total = s.listingTax + s.triggerTax;
      const lw = s.listingTax > 0 ? Math.max(1, Math.round((s.listingTax / max) * 100)) : 0;
      const tw = s.triggerTax > 0 ? Math.max(1, Math.round((s.triggerTax / max) * 100)) : 0;
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <div style="width:180px;font-size:12px;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(s.dir)}">${esc(s.name)}</div>
        <div style="flex:1;background:#f1f5f9;border-radius:6px;height:16px;display:flex;overflow:hidden;">
          <div style="width:${lw}%;background:#0e7490;" title="常驻税 ${s.listingTax} tokens/轮"></div>
          <div style="width:${tw}%;background:#f59e0b;" title="触发税 ${s.triggerTax} tokens/次"></div>
        </div>
        <div style="width:150px;text-align:right;font-size:12px;color:#334155;font-variant-numeric:tabular-nums;">常驻 ${s.listingTax} + 触发 ${s.triggerTax}</div>
      </div>`;
    })
    .join('');
  return `<h3 style="font-size:14px;margin:22px 0 10px;color:#0f172a;">每轮/每次调用的上下文开销（估算 tokens）</h3>
    <div style="display:flex;gap:16px;font-size:12px;color:#475569;margin-bottom:8px;">
      <span><span style="display:inline-block;width:10px;height:10px;background:#0e7490;border-radius:2px;margin-right:4px;"></span>常驻税：名称+描述，每轮都加载</span>
      <span><span style="display:inline-block;width:10px;height:10px;background:#f59e0b;border-radius:2px;margin-right:4px;"></span>触发税：SKILL.md 正文，被调用时加载</span>
    </div>${rows}`;
}

function issuesTable(issues) {
  if (!issues.length) return `<p style="font-size:13px;color:#059669;">未发现问题。</p>`;
  const rows = issues
    .map(
      (i) => `<tr>
        <td><span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;${SEVERITY_CHIP[i.severity]}">${esc(i.severity)}</span></td>
        <td style="font-family:Consolas,monospace;font-size:11px;color:#64748b;white-space:nowrap;">${esc(i.id)}</td>
        <td style="font-size:12px;color:#334155;white-space:nowrap;">${esc(i.skill)}</td>
        <td style="font-size:12px;color:#1e293b;">${esc(i.message)}${i.detail ? `<div style="font-size:11px;color:#64748b;margin-top:2px;">${esc(i.detail)}</div>` : ''}</td>
      </tr>`,
    )
    .join('');
  return `<h3 style="font-size:14px;margin:22px 0 10px;color:#0f172a;">体检问题清单（${issues.length} 项）</h3>
    <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;min-width:640px;">
      <thead><tr style="text-align:left;border-bottom:2px solid #e2e8f0;">
        <th style="padding:6px 8px;font-size:12px;color:#64748b;">级别</th>
        <th style="padding:6px 8px;font-size:12px;color:#64748b;">ID</th>
        <th style="padding:6px 8px;font-size:12px;color:#64748b;">技能</th>
        <th style="padding:6px 8px;font-size:12px;color:#64748b;">问题</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function pairsTable(pairs) {
  if (!pairs.length) return '';
  const typeLabel = { overlap: '触发重叠', duplicate: '高度重复', 'workflow-conflict': '工作流冲突' };
  const rows = pairs
    .map(
      (p) => `<tr>
        <td style="font-size:12px;color:#334155;">${esc(p.a)} ↔ ${esc(p.b)}</td>
        <td style="font-size:12px;color:#475569;">${esc(typeLabel[p.type] || p.type)}</td>
        <td style="font-size:12px;color:#475569;font-variant-numeric:tabular-nums;">${p.sim}%</td>
      </tr>`,
    )
    .join('');
  return `<h3 style="font-size:14px;margin:22px 0 10px;color:#0f172a;">技能间关系（${pairs.length} 对）</h3>
    <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;min-width:480px;">
      <thead><tr style="text-align:left;border-bottom:2px solid #e2e8f0;">
        <th style="padding:6px 8px;font-size:12px;color:#64748b;">技能对</th>
        <th style="padding:6px 8px;font-size:12px;color:#64748b;">关系</th>
        <th style="padding:6px 8px;font-size:12px;color:#64748b;">相似度</th>
      </tr></thead><tbody>${rows}</tbody></table></div>`;
}

function suggestionsList(suggestions) {
  if (!suggestions.length) return `<h3 style="font-size:14px;margin:22px 0 10px;color:#0f172a;">治理建议</h3><p style="font-size:13px;color:#059669;">当前配置健康，无需治理。</p>`;
  const rows = suggestions
    .map(
      (s) => `<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #f1f5f9;">
        <span style="flex:0 0 64px;font-size:12px;font-weight:700;color:#0e7490;text-transform:uppercase;">${esc(s.action)}</span>
        <div style="font-size:12px;color:#1e293b;"><strong>${esc(s.skill)}</strong> — ${esc(s.reason)}<div style="font-size:11px;color:#64748b;">${esc(s.detail)}</div></div>
      </div>`,
    )
    .join('');
  return `<h3 style="font-size:14px;margin:22px 0 10px;color:#0f172a;">治理建议（${suggestions.length} 条）</h3>${rows}`;
}

/**
 * 生成自包含 HTML 报告
 * @param {object} analysis runAnalysis 输出
 * @param {{title?:string, scope?:string, version?:string}} opts
 */
export function buildReport(analysis, opts = {}) {
  const t = analysis.totals;
  const scope = opts.scope || '当前扫描范围';
  const title = opts.title || 'SkillOps 体检报告';

  const cards = [
    { label: '扫描技能', value: t.skillCount },
    { label: '常驻税合计', value: `${t.listingTax} tok/轮` },
    { label: '触发税合计', value: `${t.triggerTax} tok/次` },
    { label: '问题 error / warn / info', value: `${t.bySeverity.error} / ${t.bySeverity.warn} / ${t.bySeverity.info}` },
  ]
    .map(
      (c) => `<div style="flex:1;min-width:150px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;">
        <div style="font-size:12px;color:#64748b;">${esc(c.label)}</div>
        <div style="font-size:20px;font-weight:700;color:#0f172a;margin-top:4px;font-variant-numeric:tabular-nums;">${esc(c.value)}</div>
      </div>`,
    )
    .join('');

  const ageNote = analysis.skills
    .filter((s) => s.ageDays != null)
    .map((s) => `${esc(s.name)} ${s.ageDays} 天`)
    .join('、');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
</head>
<body style="margin:0;font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif;background:#f1f5f9;color:#0f172a;">
<div style="max-width:960px;margin:0 auto;padding:20px 16px 48px;">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">
    <div>
      <h1 style="font-size:22px;margin:0 0 4px;">${esc(title)}</h1>
      <div style="font-size:12px;color:#64748b;">生成时间 ${esc(new Date(analysis.generatedAt).toLocaleString('zh-CN'))} · 工具 v${esc(opts.version || '0.1.0')} · 范围：${esc(scope)}</div>
    </div>
    ${gradeBadge(analysis.grade, analysis.score)}
  </div>

  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:18px;">${cards}</div>

  ${scoreBars(analysis.skills)}
  ${taxBars(analysis.skills)}
  ${pairsTable(analysis.pairs)}
  ${issuesTable(analysis.issues)}
  ${suggestionsList(analysis.suggestions)}

  <div style="margin-top:28px;padding:12px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;font-size:12px;color:#78350f;line-height:1.7;">
    <strong>口径与限制：</strong>
    token 为估算值（CJK 字符 1 字符 ≈ 1 token，其余 4 字符 ≈ 1 token）；常驻税 = 名称+描述，触发税 = SKILL.md 正文；
    相似度为 bigram Jaccard（描述权重 0.7 + 名称 0.3）；安全扫描为启发式规则，命中不代表恶意，需人工复核；
    阈值：描述 ≤ 1536 字符、SKILL.md ≤ 500 行、过期阈值 180 天。
    评分口径：起始 100 分，error −15 / warn −8 / info −3。
    本报告由 SkillOps 本地生成，无任何数据外传。
  </div>
  <div style="font-size:11px;color:#94a3b8;margin-top:8px;">${ageNote ? `技能最后更新：${ageNote}` : ''}</div>
</div>
</body>
</html>`;
}
