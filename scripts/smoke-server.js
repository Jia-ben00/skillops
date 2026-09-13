// 冒烟测试：团队版服务端首页与体检 API（进程内，自动退出）
import { createServer } from '../src/server.js';

const PORT = 3199;
const srv = createServer().listen(PORT, async () => {
  try {
    const base = `http://localhost:${PORT}`;
    const r1 = await fetch(`${base}/`);
    const text1 = await r1.text();
    console.log('GET / ->', r1.status, '包含控制台:', text1.includes('SkillOps 团队控制台'));
    const r2 = await fetch(`${base}/api/doctor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillsRoot: 'test/fixtures' }),
    });
    const j = await r2.json();
    console.log('POST /api/doctor ->', r2.status, 'skills =', j.totals?.skillCount, 'score =', j.score, 'grade =', j.grade);
    const ok = r1.status === 200 && text1.includes('SkillOps') && r2.status === 200 && j.totals?.skillCount === 7;
    console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAIL');
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('SMOKE_ERROR', e);
    process.exit(1);
  } finally {
    srv.close();
  }
});
