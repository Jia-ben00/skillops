// SkillOps 公共 API（供其他工具/脚本调用）
export { parseSkill } from './skillfile.js';
export { scan, scanFromArgs, defaultSkillRoots, loadConfig } from './scanner.js';
export { runAnalysis, analyzeSkill } from './analyzers/index.js';
export { buildReport } from './report.js';
export { loadSuite, listSuites } from './bench/suite.js';
export { runSuite } from './bench/runner.js';
export { plan as planFix, execute as executeFix } from './fix.js';
export { initTeamRepo, pushSkills, buildRegistry, gateSkills, pullSkills, checksumSkill, versionOf, compareVersions } from './sync.js';
export { estimateTokens, similarity, jaccard } from './util.js';
