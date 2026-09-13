// 分析器：触发重叠、工作流冲突、重复、过期、来源可信度
import { mtimeMs, humanAge, isGitRepo, runGit } from '../util.js';

const READONLY_RE = [
  /\b(?:readonly|read-only|read\s+only|analy[sz]e|inspect|review)\b/i,
  /(?:只读|仅读|禁止修改|不要修改|禁止写入|只检查)/,
  /\b(?:never|do not|禁止|不要)\s*(?:modify|write|edit|修改|写入|编辑)/i,
];
const MODIFY_RE = [
  /\b(?:modify|write|edit|create|apply|patch|update|rewrite|generate|fix)\b/i,
  /(?:修改|写入|编辑|重构|生成|修复|创建)/,
];

function hasAny(reList, text) {
  return reList.some((re) => re.test(text));
}

/** 判断技能正文的写入倾向：readonly / modify / both / none（先剔除“禁止修改”类否定表达） */
function classifyDirective(body) {
  const stripped = String(body || '').replace(
    /(?:禁止|不要|不能|不会|不|never|do not|won'?t)\s*(?:修改|写入|编辑|modify|write|edit)/gi,
    '',
  );
  const readonly = hasAny(READONLY_RE, body);
  const modify = hasAny(MODIFY_RE, stripped);
  if (readonly && modify) return 'both';
  if (readonly) return 'readonly';
  if (modify) return 'modify';
  return 'none';
}

/** 中文分词近似：按标点/空白切分，保留 ≥2 字词条；英文按词切分 */
export function tokenize(text) {
  const parts = String(text || '').split(/[，。；：、（）()\s,;:!?！？·\-_/\\|]+/);
  const out = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    if (/[\u4e00-\u9fff]/.test(t)) {
      if (t.length >= 2) out.push(t);
    } else {
      for (const w of t.split(/(?=[A-Z])|(?<=[a-z])(?=[A-Z])/)) {
        const low = w.toLowerCase();
        if (low.length >= 3) out.push(low);
      }
    }
  }
  return out;
}

/** 泛化停用 bigram：只过滤功能词，保留领域名词（如“数据库/迁移”） */
const STOP_BIGRAMS = new Set([
  '处理', '使用', '支持', '项目', '进行', '需要', '提供', '帮助', '用于', '以及', '可以', '能够',
  '相关', '一个', '对于', '关于', '根据', '用户', '要求', '工作', '任务', '场景', '情况', '时候',
  '同时', '实现', '包括', '通过', '基于', '针对', '生成', '检查', '分析', '自动', '快速', '简单',
  '复杂', '不同', '各种', '以上', '以下', '操作', '执行', '内容', '信息', '代码', '目录', '结构',
  '配置', '环境', '系统', '服务', '应用', '功能', '能力', '以及', '并且', '或者', '如果', '那么',
  '当用户', '用户要', '我们来',
]);

/** 抽取描述的中文连续 2-gram（过滤停用词） */
function descBigrams(text) {
  const out = new Set();
  const runs = String(text || '').match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of runs) {
    for (let i = 0; i < run.length - 1; i += 1) {
      const g = run.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(g)) out.add(g);
    }
  }
  return out;
}

function describeOverlap(aDesc, bDesc) {
  const A = descBigrams(aDesc);
  const B = descBigrams(bDesc);
  if (!A.size || !B.size) return { shared: 0, jaccard: 0, containment: 0 };
  let shared = 0;
  for (const g of A) if (B.has(g)) shared += 1;
  const union = A.size + B.size - shared;
  return { shared, jaccard: shared / union, containment: shared / Math.min(A.size, B.size) };
}

export function analyzeConflicts(skills, config) {
  const issues = [];
  const pairs = [];
  const add = (id, severity, message, detail, skill) =>
    issues.push({ id, severity, skill: skill?.name || '', skillDir: skill?.dir || '', message, detail });

  const n = skills.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = skills[i];
      const b = skills[j];
      const o = describeOverlap(a.description, b.description);
      if (o.shared < 4) continue;
      const sim = Math.round(Math.max(o.jaccard, o.containment) * 100);
      const pair = { a: a.name, b: b.name, sim };
      if (o.containment >= 0.8 || o.jaccard >= 0.7) {
        pairs.push({ ...pair, type: 'duplicate' });
        add('DUPLICATE', 'warn', `「${a.name}」与「${b.name}」高度重复（共享 ${o.shared} 个语义片段）`, `描述重叠度 ${sim}%，建议二选一或合并`, a);
      } else if (o.containment >= 0.25 || o.jaccard >= 0.2) {
        pairs.push({ ...pair, type: 'overlap' });
        add('TRIGGER_OVERLAP', 'warn', `「${a.name}」与「${b.name}」触发描述重叠（共享 ${o.shared} 个关键词）`, '同一请求可能同时命中多个技能', a);
        const aDir = classifyDirective(a.body);
        const bDir = classifyDirective(b.body);
        if ((aDir === 'readonly' && bDir === 'modify') || (aDir === 'modify' && bDir === 'readonly')) {
          pairs.push({ ...pair, type: 'workflow-conflict' });
          add('WORKFLOW_CONFLICT', 'error', `「${a.name}」与「${b.name}」工作流指令冲突（一个偏只读分析、一个偏写入修改）`, '组合使用时执行规则互相矛盾', a);
        }
      }
    }
    // 单技能内部指令混合（提示）
    const s = skills[i];
    const must = (s.body.match(/必须|always|must/g) || []).length;
    const forbid = (s.body.match(/禁止|never|must not|do not/g) || []).length;
    if (must >= 2 && forbid >= 2) {
      add('INTERNAL_DIRECTIVE_MIX', 'info', `「${s.name}」同时包含多组“必须/禁止”指令，触发时可能互相打架`, `必须 ${must} 处 / 禁止 ${forbid} 处`, s);
    }
  }

  // 过期与来源
  const now = Date.now();
  for (const s of skills) {
    let ageMs = null;
    let via = 'mtime';
    if (isGitRepo(s.dir)) {
      const ts = runGit(s.dir, ['log', '-1', '--format=%ct']);
      if (ts && /^\d+$/.test(ts)) {
        ageMs = now - Number(ts) * 1000;
        via = 'git';
      }
    }
    if (ageMs == null) {
      const m = mtimeMs(s.dir);
      ageMs = m == null ? null : now - m;
    }
    const days = ageMs == null ? null : Math.floor(ageMs / 86400000);
    s.ageDays = days;
    if (days != null && days > config.staleDays) {
      add(
        'STALE',
        'warn',
        `「${s.name}」已 ${humanAge(ageMs)} 未更新（> ${config.staleDays} 天，来源 ${via}）`,
        '规则可能已过时，建议检查更新',
        s,
      );
    }
    const hasManifest = s.files.some((f) => /(^|\\)(package\.json|pyproject\.toml|requirements\.txt)$/i.test(f.rel));
    if (!s.hasLicense && !s.hasVersion && !isGitRepo(s.dir) && !hasManifest) {
      add('UNKNOWN_SOURCE', 'info', `「${s.name}」无 license / 版本 / 仓库信息，来源可信度低`, '手工复制的技能难以追踪更新', s);
    }
  }
  return { issues, pairs };
}
