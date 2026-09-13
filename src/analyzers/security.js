// 分析器：脚本安全启发式扫描（只读、启发式，不构成安全结论）
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT_EXTS = new Set(['sh', 'bash', 'ps1', 'py', 'js', 'mjs', 'cjs', 'bat', 'cmd']);
const FENCE_LANGS = new Set(['sh', 'bash', 'zsh', 'powershell', 'ps1', 'python', 'py', 'javascript', 'js']);

const PATTERNS = [
  { id: 'RISKY_PIPE_SHELL', severity: 'warn', label: '下载并直接执行（curl|wget → shell）', re: /(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*(?:ba)?sh\b/i },
  { id: 'RISKY_RM_RF', severity: 'warn', label: '递归强制删除 rm -rf 类命令', re: /\brm\s+-(?:[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+/i },
  { id: 'RISKY_IE', severity: 'warn', label: 'PowerShell 动态执行（Invoke-Expression / iex）', re: /\b(?:Invoke-Expression|iex)\s+/i },
  { id: 'RISKY_EVAL', severity: 'info', label: 'JavaScript eval 动态执行', re: /\beval\s*\(/ },
  { id: 'RISKY_CHMOD', severity: 'info', label: '宽松权限 chmod（含 7）', re: /\bchmod\s+[0-7]*7[0-7]*\s+/i },
  { id: 'RISKY_EXFIL', severity: 'warn', label: '疑似带数据外传（curl -d / --data 到远程 URL）', re: /(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*(?:-d\s|--data|--data-urlencode|--data-raw)\s*["']?https?:/i },
  { id: 'RISKY_BASE64_EXEC', severity: 'info', label: 'base64 解码后管道执行', re: /(?:base64\s*-d|base64\s+--decode)\b[^\n]*\|/i },
];

function checkContent(content, skill, issues, label) {
  for (const p of PATTERNS) {
    if (p.re.test(content)) {
      issues.push({
        id: p.id,
        severity: p.severity,
        skill: skill.name,
        skillDir: skill.dir,
        message: `${p.label}（${label}）`,
        detail: '启发式规则，命中不代表恶意，请人工复核',
      });
    }
  }
}

export function analyzeSecurity(skill) {
  const issues = [];
  for (const f of skill.files) {
    const ext = path.extname(f.rel).slice(1).toLowerCase();
    if (!SCRIPT_EXTS.has(ext)) continue;
    if (f.size > 200 * 1024) continue;
    let content = '';
    try {
      content = fs.readFileSync(f.path, 'utf8');
    } catch {
      continue;
    }
    checkContent(content, skill, issues, f.rel);
  }
  // 内联代码块
  for (const fence of skill.codeFences || []) {
    if (!FENCE_LANGS.has(fence.lang.toLowerCase())) continue;
    checkContent(fence.code, skill, issues, `SKILL.md 内联 ${fence.lang} 代码块`);
  }
  return issues;
}
