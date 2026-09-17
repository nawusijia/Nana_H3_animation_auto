import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const port = 18970 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nana-h3-agent-smoke-'));
let stderr = '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(pathname, options = {}, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...(options.headers || {}) } : options.headers,
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { text }; }
  assert(response.status === expectedStatus, `${pathname}: expected ${expectedStatus}, got ${response.status}: ${text.slice(0, 500)}`);
  return payload;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/projects`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Server did not start on ${baseUrl}. ${stderr.slice(-1000)}`);
}

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    NANA_H3_PORT: String(port),
    NANA_H3_DATA_DIR: dataDir,
    NANA_H3_AGENT_ONLY: 'true',
    GLM_API_KEY: '',
    API_KEY: '',
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', chunk => { stderr += String(chunk); });

try {
  await waitForServer();

  await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Agent Protocol Smoke' }),
  }, 201);

  const source = await request('/api/agent/source', {
    method: 'PUT',
    body: JSON.stringify({
      sourceText: '第1场｜走廊\n【画面】主角沿走廊走到门前停下。',
      isOtome: false,
      scriptMode: 'original',
    }),
  });
  assert(source.bootstrap?.policy?.mode === 'agent_owned', 'Expected agent_owned policy.');
  assert(source.bootstrap?.pipeline?.nextStage === 'outline', 'Expected outline after source handoff.');

  const legacy = await request('/api/workflow/analyze-outline', {
    method: 'POST',
    body: JSON.stringify({ sourceText: 'legacy must be blocked' }),
  }, 423);
  assert(/Agent 接管模式/.test(String(legacy.error || '')), 'Legacy provider route was not blocked by agent-owned policy.');

  const settings = {
    overview: '主角沿走廊走到门前。',
    style: '电影级写实，动作清晰，空间连续。',
    characters: [{ id: 'char-main', name: '主角', description: '主角', prompt: '主角参考设定图' }],
    scenes: [{ id: 'scene-ref-hall', name: '走廊', description: '走廊场景', prompt: '走廊参考设定图' }],
    assets: [],
  };
  const outline = {
    settings,
    sceneOutlines: [{ id: 'scene-1', title: '走廊', rawText: '主角沿走廊走到门前停下。', locationId: 'scene-ref-hall' }],
  };

  let result = await request('/api/agent/pipeline/outline', {
    method: 'PUT',
    body: JSON.stringify({ status: 'completed', artifact: { outline, settings } }),
  });
  assert(result.bootstrap?.pipeline?.nextStage === 'assets', 'Expected assets after outline.');

  result = await request('/api/agent/pipeline/assets', {
    method: 'PUT',
    body: JSON.stringify({ status: 'completed', artifact: { settings } }),
  });
  assert(result.bootstrap?.pipeline?.nextStage === 'shots', 'Expected shots after assets.');

  const shots = [{
    id: 'shot-1',
    sceneId: 'scene-1',
    order: 0,
    durationSeconds: 5,
    sourceText: '主角沿走廊走到门前停下。',
    description: '主角沿走廊走到门前停下。',
    direction: {
      framing: '全身中景',
      camera: '沿行进方向平稳跟随',
      subject: '主角与前方门口',
      action: '主角沿走廊向前走，到门前停住。',
      endState: '主角停在门前。',
    },
    speech: [],
    characterIds: ['char-main'],
    assetIds: ['scene-ref-hall'],
  }];
  result = await request('/api/agent/pipeline/shots', {
    method: 'PUT',
    body: JSON.stringify({ status: 'completed', artifact: { shots } }),
  });
  assert(result.bootstrap?.pipeline?.nextStage === 'sequences', 'Expected sequences after shots.');

  const sequences = [{
    id: 'sequence-1',
    sceneId: 'scene-1',
    order: 0,
    title: '走到门前',
    shotIds: ['shot-1'],
    durationSeconds: 5,
    assetIds: ['char-main', 'scene-ref-hall'],
  }];
  result = await request('/api/agent/pipeline/sequences', {
    method: 'PUT',
    body: JSON.stringify({ status: 'completed', artifact: { sequences } }),
  });
  assert(result.bootstrap?.pipeline?.nextStage === 'prompts', 'Expected prompts after sequences.');

  const directorRead = {
    dramaticFunction: '建立主角到达门前的明确动作结果。',
    turn: '主角从移动状态转为门前停步。',
    viewerPOV: '观众沿主角行进方向观察。',
    relationshipShift: '人物与门口的空间距离从远到近。',
    objective: '主角抵达门前。',
    obstacle: '走廊距离构成动作过程。',
    visibleBehavior: '主角持续向前走并在门前停住。',
    visualIntention: '用连续行进建立清楚空间。',
    cameraPrinciple: '保持主体、行进方向与终点同时可读。',
    genreRefusal: '不加入原文之外的新事件。',
  };
  const audit = {
    appearanceCheck: 'pass',
    assetBoundaryCheck: 'pass',
    timelineCheck: 'pass',
    dialogueCheck: 'pass',
    transitionCheck: 'pass',
    notes: 'smoke test',
  };
  const prompt = [
    '【生成规格】',
    'MiniMax H3，5秒，16:9，连续真实动作。',
    '【导演原则】',
    '用一次连续行进完成从走廊到门前的空间变化。',
    '【场景设定】',
    '走廊，终点为前方门口，空间方向保持稳定。',
    '【声音设定】',
    '保留自然脚步与环境同期声。',
    '【氛围与画质】',
    '电影级写实视频质感，材质清晰，光影和色彩统一，动作有重量，环境持续产生与动作对应的可见变化。',
    '【画面内容】',
    'shot1(0s-5s)',
    '全身中景，沿行进方向平稳跟随。主角沿走廊向前走，到门前停住，结束时主体与门口关系清楚。',
    '【生成限制】',
    '禁止生成字幕，禁止生成BGM。',
  ].join('\n');

  result = await request('/api/agent/pipeline/prompts', {
    method: 'PUT',
    body: JSON.stringify({
      status: 'completed',
      artifact: {
        prompts: { 'sequence-1': prompt },
        directorReads: { 'sequence-1': directorRead },
        generationAudits: { 'sequence-1': audit },
        sequenceEndStates: { 'sequence-1': '主角停在门前，镜头保持主体与门口的空间关系。' },
      },
    }),
  });
  assert(result.bootstrap?.pipeline?.nextStage === 'reviewer', 'Expected reviewer after prompts.');

  result = await request('/api/agent/pipeline/reviewer', {
    method: 'PUT',
    body: JSON.stringify({ status: 'completed', artifact: { status: 'pass', findings: [] } }),
  });
  assert(result.bootstrap?.pipeline?.nextStage === 'execution', 'Expected execution after reviewer.');

  const workflow = await request('/api/workflow');
  assert(workflow.workflow?.stage === 'execution', 'Workflow was not committed to execution stage.');
  const auto = await request('/api/auto');
  assert(auto.plan?.plan?.rejections?.some(item => item.reason === 'missing_asset_reference'), 'Expected asset gate to block missing real reference images.');

  const reset = await request('/api/agent/source', {
    method: 'PUT',
    body: JSON.stringify({
      sourceText: '第1场｜走廊\n【画面】主角沿走廊走到门前停下。',
      isOtome: false,
      scriptMode: 'original',
    }),
  });
  assert(reset.bootstrap?.pipeline?.nextStage === 'outline', 'Reusing the same source must start a fresh checkpoint run.');

  console.log(JSON.stringify({
    ok: true,
    mode: result.bootstrap?.policy?.mode,
    nextStage: result.bootstrap?.pipeline?.nextStage,
    legacyProviderBlocked: true,
    assetGateBlockedWithoutImages: true,
    sameSourceResetClearsCheckpoints: true,
    port,
  }, null, 2));
} finally {
  child.kill();
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  await rm(dataDir, { recursive: true, force: true });
}
