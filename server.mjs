import http from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const PUBLIC_DIR = existsSync(path.join(ROOT, 'dist')) ? path.join(ROOT, 'dist') : path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PORT = Number(process.env.NANA_H3_PORT || 8797);
const DATA_ROOT = path.resolve(process.env.NANA_H3_DATA_DIR || path.join(ROOT, 'data'));
const H3_STATE_DIR = path.join(DATA_ROOT, '.nana-h3');
const H3_REGISTRY_PATH = path.join(H3_STATE_DIR, 'projects.json');
const H3_PROJECTS_ROOT = path.join(DATA_ROOT, 'H3Projects');
const H3_ENV_PATH = process.env.NANA_H3_ENV_FILE || path.join(ROOT, '.env');
const LEGACY_OUTPUT_DIR = path.join(DATA_ROOT, 'H3output');
const LOVART_MEDIA_DOWNLOAD_DIR = path.resolve(process.env.NANA_LOVART_OUTPUT_DIR || path.join(DATA_ROOT, 'media-downloads'));
const CLIENT_ID = `nana-h3-${crypto.randomUUID()}`;
const ACTIVE_JOBS = new Map();
const JOB_SAVE_CHAINS = new Map();
const AUTO_RUNS = new Map();
let glmSequenceQueue = Promise.resolve();
let glmAssetQueue = Promise.resolve();
const H3_MIN_SECONDS = 5;
const H3_MAX_SECONDS = 15;
const H3_ATMOSPHERE_AND_QUALITY = '电影级写实视频质感，材质清晰，光影和色彩统一，动作有重量，环境和怪物持续产生与动作对应的可见变化；避免游戏过场、技能展示和廉价贴图式特效。';
const H3_WORKFLOW_PRESETS = {
  standard: { id: 'standard', version: 'standard-v1', label: '极速文戏' },
  best_dynamic: { id: 'best_dynamic', version: 'best-dynamic-full-768p-v2', label: '动态增强·中档' },
  ultra_refine: {
    id: 'ultra_refine',
    version: 'ultra-refine-blog-mv-1088p-9plus4-v2',
    label: '极致精修 1080P',
    note: '0.5MP→1920×1088，9+4；高分辨率采样保持 full timeline，仅学习型潜空间放大器内部使用 overlap chunk。该档位属于高显存实验路线，建议先用短片验证本机稳定性。',
  },
};
const H3_WORKFLOW_PRESET_ALIASES = new Map([
  ['best_dynamic_short', 'best_dynamic'],
  ['best_dynamic_long', 'best_dynamic'],
]);
const H3_ULTRA_REFINE_EXPERIMENT = H3_WORKFLOW_PRESETS.ultra_refine;

function normalizeH3WorkflowPreset(preset) {
  const value = String(preset || '').trim();
  return H3_WORKFLOW_PRESET_ALIASES.get(value) || value;
}

function isDynamicPreset(preset) {
  return ['best_dynamic', 'ultra_refine'].includes(normalizeH3WorkflowPreset(preset));
}
const H3_DYNAMIC_ROUTE_RULES = [
  ['魔法/能量', /(魔法|法术|能量(?:流|环|轨道|墙|束|波|核心|路径)|灵力|念力|超能力)/i],
  ['粒子/流体/环境特效', /(粒子|能量粒子|光粒|光点(?:爆发|扩散)|火焰|火星|火花|烟尘|烟雾|蒸汽|粉尘|碎屑|飞溅|水流|水花|雨(?:滴|幕|水)?|雪(?:花|片)?|风沙|电弧|闪电|雷电|符文|法阵)/i],
  ['硬光/护盾/光刃', /(硬光|护盾|光盾|光刃|光剑|激光|光束|隔离墙)/i],
  ['爆炸/冲击/破坏', /(爆炸|爆破|冲击波|撞击|受击|击飞|碎裂|破碎|崩塌|坍塌|炸裂)/i],
  ['战斗/高速动作', /(战斗|格斗|挥砍|劈砍|刺击|追逐|奔跑|冲刺|跳跃|翻滚|闪避|飞行|投射物)/i],
  ['变身/多部件运动', /(变身|装甲(?:模块|装配|展开|锁定)|机械臂|机械结构(?:展开|运动)|多(?:个|支|组).{0,8}(?:机械|部件|物体).{0,8}(?:同步|运动|展开))/i],
];
const H3_SMALL_FACE_FRAMING_RULES = [
  ['大全景/全景', /(?:大全景|全景)/i],
  ['远景/中远景', /(?:中远景|远景)/i],
  ['大中景/膝部构图', /(?:大中景|膝盖|膝部|膝上|及膝|到膝)/i],
  ['全身构图', /(?:全身景|全身镜头|全身构图|人物全身)/i],
];
let progressSocket;
let progressReconnectTimer;

const ASPECTS = new Set([
  '1:1 (Square)',
  '2:3 (Portrait Photo)',
  '3:2 (Photo)',
  '3:4 (Portrait Standard)',
  '4:3 (Standard)',
  '9:16 (Portrait Widescreen)',
  '16:9 (Widescreen)',
  '21:9 (Ultrawide)',
]);
const MEGAPIXELS = new Set([0.5, 0.7, 0.9, 1.0, 1.1]);

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

function sendJson(res, status, value) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(value));
}

function errorMessage(error) {
  return error?.message || String(error);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function renameWithRetry(source, destination, attempts = 10) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const transientWindowsLock = process.platform === 'win32'
        && ['EPERM', 'EACCES', 'EBUSY'].includes(String(error?.code || ''));
      if (!transientWindowsLock || attempt >= attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await renameWithRetry(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function readConfig() {
  const saved = await readJson(CONFIG_PATH, {});
  const comfyUrl = String(process.env.NANA_H3_COMFY_URL || saved.comfy_url || '').trim().replace(/\/+$/, '');
  if (!comfyUrl) throw new Error('尚未配置ComfyUI 地址。');
  const gpuSwitchUrl = String(process.env.NANA_GPU_SWITCH_URL || saved.gpu_switch_url || '').trim().replace(/\/+$/, '');
  return { comfyUrl, gpuSwitchUrl, officeName: saved.office_name || 'MiniMax H3 / ComfyUI' };
}

function emptyH3Registry() {
  return { schemaVersion: 1, kind: 'nana-h3-project-registry', activeProjectId: null, projects: [] };
}

async function readH3Registry() {
  return readJson(H3_REGISTRY_PATH, emptyH3Registry());
}

function h3ProjectSlug(name) {
  const safe = String(name || '未命名 H3 项目').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, '-');
  return safe.slice(0, 60) || '未命名-H3-项目';
}

async function createH3Project(name) {
  const now = new Date().toISOString();
  const id = `h3-project-${crypto.randomUUID()}`;
  const projectPath = path.join(H3_PROJECTS_ROOT, `${h3ProjectSlug(name)}-${id.slice(-8)}`);
  const project = { id, name: String(name || '未命名 H3 项目').trim() || '未命名 H3 项目', path: projectPath, kind: 'h3-project', createdAt: now, lastOpenedAt: now };
  const registry = await readH3Registry();
  registry.schemaVersion = 1;
  registry.kind = 'nana-h3-project-registry';
  registry.projects = Array.isArray(registry.projects) ? registry.projects : [];
  registry.projects.push(project);
  registry.activeProjectId = project.id;
  await mkdir(path.join(projectPath, 'execution', 'h3'), { recursive: true });
  await mkdir(path.join(projectPath, 'outputs', 'h3'), { recursive: true });
  await writeJsonAtomic(path.join(projectPath, 'project.json'), { ...project, schemaVersion: 1, updatedAt: now });
  await writeJsonAtomic(H3_REGISTRY_PATH, registry);
  return { project, registry };
}

function resolveH3ProjectRoot(project) {
  if (!project || project.kind !== 'h3-project' || !project.path) {
    throw Object.assign(new Error('当前项目不是 H3 工作台项目，已拒绝载入。'), { status: 409 });
  }
  const projectsRoot = path.resolve(H3_PROJECTS_ROOT);
  const projectRoot = path.resolve(project.path);
  const relative = path.relative(projectsRoot, projectRoot);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error('H3 项目路径不在 H3Projects 存档目录内，已拒绝载入。'), { status: 409 });
  }
  return projectRoot;
}

async function projectRuntime() {
  const registry = await readH3Registry();
  const project = registry.projects?.find(item => item.id === registry.activeProjectId);
  if (!project?.path) {
    throw Object.assign(new Error('请先在 H3 工作台新建或打开一个 H3 项目。'), { status: 409 });
  }
  const projectRoot = resolveH3ProjectRoot(project);
  const workbenchDir = path.join(projectRoot, 'execution', 'h3');
  return {
    project,
    projectRoot,
    workbenchDir,
    jobsPath: path.join(workbenchDir, 'tasks.json'),
    autoJobsPath: path.join(workbenchDir, 'auto-tasks.json'),
    outputDir: path.join(projectRoot, 'outputs', 'h3'),
    freeIslandInputDir: path.join(workbenchDir, 'free-island-inputs'),
    legacyOutputDir: LEGACY_OUTPUT_DIR,
  };
}

function autoPlanPath(runtime) {
  return path.join(runtime.workbenchDir, 'auto-plan.json');
}

function workflowStatePath(runtime) {
  return path.join(runtime.workbenchDir, 'workflow.json');
}

function relationFrameDir(runtime) {
  return path.join(runtime.workbenchDir, 'relation-frames');
}

function workflowFingerprint(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

async function loadWorkflowState(runtime) {
  return readJson(workflowStatePath(runtime), {
    version: 1,
    stage: 'script',
    sourceText: '',
    outline: null,
    settings: null,
    shots: [],
    sequences: [],
    prompts: {},
    directorReads: {},
    generationAudits: {},
    sequenceEndStates: {},
    updatedAt: new Date().toISOString(),
  });
}

function buildWorkflowWorkspace(runtime, input) {
  const outline = input.outline || {};
  const settings = input.settings || outline.settings || { overview: '', style: '', characters: [], scenes: [], assets: [] };
  const sourceText = String(input.sourceText || '');
  const rawShots = Array.isArray(input.shots) ? input.shots : [];
  const rawSequences = Array.isArray(input.sequences) ? input.sequences : [];
  const fingerprint = workflowFingerprint({ sourceText, outline, settings, rawShots, rawSequences, prompts: input.prompts || {} });
  const scenes = (outline.sceneOutlines || []).map((scene, index) => {
    const sceneShots = rawShots.filter(shot => String(shot.sceneId || '') === String(scene.id));
    const sceneSequences = rawSequences.filter(sequence => String(sequence.sceneId || '') === String(scene.id));
    return {
      id: String(scene.id || `workflow-scene-${index + 1}`),
      order: index,
      title: String(scene.title || `第${index + 1}场`),
      sourceText: String(scene.rawText || ''),
      continuityBoundary: 'scene',
      continuityKey: String(scene.id || `workflow-scene-${index + 1}`),
      characterIds: [...new Set(sceneShots.flatMap(shot => shot.characterIds || []))],
      assetIds: [...new Set(sceneShots.flatMap(shot => shot.assetIds || []))],
      shotIds: sceneShots.map(shot => String(shot.id)),
      sequenceIds: sceneSequences.map(sequence => String(sequence.id)),
      legacyIds: {},
      sourceFingerprint: fingerprint,
    };
  });
  const shots = rawShots.map((shot, index) => {
    const sceneId = String(shot.sceneId || scenes[0]?.id || `workflow-scene-1`);
    const sequenceId = String(shot.sequenceId || rawSequences.find(sequence => String(sequence.sceneId) === sceneId)?.id || `workflow-sequence-${sceneId}`);
    return {
      id: String(shot.id || `workflow-shot-${index + 1}`),
      sceneId,
      order: Number.isFinite(Number(shot.order)) ? Number(shot.order) : index,
      sequenceIds: [sequenceId],
      // Shot 是导演镜头单位，保留导演设计的自由时长；H3 的 5～15 秒限制只
      // 应该由 Sequence 规划层校验，不能在这里把每个 Shot 强行改成 5～15 秒。
      durationSeconds: Number.isFinite(Number(shot.durationSeconds)) && Number(shot.durationSeconds) > 0
        ? Number(shot.durationSeconds)
        : 1,
      sourceText: String(shot.sourceText || shot.description || ''),
      description: String(shot.description || shot.sourceText || ''),
      videoPrompt: String((input.prompts || {})[shot.id] || shot.videoPrompt || ''),
      direction: shot.direction || {},
      speech: Array.isArray(shot.speech) ? shot.speech : [],
      legacyUnclassifiedSpeech: [],
      characterIds: Array.isArray(shot.characterIds) ? shot.characterIds : [],
      assetIds: Array.isArray(shot.assetIds) ? shot.assetIds : [],
      legacyIds: {},
      sourceFingerprint: fingerprint,
    };
  });
  const sequences = rawSequences.map((sequence, index) => {
    const sequenceShotIds = new Set(Array.isArray(sequence.shotIds) ? sequence.shotIds.map(String) : []);
    const sequenceShots = shots.filter(shot => sequenceShotIds.has(shot.id) || String(shot.sequenceIds[0]) === String(sequence.id));
    return {
      id: String(sequence.id || `workflow-sequence-${index + 1}`),
      sceneId: String(sequence.sceneId || scenes[index]?.id || scenes[0]?.id || `workflow-scene-1`),
      order: Number.isFinite(Number(sequence.order)) ? Number(sequence.order) : index,
      shotIds: Array.isArray(sequence.shotIds) && sequence.shotIds.length ? sequence.shotIds.map(String) : sequenceShots.map(shot => shot.id),
      durationSeconds: Number.isFinite(Number(sequence.durationSeconds))
        ? Number(sequence.durationSeconds)
        : sequenceShots.reduce((sum, shot) => sum + Number(shot.durationSeconds || 0), 0),
      engine: 'h3',
      h3WorkflowPreset: normalizeH3WorkflowPreset(sequence.h3WorkflowPreset || sequence.metadata?.h3WorkflowPreset || ''),
      prompt: {
        text: String((input.prompts || {})[sequence.id] || sequence.prompt?.text || sequence.promptText || ''),
        source: String(sequence.prompt?.source || ((input.prompts || {})[sequence.id] || sequence.promptText) ? 'imported' : 'sequence-compiled'),
      },
      directorRead: sequence.directorRead || (input.directorReads || {})[sequence.id] || null,
      generationAudit: sequence.generationAudit || (input.generationAudits || {})[sequence.id] || null,
      endState: String(sequence.endState || (input.sequenceEndStates || {})[sequence.id] || ''),
      assetIds: [...new Set([
        ...(Array.isArray(sequence.assetIds) ? sequence.assetIds : []),
        ...sequenceShots.flatMap(shot => [...shot.characterIds, ...shot.assetIds]),
      ])],
      continuity: {
        scope: 'same_scene_only',
        previousSequenceId: index > 0 && String(rawSequences[index - 1]?.sceneId || '') === String(sequence.sceneId || '')
          ? String(rawSequences[index - 1].id)
          : null,
      },
      status: 'ready',
      resultIds: [],
      legacyIds: {},
      sourceFingerprint: fingerprint,
    };
  });
  const assetGroups = [
    ...(settings.characters || []).map(item => ({ ...item, kind: 'character' })),
    ...(settings.scenes || []).map(item => ({ ...item, kind: 'scene_reference' })),
    ...(settings.assets || []).map(item => ({ ...item, kind: 'prop' })),
  ];
  const assets = assetGroups.map(item => ({
    id: String(item.id || item.name),
    kind: item.kind,
    name: String(item.name || item.id),
    description: String(item.description || ''),
    generationPrompt: String(item.prompt || ''),
    uri: String(item.uri || item.path || ''),
    legacyIds: {},
    sourceFingerprint: fingerprint,
  }));
  const project = {
    schemaVersion: 2,
    id: runtime.project.id,
    name: String(input.projectName || runtime.project.name),
    legacyIds: {},
    sourceFingerprint: fingerprint,
    migration: {
      sourceSchemaVersion: 2,
      adapterVersion: 'h3-workflow',
      legacyMode: 'native',
      mode: 'native_v2',
      rollback: 'workspace_versions',
      sourceFingerprint: fingerprint,
      warnings: [],
    },
    scenes,
    shots,
    sequences,
    assets,
    results: [],
  };
  return {
    kind: 'nana-h3-workspace',
    workspaceSchemaVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    project,
    sequenceSettings: Object.fromEntries(sequences.map(sequence => [sequence.id, {
      ratio: '16:9', resolution: '720p', enableSound: true, allowText2Video: true, generationMode: 'auto', megapixels: 0.9,
    }])),
    annotations: {},
    engineBindings: { libtv: {}, dreamina: {}, h3: { serviceUrl: `http://127.0.0.1:${PORT}` } },
    migration: {
      source: 'h3-guided-workflow',
      loadedSources: ['H3 工作台逐层向导'],
      missingSources: [], warnings: [], blockers: [], referenceAssetsVersion: 1, pendingRunsVersion: 1,
    },
  };
}

async function loadDirectorWorkspace(runtime) {
  const file = path.join(runtime.workbenchDir, 'workspace.json');
  const workspace = await readJson(file, null);
  if (!workspace?.project?.scenes || !Array.isArray(workspace.project.shots)) {
    throw Object.assign(new Error('当前 H3 项目没有可供规划的 Scene / Shot 数据。请先在 H3 工作台完成剧本、分场和镜头设计。'), { status: 409 });
  }
  return workspace;
}

function autoSequenceId(projectId, sceneId, shotIds) {
  return `h3-seq-${crypto.createHash('sha256').update([projectId, sceneId, shotIds.join('|')].join('|')).digest('hex').slice(0, 18)}`;
}

function resolveAssetPath(projectRoot, asset) {
  const raw = String(asset?.uri || '').trim();
  if (!raw) return '';
  if (raw.startsWith('file://')) {
    try { return path.normalize(new URL(raw).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')); } catch { return ''; }
  }
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(projectRoot, raw);
}

async function openH3PathInExplorer(runtime, rawPath) {
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('当前系统不支持直接打开 Windows 文件夹。'), { status: 501 });
  }
  const root = path.resolve(runtime.projectRoot);
  const target = path.resolve(String(rawPath || ''));
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error('媒体文件不在当前 H3 项目目录内，已拒绝打开外部路径。'), { status: 403 });
  }
  const file = await stat(target).catch(() => null);
  if (!file) {
    throw Object.assign(new Error('媒体文件已不存在，无法打开所在文件夹。'), { status: 404 });
  }
  const folder = file.isDirectory() ? target : path.dirname(target);
  const explorerArgs = file.isDirectory() ? [folder] : [`/select,${target}`];
  const child = spawn('explorer.exe', explorerArgs, { detached: true, windowsHide: false, stdio: 'ignore' });
  child.unref();
  return folder;
}

function routeH3Workflow(sequence, prompt, shots = []) {
  const requested = normalizeH3WorkflowPreset(sequence?.h3WorkflowPreset || sequence?.metadata?.h3WorkflowPreset || '');
  const durationSeconds = Number(sequence?.durationSeconds || sequence?.targetDurationSeconds || 0);
  if (H3_WORKFLOW_PRESETS[requested]) {
    return {
      preset: requested,
      version: H3_WORKFLOW_PRESETS[requested].version,
      source: 'manual',
      reason: `手动指定：${H3_WORKFLOW_PRESETS[requested].label}`,
    };
  }

  const smallFaceShots = shots.flatMap(shot => {
    if (!(shot?.characterIds || []).length) return [];
    const framing = String(shot?.direction?.framing || '').trim();
    const matched = H3_SMALL_FACE_FRAMING_RULES.find(([, pattern]) => pattern.test(framing));
    return matched ? [{ shotId: shot.id, label: matched[0], framing }] : [];
  });
  if (smallFaceShots.length) {
    const sample = smallFaceShots[0];
    return {
      preset: 'ultra_refine',
      version: H3_WORKFLOW_PRESETS.ultra_refine.version,
      source: 'auto',
      reason: `${sample.label}${sample.framing ? `（${sample.framing}）` : ''} · 人物面部占比偏小，为保证脸部清晰度使用极致精修 1080P`,
    };
  }

  const text = String(prompt || '');
  const hits = H3_DYNAMIC_ROUTE_RULES.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  if (hits.length) {
    return {
      preset: 'best_dynamic',
      version: H3_WORKFLOW_PRESETS.best_dynamic.version,
      source: 'auto',
      reason: `${hits.slice(0, 3).join(' + ')} · ${durationSeconds || '?'}s · 动态增强候选；Agent提交前如未指定档位，先询问中档或极致`,
    };
  }
  return {
    preset: 'standard',
    version: H3_WORKFLOW_PRESETS.standard.version,
    source: 'auto',
    reason: '未命中人物小脸景别，且为对白/低动态/常规动作，默认极速文戏',
  };
}

function planH3AutoComic(workspace, runtime) {
  const project = workspace.project;
  const shotsById = new Map(project.shots.map(shot => [shot.id, shot]));
  const scenesById = new Map(project.scenes.map(scene => [scene.id, scene]));
  const assetsById = new Map((project.assets || []).map(asset => [asset.id, asset]));
  const queue = [];
  const rejections = [];
  const assignedSequenceIds = new Set();

  // Sequence.order 在每个 Scene 内从 0 重新计数；只按 order 排序会把
  // Scene 2 / Sequence 1 插到 Scene 1 / Sequence 2 前面，直接打断同 Scene
  // 的末帧连续性。先按 Scene 顺序，再按 Scene 内 Sequence 顺序排列。
  const sceneOrderById = new Map(project.scenes.map(scene => [scene.id, Number(scene.order ?? 0)]));
  const sourceSequences = [...(project.sequences || [])].sort((a, b) => {
    const sceneOrderDiff = (sceneOrderById.get(a.sceneId) ?? Number.MAX_SAFE_INTEGER)
      - (sceneOrderById.get(b.sceneId) ?? Number.MAX_SAFE_INTEGER);
    return sceneOrderDiff || (Number(a.order ?? 0) - Number(b.order ?? 0));
  });
  const fallbackSequences = sourceSequences.length ? [] : project.scenes.map((scene, index) => ({ id: autoSequenceId(project.id, scene.id, scene.shotIds || []), sceneId: scene.id, order: index, shotIds: scene.shotIds || [] }));
  for (const sequence of [...sourceSequences, ...fallbackSequences]) {
    const scene = scenesById.get(sequence.sceneId);
    if (!scene) {
      rejections.push({ sceneId: sequence.sceneId, shotIds: sequence.shotIds || [], reason: 'missing_scene', message: `Sequence ${sequence.id} 找不到所属 Scene。` });
      continue;
    }
    const shots = (sequence.shotIds || []).map(id => shotsById.get(id)).filter(Boolean).sort((a, b) => a.order - b.order);
    const missingShotIds = (sequence.shotIds || []).filter(id => !shotsById.has(id));
    if (missingShotIds.length) rejections.push({ sceneId: scene.id, shotIds: missingShotIds, reason: 'missing_shot', message: `${scene.title || scene.id} 的 Sequence ${sequence.id} 找不到 Shot：${missingShotIds.join(', ')}。` });
    if (!shots.length) continue;
    const duration = Number(sequence.durationSeconds || shots.reduce((sum, shot) => sum + Number(shot.durationSeconds || 0), 0));
    if (!Number.isInteger(duration) || duration < H3_MIN_SECONDS || duration > H3_MAX_SECONDS) {
      rejections.push({
        sceneId: scene.id,
        shotIds: shots.map(shot => shot.id),
        reason: 'invalid_sequence_duration',
        durationSeconds: duration,
        message: `${scene.title || scene.id} 的 Sequence ${sequence.id} 总时长为 ${duration}s；H3 单条 Sequence 必须是 ${H3_MIN_SECONDS}～${H3_MAX_SECONDS} 秒整数，不能把 Sequence 拆成逐 Shot 生成。`,
      });
      continue;
    }
    const sequencePrompt = String(sequence?.prompt?.text || '').trim();
    if (!sequencePrompt) {
      rejections.push({
        sceneId: scene.id,
        shotIds: shots.map(shot => shot.id),
        reason: 'missing_sequence_prompt',
        message: `${scene.title || scene.id} 的 Sequence ${sequence.id} 没有 GLM-5.3 返回的提示词；请先完成“Sequence → GLM-5.3”步骤。`,
      });
      continue;
    }
    if (assignedSequenceIds.has(sequence.id)) continue;
    assignedSequenceIds.add(sequence.id);
    const sequenceAssetIds = [...new Set([
      ...(Array.isArray(sequence.assetIds) ? sequence.assetIds : []),
      ...shots.flatMap(shot => [...(shot.characterIds || []), ...(shot.assetIds || [])]),
      ...(scene.assetIds || []),
    ])];
    const assetBindings = sequenceAssetIds.map(id => {
      const file = resolveAssetPath(runtime.projectRoot, assetsById.get(id));
      return { assetId: id, path: file && existsSync(file) ? projectRelativePath(runtime.projectRoot, file) : '' };
    });
    const missingAssetIds = assetBindings.filter(binding => !binding.path).map(binding => binding.assetId);
    if (!sequenceAssetIds.length || missingAssetIds.length) {
      rejections.push({
        sceneId: scene.id,
        shotIds: shots.map(shot => shot.id),
        assetIds: missingAssetIds.length ? missingAssetIds : sequenceAssetIds,
        reason: 'missing_asset_reference',
        message: `${scene.title || scene.id} 的 Sequence ${sequence.id} 缺少可上传的实际参考图：${(missingAssetIds.length ? missingAssetIds : sequenceAssetIds).join('、')}。资产图未绑定完成前禁止提交 H3 视频。`,
      });
      continue;
    }
    const workflowRoute = routeH3Workflow(sequence, sequencePrompt, shots);
    queue.push({
      sequenceId: sequence.id || autoSequenceId(project.id, scene.id, shots.map(shot => shot.id)),
      sceneId: scene.id,
      sceneTitle: scene.title || scene.id,
      sceneOrder: scene.order,
      sequenceOrder: sequence.order,
      shotIds: shots.map(shot => shot.id),
      durationSeconds: duration,
      prompt: sequencePrompt,
      assetIds: sequenceAssetIds,
      assetPaths: assetBindings.map(binding => binding.path),
      assetBindings,
      workflowPreset: workflowRoute.preset,
      workflowPresetVersion: workflowRoute.version,
      workflowPresetSource: workflowRoute.source,
      routeReason: workflowRoute.reason,
      status: 'waiting',
    });
  }

  const assignedShotIds = new Set(queue.flatMap(item => item.shotIds));
  for (const scene of [...project.scenes].sort((a, b) => a.order - b.order)) {
    const unassigned = (scene.shotIds || []).map(id => shotsById.get(id)).filter(shot => shot && !assignedShotIds.has(shot.id)).sort((a, b) => a.order - b.order);
    if (!unassigned.length) continue;
    const sequence = {
      id: autoSequenceId(project.id, scene.id, unassigned.map(shot => shot.id)),
      sceneId: scene.id,
      order: queue.filter(item => item.sceneId === scene.id).length,
      shotIds: unassigned.map(shot => shot.id),
      durationSeconds: unassigned.reduce((sum, shot) => sum + Number(shot.durationSeconds || 0), 0),
      prompt: { text: '', source: 'glm-5.3-required' },
      assetIds: [],
    };
    const duration = Number(sequence.durationSeconds);
    if (!Number.isInteger(duration) || duration < H3_MIN_SECONDS || duration > H3_MAX_SECONDS) {
      rejections.push({ sceneId: scene.id, shotIds: sequence.shotIds, reason: 'invalid_sequence_duration', durationSeconds: duration, message: `${scene.title || scene.id} 的未分配 Shot 组合无法组成合法 H3 Sequence：总时长 ${duration}s。` });
      continue;
    }
    rejections.push({
      sceneId: scene.id,
      shotIds: sequence.shotIds,
      reason: 'missing_sequence_prompt',
      message: `${scene.title || scene.id} 的自动补齐 Sequence 没有 GLM-5.3 提示词；不能使用本地编译器代替。`,
    });
    continue;
  }

  return {
    kind: 'nana-h3-auto-comic-plan',
    version: 2,
    projectId: project.id,
    projectName: project.name,
    sourceFingerprint: project.sourceFingerprint || '',
    generatedAt: new Date().toISOString(),
    status: rejections.length ? 'paused' : 'ready',
    currentSequenceId: null,
    stopRequested: false,
    plan: {
      scenes: project.scenes.length,
      shots: project.shots.length,
      plannedShots: queue.reduce((sum, item) => sum + item.shotIds.length, 0),
      plannedSequences: queue.length,
      rejectedShots: rejections.reduce((sum, item) => sum + item.shotIds.length, 0),
      rejections,
      executionModel: 'sequence-prompt-then-sequence-generation',
      assetGate: {
        ready: !rejections.some(item => item.reason === 'missing_asset_reference'),
        required: [...new Set(queue.flatMap(item => item.assetIds))].length,
        bound: [...new Set(queue.flatMap(item => item.assetBindings?.filter(binding => binding.path).map(binding => binding.assetId) || []))].length,
      },
    },
    queue,
  };
}

async function loadAutoPlan(runtime) {
  return readJson(autoPlanPath(runtime), null);
}

function inspectAutoAssetGate(workspace, plan, runtime) {
  const assetsById = new Map((workspace?.project?.assets || []).map(asset => [String(asset.id), asset]));
  const missing = [];
  for (const item of plan?.queue || []) {
    const bindings = Array.isArray(item.assetBindings) ? item.assetBindings : [];
    const boundById = new Map(bindings.map(binding => [String(binding.assetId), String(binding.path || '')]));
    for (const assetId of [...new Set(item.assetIds || [])]) {
      const relativePath = boundById.get(String(assetId)) || '';
      const asset = assetsById.get(String(assetId));
      const absolutePath = relativePath ? resolveAssetPath(runtime.projectRoot, { uri: relativePath }) : '';
      if (!relativePath || !absolutePath || !existsSync(absolutePath)) {
        missing.push({ sequenceId: item.sequenceId, assetId: String(assetId), name: asset?.name || String(assetId) });
      }
    }
  }
  return {
    ready: Boolean(plan?.queue?.length) && missing.length === 0 && (plan?.queue || []).every(item => Array.isArray(item.assetBindings)),
    missing,
  };
}

async function saveAutoPlan(runtime, plan) {
  plan.updatedAt = new Date().toISOString();
  await writeJsonAtomic(autoPlanPath(runtime), plan);
  return plan;
}

function projectRelativePath(projectRoot, filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  const absolute = path.resolve(raw);
  const relative = path.relative(projectRoot, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return relative.replace(/\\/g, '/');
}

function h3AutoResultId(item) {
  return `h3-auto-result-${String(item.jobId || item.sequenceId).replace(/[^a-zA-Z0-9._-]+/g, '-')}`;
}

function upsertH3AutoResult(workspace, runtime, item, job, status, extra = {}) {
  workspace.project.results = Array.isArray(workspace.project.results) ? workspace.project.results : [];
  const resultId = String(item.resultId || h3AutoResultId(item));
  const outputUri = projectRelativePath(runtime.projectRoot, job?.output_path || item.outputPath);
  let result = workspace.project.results.find(candidate => candidate.id === resultId);
  if (!result) {
    result = {
      id: resultId,
      sequenceId: item.sequenceId,
      engine: 'h3',
      status: 'queued',
      uri: '',
      promptFingerprint: workflowFingerprint(item.prompt || ''),
      createdAt: job?.created_at || new Date().toISOString(),
      metadata: {},
      legacyIds: {},
      sourceFingerprint: workflowFingerprint({ projectId: runtime.project.id, sequenceId: item.sequenceId, jobId: item.jobId || '' }),
    };
    workspace.project.results.push(result);
  }
  result.sequenceId = item.sequenceId;
  result.engine = 'h3';
  result.status = status;
  result.uri = outputUri || result.uri || '';
  result.metadata = {
    ...result.metadata,
    jobId: item.jobId || result.metadata?.jobId || '',
    outputPath: outputUri || result.metadata?.outputPath || '',
    targetDurationSeconds: Number(item.durationSeconds || 0),
    generationMode: job?.generation_mode || result.metadata?.generationMode || '',
    taskType: job?.task_type || result.metadata?.taskType || '',
    imageCount: Number(job?.image_count || result.metadata?.imageCount || 0),
    firstAsFrame: Boolean(job?.first_as_frame || result.metadata?.firstAsFrame || false),
    workflowPreset: item.workflowPreset || job?.workflow_preset || result.metadata?.workflowPreset || 'standard',
    workflowPresetVersion: item.workflowPresetVersion || job?.workflow_preset_version || result.metadata?.workflowPresetVersion || H3_WORKFLOW_PRESETS.standard.version,
    workflowPresetSource: item.workflowPresetSource || job?.workflow_preset_source || result.metadata?.workflowPresetSource || 'legacy',
    routeReason: item.routeReason || job?.route_reason || result.metadata?.routeReason || '',
    h3AutoComic: {
      sceneId: item.sceneId,
      shotIds: item.shotIds || [],
      relationFrameIn: item.relationFrameIn || '',
      relationFrameOut: item.relationFrameOut || '',
      ...(extra || {}),
    },
    ...(status === 'failed' && extra.error ? { error: extra.error } : {}),
  };
  const sequence = workspace.project.sequences.find(candidate => candidate.id === item.sequenceId);
  if (sequence) {
    sequence.resultIds = [...new Set([...(sequence.resultIds || []), result.id])];
    if (status === 'succeeded') sequence.status = 'succeeded';
    if (status === 'failed') sequence.status = 'failed';
  }
  item.resultId = result.id;
  return result;
}

async function saveDirectorWorkspace(runtime, workspace) {
  workspace.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path.join(runtime.workbenchDir, 'workspace.json'), workspace);
  return workspace;
}

async function backfillCompletedAutoResults(runtime, plan) {
  const migratedLegacyJobs = await migrateLegacyAutoJobs(runtime);
  if (!plan?.queue?.length) return { count: 0, workspace: null, migratedLegacyJobs };
  const workspace = await loadDirectorWorkspace(runtime);
  const jobs = await loadJobs(runtime, 'auto');
  const jobsById = new Map((jobs.jobs || []).map(job => [job.id, job]));
  const workflow = await loadWorkflowState(runtime);
  workflow.generationAudits = workflow.generationAudits || {};
  let workflowChanged = false;
  let count = 0;
  for (const item of plan.queue) {
    if (item.status !== 'completed' || !item.outputPath || !item.jobId) continue;
    const job = jobsById.get(item.jobId);
    if (!job || job.status !== 'completed') continue;
    upsertH3AutoResult(workspace, runtime, item, job, 'succeeded');
    const prompt = String(workflow.prompts?.[item.sequenceId] || '');
    const audit = workflow.generationAudits[item.sequenceId];
    if (audit && !audit.transitionCheck && !findPostTransitionViolation(prompt)) {
      audit.transitionCheck = 'pass';
      audit.notes = `${String(audit.notes || '').trim()}${audit.notes ? '；' : ''}本轮回填时自动复核未发现后期转场词。`;
      workflowChanged = true;
    }
    count += 1;
  }
  if (count) {
    await saveDirectorWorkspace(runtime, workspace);
    await saveAutoPlan(runtime, plan);
  }
  if (workflowChanged) await writeJsonAtomic(workflowStatePath(runtime), workflow);
  return { count, workspace, migratedLegacyJobs };
}

function fileType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.webp' ? 'image/webp' : 'image/png';
}

async function uploadImagePath(filePath, jobId, index) {
  const bytes = await readFile(filePath);
  return uploadImage({ arrayBuffer: async () => bytes, name: path.basename(filePath), type: fileType(filePath) }, jobId, index);
}

async function submitAutoSequence(runtime, sequenceItem, relationFramePath) {
  const jobId = `h3-auto-sequence-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const assetPaths = (sequenceItem.assetPaths || [])
    .map(assetPath => resolveAssetPath(runtime.projectRoot, { uri: assetPath }))
    .filter(Boolean);
  const imagePaths = [relationFramePath || '', ...assetPaths].filter(Boolean).slice(0, 9);
  const missingImagePaths = imagePaths.filter(imagePath => !existsSync(imagePath));
  if (missingImagePaths.length) {
    throw new Error(`H3 Sequence ${sequenceItem.sequenceId} 缺少可上传的参考图：${missingImagePaths.join('、')}`);
  }
  const firstAsFrame = false;
  const imageNames = [];
  for (let index = 0; index < imagePaths.length; index += 1) imageNames.push(await uploadImagePath(imagePaths[index], jobId, index));
  const continuityPrompt = relationFramePath
    ? `【连续性参考】<Picture 1> 是上一条 Sequence 的最后一帧，代表上一条结束时的人物状态、构图与空间关系；本条从这个状态自然接续。\n\n${sequenceItem.prompt}`
    : sequenceItem.prompt;
  const built = buildAutoWorkflow({
    prompt: continuityPrompt,
    aspectRatio: '16:9 (Widescreen)',
    seconds: sequenceItem.durationSeconds,
    megapixels: 0.9,
    imageNames,
    firstAsFrame,
    jobId,
    workflowPreset: sequenceItem.workflowPreset || 'standard',
  });
  const response = await comfyFetch('/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: built.workflow, client_id: CLIENT_ID }),
    timeoutMs: 30_000,
  });
  const queued = await response.json();
  if (!queued.prompt_id) throw new Error(queued.error || 'ComfyUI 没有返回 H3 漫剧 prompt_id。');
  const now = new Date().toISOString();
  const job = {
    id: jobId,
    prompt_id: queued.prompt_id,
    status: 'queued',
    prompt: continuityPrompt,
    prompt_sent: built.prompt,
    aspect_ratio: '16:9 (Widescreen)',
    seconds: sequenceItem.durationSeconds,
    megapixels: built.megapixels,
    target_width: built.targetWidth,
    target_height: built.targetHeight,
    length: built.length,
    image_count: imageNames.length,
    generation_mode: imageNames.length ? 'reference' : 'text',
    first_as_frame: firstAsFrame,
    task_type: built.taskType,
    workflow_preset: sequenceItem.workflowPreset || 'standard',
    workflow_preset_version: sequenceItem.workflowPresetVersion || H3_WORKFLOW_PRESETS.standard.version,
    workflow_preset_source: sequenceItem.workflowPresetSource || 'legacy',
    route_reason: sequenceItem.routeReason || '',
    progress_phase: 'queued',
    progress_percent: 0,
    progress_label: '等待H3 GPU 开始',
    auto_comic: {
      stage: 'sequence',
      sequence_id: sequenceItem.sequenceId,
      scene_id: sequenceItem.sceneId,
      shot_ids: sequenceItem.shotIds,
      target_duration_seconds: sequenceItem.durationSeconds,
      relation_frame_in: relationFramePath || '',
    },
    created_at: now,
    updated_at: now,
  };
  await saveJob(runtime, job, 'auto');
  ACTIVE_JOBS.set(job.prompt_id, { runtime, job, scope: 'auto' });
  void monitorJob(runtime, job, 'auto');
  return job;
}

async function waitForJob(runtime, jobId, scope = 'single') {
  while (true) {
    const doc = await loadJobs(runtime, scope);
    const job = doc.jobs.find(item => item.id === jobId);
    if (!job) throw new Error(`H3 漫剧任务 ${jobId} 不存在。`);
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
}

function runProcess(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => resolve({ code: Number(code ?? -1), stdout, stderr }));
  });
}

async function extractRelationFrame(runtime, item, outputPath) {
  await mkdir(relationFrameDir(runtime), { recursive: true });
  const safeItemId = String(item.sequenceId).replace(/[^a-zA-Z0-9._-]+/g, '_');
  const selected = path.join(relationFrameDir(runtime), `${safeItemId}.png`);
  const extracted = await runProcess(process.env.FFMPEG_BIN || 'ffmpeg', [
    '-y', '-v', 'error', '-sseof', '-1', '-i', outputPath,
    '-vf', 'reverse', '-frames:v', '1', selected,
  ]);
  if (extracted.code !== 0 || !existsSync(selected)) throw new Error(`无法从 H3 成品提取最后一帧：${item.sequenceId}`);
  return selected;
}

async function runAutoComic(runtime, plan) {
  let lastExecutedPreset = '';
  let lastDynamicCleanupOk = true;
  try {
    for (let index = 0; index < plan.queue.length; index += 1) {
      const item = plan.queue[index];
      if (item.status === 'completed') continue;
      if (item.status === 'blocked' || plan.plan.rejections.length) throw new Error('H3 漫剧规划存在阻断项，请先修正 Shot 时长。');
      if (plan.stopRequested) { plan.status = 'paused'; plan.currentSequenceId = null; await saveAutoPlan(runtime, plan); return; }
      const previous = index > 0 ? plan.queue[index - 1] : null;
      const relationFrameIn = previous && previous.sceneId === item.sceneId && previous.status === 'completed' ? previous.relationFrameOut : '';
      item.status = 'running';
      item.relationFrameIn = relationFrameIn;
      item.progressPhase = 'preparing';
      item.progressPercent = 0;
      item.progressLabel = `准备 ${H3_WORKFLOW_PRESETS[item.workflowPreset || 'standard']?.label || item.workflowPreset || 'H3'} 工作流`;
      item.progressUpdatedAt = new Date().toISOString();
      plan.currentSequenceId = item.sequenceId;
      await saveAutoPlan(runtime, plan);
      if (plan.stopRequested) { plan.status = 'paused'; item.status = 'paused'; plan.currentSequenceId = null; await saveAutoPlan(runtime, plan); return; }
      item.relationFrameIn = relationFrameIn || '';
      const currentPreset = item.workflowPreset || 'standard';
      item.workflowPresetVersion = H3_WORKFLOW_PRESETS[currentPreset]?.version || item.workflowPresetVersion || '';
      const needsPreRelease = (
        isDynamicPreset(currentPreset) && !isDynamicPreset(lastExecutedPreset)
      ) || (
        isDynamicPreset(lastExecutedPreset) && !lastDynamicCleanupOk
      );
      if (needsPreRelease) {
        const released = await freeComfyMemory(`切换工作流 ${lastExecutedPreset || 'cold'} → ${currentPreset}`);
        if (!released.ok) throw new Error(`提交 ${currentPreset} 前显存释放失败：${released.error || 'unknown error'}`);
        lastDynamicCleanupOk = true;
      }
      const job = await submitAutoSequence(runtime, item, relationFrameIn ? path.resolve(runtime.projectRoot, relationFrameIn) : '');
      item.jobId = job.id;
      item.progressPhase = 'queued';
      item.progressPercent = 0;
      item.progressLabel = '已提交H3 GPU，等待执行';
      item.progressUpdatedAt = new Date().toISOString();
      const queuedWorkspace = await loadDirectorWorkspace(runtime);
      upsertH3AutoResult(queuedWorkspace, runtime, item, job, 'queued');
      await saveDirectorWorkspace(runtime, queuedWorkspace);
      await saveAutoPlan(runtime, plan);
      const finished = await waitForJob(runtime, job.id, 'auto');
      if (finished.status !== 'completed') throw new Error(finished.error || `H3 Sequence ${item.sequenceId} 生成失败。`);
      // Stop 请求可能在 H3 生成期间写入磁盘；重新读取最新计划再落盘，
      // 避免本地旧 plan 把 stopRequested=true 覆盖回 false。
      const latestPlan = await loadAutoPlan(runtime) || plan;
      const latestItem = latestPlan.queue.find(candidate => candidate.sequenceId === item.sequenceId) || item;
      latestItem.outputPath = finished.output_path;
      if (isDynamicPreset(currentPreset)) {
        const released = await freeComfyMemory(`${currentPreset} 成片完成`);
        lastDynamicCleanupOk = released.ok;
        latestItem.memoryRelease = released.ok ? 'ok' : `warning:${released.error || 'unknown'}`;
      } else {
        lastDynamicCleanupOk = true;
      }
      lastExecutedPreset = currentPreset;
      const sequenceOutput = finished.output_path;
      latestItem.status = 'extracting_frame';
      latestItem.progressPhase = 'extracting_frame';
      latestItem.progressPercent = 99;
      latestItem.progressLabel = 'H3 成片已回传，正在提取最后一帧';
      latestItem.progressUpdatedAt = new Date().toISOString();
      await saveAutoPlan(runtime, latestPlan);
      const frame = await extractRelationFrame(runtime, latestItem, sequenceOutput);
      latestItem.relationFrameOut = path.relative(runtime.projectRoot, frame).replace(/\\/g, '/');
      latestItem.status = 'completed';
      latestItem.progressPhase = 'completed';
      latestItem.progressPercent = 100;
      latestItem.progressLabel = '完成并生成末帧接力';
      latestItem.progressUpdatedAt = new Date().toISOString();
      const completedWorkspace = await loadDirectorWorkspace(runtime);
      upsertH3AutoResult(completedWorkspace, runtime, latestItem, finished, 'succeeded');
      await saveDirectorWorkspace(runtime, completedWorkspace);
      latestPlan.currentSequenceId = null;
      await saveAutoPlan(runtime, latestPlan);
      plan = latestPlan;
    }
    plan.status = 'completed';
    plan.stopRequested = false;
    plan.currentSequenceId = null;
    await saveAutoPlan(runtime, plan);
  } catch (error) {
    plan.status = 'failed';
    plan.currentSequenceId = null;
    plan.lastError = errorMessage(error);
    plan.lastErrorAt = new Date().toISOString();
    const current = plan.queue.find(item => item.status === 'running' || item.status === 'extracting_frame');
    plan.lastErrorSequenceId = current?.sequenceId || plan.currentSequenceId || '';
    if (current) {
      current.status = 'failed';
      current.error = plan.lastError;
      current.progressPhase = 'failed';
      current.progressLabel = plan.lastError;
      current.progressUpdatedAt = new Date().toISOString();
      if (isDynamicPreset(current.workflowPreset || '')) {
        const released = await freeComfyMemory(`${current.workflowPreset} 异常退出`);
        current.memoryRelease = released.ok ? 'ok-after-failure' : `failed:${released.error || 'unknown'}`;
      }
    }
    if (current?.jobId) {
      try {
        const failedWorkspace = await loadDirectorWorkspace(runtime);
        const jobs = await loadJobs(runtime, 'auto');
        const failedJob = (jobs.jobs || []).find(job => job.id === current.jobId) || { id: current.jobId };
        upsertH3AutoResult(failedWorkspace, runtime, current, failedJob, 'failed', { error: plan.lastError });
        await saveDirectorWorkspace(runtime, failedWorkspace);
      } catch {}
    }
    await saveAutoPlan(runtime, plan);
  }
}

async function ensureH3Gpu() {
  const { gpuSwitchUrl } = await readConfig();
  if (!gpuSwitchUrl) return;
  const response = await fetch(`${gpuSwitchUrl}/switch/h3`, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`GPU 切换到 H3 失败：${response.status}${text ? ` ${text.slice(0, 300)}` : ''}`);
  }
  const state = text ? JSON.parse(text) : {};
  if (state.active !== 'h3' || state.qwen) {
    throw new Error(`GPU 未进入 H3 独占状态：${text || 'empty response'}`);
  }
}

async function comfyFetch(pathname, options = {}) {
  const { comfyUrl } = await readConfig();
  const method = String(options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    await ensureH3Gpu();
  }
  const url = new URL(pathname, `${comfyUrl}/`);
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(options.timeoutMs || 15_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`ComfyUI 返回 ${response.status}${text ? `：${text.slice(0, 300)}` : ''}`);
  }
  return response;
}

async function freeComfyMemory(reason = '') {
  try {
    const { comfyUrl } = await readConfig();
    const response = await fetch(new URL('/free', `${comfyUrl}/`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { ok: true, reason };
  } catch (error) {
    console.warn(`H3 显存释放失败${reason ? `（${reason}）` : ''}: ${errorMessage(error)}`);
    return { ok: false, reason, error: errorMessage(error) };
  }
}

function alignedLength(seconds) {
  const frames = Math.max(5, Math.round(Number(seconds) * 24));
  return frames + ((5 - (frames % 17)) % 17 + 17) % 17;
}

function normalizedPrompt(prompt) {
  return String(prompt || '').replace(/@?图片?\s*([1-9])/g, '<Picture $1>');
}

function taskTypeFor(imageCount, firstAsFrame) {
  if (imageCount === 0) return 'T2VA';
  if (!firstAsFrame) return 'Ref2VA';
  return imageCount === 1 ? 'I2VA' : 'Hybrid';
}

function generationModeFor(imageCount, firstAsFrame) {
  if (imageCount === 0) return 'text';
  return firstAsFrame ? 'image' : 'reference';
}

function buildWorkflow({ prompt, aspectRatio, seconds, megapixels, imageNames, firstAsFrame, jobId }) {
  const taskType = taskTypeFor(imageNames.length, firstAsFrame);
  const conditioningInputs = {
    prompt: ['36', 0],
    width: ['16', 0],
    height: ['16', 1],
    length: ['15', 1],
    task_type: taskType,
    audio_mode: 'native',
    audio_denoise_strength: 1.0,
    add_source_as_reference: false,
    prompt_primary_audio_ordinal: 0,
    strict_prompt_tags: true,
    ref_image_size: 'match',
    reference_video_policy: 'official_2_to_15s',
    clip: ['3', 0],
    video_vae: ['4', 0],
    audio_vae: ['5', 0],
  };

  const workflow = {
    '1': {
      inputs: {
        unet_name: 'minimax_h3_fl2va_int8_convrot.safetensors',
        weight_dtype: 'default',
      },
      class_type: 'UNETLoader',
      _meta: { title: 'UNet加载器' },
    },
    '2': {
      inputs: {
        lora_name: 'minimax_h3_fl2v_turbo_4step_v0.1_comfyui_alpha8-T8-convert.safetensors',
        strength_model: 1.0,
        model: ['17', 0],
      },
      class_type: 'LoraLoaderBypassModelOnly',
      _meta: { title: 'lora only' },
    },
    '3': {
      inputs: {
        clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
        type: 'minimax',
        device: 'default',
      },
      class_type: 'CLIPLoader',
      _meta: { title: '加载CLIP' },
    },
    '4': {
      inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: '加载视频VAE' },
    },
    '5': {
      inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: '加载音频VAE' },
    },
    '6': {
      inputs: conditioningInputs,
      class_type: 'MiniMaxH3AudioConditioningT8',
      _meta: { title: 'MiniMax H3 Audio Conditioning (T8)' },
    },
    '7': {
      inputs: {
        steps: 4,
        shift_video: 12.0,
        shift_audio: 3.0,
        model: ['2', 0],
        av_latent: ['6', 1],
      },
      class_type: 'MiniMaxH3DualClockSamplerT8',
      _meta: { title: 'STABLE 4 video / 4 audio' },
    },
    '8': {
      inputs: { model: ['7', 0], conditioning: ['6', 0] },
      class_type: 'BasicGuider',
      _meta: { title: '基本引导器' },
    },
    '9': {
      inputs: { noise_seed: 123456789 },
      class_type: 'RandomNoise',
      _meta: { title: '随机噪波' },
    },
    '10': {
      inputs: {
        noise: ['9', 0],
        guider: ['8', 0],
        sampler: ['7', 1],
        sigmas: ['7', 2],
        latent_image: ['6', 1],
      },
      class_type: 'SamplerCustomAdvanced',
      _meta: { title: '自定义采样器（高级）' },
    },
    '11': {
      inputs: {
        av_latent: ['10', 0],
        video_vae: ['4', 0],
        audio_vae: ['5', 0],
      },
      class_type: 'MiniMaxH3AVDecodeT8',
      _meta: { title: 'MiniMax H3 AV Decode (T8)' },
    },
    '12': {
      inputs: {
        frame_rate: 24.0,
        loop_count: 0,
        filename_prefix: `MiniMaxH3/nana_${jobId}`,
        format: 'video/h264-mp4',
        pix_fmt: 'yuv420p',
        crf: 19,
        save_metadata: true,
        trim_to_audio: false,
        pingpong: false,
        save_output: true,
        images: ['11', 0],
        audio: ['11', 1],
      },
      class_type: 'VHS_VideoCombine',
      _meta: { title: 'Video Combine' },
    },
    '14': {
      inputs: { value: Number(seconds) },
      class_type: 'PrimitiveFloat',
      _meta: { title: 'Float (duration)' },
    },
    '15': {
      inputs: {
        expression: 'max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17',
        'values.a': ['14', 0],
      },
      class_type: 'ComfyMathExpression',
      _meta: { title: '数学表达式' },
    },
    '16': {
      inputs: { aspect_ratio: aspectRatio, megapixels, multiple: 32 },
      class_type: 'ResolutionSelector',
      _meta: { title: '分辨率选择器' },
    },
    '17': {
      inputs: { model: ['1', 0] },
      class_type: 'MiniMaxH3MemoryEfficientSageAttentionPatch',
      _meta: { title: 'MiniMax H3 Mem Eff Sage Attention Patch' },
    },
    '36': {
      inputs: { prompt: normalizedPrompt(prompt) },
      class_type: 'CR Prompt Text',
      _meta: { title: 'CR Prompt Text' },
    },
  };

  imageNames.forEach((imageName, index) => {
    const nodeId = String(41 + index);
    workflow[nodeId] = {
      inputs: { image: imageName },
      class_type: 'LoadImage',
      _meta: { title: `加载图像 ${index + 1}` },
    };
    if (firstAsFrame && index === 0) {
      conditioningInputs.first_frame = [nodeId, 0];
    } else {
      const refIndex = firstAsFrame ? index - 1 : index;
      conditioningInputs[`ref_images.ref_image_${refIndex}`] = [nodeId, 0];
    }
  });

  return {
    workflow,
    taskType,
    length: alignedLength(seconds),
    prompt: workflow['36'].inputs.prompt,
    megapixels: Number(megapixels),
    targetWidth: null,
    targetHeight: null,
  };
}

function bindBestDynamicImages(workflow, conditioningInputsList, imageNames, firstAsFrame) {
  imageNames.forEach((imageName, index) => {
    const nodeId = String(60 + index);
    workflow[nodeId] = {
      inputs: { image: imageName },
      class_type: 'LoadImage',
      _meta: { title: `参考图像 ${index + 1}` },
    };
    for (const conditioningInputs of conditioningInputsList) {
      if (firstAsFrame && index === 0) {
        conditioningInputs.first_frame = [nodeId, 0];
      } else {
        const refIndex = firstAsFrame ? index - 1 : index;
        conditioningInputs[`ref_images.ref_image_${refIndex}`] = [nodeId, 0];
      }
    }
  });
}

function buildBestDynamicWorkflow({ prompt, aspectRatio, seconds, imageNames, firstAsFrame, jobId }) {
  if (aspectRatio !== '16:9 (Widescreen)') {
    throw new Error('最佳动态工作流当前只完成 16:9 实机验收。');
  }
  const taskType = taskTypeFor(imageNames.length, firstAsFrame);
  const normalized = normalizedPrompt(prompt);
  const lowConditioning = {
    clip: ['3', 0],
    video_vae: ['1', 0],
    audio_vae: ['2', 0],
    prompt: ['28', 0],
    width: ['29', 0],
    height: ['29', 1],
    length: ['30', 1],
    task_type: taskType,
    audio_mode: 'native',
    audio_denoise_strength: 1.0,
    add_source_as_reference: false,
    prompt_primary_audio_ordinal: 0,
    strict_prompt_tags: true,
    ref_image_size: 'match',
    reference_video_policy: 'official_2_to_15s',
    allow_above_reference_area: false,
  };
  const highConditioning = {
    clip: ['3', 0],
    video_vae: ['1', 0],
    audio_vae: ['2', 0],
    prompt: ['28', 0],
    width: ['13', 1],
    height: ['13', 2],
    length: ['30', 1],
    task_type: taskType,
    audio_mode: 'native',
    audio_denoise_strength: 1.0,
    add_source_as_reference: false,
    prompt_primary_audio_ordinal: 0,
    strict_prompt_tags: true,
    ref_image_size: 'match',
    reference_video_policy: 'official_2_to_15s',
    allow_above_reference_area: false,
  };
  const workflow = {
    '1': { inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' }, class_type: 'VAELoader' },
    '2': { inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' }, class_type: 'VAELoader' },
    '3': { inputs: { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'default' }, class_type: 'CLIPLoader' },
    '4': { inputs: { unet_name: 'DasiwaMinimaxH3_dasiwaREF2VAHybridV1.safetensors', weight_dtype: 'default' }, class_type: 'UNETLoader' },
    '5': {
      inputs: {
        model: ['4', 0],
        lora_name: 'minimax_h3_turbo_4步加速_DasiwaREF2VAHybridV1_curveproj1025_compat_v001-T8.safetensors',
        strength_model: 1.0,
      },
      class_type: 'LoraLoaderBypassModelOnly',
    },
    '7': { inputs: lowConditioning, class_type: 'MiniMaxH3AudioConditioningT8' },
    '8': {
      inputs: {
        model: ['34', 0],
        av_latent: ['7', 1],
        steps: 8,
        shift_video: 12.0,
        shift_audio: 3.0,
        sampler_name: 'dual_clock_euler',
        scheduler: 'native_flow',
      },
      class_type: 'MiniMaxH3DualClockSamplerT8',
    },
    '10': { inputs: { model: ['8', 0], conditioning: ['7', 0] }, class_type: 'BasicGuider' },
    '11': { inputs: { noise_seed: 123456789 }, class_type: 'RandomNoise' },
    '12': {
      inputs: {
        noise: ['11', 0],
        guider: ['10', 0],
        sampler: ['8', 1],
        sigmas: ['9', 0],
        latent_image: ['7', 1],
      },
      class_type: 'SamplerCustomAdvanced',
    },
    '14': { inputs: highConditioning, class_type: 'MiniMaxH3AudioConditioningT8' },
    '20': {
      inputs: {
        av_latent: ['19', 0],
        video_vae: ['1', 0],
        audio_vae: ['2', 0],
      },
      class_type: 'MiniMaxH3AVDecodeT8',
    },
    '21': {
      inputs: {
        images: ['20', 0],
        audio: ['20', 1],
        frame_rate: 24.0,
        loop_count: 0,
        filename_prefix: `MiniMaxH3/nana_${jobId}`,
        format: 'video/h264-mp4',
        pix_fmt: 'yuv420p',
        crf: 19,
        save_metadata: true,
        trim_to_audio: false,
        pingpong: false,
        save_output: true,
      },
      class_type: 'VHS_VideoCombine',
    },
    '27': { inputs: { value: Number(seconds) }, class_type: 'PrimitiveFloat' },
    '28': { inputs: { prompt: normalized }, class_type: 'CR Prompt Text' },
    '29': { inputs: { aspect_ratio: aspectRatio, megapixels: 0.45, multiple: 32 }, class_type: 'ResolutionSelector' },
    '30': {
      inputs: {
        'values.a': ['27', 0],
        expression: 'max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17',
      },
      class_type: 'ComfyMathExpression',
    },
    '32': { inputs: { model: ['5', 0] }, class_type: 'MiniMaxH3MemoryEfficientSageAttentionPatch' },
    '33': { inputs: { model: ['32', 0], attention: 'pytorch attention' }, class_type: 'ModelAttentionBackend' },
    '34': {
      inputs: {
        model: ['33', 0],
        tau: 1.3,
        start_percent: 0.2,
        end_percent: 0.9,
        min_tokens: 12288,
        sink_conditioning: 'exact_kv_and_rows',
        morton: false,
        morton_curve: '2d_frame',
        centroid_tail: true,
        routed_cap_percent: 0,
        reuse_qkv_memory: false,
        verbose: false,
        dense_blocks: '',
      },
      class_type: 'SolAttnMiniMax',
    },
  };

  workflow['9'] = {
    inputs: { model: ['8', 0], base_steps: 7, coarse_steps: 4, refine_steps: 3 },
    class_type: 'MiniMaxH3LearnedTwoPassParityPlanT8Advanced',
  };
  workflow['13'] = {
    inputs: {
      av_latent: ['12', 1],
      model_name: 'minimax_h3_latent_upscaler_3d_fp16.safetensors',
      size_mode: 'scale_by',
      scale_by: 1.5,
      target_megapixels: 1.0,
      target_width: 1280,
      target_height: 704,
      aspect_policy: 'preserve_source',
      max_anisotropy: 1.05,
      precision: 'fp16',
      release_policy: 'offload_after',
    },
    class_type: 'MiniMaxH3LearnedLatentUpscaleT8Advanced',
  };
  workflow['15'] = {
    inputs: {
      learned_latent: ['13', 0],
      highres_template: ['14', 1],
      positive: ['14', 0],
      audio_policy: 'auto',
      second_pass_audio_source: 'legacy_policy',
      second_pass_audio_strength: 0.0,
    },
    class_type: 'MiniMaxH3TwoPassLatentReconcileT8Advanced',
  };
  workflow['16'] = {
    inputs: {
      model: ['34', 0],
      av_latent: ['15', 0],
      refine_sigmas: ['9', 1],
      shift_video: 12.0,
      shift_audio: 3.0,
      enable_tail: false,
      extra_tail_steps: 1,
      tail_spacing: 'video_sigma_linear',
      enable_model_time_bias: false,
      bias: -0.025,
      bias_start_progress: 0.7,
      bias_end_progress: 0.95,
      bias_domain: 'video_sigma',
      enable_stg: false,
      stg_scale: 0.35,
      stg_double_blocks: '25',
      stg_start_progress: 0.25,
      stg_end_progress: 0.85,
      enable_restart: false,
      restart_video_sigma: 0.15,
      restart_steps: 3,
      restart_seed: 252772444908658,
    },
    class_type: 'MiniMaxH3TwoPassDetailMixerT8Advanced',
  };
  workflow['17'] = { inputs: { model: ['16', 0], conditioning: ['15', 1] }, class_type: 'BasicGuider' };
  workflow['19'] = {
    inputs: {
      noise: ['11', 0],
      guider: ['17', 0],
      sampler: ['16', 1],
      sigmas: ['16', 2],
      latent_image: ['15', 0],
    },
    class_type: 'SamplerCustomAdvanced',
  };

  bindBestDynamicImages(workflow, [lowConditioning, highConditioning], imageNames, firstAsFrame);
  return {
    workflow,
    taskType,
    length: alignedLength(seconds),
    prompt: normalized,
    megapixels: 0.45,
    targetWidth: 1408,
    targetHeight: 768,
  };
}

function buildUltraRefineWorkflow({ prompt, aspectRatio, seconds, imageNames, firstAsFrame, jobId }) {
  if (aspectRatio !== '16:9 (Widescreen)') {
    throw new Error('极致精修工作流当前只完成 16:9 / 1920×1088 实机验收。');
  }
  const taskType = taskTypeFor(imageNames.length, firstAsFrame);
  const normalized = normalizedPrompt(prompt);
  const length = alignedLength(seconds);
  const conditioningInputs = {
    clip: ['3', 0],
    video_vae: ['1', 0],
    audio_vae: ['2', 0],
    prompt: normalized,
    width: 960,
    height: 544,
    length,
    task_type: taskType,
    audio_mode: 'native',
    audio_denoise_strength: 1.0,
    add_source_as_reference: false,
    prompt_primary_audio_ordinal: 0,
    strict_prompt_tags: true,
    ref_image_size: 'match',
    reference_video_policy: 'official_2_to_15s',
    allow_above_reference_area: false,
  };
  // Ref2VA conditioning can be reused after latent upscale. Explicit I2VA/Hybrid
  // first-frame conditioning is spatially sized, so the 1080P second pass needs
  // a separate high-resolution conditioning block to avoid 960x544 keyframe rows
  // being reused against the 1920x1088 latent.
  const highResConditioningInputs = firstAsFrame ? {
    ...conditioningInputs,
    width: 1920,
    height: 1088,
  } : null;
  const workflow = {
    '1': { inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' }, class_type: 'VAELoader' },
    '2': { inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' }, class_type: 'VAELoader' },
    '3': { inputs: { clip_name: 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors', type: 'minimax', device: 'default' }, class_type: 'CLIPLoader' },
    '4': { inputs: { unet_name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', weight_dtype: 'default' }, class_type: 'UNETLoader' },
    '5': {
      inputs: {
        model: ['4', 0],
        lora_name: 'minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors',
        strength_model: 1.0,
      },
      class_type: 'LoraLoaderModelOnly',
    },
    '6': { inputs: { model: ['5', 0], attention: 'comfy kitchen attention' }, class_type: 'ModelAttentionBackend' },
    '7': {
      inputs: {
        model: ['6', 0],
        tau: 1.5,
        start_percent: 0.2,
        end_percent: 0.9,
        min_tokens: 4096,
        int8_qk: true,
        sink_conditioning: 'exact_kv_and_rows',
        morton: false,
        morton_curve: '2d_frame',
        int8_pv: true,
        verbose: false,
        use_tma: false,
        dense_blocks: '',
      },
      class_type: 'SolAttnPatch',
    },
    '10': { inputs: conditioningInputs, class_type: 'MiniMaxH3AudioConditioningT8' },
    '11': { inputs: { model: ['7', 0], conditioning: ['10', 0] }, class_type: 'BasicGuider' },
    '12': { inputs: { model: ['7', 0], scheduler: 'simple', steps: 8, denoise: 1.0 }, class_type: 'BasicScheduler' },
    '13': {
      inputs: { sigmas: ['12', 0], extra_steps: 1, start_at_sigma: 0.7, end_at_sigma: 0.0, spacing: 'cosine' },
      class_type: 'H3SigmaRefiner',
    },
    '14': { inputs: { noise_seed: 123456789 }, class_type: 'RandomNoise' },
    '15': { inputs: { sampler_name: 'euler' }, class_type: 'KSamplerSelect' },
    '16': {
      inputs: {
        noise: ['14', 0],
        guider: ['11', 0],
        sampler: ['15', 0],
        sigmas: ['13', 0],
        latent_image: ['10', 1],
      },
      class_type: 'SamplerCustomAdvanced',
    },
    '17': { inputs: { av_latent: ['16', 1] }, class_type: 'LTXVSeparateAVLatent' },
    '18': {
      inputs: {
        latent: ['17', 0],
        model_name: 'minimax_h3_latent_upscaler_3d_fp16.safetensors',
        mode: 'megapixels',
        'mode.megapixels': 2.0,
        align: 32,
        enable_temporal_chunking: true,
        force_unload: true,
        device: 'cuda',
        precision: 'fp16',
      },
      class_type: 'MinimaxH3LatentUpscaler3D',
    },
    '19': {
      inputs: { video_latent: ['18', 0], audio_latent: ['17', 1] },
      class_type: 'LTXVConcatAVLatent',
    },
    '20': { inputs: { model: ['7', 0], conditioning: highResConditioningInputs ? ['25', 0] : ['10', 0] }, class_type: 'BasicGuider' },
    '21': {
      inputs: { sigmas: '0.9035, 0.8000, 0.6316, 0.3158, 0.0000' },
      class_type: 'ManualSigmas',
    },
    '22': {
      inputs: {
        noise: ['14', 0],
        guider: ['20', 0],
        sampler: ['15', 0],
        sigmas: ['21', 0],
        latent_image: ['19', 0],
      },
      class_type: 'SamplerCustomAdvanced',
    },
    '23': {
      inputs: { av_latent: ['22', 0], video_vae: ['1', 0], audio_vae: ['2', 0] },
      class_type: 'MiniMaxH3AVDecodeT8',
    },
    '24': {
      inputs: {
        images: ['23', 0],
        audio: ['23', 1],
        frame_rate: 24.0,
        loop_count: 0,
        filename_prefix: `MiniMaxH3/nana_${jobId}`,
        format: 'video/h265-mp4',
        pix_fmt: 'yuv420p10le',
        crf: 22,
        save_metadata: true,
        pingpong: false,
        save_output: true,
      },
      class_type: 'VHS_VideoCombine',
    },
  };
  if (highResConditioningInputs) {
    workflow['25'] = { inputs: highResConditioningInputs, class_type: 'MiniMaxH3AudioConditioningT8' };
  }
  bindBestDynamicImages(workflow, highResConditioningInputs ? [conditioningInputs, highResConditioningInputs] : [conditioningInputs], imageNames, firstAsFrame);
  return {
    workflow,
    taskType,
    length,
    prompt: normalized,
    megapixels: 0.5,
    targetWidth: 1920,
    targetHeight: 1088,
  };
}

function buildAutoWorkflow(options) {
  const preset = normalizeH3WorkflowPreset(options.workflowPreset);
  if (preset === 'best_dynamic') return buildBestDynamicWorkflow(options);
  if (preset === 'ultra_refine') return buildUltraRefineWorkflow(options);
  return buildWorkflow(options);
}

async function uploadImage(file, jobId, index) {
  const bytes = await file.arrayBuffer();
  const filename = `${String(index + 1).padStart(2, '0')}_${path.basename(file.name || 'reference.png')}`;
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: file.type || 'application/octet-stream' }), filename);
  form.append('type', 'input');
  form.append('subfolder', `nana-h3/${jobId}`);
  form.append('overwrite', 'true');
  const response = await comfyFetch('/upload/image', { method: 'POST', body: form, timeoutMs: 120_000 });
  const uploaded = await response.json();
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

function jobStorePath(runtime, scope = 'single') {
  return scope === 'auto' ? runtime.autoJobsPath : runtime.jobsPath;
}

async function loadJobs(runtime, scope = 'single') {
  const doc = await readJson(jobStorePath(runtime, scope), { version: 1, jobs: [] });
  if (!Array.isArray(doc.jobs)) doc.jobs = [];
  return doc;
}

async function enrichAutoPlanProgress(runtime, plan) {
  if (!plan?.queue?.length) return plan;
  const jobs = await loadJobs(runtime, 'auto');
  const jobsById = new Map((jobs.jobs || []).map(job => [String(job.id || ''), job]));
  return {
    ...plan,
    queue: plan.queue.map(item => {
      const job = item.jobId ? jobsById.get(String(item.jobId)) : null;
      if (!job) return item;
      const itemOwnsPhase = item.status === 'extracting_frame' || item.status === 'completed' || item.status === 'failed';
      return {
        ...item,
        progressPhase: itemOwnsPhase ? (item.progressPhase || item.status) : (job.progress_phase || item.progressPhase || item.status),
        progressPercent: itemOwnsPhase ? Number(item.progressPercent ?? (item.status === 'completed' ? 100 : 0)) : Number(job.progress_percent ?? item.progressPercent ?? 0),
        progressLabel: itemOwnsPhase ? (item.progressLabel || item.error || '') : (job.progress_label || item.progressLabel || ''),
        progressValue: Number(job.progress_value || 0),
        progressMax: Number(job.progress_max || 0),
        progressUpdatedAt: String(job.updated_at || item.progressUpdatedAt || ''),
        error: item.error || job.error || '',
      };
    }),
  };
}

async function loadLegacyFreeIslandJobs(runtime) {
  let entries;
  try {
    entries = await readdir(runtime.legacyOutputDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const legacyEntries = entries.filter(entry => {
    const name = entry.name.toLowerCase();
    return entry.isFile()
      && name.endsWith('.mp4')
      && !name.startsWith('h3-auto-')
      && !name.startsWith('h3-story-sequence-')
      && !name.startsWith('outline_');
  });
  const jobs = await Promise.all(legacyEntries.map(async entry => {
    const outputPath = path.join(runtime.legacyOutputDir, entry.name);
    const fileStat = await stat(outputPath);
    return {
      id: `legacy-${entry.name}`,
      status: 'completed',
      prompt: `历史 H3 成品：${entry.name}`,
      prompt_sent: '',
      aspect_ratio: '16:9 (Widescreen)',
      seconds: 15,
      megapixels: 0.9,
      length: alignedLength(15),
      image_count: 0,
      generation_mode: 'text',
      first_as_frame: false,
      task_type: 'T2VA',
      progress_phase: 'completed',
      progress_percent: 100,
      progress_label: '历史成品（只读恢复）',
      created_at: fileStat.birthtime.toISOString(),
      updated_at: fileStat.mtime.toISOString(),
      output_path: outputPath,
      output_name: entry.name,
      legacy_history: true,
    };
  }));
  return jobs.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

async function saveJob(runtime, job, scope = 'single') {
  const storePath = jobStorePath(runtime, scope);
  const previous = JOB_SAVE_CHAINS.get(storePath) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const doc = await loadJobs(runtime, scope);
    const index = doc.jobs.findIndex(item => item.id === job.id);
    if (index >= 0) doc.jobs[index] = { ...job };
    else doc.jobs.unshift({ ...job });
    doc.jobs = doc.jobs.slice(0, 100);
    doc.updated_at = new Date().toISOString();
    await writeJsonAtomic(storePath, doc);
  });
  JOB_SAVE_CHAINS.set(storePath, next);
  try {
    await next;
  } finally {
    if (JOB_SAVE_CHAINS.get(storePath) === next) JOB_SAVE_CHAINS.delete(storePath);
  }
}

async function migrateLegacyAutoJobs(runtime) {
  const single = await loadJobs(runtime, 'single');
  const legacy = single.jobs.filter(job => job?.auto_comic?.stage === 'sequence');
  if (!legacy.length) return { moved: 0, remaining: 0 };

  const auto = await loadJobs(runtime, 'auto');
  const merged = new Map((auto.jobs || []).map(job => [job.id, job]));
  for (const job of legacy) merged.set(job.id, job);
  auto.jobs = [...merged.values()]
    .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))
    .slice(0, 100);
  auto.updated_at = new Date().toISOString();
  await writeJsonAtomic(runtime.autoJobsPath, auto);

  single.jobs = single.jobs.filter(job => job?.auto_comic?.stage !== 'sequence');
  single.updated_at = new Date().toISOString();
  await writeJsonAtomic(runtime.jobsPath, single);
  return { moved: legacy.length, remaining: single.jobs.length };
}

const H3_NODE_PROGRESS = {
  standard: {
    '1': [11, '加载 H3 模型', 'loading'],
    '2': [12, '加载极速 LoRA', 'loading'],
    '3': [13, '加载文本模型', 'loading'],
    '4': [13, '加载视频 VAE', 'loading'],
    '5': [13, '加载音频 VAE', 'loading'],
    '6': [14, '准备图像与音频条件', 'conditioning'],
    '7': [15, '配置双时钟采样器', 'conditioning'],
    '8': [15, '建立引导条件', 'conditioning'],
    '9': [16, '准备初始噪声', 'conditioning'],
    '10': [17, '极速文戏 · 视频采样', 'sampling'],
    '11': [94, '解码视频与音频', 'decoding'],
    '12': [97, '封装 MP4 成品', 'encoding'],
    '17': [14, '应用注意力优化', 'loading'],
  },
  best_dynamic: {
    '1': [11, '加载视频 VAE', 'loading'],
    '2': [11, '加载音频 VAE', 'loading'],
    '3': [12, '加载文本模型', 'loading'],
    '4': [12, '加载动态模型', 'loading'],
    '5': [13, '加载动态增强 LoRA', 'loading'],
    '7': [15, '准备低分辨率条件', 'conditioning'],
    '8': [16, '配置首轮采样器', 'conditioning'],
    '12': [20, '动态增强 · 首轮采样', 'sampling_first'],
    '13': [53, '动态增强 · Latent 放大', 'upscaling'],
    '14': [69, '准备高分辨率条件', 'conditioning_high'],
    '15': [71, '对齐高分辨率 Latent', 'conditioning_high'],
    '16': [73, '配置细节二采', 'conditioning_high'],
    '19': [75, '动态增强 · 高分辨率二采', 'sampling_second'],
    '20': [94, '解码视频与音频', 'decoding'],
    '21': [97, '封装 MP4 成品', 'encoding'],
  },
  ultra_refine: {
    '1': [11, '加载视频 VAE', 'loading'],
    '2': [11, '加载音频 VAE', 'loading'],
    '3': [12, '加载 INT8 文本模型', 'loading'],
    '4': [12, '加载极致精修模型', 'loading'],
    '5': [13, '加载 Turbo v4 LoRA', 'loading'],
    '6': [14, '应用 Comfy Kitchen Attention', 'loading'],
    '7': [14, '应用 SolAttn', 'loading'],
    '10': [16, '准备 960×544 条件', 'conditioning'],
    '16': [20, '极致精修 · 9 步首采', 'sampling_first'],
    '17': [49, '拆分音视频 Latent', 'upscaling'],
    '18': [51, '极致精修 · 2MP Latent Upscale', 'upscaling'],
    '19': [76, '合并高分辨率 Latent', 'conditioning_high'],
    '20': [77, '建立 1080P 引导条件', 'conditioning_high'],
    '21': [78, '准备 1080P 二采 Sigmas', 'conditioning_high'],
    '22': [80, '极致精修 · 1080P 二采', 'sampling_second'],
    '23': [95, '解码 1080P 视频与音频', 'decoding'],
    '24': [97, '封装 H265 成品', 'encoding'],
    '25': [77, '准备 1080P 首帧条件', 'conditioning_high'],
  },
};

function h3NodeProgress(job, nodeId) {
  const preset = normalizeH3WorkflowPreset(job?.workflow_preset || 'standard');
  return H3_NODE_PROGRESS[preset]?.[String(nodeId)] || [Math.max(11, Number(job?.progress_percent) || 11), '执行 H3 工作流', 'running'];
}

function h3ProgressRange(job, nodeId) {
  const preset = normalizeH3WorkflowPreset(job?.workflow_preset || 'standard');
  const ranges = {
    standard: {
      '10': [17, 91, '极速文戏 · 视频采样', 'sampling'],
    },
    best_dynamic: {
      '12': [20, 52, '动态增强 · 首轮采样', 'sampling_first'],
      '13': [53, 68, '动态增强 · Latent 放大', 'upscaling'],
      '19': [75, 93, '动态增强 · 高分辨率二采', 'sampling_second'],
    },
    ultra_refine: {
      '16': [20, 48, '极致精修 · 9 步首采', 'sampling_first'],
      '18': [51, 75, '极致精修 · 2MP Latent Upscale', 'upscaling'],
      '22': [80, 94, '极致精修 · 1080P 二采', 'sampling_second'],
    },
  };
  return ranges[preset]?.[String(nodeId)] || [17, 91, '视频采样', 'sampling'];
}

function rememberFailureStage(job) {
  job.failed_phase = job.progress_phase || job.failed_phase || '';
  job.failed_node = job.progress_node || job.failed_node || '';
  job.failed_label = job.progress_label || job.failed_label || '';
  job.failed_at = new Date().toISOString();
}

async function updateTrackedJob(promptId, mutate) {
  const tracked = ACTIVE_JOBS.get(promptId);
  if (!tracked) return;
  mutate(tracked.job);
  tracked.job.updated_at = new Date().toISOString();
  await saveJob(tracked.runtime, tracked.job, tracked.scope || 'single');
}

async function handleProgressMessage(raw) {
  if (typeof raw !== 'string') return;
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  const data = message.data || {};
  const promptId = data.prompt_id;
  if (!promptId || !ACTIVE_JOBS.has(promptId)) return;

  if (message.type === 'execution_start') {
    await updateTrackedJob(promptId, job => {
      job.status = 'running';
      job.progress_phase = 'starting';
      job.progress_percent = Math.max(Number(job.progress_percent) || 0, 1);
      job.progress_label = 'H3 GPU 已开始执行';
    });
    return;
  }

  if (message.type === 'executing') {
    await updateTrackedJob(promptId, job => {
      if (data.node === null) {
        job.status = 'retrieving';
        job.progress_phase = 'retrieving';
        job.progress_percent = Math.max(Number(job.progress_percent) || 0, 98);
        job.progress_label = '生成完成，正在回传到当前 H3 项目';
        return;
      }
      const nodeId = String(data.node);
      const [percent, label, phase] = h3NodeProgress(job, nodeId);
      job.status = 'running';
      job.progress_phase = phase;
      job.progress_node = nodeId;
      job.progress_value = undefined;
      job.progress_max = undefined;
      job.progress_percent = Math.max(Number(job.progress_percent) || 0, percent);
      job.progress_label = label;
    });
    return;
  }

  if (message.type === 'progress') {
    const value = Number(data.value);
    const max = Number(data.max);
    if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return;
    await updateTrackedJob(promptId, job => {
      const ratio = Math.max(0, Math.min(1, value / max));
      const nodeId = String(data.node ?? job.progress_node ?? '');
      const [startPercent, endPercent, label, phase] = h3ProgressRange(job, nodeId);
      job.status = 'running';
      job.progress_phase = phase;
      if (nodeId) job.progress_node = nodeId;
      job.progress_value = value;
      job.progress_max = max;
      job.progress_percent = Math.max(Number(job.progress_percent) || 0, startPercent + Math.round(ratio * (endPercent - startPercent)));
      job.progress_label = `${label} ${value}/${max}`;
    });
    return;
  }

  if (message.type === 'execution_error') {
    await updateTrackedJob(promptId, job => {
      rememberFailureStage(job);
      job.status = 'failed';
      job.progress_phase = 'failed';
      job.progress_label = 'ComfyUI 执行失败';
      job.error = data.exception_message || 'ComfyUI 执行失败，请查看ComfyUI 节点日志。';
    });
    ACTIVE_JOBS.delete(promptId);
  }
}

async function connectProgressSocket() {
  clearTimeout(progressReconnectTimer);
  try {
    const { comfyUrl } = await readConfig();
    const socketUrl = new URL('/ws', `${comfyUrl}/`);
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    socketUrl.searchParams.set('clientId', CLIENT_ID);
    const socket = new WebSocket(socketUrl);
    progressSocket = socket;
    socket.addEventListener('message', event => void handleProgressMessage(event.data));
    socket.addEventListener('error', () => {
      if (progressSocket !== socket) return;
      progressSocket = undefined;
      progressReconnectTimer = setTimeout(() => void connectProgressSocket(), 3000);
    });
    socket.addEventListener('close', () => {
      if (progressSocket !== socket) return;
      progressSocket = undefined;
      progressReconnectTimer = setTimeout(() => void connectProgressSocket(), 3000);
    });
  } catch {
    progressReconnectTimer = setTimeout(() => void connectProgressSocket(), 3000);
  }
}

function findMedia(value, results = []) {
  if (!value) return results;
  if (Array.isArray(value)) {
    value.forEach(item => findMedia(item, results));
    return results;
  }
  if (typeof value !== 'object') return results;
  if (typeof value.filename === 'string') results.push(value);
  Object.values(value).forEach(item => findMedia(item, results));
  return results;
}

async function downloadOutput(runtime, media, jobId) {
  const params = new URLSearchParams({
    filename: media.filename,
    subfolder: media.subfolder || '',
    type: media.type || 'output',
  });
  const response = await comfyFetch(`/view?${params.toString()}`, { timeoutMs: 120_000 });
  const extension = path.extname(media.filename) || '.mp4';
  const outputName = `${jobId}${extension}`;
  const outputPath = path.join(runtime.outputDir, outputName);
  await mkdir(runtime.outputDir, { recursive: true });
  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  return { outputPath, outputName };
}

async function monitorJob(runtime, job, scope = 'single') {
  const deadline = Date.now() + 60 * 60 * 1000;
  let consecutivePollFailures = 0;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2500));
    try {
      const response = await comfyFetch(`/history/${encodeURIComponent(job.prompt_id)}`, { timeoutMs: 15_000 });
      const history = await response.json();
      consecutivePollFailures = 0;
      const record = history[job.prompt_id];
      if (!record) continue;
      const statusText = record.status?.status_str || '';
      const executionError = record.status?.messages?.find(item => item?.[0] === 'execution_error')?.[1];
      if (statusText === 'error' || record.status?.completed === false && executionError) {
        rememberFailureStage(job);
        job.status = 'failed';
        job.progress_phase = 'failed';
        job.progress_label = 'ComfyUI 执行失败';
        job.error = executionError?.exception_message || executionError?.exception_type || 'ComfyUI 执行失败，请查看ComfyUI 节点日志。';
        job.updated_at = new Date().toISOString();
        await saveJob(runtime, job, scope);
        ACTIVE_JOBS.delete(job.prompt_id);
        if (/out of memory|cuda|acceleratorerror/i.test(String(job.error || ''))) await freeComfyMemory('执行错误后释放');
        return;
      }
      const media = findMedia(record.outputs).find(item => /\.(mp4|webm|mov)$/i.test(item.filename))
        || findMedia(record.outputs)[0];
      if (!media) continue;
      job.status = 'retrieving';
      job.progress_phase = 'retrieving';
      job.progress_percent = 98;
      job.progress_label = '生成完成，正在回传到当前 H3 项目';
      job.updated_at = new Date().toISOString();
      await saveJob(runtime, job, scope);
      const downloaded = await downloadOutput(runtime, media, job.id);
      job.status = 'completed';
      job.progress_phase = 'completed';
      job.progress_percent = 100;
      job.progress_label = '已完成并归档到当前 H3 项目';
      job.output_path = downloaded.outputPath;
      job.output_name = downloaded.outputName;
      job.updated_at = new Date().toISOString();
      await saveJob(runtime, job, scope);
      ACTIVE_JOBS.delete(job.prompt_id);
      return;
    } catch (error) {
      consecutivePollFailures += 1;
      job.last_poll_error = errorMessage(error);
      job.updated_at = new Date().toISOString();
      if (consecutivePollFailures >= 12) {
        rememberFailureStage(job);
        job.status = 'failed';
        job.progress_phase = 'failed';
        job.progress_label = 'ComfyUI 已连续离线 30 秒';
        job.error = `ComfyUI 在任务执行期间连续 30 秒不可访问：${job.last_poll_error}`;
        await saveJob(runtime, job, scope);
        ACTIVE_JOBS.delete(job.prompt_id);
        return;
      }
      await saveJob(runtime, job, scope);
    }
  }
  rememberFailureStage(job);
  job.status = 'failed';
  job.progress_phase = 'failed';
  job.progress_label = '等待ComfyUI 超时';
  job.error = '等待ComfyUI 超过 60 分钟。';
  job.updated_at = new Date().toISOString();
  await saveJob(runtime, job, scope);
  ACTIVE_JOBS.delete(job.prompt_id);
}

async function resumePendingJobs() {
  try {
    const runtime = await projectRuntime();
    let resumed = 0;
    for (const scope of ['single', 'auto']) {
      const doc = await loadJobs(runtime, scope);
      const pending = doc.jobs.filter(job =>
        job?.prompt_id
        && !job.output_path
        && ['queued', 'running', 'retrieving'].includes(job.status)
      );
      for (const job of pending) {
        if (ACTIVE_JOBS.has(job.prompt_id)) continue;
        ACTIVE_JOBS.set(job.prompt_id, { runtime, job, scope });
        void monitorJob(runtime, job, scope);
        resumed += 1;
      }
    }
    if (resumed > 0) {
      console.log(`Resumed ${resumed} unfinished H3 job(s).`);
    }
  } catch (error) {
    console.error(`Unable to resume unfinished H3 jobs: ${errorMessage(error)}`);
  }
}

async function parseMultipart(req) {
  const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: 'half',
  });
  return request.formData();
}

async function parseJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function safeFreeIslandImageName(name, index = 0) {
  const base = path.basename(String(name || `reference-${index + 1}.png`)).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  return `${String(index + 1).padStart(2, '0')}_${base || `reference-${index + 1}.png`}`;
}

function comfyPromptGraph(record) {
  const raw = record?.prompt;
  if (Array.isArray(raw)) {
    const graph = raw.find(value => value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).some(node => node?.class_type));
    return graph || {};
  }
  return raw && typeof raw === 'object' ? raw : {};
}

function referenceImagePathsFromGraph(graph) {
  return Object.entries(graph || {})
    .filter(([, node]) => node?.class_type === 'LoadImage' && typeof node?.inputs?.image === 'string')
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, node]) => String(node.inputs.image));
}

function comfyImageParts(remotePath) {
  const normalized = String(remotePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  const filename = parts.pop() || '';
  return { filename, subfolder: parts.join('/') };
}

async function saveFreeIslandInputCopy(runtime, jobId, file, index) {
  const dir = path.join(runtime.freeIslandInputDir, jobId);
  await mkdir(dir, { recursive: true });
  const name = safeFreeIslandImageName(file?.name, index);
  const localPath = path.join(dir, name);
  await writeFile(localPath, Buffer.from(await file.arrayBuffer()));
  return { name: path.basename(String(file?.name || name)), local_path: localPath, remote_path: '' };
}

async function recoverFreeIslandReferenceImages(runtime, job) {
  const known = Array.isArray(job.reference_images) ? job.reference_images.map(item => ({ ...item })) : [];
  let remotePaths = known.map(item => item.remote_path).filter(Boolean);
  if (!remotePaths.length && job.prompt_id) {
    const response = await comfyFetch(`/history/${encodeURIComponent(job.prompt_id)}`, { timeoutMs: 15_000 });
    const history = await response.json();
    remotePaths = referenceImagePathsFromGraph(comfyPromptGraph(history[job.prompt_id]));
  }
  const count = Math.max(known.length, remotePaths.length);
  if (!count) return [];
  const dir = path.join(runtime.freeIslandInputDir, job.id);
  await mkdir(dir, { recursive: true });
  const recovered = [];
  for (let index = 0; index < count; index++) {
    const existing = known[index] || {};
    const remotePath = existing.remote_path || remotePaths[index] || '';
    let localPath = existing.local_path && existsSync(existing.local_path) ? existing.local_path : '';
    let displayName = existing.name || '';
    if (!localPath && remotePath) {
      const { filename, subfolder } = comfyImageParts(remotePath);
      if (filename) {
        const params = new URLSearchParams({ filename, subfolder, type: 'input' });
        const response = await comfyFetch(`/view?${params.toString()}`, { timeoutMs: 30_000 });
        const name = safeFreeIslandImageName(filename.replace(/^\d+_/, ''), index);
        localPath = path.join(dir, name);
        await writeFile(localPath, Buffer.from(await response.arrayBuffer()));
        displayName ||= filename.replace(/^\d+_/, '');
      }
    }
    if (localPath && existsSync(localPath)) {
      recovered.push({ name: displayName || path.basename(localPath).replace(/^\d+_/, ''), local_path: localPath, remote_path: remotePath });
    }
  }
  return recovered;
}

function ensureFreeIslandReusePath(runtime, localPath) {
  const root = path.resolve(runtime.freeIslandInputDir);
  const resolved = path.resolve(String(localPath || ''));
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return '';
  return resolved;
}

async function serveOutput(req, res, jobId, scope = 'single') {
  const runtime = await projectRuntime();
  const doc = await loadJobs(runtime, scope);
  let job = doc.jobs.find(item => item.id === jobId);
  if (!job && scope === 'single' && jobId.startsWith('legacy-')) {
    const legacyName = jobId.slice('legacy-'.length);
    if (legacyName === path.basename(legacyName) && legacyName.toLowerCase().endsWith('.mp4')) {
      const legacyPath = path.join(runtime.legacyOutputDir, legacyName);
      if (existsSync(legacyPath)) job = { output_path: legacyPath };
    }
  }
  if (!job?.output_path || !existsSync(job.output_path)) {
    sendJson(res, 404, { error: '找不到生成结果。' });
    return;
  }
  const statName = path.basename(job.output_path);
  const fileStat = await stat(job.output_path);
  const range = req.headers.range;
  const commonHeaders = {
    'content-type': 'video/mp4',
    'content-disposition': `inline; filename="${encodeURIComponent(statName)}"`,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'accept-ranges': 'bytes',
  };
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.writeHead(416, { ...commonHeaders, 'content-range': `bytes */${fileStat.size}` });
      res.end();
      return;
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), fileStat.size - 1) : fileStat.size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= fileStat.size) {
      res.writeHead(416, { ...commonHeaders, 'content-range': `bytes */${fileStat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...commonHeaders,
      'content-range': `bytes ${start}-${end}/${fileStat.size}`,
      'content-length': end - start + 1,
    });
    createReadStream(job.output_path, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...commonHeaders, 'content-length': fileStat.size });
  createReadStream(job.output_path).pipe(res);
}

function loadEnvFileValues(filePath) {
  const values = {};
  try {
    const text = readFileSync(filePath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      values[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  } catch {}
  return values;
}

function glmConfig() {
  const fileValues = loadEnvFileValues(H3_ENV_PATH);
  return {
    apiKey: String(process.env.GLM_API_KEY || process.env.API_KEY || fileValues.GLM_API_KEY || fileValues.API_KEY || '').trim(),
    baseUrl: String(process.env.GLM_BASE_URL || fileValues.GLM_BASE_URL || 'https://open.bigmodel.cn/api/anthropic').trim().replace(/\/+$/, ''),
    model: String(process.env.GLM_MODEL || fileValues.GLM_MODEL || 'glm-5.3').trim(),
  };
}

function parseH3Json(text, errorMessage) {
  const cleaned = String(text || '').replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const starts = [cleaned.indexOf('{'), cleaned.indexOf('[')].filter(index => index >= 0);
    const ends = [cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']')].filter(index => index >= 0);
    if (starts.length && ends.length) {
      const candidate = cleaned.slice(Math.min(...starts), Math.max(...ends) + 1).replace(/,\s*([}\]])/g, '$1');
      try { return JSON.parse(candidate); } catch {}
    }
    throw new Error(errorMessage);
  }
}

function normalizeSequenceShotFormatting(videoPrompt) {
  return String(videoPrompt || '')
    .replace(/([^\n])(shot\d+\(\d+s-\d+s\))/g, '$1\n$2')
    .replace(/(shot\d+\(\d+s-\d+s\))[ \t]*(?!\n)/g, '$1\n');
}

const DIRECTOR_READ_FIELDS = [
  'dramaticFunction', 'turn', 'viewerPOV', 'relationshipShift', 'objective',
  'obstacle', 'visibleBehavior', 'visualIntention', 'cameraPrinciple', 'genreRefusal',
];

const GENERATION_AUDIT_FIELDS = [
  'appearanceCheck', 'assetBoundaryCheck', 'timelineCheck', 'dialogueCheck', 'transitionCheck',
];

const VISUAL_APPEARANCE_PATTERN = /(发色|发型|黑发|棕发|金发|白发|银发|红发|蓝发|紫发|短发|长发|卷发|直发|肤色|瞳色|皮肤|脸型|五官|眉骨|下颌线|鼻梁|面部轮廓|身穿|穿着|穿上|披着|换上|衣服|服装|雨衣|针织衫|衬衫|长袍|铠甲|裙子|裤子|鞋子|靴子)/i;
const POST_TRANSITION_PATTERN = /(交叉溶解|交叉淡化|叠化|溶解转场|溶解|淡入|淡出|渐入|渐出|渐隐|渐显|闪黑|闪白|黑闪|白闪|闪白闪黑|闪黑闪白|从黑场|从白场|到黑场|到白场|fade\s*-?\s*in|fade\s*-?\s*out|fade\s*to\s*(?:black|white)|flash\s*(?:black|white)|(?:black|white)\s*flash)/i;

function findVisualAppearanceViolation(text) {
  const source = String(text || '');
  for (const match of source.matchAll(new RegExp(VISUAL_APPEARANCE_PATTERN.source, 'gi'))) {
    const before = source.slice(Math.max(0, match.index - 18), match.index);
    if (/(不改变|不出现|不写|不要写|禁止|避免|不能|不得|无需|不描述|不新增|不复述|由参考资产图|由资产图)/.test(before)) continue;
    return { term: match[0], index: match.index || 0 };
  }
  return null;
}

function findPostTransitionViolation(text) {
  const source = String(text || '');
  const match = source.match(POST_TRANSITION_PATTERN);
  return match ? { term: match[0], index: match.index || 0 } : null;
}

function sanitizeSequenceTransitionText(text) {
  return String(text || '').split(/\r?\n/).filter(line => {
    if (/^\s*(?:台词|对白|旁白|画外音|OS)/.test(line)) return true;
    return !findPostTransitionViolation(line);
  }).join('\n').trim();
}

function sanitizeSequenceResult(result) {
  const directorRead = { ...(result?.directorRead || {}) };
  for (const field of DIRECTOR_READ_FIELDS) {
    directorRead[field] = sanitizeSequenceTransitionText(directorRead[field]);
    if (!directorRead[field]) directorRead[field] = '围绕本段唯一的可见动作推进叙事。';
  }
  return {
    ...result,
    directorRead,
    videoPrompt: sanitizeSequenceTransitionText(result?.videoPrompt),
  };
}

function visualSections(videoPrompt) {
  return ['【场景设定】', '【画面内容】'].map((heading, index, headings) => {
    const start = videoPrompt.indexOf(heading);
    if (start < 0) return '';
    const contentStart = start + heading.length;
    const nextStarts = headings.slice(index + 1)
      .map(nextHeading => videoPrompt.indexOf(nextHeading, contentStart))
      .filter(position => position >= 0);
    const end = nextStarts.length ? Math.min(...nextStarts) : videoPrompt.length;
    return videoPrompt.slice(contentStart, end);
  }).join('\n');
}

function stripApprovedAudioLines(text) {
  return String(text || '').split(/\r?\n/).filter(line => !/^\s*(?:台词|旁白)(?:（[^）]*）|\([^)]*\))?\s*[：:]/.test(line)).join('\n');
}

function normalizeSpeechText(value) {
  return String(value || '').normalize('NFKC').replace(/[^\p{L}\p{N}\u3400-\u9FFF]/gu, '');
}

function extractSourceSpeech(text, allowedSpeakers = null) {
  const speakerSet = Array.isArray(allowedSpeakers) ? new Set(allowedSpeakers.map(value => String(value || '').trim()).filter(Boolean)) : null;
  return String(text || '').split(/\r?\n/).flatMap(line => {
    if (speakerSet) {
      const names = [...speakerSet].sort((a, b) => b.length - a.length);
      if (names.length) {
        const escaped = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const matches = [...line.matchAll(new RegExp(`(${escaped})\\s*[：:]`, 'g'))];
        if (matches.length) {
          return matches.map((match, index) => {
            const speaker = String(match[1] || '').trim();
            const start = (match.index || 0) + match[0].length;
            const end = index + 1 < matches.length ? (matches[index + 1].index || line.length) : line.length;
            return { speaker, text: line.slice(start, end).trim() };
          }).filter(item => item.speaker && item.text);
        }
      }
    }
    const match = /^\s*([^：:\n]{1,30})\s*[：:]\s*(.+?)\s*$/.exec(line);
    if (!match) return [];
    const speaker = match[1].trim();
    const speech = match[2].trim();
    if (speakerSet && !speakerSet.has(speaker)) return [];
    return speaker && speech ? [{ speaker, text: speech }] : [];
  });
}

function splitH3NarrationLine(text) {
  return String(text || '').match(/[^。！？!?；;]+[。！？!?；;](?:[”"’』」）】])?|[^。！？!?；;]+$/g)?.map(value => value.trim()).filter(Boolean) || [];
}

function collectSpeechLines(shots) {
  return (Array.isArray(shots) ? shots : []).flatMap(shot => (
    Array.isArray(shot?.speech) ? shot.speech.map(line => ({
      speaker: String(line?.speaker || '').trim(),
      text: String(line?.text || '').trim(),
    })).filter(line => line.text) : shot?.text ? [{
      speaker: String(shot?.speaker || '').trim(),
      text: String(shot.text).trim(),
    }] : extractSourceSpeech(shot?.sourceText || shot?.description)
  ));
}

function estimateSpeechSeconds(lines) {
  const normalized = lines.map(line => normalizeSpeechText(line.text)).filter(Boolean);
  if (!normalized.length) return 0;
  // 以较宽松但可说完的中文口播速度估算；不额外硬扣动作时间，15 秒内只拦截明显说不完的台词。
  // 中文科普旁白按自然清晰的约 4.5 字/秒估算，给停顿保留余量，避免把完整台词误判为超过 H3 单条上限。
  return normalized.reduce((seconds, text) => seconds + text.length / 4.5, 0) + normalized.length * 0.45;
}

function extractPromptSpeech(videoPrompt) {
  const lines = [];
  // 声音标记可能被 GLM 放在镜头描述中间；按标记提取，不能要求它必须位于行首。
  const markerPattern = /(?:台词|对白|旁白|画外音|OS)\s*(?:[（(][^）)]*[）)])?\s*[：:]/gu;
  const matches = [...String(videoPrompt || '').matchAll(markerPattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = (match.index || 0) + match[0].length;
    const nextMarker = index + 1 < matches.length ? (matches[index + 1].index || String(videoPrompt || '').length) : String(videoPrompt || '').length;
    const nextShot = String(videoPrompt || '').slice(start, nextMarker).search(/shot\d+\(\d+s-\d+s\)/i);
    const rawSegment = String(videoPrompt || '').slice(start, nextShot >= 0 ? start + nextShot : nextMarker).trim();
    let value = rawSegment;
    const pairs = [['“', '”'], ['「', '」'], ['『', '』'], ['"', '"']];
    const pair = pairs.find(([open]) => value.startsWith(open));
    if (pair) {
      const closing = value.lastIndexOf(pair[1]);
      if (closing > 0) value = value.slice(1, closing);
    } else {
      value = value.split(/\s*[|｜]\s*(?=(?:远景|全景|中景|近景|特写|固定|缓慢|镜头|画面))/i)[0].trim();
    }
    const text = normalizeSpeechText(value);
    if (text) lines.push(text);
  }
  return lines;
}

function validateDialogue(videoPrompt, durationSeconds, expectedSpeech) {
  const expected = collectSpeechLines(expectedSpeech);
  const actualLines = extractPromptSpeech(videoPrompt);
  if (!expected.length) {
    if (actualLines.length) throw new Error('GLM-5.3 在原文没有台词或旁白时新增了朗读内容。');
    return;
  }
  const expectedText = expected.map(line => normalizeSpeechText(line.text)).join('');
  const actualText = actualLines.join('');
  if (!actualText || actualText !== expectedText) {
    const candidates = String(videoPrompt).split(/\r?\n/).filter(line => /台词|对白|旁白|画外音|OS/i.test(line)).slice(0, 8).join(' | ').slice(0, 360);
    throw new Error(`GLM-5.3 返回的台词与原文不一致：期望“${expectedText}”，实际“${actualText}”；候选声音行：“${candidates}”；必须逐字保留、按原顺序出现，不能改写、重复、补写或提前说后续台词。`);
  }
  const estimatedSeconds = estimateSpeechSeconds(expected);
  if (estimatedSeconds > durationSeconds) {
    throw new Error(`GLM-5.3 返回的台词按宽松语速估算约需 ${estimatedSeconds.toFixed(1)} 秒，超过 Sequence 的 ${durationSeconds} 秒，无法保证完整说完。`);
  }
}

function validateGlmSequenceResult(result, durationSeconds, expectedSpeech = []) {
  const read = result?.directorRead;
  if (!read || DIRECTOR_READ_FIELDS.some(field => !String(read[field] || '').trim())) {
    throw new Error('GLM-5.3 返回的 Sequence 缺少完整 Director Read（10 项导演判断）。');
  }
  const videoPrompt = String(result?.videoPrompt || '').trim();
  if (!videoPrompt) throw new Error('GLM-5.3 没有返回 videoPrompt。');
  for (const heading of ['【生成规格】', '【导演原则】', '【场景设定】', '【声音设定】', '【氛围与画质】', '【画面内容】', '【生成限制】']) {
    if (!videoPrompt.includes(heading)) throw new Error(`GLM-5.3 返回的 videoPrompt 缺少固定结构：${heading}`);
  }
  if (/\d+\.\d+s/i.test(videoPrompt)) throw new Error('GLM-5.3 返回了小数时间码；H3 只接受整数秒。');
  if (/(?:0-3s|3-6s|6-10s|10-15s)/i.test(videoPrompt)) {
    throw new Error('GLM-5.3 返回了旧的 0-3s / 3-6s / 6-10s / 10-15s 模板。');
  }
  if (/\[(?:[^\]]*景|[^\]]*拍|[^\]]*镜头)[^\]]*\]/.test(videoPrompt)) {
    throw new Error('GLM-5.3 返回了旧式复杂括号镜头标签。');
  }
  const blocks = [...videoPrompt.matchAll(/shot(\d+)\((\d+)s-(\d+)s\)/g)];
  if (!blocks.length) throw new Error('GLM-5.3 返回的 videoPrompt 没有 shot1(0s-3s) 格式的 Shot。');
  let cursor = 0;
  let previousNumber = 0;
  for (const block of blocks) {
    const number = Number(block[1]);
    const start = Number(block[2]);
    const end = Number(block[3]);
    if (number !== previousNumber + 1 || start !== cursor || end <= start) {
      throw new Error('GLM-5.3 返回的 Shot 时间轴不连续或顺序错误。');
    }
    const headerEnd = block.index + block[0].length;
    if (videoPrompt[headerEnd] !== '\n') throw new Error('GLM-5.3 的 Shot 标题必须独占一行，不能把景别写在 shotN(...) 同一行。');
    cursor = end;
    previousNumber = number;
  }
  if (cursor !== durationSeconds) {
    throw new Error(`GLM-5.3 返回的 Shot 时间轴结束于 ${cursor}s，不等于 Sequence 总时长 ${durationSeconds}s。`);
  }
  // H3 上限只有 15 秒，不按总时长强制计算 Shot 数；只要求每个 Shot 有独立动作、时间轴连续且可执行。
  if (/【匹配资产】|asset[_-]?id|上传参考图|上传说明/i.test(videoPrompt)) {
    throw new Error('GLM-5.3 把资产匹配或上传说明混入了 videoPrompt。');
  }
  const generatedNarrative = [
    ...DIRECTOR_READ_FIELDS.map(field => String(read[field] || '')),
    // 已批准台词/旁白属于声音内容，必须逐字保留；外观审核只扫描视觉正文和 endState。
    stripApprovedAudioLines(visualSections(videoPrompt)),
    String(result?.endState || ''),
  ].join('\n');
  const transitionMatch = findPostTransitionViolation(generatedNarrative);
  if (transitionMatch) {
    throw new Error(`GLM-5.3 在生成内容中写入了后期转场方式（命中：${transitionMatch.term}）；镜头交接、片头和片尾必须直接从有效画面开始或结束，后期转场不写进生成提示词。`);
  }
  const appearanceMatch = findVisualAppearanceViolation(generatedNarrative);
  if (appearanceMatch) {
    const context = generatedNarrative.slice(Math.max(0, appearanceMatch.index - 24), Math.min(generatedNarrative.length, appearanceMatch.index + appearanceMatch.term.length + 24)).replace(/\s+/g, ' ');
    throw new Error(`GLM-5.3 在生成内容中复述了资产外观（命中：${appearanceMatch.term}，上下文：${context}）；外观必须由参考资产图决定。`);
  }
  const audit = result?.generationAudit;
  if (!audit || GENERATION_AUDIT_FIELDS.some(field => !String(audit[field] || '').trim())) {
    throw new Error('GLM-5.3 返回的生成 Agent 审核不完整。');
  }
  if (String(audit.appearanceCheck).toLowerCase() !== 'pass') {
    throw new Error('生成 Agent 审核未通过：videoPrompt 仍包含角色或资产外观复述。');
  }
  if (String(audit.dialogueCheck).toLowerCase() !== 'pass') {
    throw new Error('生成 Agent 审核未通过：台词完整性检查未通过。');
  }
  if (String(audit.transitionCheck).toLowerCase() !== 'pass') {
    throw new Error('生成 Agent 审核未通过：镜头交接、片头片尾包含后期转场方式。');
  }
  validateDialogue(videoPrompt, durationSeconds, expectedSpeech);
  return result;
}

async function generateGlmSequencePrompt(input) {
  const config = glmConfig();
  if (!config.apiKey) throw new Error('H3 工作台没有找到 GLM_API_KEY，无法让 GLM-5.3 生成 Sequence 提示词。');
  const timeoutMs = Math.max(30_000, Number(process.env.NANA_H3_GLM_TIMEOUT_MS || 180_000));
  const durationSeconds = Number(input.sequence?.durationSeconds || input.sequence?.duration || 0);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 5 || durationSeconds > 15) {
    throw new Error(`H3 Sequence 总时长必须是 5～15 秒整数，当前为 ${durationSeconds}s。`);
  }
  const styleForGlm = String(input.style || '')
    .replace(/(?:无|禁止|不要)?(?:交叉溶解|交叉淡化|叠化|溶解|淡入|淡出|渐入|渐出|渐隐|渐显|闪黑|闪白|黑闪|白闪|闪白闪黑|闪黑闪白|黑场|白场|fade\s*-?\s*in|fade\s*-?\s*out|flash\s*(?:black|white))/gi, '')
    .replace(/[，、；;]{2,}/g, '，')
    .trim();
  const characters = (Array.isArray(input.characters) ? input.characters : []).map(item => ({
    id: String(item?.id || ''),
    name: String(item?.name || ''),
    kind: 'character',
  })).filter(item => item.id || item.name);
  const assets = (Array.isArray(input.assets) ? input.assets : []).map(item => ({
    id: String(item?.id || ''),
    name: String(item?.name || ''),
    kind: String(item?.kind || item?.assetType || 'asset'),
  })).filter(item => item.id || item.name);
  const shots = (Array.isArray(input.shots) ? input.shots : []).map(shot => ({
    id: String(shot?.id || ''),
    sourceText: String(shot?.sourceText || shot?.description || ''),
    durationSeconds: Number(shot?.durationSeconds || 0),
    direction: {
      framing: String(shot?.direction?.framing || ''),
      camera: String(shot?.direction?.camera || ''),
      subject: String(shot?.direction?.subject || ''),
      action: String(shot?.direction?.action || shot?.description || ''),
      endState: String(shot?.direction?.endState || ''),
    },
      speech: Array.isArray(shot?.speech) ? shot.speech.map(line => ({
       speaker: String(line?.speaker || ''),
       text: String(line?.text || ''),
      })) : extractSourceSpeech(shot?.sourceText || shot?.description),
    characterIds: Array.isArray(shot?.characterIds) ? shot.characterIds.map(String) : [],
    assetIds: Array.isArray(shot?.assetIds) ? shot.assetIds.map(String) : [],
  }));
  const approvedDialogue = collectSpeechLines(shots);
  const approvedDialogueLines = approvedDialogue.map(line => `台词（${line.speaker || '说话人'}）：“${line.text}”`);
  const system = [
    '你是 H3 全自动漫剧工作台的 GLM-5.3 Sequence Prompt Agent。',
    'H3 的实际执行单位是一整条 Sequence，不是单个 Shot。你要先完成 Sequence 级 Director Read，再把这条 Sequence 写成一条可直接交给 MiniMax H3 的最终视频提示词。不要重新拆 Scene，不要改 Scene 边界，不要把每个 Shot 当成独立视频提交。',
    '只返回严格 JSON，不要 markdown、不要解释：{"directorRead":{"dramaticFunction":"...","turn":"...","viewerPOV":"...","relationshipShift":"...","objective":"...","obstacle":"...","visibleBehavior":"...","visualIntention":"...","cameraPrinciple":"...","genreRefusal":"..."},"videoPrompt":"...","endState":"...","generationAudit":{"appearanceCheck":"pass","assetBoundaryCheck":"pass","timelineCheck":"pass","dialogueCheck":"pass","transitionCheck":"pass","notes":"..."}}。',
    '【H3 总规则】Sequence 继续遵守 H3 的 5～15 秒整数时长；这一整条 Sequence 一次生成。上一条同 Scene 的 endState 是连续性文字参考，H3 另外会把上一条成品最后一帧作为下一条 Ref2VA 的普通参考图 <Picture 1>，只用于提示上一条结束状态，不绑定 first_frame、不切换 I2VA/Hybrid；跨 Scene 不继承。只使用输入中批准的角色、场景、道具和资产，不添加新人物、台词、旁白、OS、重大事件、服装变化或无依据的环境变化。',
    '【整体风格】输入中的 style 只用于统一本项目的叙事气质、色彩和环境氛围；必须与固定的【氛围与画质】段同时遵守，不得用风格描述替代可拍动作，也不得借风格段复述资产外观。',
    '【导演层先行】Director Read 必须完整回答：戏剧功能、唯一状态转折、观众站位与观看顺序、人物关系可见变化、角色目标、具体障碍、关键可见表演、唯一可拍的视觉意图、贯穿全段的摄影原则、明确拒绝的错误类型。10 项只写一次，不要把它们机械重复到每个 Shot。',
    '【Shot 颗粒度】videoPrompt 的画面内容必须按以下两行格式输出，每个 Shot 标题独占一行：第一行是 shot1(0s-3s)，下一行才写“中景，稳定观察，轻微呼吸感。”；标签后不加冒号、不加“约”、不加“分镜头”，不使用 [中景] 等复杂括号标签。景别必须尽量写清人物在画面中的实际占比：腰部以上使用“小中景”，膝部附近使用“大中景”，不要用含糊的“中景”代替已经明确的腰部/膝部构图；极特写、特写、近景、大全景/全景、远景/中远景、全身构图也应明确写出。这个景别信息会参与 H3 档位判断：人物脸占比大的极特写/特写/近景/小中景可用极速档；人物大全景/全景、远景/中远景、大中景（约到膝盖）或全身构图需要 1080P 保脸。时间轴从 0 连续覆盖到 Sequence 总时长，所有时间点为整数，禁止小数；普通 Shot 优先 2～5 秒，必要时可根据动作或台词使用更长或更短的单一 Shot；不按总时长强制计算 Shot 数，不为了满足颗粒度硬拆。输入的粗拆 Shot 是叙事素材，必要时可在本 Sequence 内细化为更小的 Shot，但必须保留原文顺序和全部批准信息。禁止旧的 0-3s、3-6s、6-10s、10-15s 模板。',
    '【每个 Shot 合约】每个 Shot 只承担一个主要可见叙事动作和一个主要摄影机运动；写清起始构图、主体位置、动作过程、可见物理后果、光线来源与照射方向、焦点变化或保持、结束画面。固定构图/稳定观察必须带“轻微呼吸感”；有推拉、横移、跟拍、环绕等运动时不要额外叠加呼吸感。动作和摄影机运动不能写成游戏 CG、技能展示、玩家视角或抽象情绪。',
    `【氛围与画质】videoPrompt 必须包含一个独立的固定段，标题和正文原样保留：${H3_ATMOSPHERE_AND_QUALITY} 这一段是全 Sequence 的画面风格与质量基线，不写人物发色、服装、脸型等资产外观。`,
    '【镜头交接与片头片尾】本次 H3 生成只负责有效画面与同期声，不负责后期转场。禁止闪白、闪黑、白闪、黑闪、渐隐、渐显、淡入、淡出、渐入、渐出、交叉溶解、交叉淡化、黑场/白场切入或落入，以及任何等价的 fade/flash 过渡。每条 Sequence 第一帧直接进入有效画面，最后一帧停在最后一个 Shot 的有效状态；镜头之间只用硬切、连续动作、视线、构图或同期声自然衔接。不要在 videoPrompt、endState、Director Read 或审核备注中写任何后期转场方式或片头片尾效果，这些留给后期剪辑处理。',
    '【台词与声音】所有台词必须逐字来自输入，不能重复、改写、补写或提前说后续台词。每条朗读内容必须用明确格式写出：台词（说话人）：“原文”；旁白（仅朗读）：“原文”。台词正文只允许出现在对应 Shot 的声音行中，每条批准台词在整个 videoPrompt 里只能出现一次；【声音设定】只写雨声、动作声和朗读原则，不要再次抄写台词原文。一条长台词可以按自然情绪和镜头拆到多个 Shot，但各段按原顺序拼接后必须与输入原文完全一致；不能删字、换字、重复、补写或提前说后续内容。根据台词长度给出足够时间，以自然、偏宽松的语速完整说完，不要为了塞动作压缩语速。画面说明、运镜、声音设计不是朗读内容。默认开启声音，保留动作和环境同期声；只禁止自动生成 BGM 和字幕。原文没有明确要求时，不自行添加音乐、心跳式情绪音或旁白。',
    '批准的台词/旁白是必须逐字保留的声音轨内容，不属于画面外观描述；即使原文中出现“衣服”等普通词语，也只能放在对应声音行，不能把它扩写成画面外观。',
    '【动作、战斗与光效】战斗 Shot 必须写出攻击者主动表演、蓄力/发力、受击对象具体受力、环境反馈、重量和明确结束状态；投射物按蓄力/瞄准→释放→飞行→命中→后果表现；关键接触点拆成动作特写或近景，必要时只在接触瞬间使用升格后恢复正常速度。主光效必须写清来源、路径、接触/遮挡、材质受光、环境反射和收束位置，一个 Shot 最多一个主光效。',
    '【台词清单】videoPrompt 只能朗读当前 Sequence 的批准台词，禁止朗读上一条 Sequence、下一条 Sequence 或 previousEndState 中的任何文字；必须逐字、按顺序使用用户输入中的台词，不能遗漏、重复或改写。清单为空时不得生成任何台词。',
    `【当前 Sequence 必须出现的台词】${approvedDialogueLines.length ? `每一行都必须逐字复制到且只能复制到对应 Shot 的声音说明中；不得在【声音设定】或其他段落重复：\n${approvedDialogueLines.join('\n')}` : '本条没有台词，禁止生成任何台词。'}`,
    '【资产边界】资产匹配是上传参考图的结构化输入，不是画面提示词正文。videoPrompt 不得出现 asset_id、资产长设定、上传说明或“图1/图2”匹配说明；只在画面需要时自然描述已经选定的角色、场景和道具。',
    '【外观边界——必须执行】角色、场景、道具的外观以对应参考资产图为唯一来源。生成阶段不得在 Director Read、videoPrompt 或 endState 中复述或新增外观设定。角色只使用已批准的名字/身份和中性动作称谓；场景和道具只使用已批准资产名称，并描写它们在本段中的位置、动作、交互和物理结果。不要把资产描述、设计图内容或参考图构图翻译进视频正文。原文若含外观修饰，只保留其可拍的剧情动作，不复述修饰词。',
    '【禁词执行】外观禁词不能以正面描述、否定句、提醒句、审核说明或“不要出现某外观”这类句式写进 Director Read、videoPrompt、endState；不要在 genreRefusal 里提及外观禁词。外观审核通过的方式是结果正文直接不出现外观词，不是把“禁止外观”写进结果。',
    '【生成 Agent 审核】返回 JSON 前必须自审：appearanceCheck 必须为 pass，确认画面正文没有角色/场景/道具外观复述；assetBoundaryCheck、timelineCheck、dialogueCheck、transitionCheck 也必须逐项填写 pass。transitionCheck 必须确认视频提示词只包含有效画面、连续动作和同期声，不包含闪白、闪黑、渐隐、渐显、淡入淡出、交叉溶解、黑白场切入落入或任何等价后期过渡。任一项不通过就先重写 videoPrompt，不能把 fail 结果返回。generationAudit 只记录审核结论，不把审核规则写入 videoPrompt。',
    '【输出结构】videoPrompt 必须使用以下固定标题，标题文字不可改：`【生成规格】`、`【导演原则】`、`【场景设定】`、`【声音设定】`、`【氛围与画质】`、`【画面内容】`、`【生成限制】`。其中【氛围与画质】必须原样写入固定正文。画面内容中连续写每个独占一行标题的 shotN(整数s-整数s)。endState 只写 Sequence 最后一帧摄影机能看到的角色位置、动作、道具、光线和空间状态，禁止写生成限制、审核结论或否定性规则，供同 Scene 下一条继续。输出 JSON 必须额外包含 generationAudit：{"appearanceCheck":"pass","assetBoundaryCheck":"pass","timelineCheck":"pass","dialogueCheck":"pass","transitionCheck":"pass","notes":"..."}。',
  ].join('\n');
  const prompt = JSON.stringify({
    task: '先完成 Director Read，再为一整条 H3 Sequence 生成细粒度 Shot 视频提示词',
    targetDurationSeconds: durationSeconds,
    sequence: input.sequence,
    scene: input.scene,
    shots,
    characters,
    assets,
    approvedDialogue: approvedDialogueLines,
    style: styleForGlm,
    atmosphereAndQuality: H3_ATMOSPHERE_AND_QUALITY,
    previousEndState: input.previousEndState || '无，这是本 Scene 的第一条 Sequence。',
  }, null, 2);
  const startedAt = Date.now();
  let correction = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const attemptPrompt = correction
        ? `${prompt}\n\n【H3 上一版审核反馈】${correction}\n请完整重写 JSON；只修正被指出的问题，仍须满足全部 H3 规则。`
        : prompt;
      const response = await fetch(`${config.baseUrl}/v1/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          thinking: { type: 'disabled' },
          reasoning_effort: 'low',
          max_tokens: 8_192,
          system,
          messages: [{ role: 'user', content: attemptPrompt }],
        }),
      });
      if (!response.ok) throw new Error(`GLM API 请求失败（${response.status}）：${(await response.text()).slice(0, 240)}`);
      const data = await response.json();
      const text = (data.content || []).filter(block => block?.type === 'text').map(block => block.text || '').join('').trim();
      const result = sanitizeSequenceResult(parseH3Json(text, 'GLM-5.3 返回的 Sequence 结果不是合法 JSON。'));
      result.videoPrompt = normalizeSequenceShotFormatting(result.videoPrompt);
      try {
        validateGlmSequenceResult(result, durationSeconds, shots);
      } catch (validationError) {
        if (attempt < 2) {
          correction = errorMessage(validationError);
          if (/台词/.test(correction)) {
            correction += ` 当前 Sequence 唯一允许的朗读清单：${approvedDialogueLines.length ? approvedDialogueLines.join('；') : '无'}。请把清单中的每一行逐字放入对应 Shot 的声音说明，不得省略。`;
          }
          continue;
        }
        throw validationError;
      }
      return { ...result, model: data.model || config.model, elapsedMs: Date.now() - startedAt, usage: data.usage || null };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`GLM-5.3 Sequence 提示词请求超时（${timeoutMs}ms）。`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('GLM-5.3 Sequence 审核重试失败。');
}

const ASSET_REFERENCE_PLAN_FIELDS = ['main', 'fullBody', 'multiAngle', 'details'];

function parseGlmJson(text) {
  return parseH3Json(text, 'GLM-5.3 返回的资产设计结果不是合法 JSON。');
}

async function requestGlmJson({ system, prompt, maxTokens = 12_000, timeoutMs = 180_000 }) {
  const config = glmConfig();
  if (!config.apiKey) throw new Error('H3 工作台没有找到 GLM_API_KEY。');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${config.baseUrl}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        thinking: { type: 'disabled' },
        reasoning_effort: 'low',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`GLM API 请求失败（${response.status}）：${(await response.text()).slice(0, 240)}`);
    const data = await response.json();
    const text = (data.content || []).filter(block => block?.type === 'text').map(block => block.text || '').join('').trim();
    if (!text) throw new Error(`GLM 没有返回可解析正文（model=${data.model || config.model}）。`);
    return { result: parseGlmJson(text), model: data.model || config.model, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`GLM-5.3 请求超时（${timeoutMs}ms）。`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function materializeH3SceneOutlines(sourceText, proposed) {
  const scenePlans = Array.isArray(proposed) ? proposed : [];
  const explicitSceneHeadings = [...sourceText.matchAll(/^[ \t]*##\s*Scene\s+[0-9０-９]+\s*[｜|]\s*([^\r\n｜|]+)(?:\s*[｜|][^\r\n]*)?[ \t]*(?=\r?$)/gim)];
  if (explicitSceneHeadings.length && (!scenePlans.length || explicitSceneHeadings.length === scenePlans.length)) {
    return explicitSceneHeadings.map((match, index) => {
      const plan = scenePlans[index] || {};
      const headingEnd = (match.index || 0) + match[0].length;
      const startOffset = headingEnd;
      const endOffset = explicitSceneHeadings[index + 1]?.index || sourceText.length;
      return {
        id: String(plan.id || `h3-scene-${index + 1}`),
        title: String(plan.title || match[1].trim() || `Scene ${index + 1}`),
        locationId: String(plan.locationId || ''),
        rawText: sourceText.slice(startOffset, endOffset),
        targetShots: Number(plan.targetShots) || 1,
        startOffset,
        endOffset,
      };
    });
  }
  const headings = [...sourceText.matchAll(/^[ \t]*第\s*[0-9０-９一二三四五六七八九十百零〇两]+\s*场(?:\s*[｜|丨:：—-]\s*[^\r\n]*)?[ \t]*(?=\r?$)/gm)];
  if (headings.length >= 2) {
    return headings.map((match, index) => {
      const startOffset = index === 0 ? 0 : match.index || 0;
      const endOffset = headings[index + 1]?.index || sourceText.length;
      const plan = scenePlans[index] || {};
      return {
        id: String(plan.id || `h3-scene-${index + 1}`),
        title: String(plan.title || match[0].trim() || `第${index + 1}场`),
        locationId: String(plan.locationId || ''),
        rawText: sourceText.slice(startOffset, endOffset),
        targetShots: Number(plan.targetShots) || 1,
        startOffset,
        endOffset,
      };
    });
  }
  if (!scenePlans.length) {
    return [{ id: 'h3-scene-1', title: '第1场', locationId: '', rawText: sourceText, targetShots: 1, startOffset: 0, endOffset: sourceText.length }];
  }
  const starts = scenePlans.map((plan, index) => {
    if (index === 0) return 0;
    const marker = String(plan.startMarker || '');
    const located = marker ? sourceText.indexOf(marker) : -1;
    return located > 0 ? located : -1;
  });
  if (starts.some((start, index) => start < 0 || (index > 0 && start <= starts[index - 1]))) {
    return [{ id: String(scenePlans[0]?.id || 'h3-scene-1'), title: String(scenePlans[0]?.title || '第1场'), locationId: String(scenePlans[0]?.locationId || ''), rawText: sourceText, targetShots: 1, startOffset: 0, endOffset: sourceText.length }];
  }
  return scenePlans.map((plan, index) => {
    const startOffset = starts[index];
    const endOffset = starts[index + 1] ?? sourceText.length;
    return {
      id: String(plan.id || `h3-scene-${index + 1}`),
      title: String(plan.title || `第${index + 1}场`),
      locationId: String(plan.locationId || ''),
      rawText: sourceText.slice(startOffset, endOffset),
      targetShots: Number(plan.targetShots) || 1,
      startOffset,
      endOffset,
    };
  }).filter(scene => scene.rawText.length > 0);
}

async function analyzeH3Outline(sourceText, isOtome) {
  const system = [
    '你是 H3 全自动漫剧工作台自己的 GLM-5.3 剧本分析 Agent。你不调用主导演台，也不依赖其他项目。',
    '只负责第一层：提取世界观、整体风格、人物、场景、道具/资产和自然大分场；不要生成 Shot、Sequence 或最终视频提示词。',
    '资产设计信息可以完整保留外观细节，因为外观属于资产图阶段；后续视频提示词阶段会禁止复述这些外观。',
    'Scene 是稳定的主要物理空间加连续时间/行动形成的大场，不按一句台词、一个动作或一个情绪节拍切小场。若原文有“第X场”标题，必须一标题对应一 Scene，不能合并或再拆。没有显式标题时，返回每个 Scene 的 startMarker，必须逐字摘自原文。',
    `${isOtome ? '乙女模式：禁止女主正脸。' : '普通导演模式。'}`,
    '只返回严格 JSON：{"overview":"...","style":"...","characters":[{"id":"...","name":"...","description":"...","prompt":"..."}],"scenes":[{"id":"...","name":"...","description":"...","prompt":"..."}],"assets":[{"id":"...","name":"...","description":"...","prompt":"..."}],"sceneOutlines":[{"id":"...","title":"...","locationId":"...","startMarker":"...","endMarker":"...","targetShots":1}]}。不要 markdown，不要解释，不要漏掉原文中的已批准人物或关键资产。',
  ].join('\n');
  const prompt = JSON.stringify({ task: '独立完成 H3 第一层剧本分析', sourceText }, null, 2);
  const response = await requestGlmJson({ system, prompt, maxTokens: 16_000 });
  const model = response.result || {};
  const sceneOutlines = materializeH3SceneOutlines(sourceText, model.sceneOutlines);
  return {
    model: response.model,
    elapsedMs: response.elapsedMs,
    result: {
      settings: {
        overview: String(model.overview || ''),
        style: String(model.style || ''),
        isOtome: Boolean(isOtome),
        characters: Array.isArray(model.characters) ? model.characters : [],
        scenes: Array.isArray(model.scenes) ? model.scenes : [],
        assets: Array.isArray(model.assets) ? model.assets : [],
        sequences: sceneOutlines.map(scene => ({ id: scene.id, name: scene.title, description: '', prompt: '' })),
      },
      sceneOutlines,
    },
  };
}

function normalizeH3CutPlan(rawText, cuts, settings, scene) {
  const allowedCharacterIds = new Set((settings.characters || []).map(item => String(item.id)));
  const sceneAssetId = String(
    (settings.scenes || []).find(item => String(item.id) === String(scene.id))?.id
      || (settings.scenes || []).find(item => String(item.id) === String(scene.locationId))?.id
      || scene.locationId
      || scene.id
      || '',
  );
  const allowedAssetIds = new Set([
    sceneAssetId,
    ...(settings.scenes || []).map(item => String(item.id)),
    ...(settings.assets || []).map(item => String(item.id)),
  ].filter(Boolean));
  const accepted = [];
  let cursor = 0;
  const sourceCharacters = (settings.characters || []).map(item => ({ id: String(item.id), name: String(item.name || '') }));
  const sourceAssets = [
    ...(settings.scenes || []).map(item => ({ id: String(item.id), name: String(item.name || '') })),
    ...(settings.assets || []).map(item => ({ id: String(item.id), name: String(item.name || '') })),
  ];
  const rawCuts = Array.isArray(cuts) ? cuts : [];
  for (let index = 0; index < rawCuts.length; index += 1) {
    const cut = rawCuts[index];
    const requestedEndOffset = Number(cut?.endOffset);
    if (!Number.isInteger(requestedEndOffset) || requestedEndOffset <= cursor || requestedEndOffset > rawText.length) continue;
    // 粗拆 Shot 只能在原文完整行之后落点，避免把台词或 Scene 标题从中间截断。
    const newlineOffset = rawText.indexOf('\n', requestedEndOffset - 1);
    const endOffset = index === rawCuts.length - 1
      ? rawText.length
      : (newlineOffset >= 0 ? newlineOffset + 1 : rawText.length);
    if (!Number.isInteger(endOffset) || endOffset <= cursor || endOffset > rawText.length) continue;
    const sourceChunk = rawText.slice(cursor, endOffset);
    const sourceSpeech = extractSourceSpeech(sourceChunk, sourceCharacters.map(item => item.name));
    const sourceCharacterIds = sourceCharacters
      .filter(item => item.name && (sourceChunk.includes(item.name) || sourceSpeech.some(line => line.speaker === item.name)))
      .map(item => item.id);
    const sourceAssetIds = sourceAssets
      .filter(item => item.name && sourceChunk.includes(item.name))
      .map(item => item.id);
    const characterIds = sourceCharacterIds.length
      ? sourceCharacterIds
      : (Array.isArray(cut?.characterIds) ? cut.characterIds.map(String).filter(id => allowedCharacterIds.has(id)) : []);
    const assetIds = [sceneAssetId, ...sourceAssetIds, ...(Array.isArray(cut?.assetIds) ? cut.assetIds.map(String) : [])]
      .filter((id, idIndex, list) => id && list.indexOf(id) === idIndex && allowedAssetIds.has(id));
    accepted.push({
      rawText: sourceChunk,
      durationSeconds: Math.max(1, Math.min(15, Math.round(Number(cut?.durationSeconds) || 3))),
      characterIds,
      assetIds,
      direction: cut?.direction && typeof cut.direction === 'object' ? cut.direction : {},
      // 台词是导演台批准原文的派生数据，不接受 GLM 在 cut.speech 中自行改写或补写。
      speech: sourceSpeech,
      sourceStart: cursor,
      sourceEnd: endOffset,
    });
    cursor = endOffset;
  }
  if (cursor < rawText.length) {
    accepted.push({
      rawText: rawText.slice(cursor),
      durationSeconds: 3,
      characterIds: [],
      assetIds: sceneAssetId ? [sceneAssetId] : [],
      direction: {},
      speech: extractSourceSpeech(rawText.slice(cursor)),
      sourceStart: cursor,
      sourceEnd: rawText.length,
    });
  }
  return accepted;
}

async function generateH3ShotsForScene(outline, sceneIndex) {
  const scene = outline.sceneOutlines?.[sceneIndex];
  const settings = outline.settings || {};
  if (!scene) throw new Error(`找不到 H3 Scene ${sceneIndex + 1}。`);
  const system = [
    '你是 H3 全自动漫剧工作台自己的 GLM-5.3 原子 Shot 粗拆 Agent。只处理输入的一个获批 Scene，不调用主导演台。',
    '你只返回原文切点和镜头执行资料，不改写原文，不生成最终视频提示词。每个 cut 的 endOffset 必须是输入原文的绝对字符偏移，递增且最后一个必须等于原文长度。',
    '每个粗拆 Shot 是一个后续可细化的叙事单元，不是 H3 视频；不要按 5～15 秒限制拆 Shot，也不要输出旧的 0-3s、3-6s、6-10s、10-15s 模板。durationSeconds 只是粗略动作时长，取 1～15 的整数。',
    '台词必须逐字从原文抽取到 speech，不能改写或补写。characterIds 只能使用人物 ID；assetIds 只能使用场景/道具 ID。',
    '只返回严格 JSON：{"cuts":[{"endOffset":0,"durationSeconds":3,"reason":"...","characterIds":[],"assetIds":[],"direction":{"framing":"...","camera":"...","subject":"...","action":"...","endState":"..."},"speech":[{"speaker":"...","text":"...","type":"dialogue"}]}]}。不要 markdown，不要解释。',
  ].join('\n');
  const prompt = JSON.stringify({
    task: '独立完成 H3 Scene 的原子 Shot 粗拆',
    scene: { id: scene.id, title: scene.title, locationId: scene.locationId, rawText: scene.rawText },
    characters: (settings.characters || []).map(item => ({ id: item.id, name: item.name })),
    scenes: (settings.scenes || []).map(item => ({ id: item.id, name: item.name })),
    assets: (settings.assets || []).map(item => ({ id: item.id, name: item.name })),
  }, null, 2);
  const response = await requestGlmJson({ system, prompt, maxTokens: 12_000 });
  const normalizedCards = normalizeH3CutPlan(scene.rawText, response.result?.cuts, settings, scene)
    .filter(card => String(card.rawText || '').trim());
  const letterStart = String(scene.title || '').includes('致新生的火种')
    ? scene.rawText.indexOf('致新生的火种：')
    : -1;
  const cards = normalizedCards.map((card, index) => {
    const narration = letterStart >= 0
      ? scene.rawText
        .slice(Math.max(card.sourceStart, letterStart), card.sourceEnd)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .flatMap(text => splitH3NarrationLine(text).map(sentence => ({ speaker: '古老AI', text: sentence, type: 'voiceover' })))
      : [];
    return {
    id: `${scene.id}-shot-${index + 1}`,
    sceneId: scene.id,
    description: card.rawText,
    sourceText: card.rawText,
    durationSeconds: card.durationSeconds,
    direction: card.direction,
    speech: [...card.speech, ...narration],
    characterIds: card.characterIds,
    assetIds: card.assetIds,
    sourceStart: card.sourceStart,
    sourceEnd: card.sourceEnd,
    order: index,
    };
  });
  return { cards, model: response.model, elapsedMs: response.elapsedMs, sceneId: scene.id };
}

function assetDesignItems(settings) {
  return [
    ...(Array.isArray(settings?.characters) ? settings.characters : []).map(item => ({
      id: String(item?.id || ''),
      name: String(item?.name || ''),
      assetType: 'character',
      description: String(item?.description || item?.prompt || ''),
    })),
    ...(Array.isArray(settings?.scenes) ? settings.scenes : []).map(item => ({
      id: String(item?.id || ''),
      name: String(item?.name || ''),
      assetType: 'scene',
      description: String(item?.description || item?.prompt || ''),
    })),
    ...(Array.isArray(settings?.assets) ? settings.assets : []).map(item => ({
      id: String(item?.id || ''),
      name: String(item?.name || ''),
      assetType: 'prop',
      description: String(item?.description || item?.prompt || ''),
    })),
  ].filter(item => item.id || item.name);
}

function validateAssetReferencePlan(item) {
  const plan = item?.referencePlan;
  const requiredFields = item?.assetType === 'character'
    ? ASSET_REFERENCE_PLAN_FIELDS
    : ['main', 'multiAngle', 'details'];
  if (!plan || requiredFields.some(field => field === 'multiAngle' || field === 'details'
    ? !Array.isArray(plan[field]) || plan[field].length < 2 || plan[field].some(value => !String(value || '').trim())
    : !String(plan[field] || '').trim())) {
    throw new Error(`GLM-5.3 返回的资产参考图计划不完整：${item?.id || 'unknown'}`);
  }
  return plan;
}

async function generateGlmAssetDesigns(settings) {
  const config = glmConfig();
  if (!config.apiKey) throw new Error('H3 工作台没有找到 GLM_API_KEY，无法生成资产参考图计划。');
  const items = assetDesignItems(settings);
  if (!items.length) return { settings, model: config.model, elapsedMs: 0 };
  const timeoutMs = Math.max(30_000, Number(process.env.NANA_H3_GLM_ASSET_TIMEOUT_MS || 180_000));
  const system = [
    '你是 H3 全自动漫剧工作台的资产设计与参考图规划 Agent，负责把已批准的人物、场景、道具变成可供画师或 LibTV CLI 执行的资产参考图组。',
    '资产设计阶段必须完整描写外观。角色的发色、发型、脸型、五官、肤色、瞳色、体型、衣服、饰品和材质都属于资产图的内容，不能在这一层删掉；它们之后由参考资产图统一决定，视频生成阶段不得复述。',
    '资产设计图提示词可以并且应当在输入需要时明确写出人物、场景和物品的具体颜色；“不复述外观、不得指定颜色”只属于后续视频提示词，不适用于资产设计图。',
    '【角色参考图构成】每个角色必须把面部三视图作为第一视觉层级。面部三视图应优先使用横跨画面上方或其他可容纳三个等大头像的整宽横向长条主面板，依次展示正面、3/4、纯侧面；三个头像都只裁切到肩膀附近，重点展示头部、脸型、五官、发际线、发型轮廓和侧脸结构，严禁画成胸像、半身像或把大面积上半身带入主面板，也不得把面部三视图塞进左侧或右侧狭窄栏位。若画幅比例不同，可自适应调整横向主面板高度，但必须保证三张脸的实际视觉尺寸明显大于全身三视图中的脸。其余区域再安排一块明显更小的全身三视图（正面、侧面、背面或正面、3/4、侧面）和若干细节图，细节至少覆盖面部/眼神、手部、鞋部或标志性特征。referencePlan.main 必须明确面部三视图的横向长条主面板与肩部裁切，referencePlan.fullBody 必须明确写出小面积全身三视图。',
    '【场景参考图构成】每个场景必须规划为：一张大面积主图，交代完整空间和气氛；几张多角度图，至少两张，覆盖相对侧、入口/出口或高低机位；若干细节图，至少两张，覆盖结构连接、关键区域、材质和可互动位置。',
    '【道具参考图构成】道具和场景使用同一套结构：一张大面积主图，几张多角度图，若干细节图；细节要覆盖结构、材质、接口/握持区域和静止或使用状态。',
    'designPrompt 必须是一条可直接交给图像模型的完整提示词，必须写清布局顺序和面积关系，并保留输入中的具体外观信息。不要只输出“高清三视图”这类空壳。referencePlan 用于工作台审核，必须真实对应 designPrompt，不能写成泛泛的占位词。',
    '只返回严格 JSON：{"items":[{"id":"...","designPrompt":"...","referencePlan":{"main":"...","fullBody":"...","multiAngle":["...","..."],"details":["...","..."]}}]}。不要 markdown，不要解释，不要遗漏 ID。',
  ].join('\n');
  const prompt = JSON.stringify({
    task: '为 H3 的已批准资产生成参考图组设计提示词与可审核的构成计划',
    overallStyle: String(settings?.style || ''),
    items,
  }, null, 2);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${config.baseUrl}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        thinking: { type: 'disabled' },
        reasoning_effort: 'low',
        max_tokens: 14_000,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`GLM API 请求失败（${response.status}）：${(await response.text()).slice(0, 240)}`);
    const data = await response.json();
    const text = (data.content || []).filter(block => block?.type === 'text').map(block => block.text || '').join('').trim();
    const result = parseGlmJson(text);
    const expectedIds = new Set(items.map(item => item.id));
    const generated = new Map();
    for (const item of Array.isArray(result?.items) ? result.items : []) {
      if (!expectedIds.has(item?.id) || String(item?.designPrompt || '').trim().length < 120) continue;
      const expectedItem = items.find(candidate => candidate.id === item.id);
      const referencePlan = validateAssetReferencePlan({ ...item, assetType: expectedItem?.assetType });
      generated.set(item.id, {
        prompt: String(item.designPrompt).trim(),
        referencePlan,
      });
    }
    if (generated.size !== items.length) {
      const missing = items.filter(item => !generated.has(item.id)).map(item => item.name || item.id);
      throw new Error(`GLM-5.3 未完整返回资产参考图计划：${missing.join('、')}。`);
    }
    const applyAsset = item => {
      const generatedItem = generated.get(item.id);
      return generatedItem
        ? { ...item, prompt: generatedItem.prompt, referencePlan: generatedItem.referencePlan }
        : item;
    };
    return {
      settings: {
        ...settings,
        characters: (settings.characters || []).map(applyAsset),
        scenes: (settings.scenes || []).map(applyAsset),
        assets: (settings.assets || []).map(applyAsset),
      },
      model: data.model || config.model,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`GLM-5.3 资产参考图计划请求超时（${timeoutMs}ms）。`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function generateGlmAssetDesignsBatched(settings) {
  const items = assetDesignItems(settings);
  if (items.length <= 4) return generateGlmAssetDesigns(settings);

  const startedAt = Date.now();
  const generatedById = new Map();
  let model = '';
  for (let offset = 0; offset < items.length; offset += 1) {
    const chunk = items.slice(offset, offset + 1);
    const chunkIds = new Set(chunk.map(item => item.id));
    const partialSettings = {
      ...settings,
      characters: (settings.characters || []).filter(item => chunkIds.has(String(item?.id || ''))),
      scenes: (settings.scenes || []).filter(item => chunkIds.has(String(item?.id || ''))),
      assets: (settings.assets || []).filter(item => chunkIds.has(String(item?.id || ''))),
    };
    const result = await generateGlmAssetDesigns(partialSettings);
    model = result.model || model;
    for (const category of ['characters', 'scenes', 'assets']) {
      for (const item of result.settings?.[category] || []) {
        if (chunkIds.has(String(item?.id || ''))) generatedById.set(String(item.id), item);
      }
    }
  }
  if (generatedById.size !== items.length) {
    const missing = items.filter(item => !generatedById.has(item.id)).map(item => item.name || item.id);
    throw new Error('GLM-5.3 分批资产设计仍有缺失：' + missing.join('、'));
  }
  const mergeCategory = category => (settings[category] || []).map(item => ({
    ...item,
    ...(generatedById.get(String(item?.id || '')) || {}),
  }));
  return {
    settings: {
      ...settings,
      characters: mergeCategory('characters'),
      scenes: mergeCategory('scenes'),
      assets: mergeCategory('assets'),
    },
    model,
    elapsedMs: Date.now() - startedAt,
  };
}

function queueGlmSequenceRequest(task) {
  const next = glmSequenceQueue.then(task, task);
  glmSequenceQueue = next.catch(() => undefined);
  return next;
}

function queueGlmAssetRequest(task) {
  const next = glmAssetQueue.then(task, task);
  glmAssetQueue = next.catch(() => undefined);
  return next;
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, jsonHeaders);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { online: true, service: 'h3-workbench' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    try {
      const config = await readConfig();
      const response = await comfyFetch('/system_stats', { timeoutMs: 5_000 });
      const stats = await response.json();
      sendJson(res, 200, {
        online: true,
        office_name: config.officeName,
        comfy_url: config.comfyUrl,
        gpu: stats.devices?.[0]?.name || 'GPU',
        comfyui_version: stats.system?.comfyui_version || '',
      });
    } catch (error) {
      try {
        const config = await readConfig();
        const switchResponse = await fetch(`${config.gpuSwitchUrl}/health`, { signal: AbortSignal.timeout(5_000) });
        const switchState = await switchResponse.json();
        if (switchResponse.ok && (switchState.active === 'qwen' || switchState.active === 'idle')) {
          sendJson(res, 200, {
            online: true,
            standby: true,
            office_name: config.officeName,
            comfy_url: config.comfyUrl,
            gpu: 'GPU',
            gpu_owner: switchState.active,
            auto_wake: true,
          });
          return;
        }
      } catch {}
      sendJson(res, 503, { online: false, error: errorMessage(error) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/projects') {
    const registry = await readH3Registry();
    const projects = (Array.isArray(registry.projects) ? registry.projects : []).map(project => ({
      ...project,
      isActive: project.id === registry.activeProjectId,
    }));
    sendJson(res, 200, { registry: { ...registry, projects }, activeProject: projects.find(project => project.isActive) || null });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/projects') {
    if (AUTO_RUNS.size) throw Object.assign(new Error('H3 正在生成中，不能新建项目。'), { status: 409 });
    const body = await parseJsonBody(req);
    const name = String(body.name || '').trim();
    if (!name) throw Object.assign(new Error('请输入 H3 项目名称。'), { status: 400 });
    const result = await createH3Project(name);
    sendJson(res, 201, { ...result, activeProject: result.project });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/projects/activate') {
    if (AUTO_RUNS.size) throw Object.assign(new Error('H3 正在生成中，不能切换项目。'), { status: 409 });
    const body = await parseJsonBody(req);
    const projectId = String(body.id || '').trim();
    const registry = await readH3Registry();
    const project = registry.projects?.find(item => item.id === projectId);
    if (!project?.path) throw Object.assign(new Error('找不到要打开的 H3 项目。'), { status: 404 });
    const projectRoot = resolveH3ProjectRoot(project);
    registry.activeProjectId = project.id;
    registry.projects = registry.projects.map(item => item.id === project.id
      ? { ...item, lastOpenedAt: new Date().toISOString() }
      : item);
    await mkdir(path.join(projectRoot, 'execution', 'h3'), { recursive: true });
    await mkdir(path.join(projectRoot, 'outputs', 'h3'), { recursive: true });
    await writeJsonAtomic(H3_REGISTRY_PATH, registry);
    sendJson(res, 200, { project: registry.projects.find(item => item.id === project.id), registry });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/workflow') {
    const runtime = await projectRuntime();
    const workflow = await loadWorkflowState(runtime);
    sendJson(res, 200, { project: runtime.project, workflow });
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/workflow') {
    const runtime = await projectRuntime();
    const body = await parseJsonBody(req);
    const workflow = { ...body, version: 1, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(workflowStatePath(runtime), workflow);
    sendJson(res, 200, { project: runtime.project, workflow });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/workflow/analyze-outline') {
    const body = await parseJsonBody(req);
    const sourceText = String(body.sourceText || '').trim();
    if (!sourceText) throw Object.assign(new Error('请先输入 H3 剧本。'), { status: 400 });
    const result = await queueGlmSequenceRequest(() => analyzeH3Outline(sourceText, Boolean(body.isOtome)));
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/workflow/generate-shots') {
    const body = await parseJsonBody(req);
    const outline = body.outline || {};
    const sceneIndex = Number(body.sceneIndex);
    if (!outline.settings || !Array.isArray(outline.sceneOutlines) || !Number.isInteger(sceneIndex)
      || sceneIndex < 0 || sceneIndex >= outline.sceneOutlines.length) {
      throw Object.assign(new Error('缺少有效的 H3 分场或场次序号。'), { status: 400 });
    }
    const result = await queueGlmSequenceRequest(() => generateH3ShotsForScene(outline, sceneIndex));
    sendJson(res, 200, { result: result.cards, model: result.model, elapsedMs: result.elapsedMs, sceneId: result.sceneId });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/workflow/generate-sequence-prompt') {
    const body = await parseJsonBody(req);
    const sequence = body.sequence || {};
    const shots = Array.isArray(body.shots) ? body.shots : [];
    if (!sequence.id || !shots.length) {
      throw Object.assign(new Error('缺少有效的 Sequence 或 Shot，不能提交给 GLM-5.3。'), { status: 400 });
    }
    const result = await queueGlmSequenceRequest(() => generateGlmSequencePrompt({
      sequence,
      scene: body.scene || {},
      shots,
      characters: Array.isArray(body.characters) ? body.characters : [],
      assets: Array.isArray(body.assets) ? body.assets : [],
      style: body.style || body.overallStyle || '',
      previousEndState: body.previousEndState || '',
    }));
    sendJson(res, 200, { result });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/workflow/generate-asset-designs') {
    const body = await parseJsonBody(req);
    if (!body.settings || typeof body.settings !== 'object') {
      throw Object.assign(new Error('缺少有效的 H3 资产设定。'), { status: 400 });
    }
    const result = await queueGlmAssetRequest(() => generateGlmAssetDesignsBatched(body.settings));
    sendJson(res, 200, { result });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/workflow/commit') {
    const runtime = await projectRuntime();
    const body = await parseJsonBody(req);
    const commitSequences = Array.isArray(body.sequences) ? body.sequences : [];
    const commitShotsById = new Map((Array.isArray(body.shots) ? body.shots : []).map(shot => [String(shot?.id || ''), shot]));
    for (const sequence of commitSequences) {
      const sequenceId = String(sequence?.id || '');
      const videoPrompt = String((body.prompts || {})[sequenceId] || sequence?.prompt?.text || sequence?.promptText || '');
      const expectedSpeech = (Array.isArray(sequence?.shotIds) ? sequence.shotIds : [])
        .flatMap(shotId => collectSpeechLines([commitShotsById.get(String(shotId))]));
      validateGlmSequenceResult({
        directorRead: sequence?.directorRead || (body.directorReads || {})[sequenceId],
        generationAudit: sequence?.generationAudit || (body.generationAudits || {})[sequenceId],
        videoPrompt,
      }, Number(sequence?.durationSeconds || sequence?.duration || 0), expectedSpeech);
    }
    const workspace = buildWorkflowWorkspace(runtime, body);
    const workspacePath = path.join(runtime.workbenchDir, 'workspace.json');
    await writeJsonAtomic(workspacePath, workspace);
    await writeJsonAtomic(workflowStatePath(runtime), {
      version: 1,
      stage: 'execution',
      sourceText: String(body.sourceText || ''),
      outline: body.outline || null,
      settings: body.settings || body.outline?.settings || null,
      shots: body.shots || [],
      sequences: body.sequences || [],
      prompts: body.prompts || {},
      directorReads: body.directorReads || {},
      generationAudits: body.generationAudits || {},
      sequenceEndStates: body.sequenceEndStates || {},
      updatedAt: new Date().toISOString(),
    });
    sendJson(res, 200, { project: runtime.project, workspace, workspacePath });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/auto') {
    const runtime = await projectRuntime();
    const plan = await enrichAutoPlanProgress(runtime, await loadAutoPlan(runtime));
    sendJson(res, 200, { project: runtime.project, plan, running: AUTO_RUNS.has(runtime.projectRoot) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/auto/annotations') {
    const runtime = await projectRuntime();
    const workspace = await loadDirectorWorkspace(runtime);
    sendJson(res, 200, { project: runtime.project, annotations: workspace.annotations || {} });
    return;
  }

  const workflowPresetMatch = url.pathname.match(/^\/api\/auto\/sequences\/([^/]+)\/workflow-preset$/);
  if (req.method === 'POST' && workflowPresetMatch) {
    const runtime = await projectRuntime();
    if (AUTO_RUNS.has(runtime.projectRoot)) {
      sendJson(res, 409, { error: 'H3 全自动漫剧正在运行，不能切换工作流档位。' });
      return;
    }
    const sequenceId = decodeURIComponent(workflowPresetMatch[1]);
    if (!/^[a-zA-Z0-9._-]+$/.test(sequenceId)) {
      sendJson(res, 400, { error: 'Invalid Sequence id.' });
      return;
    }
    const body = await parseJsonBody(req);
    const rawPreset = String(body?.preset || 'auto').trim();
    const preset = rawPreset === 'auto' ? '' : normalizeH3WorkflowPreset(rawPreset);
    if (preset && !H3_WORKFLOW_PRESETS[preset]) {
      sendJson(res, 400, { error: `未知 H3 工作流档位：${rawPreset}` });
      return;
    }
    const workspace = await loadDirectorWorkspace(runtime);
    const sequence = (workspace.project.sequences || []).find(candidate => String(candidate.id) === sequenceId);
    if (!sequence) {
      sendJson(res, 404, { error: `Sequence not found: ${sequenceId}` });
      return;
    }
    if (preset) sequence.h3WorkflowPreset = preset;
    else delete sequence.h3WorkflowPreset;
    await saveDirectorWorkspace(runtime, workspace);

    const workflow = await loadWorkflowState(runtime);
    const workflowSequence = (workflow.sequences || []).find(candidate => String(candidate?.id || '') === sequenceId);
    if (workflowSequence) {
      if (preset) workflowSequence.h3WorkflowPreset = preset;
      else delete workflowSequence.h3WorkflowPreset;
      workflow.updatedAt = new Date().toISOString();
      await writeJsonAtomic(workflowStatePath(runtime), workflow);
    }

    const rebuiltPlan = planH3AutoComic(workspace, runtime);
    const existingPlan = await loadAutoPlan(runtime);
    let plan = rebuiltPlan;
    if (existingPlan?.queue?.length) {
      const routedItem = rebuiltPlan.queue.find(candidate => String(candidate.sequenceId) === sequenceId);
      const currentItem = existingPlan.queue.find(candidate => String(candidate.sequenceId) === sequenceId);
      if (routedItem && currentItem) {
        currentItem.workflowPreset = routedItem.workflowPreset;
        currentItem.workflowPresetVersion = routedItem.workflowPresetVersion;
        currentItem.workflowPresetSource = routedItem.workflowPresetSource;
        currentItem.routeReason = routedItem.routeReason;
        existingPlan.updatedAt = new Date().toISOString();
        plan = existingPlan;
      }
    }
    await saveAutoPlan(runtime, plan);
    sendJson(res, 200, {
      project: runtime.project,
      plan,
      running: false,
      preset: preset || 'auto',
      ultraRefineExperiment: H3_ULTRA_REFINE_EXPERIMENT,
    });
    return;
  }

  const annotationMatch = url.pathname.match(/^\/api\/auto\/sequences\/([^/]+)\/annotations$/);
  if (req.method === 'POST' && annotationMatch) {
    const runtime = await projectRuntime();
    const sequenceId = decodeURIComponent(annotationMatch[1]);
    if (!/^[a-zA-Z0-9._-]+$/.test(sequenceId)) {
      sendJson(res, 400, { error: 'Invalid Sequence id.' });
      return;
    }
    const workspace = await loadDirectorWorkspace(runtime);
    const sequence = (workspace.project.sequences || []).find(candidate => String(candidate.id) === sequenceId);
    if (!sequence) {
      sendJson(res, 404, { error: `Sequence not found: ${sequenceId}` });
      return;
    }
    const body = await parseJsonBody(req);
    const text = String(body?.text || '').trim();
    if (!text) {
      sendJson(res, 400, { error: '批注不能为空。' });
      return;
    }
    workspace.annotations = workspace.annotations && typeof workspace.annotations === 'object' ? workspace.annotations : {};
    const annotation = {
      id: `annotation_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
      text,
      createdAt: new Date().toISOString(),
      promptFingerprint: `sha256:${crypto.createHash('sha256').update(String(sequence.prompt?.text || '')).digest('hex')}`,
    };
    const history = Array.isArray(workspace.annotations[sequenceId]) ? workspace.annotations[sequenceId] : [];
    workspace.annotations[sequenceId] = [...history, annotation];
    await saveDirectorWorkspace(runtime, workspace);
    sendJson(res, 200, { project: runtime.project, annotation, annotations: workspace.annotations });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/auto/jobs') {
    const runtime = await projectRuntime();
    const doc = await loadJobs(runtime, 'auto');
    sendJson(res, 200, { project: runtime.project, jobs: doc.jobs });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/assets/') && url.pathname.endsWith('/media')) {
    const runtime = await projectRuntime();
    const rawAssetId = url.pathname.slice('/api/assets/'.length, -'/media'.length);
    let assetId = '';
    try { assetId = decodeURIComponent(rawAssetId); } catch {
      sendJson(res, 400, { error: '无效的 H3 资产标识。' });
      return;
    }
    const safeAssetId = assetId.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safeAssetId || safeAssetId !== assetId) {
      sendJson(res, 400, { error: '无效的 H3 资产标识。' });
      return;
    }
    const workspace = await loadDirectorWorkspace(runtime);
    const asset = (workspace.project.assets || []).find(candidate => String(candidate.id) === safeAssetId);
    if (!asset) {
      sendJson(res, 404, { error: 'H3 资产不存在：' + safeAssetId });
      return;
    }
    const assetPath = resolveAssetPath(runtime.projectRoot, asset);
    const projectRoot = path.resolve(runtime.projectRoot);
    const resolvedAssetPath = assetPath ? path.resolve(assetPath) : '';
    const relativePath = resolvedAssetPath ? path.relative(projectRoot, resolvedAssetPath) : '';
    const outsideProject = !resolvedAssetPath
      || path.isAbsolute(relativePath)
      || relativePath === '..'
      || relativePath.startsWith('..' + path.sep);
    if (outsideProject) {
      sendJson(res, 409, { error: 'H3 资产参考图不在当前 H3 项目目录内。' });
      return;
    }
    if (!existsSync(resolvedAssetPath)) {
      sendJson(res, 404, { error: '该 H3 资产还没有实际参考图。' });
      return;
    }
    res.writeHead(200, {
      'content-type': fileType(resolvedAssetPath),
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    createReadStream(resolvedAssetPath).pipe(res);
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/auto/assets/') && url.pathname.endsWith('/upload')) {
    const runtime = await projectRuntime();
    const rawAssetId = url.pathname.slice('/api/auto/assets/'.length, -'/upload'.length);
    let assetId = '';
    try { assetId = decodeURIComponent(rawAssetId); } catch {
      sendJson(res, 400, { error: '无效的 H3 资产标识。' });
      return;
    }
    const safeAssetId = assetId.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safeAssetId || safeAssetId !== assetId) {
      sendJson(res, 400, { error: '无效的 H3 资产标识。' });
      return;
    }
    const form = await parseMultipart(req);
    const upload = form.get('file');
    if (!upload || typeof upload.arrayBuffer !== 'function') {
      sendJson(res, 400, { error: '请选择要绑定的资产参考图。' });
      return;
    }
    const mime = String(upload.type || '').toLowerCase();
    if (mime && !mime.startsWith('image/')) {
      sendJson(res, 415, { error: 'H3 资产只接受图片文件。' });
      return;
    }
    const workspace = await loadDirectorWorkspace(runtime);
    const asset = (workspace.project.assets || []).find(candidate => String(candidate.id) === safeAssetId);
    if (!asset) {
      sendJson(res, 404, { error: `H3 资产不存在：${safeAssetId}` });
      return;
    }
    const category = asset.kind === 'character' ? 'characters' : asset.kind === 'scene_reference' ? 'scenes' : 'props';
    const extensionByMime = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
    let ext = path.extname(String(upload.name || '')).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) ext = extensionByMime[mime] || '.png';
    const safeName = String(asset.name || asset.id || 'asset').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, '-').slice(0, 64) || 'asset';
    const destinationDir = path.join(runtime.projectRoot, 'assets', category);
    const destinationPath = path.join(destinationDir, `${safeName}-${safeAssetId}${ext}`);
    await mkdir(destinationDir, { recursive: true });
    await writeFile(destinationPath, Buffer.from(await upload.arrayBuffer()));
    const relativePath = path.relative(runtime.projectRoot, destinationPath).split(path.sep).join('/');
    asset.uri = relativePath;
    await saveDirectorWorkspace(runtime, workspace);

    const workflow = await loadWorkflowState(runtime);
    const applyUri = settings => {
      if (!settings || typeof settings !== 'object') return;
      for (const key of ['characters', 'scenes', 'assets']) {
        if (!Array.isArray(settings[key])) continue;
        settings[key] = settings[key].map(item => String(item?.id || '') === safeAssetId ? { ...item, uri: relativePath } : item);
      }
    };
    applyUri(workflow.settings);
    applyUri(workflow.outline?.settings);
    workflow.updatedAt = new Date().toISOString();
    await writeJsonAtomic(workflowStatePath(runtime), workflow);
    sendJson(res, 200, { project: runtime.project, asset, path: destinationPath, relativePath });
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/auto/assets/') && url.pathname.endsWith('/bind-generated')) {
    const runtime = await projectRuntime();
    const rawAssetId = url.pathname.slice('/api/auto/assets/'.length, -'/bind-generated'.length);
    let assetId = '';
    try { assetId = decodeURIComponent(rawAssetId); } catch {
      sendJson(res, 400, { error: '无效的 H3 资产标识。' });
      return;
    }
    const safeAssetId = assetId.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safeAssetId || safeAssetId !== assetId) {
      sendJson(res, 400, { error: '无效的 H3 资产标识。' });
      return;
    }
    const body = await parseJsonBody(req);
    const sourcePath = path.resolve(String(body?.sourcePath || ''));
    const sourceRelative = path.relative(LOVART_MEDIA_DOWNLOAD_DIR, sourcePath);
    const sourceOutsideDownloads = !sourcePath
      || path.isAbsolute(sourceRelative)
      || sourceRelative === '..'
      || sourceRelative.startsWith('..' + path.sep);
    if (sourceOutsideDownloads) {
      sendJson(res, 403, { error: 'H3 只允许绑定落盘到 NANA_LOVART_OUTPUT_DIR 的外部生成图片。公开版建议直接使用“上传参考图”。' });
      return;
    }
    if (!existsSync(sourcePath)) {
      sendJson(res, 404, { error: 'Lovart 生成文件不存在，无法绑定到 H3 项目。' });
      return;
    }

    const workspace = await loadDirectorWorkspace(runtime);
    const asset = (workspace.project.assets || []).find(candidate => String(candidate.id) === safeAssetId);
    if (!asset) {
      sendJson(res, 404, { error: `H3 资产不存在：${safeAssetId}` });
      return;
    }
    const category = asset.kind === 'character' ? 'characters' : asset.kind === 'scene_reference' ? 'scenes' : 'props';
    const ext = path.extname(sourcePath) || '.png';
    const safeName = String(asset.name || asset.id || 'asset').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, '-').slice(0, 64) || 'asset';
    const destinationDir = path.join(runtime.projectRoot, 'assets', category);
    const destinationPath = path.join(destinationDir, `${safeName}-${safeAssetId}${ext}`);
    await mkdir(destinationDir, { recursive: true });
    await copyFile(sourcePath, destinationPath);
    const relativePath = path.relative(runtime.projectRoot, destinationPath).split(path.sep).join('/');
    asset.uri = relativePath;
    await saveDirectorWorkspace(runtime, workspace);

    const workflow = await loadWorkflowState(runtime);
    const applyUri = settings => {
      if (!settings || typeof settings !== 'object') return;
      for (const key of ['characters', 'scenes', 'assets']) {
        if (!Array.isArray(settings[key])) continue;
        settings[key] = settings[key].map(item => String(item?.id || '') === safeAssetId ? { ...item, uri: relativePath } : item);
      }
    };
    applyUri(workflow.settings);
    applyUri(workflow.outline?.settings);
    workflow.updatedAt = new Date().toISOString();
    await writeJsonAtomic(workflowStatePath(runtime), workflow);

    sendJson(res, 200, {
      project: runtime.project,
      asset,
      path: destinationPath,
      relativePath,
      sourcePath,
      provider: String(body?.provider || 'lovart'),
      model: String(body?.model || ''),
      ratio: String(body?.ratio || ''),
      remoteUrl: String(body?.remoteUrl || ''),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/auto/assets/') && url.pathname.endsWith('/open-folder')) {
    const runtime = await projectRuntime();
    const rawAssetId = url.pathname.slice('/api/auto/assets/'.length, -'/open-folder'.length);
    let assetId = '';
    try { assetId = decodeURIComponent(rawAssetId); } catch {
      sendJson(res, 400, { error: '无效的 H3 资产标识。' });
      return;
    }
    const safeAssetId = assetId.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safeAssetId || safeAssetId !== assetId) {
      sendJson(res, 400, { error: '无效的 H3 资产标识。' });
      return;
    }
    const workspace = await loadDirectorWorkspace(runtime);
    const asset = (workspace.project.assets || []).find(candidate => String(candidate.id) === safeAssetId);
    if (!asset) {
      sendJson(res, 404, { error: `H3 资产不存在：${safeAssetId}` });
      return;
    }
    const assetPath = resolveAssetPath(runtime.projectRoot, asset);
    const folder = await openH3PathInExplorer(runtime, assetPath);
    sendJson(res, 200, { opened: true, folder });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/auto/relation-frame/')) {
    const runtime = await projectRuntime();
    const sequenceId = decodeURIComponent(url.pathname.slice('/api/auto/relation-frame/'.length));
    const safeSequenceId = sequenceId.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safeSequenceId || safeSequenceId !== sequenceId) {
      sendJson(res, 400, { error: '无效的 Sequence 标识。' });
      return;
    }
    const framePath = path.join(relationFrameDir(runtime), `${safeSequenceId}.png`);
    if (!existsSync(framePath)) {
      sendJson(res, 404, { error: '该 Sequence 还没有空间关系帧。' });
      return;
    }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    createReadStream(framePath).pipe(res);
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/auto/relation-frame/') && url.pathname.endsWith('/open-folder')) {
    const runtime = await projectRuntime();
    const rawSequenceId = url.pathname.slice('/api/auto/relation-frame/'.length, -'/open-folder'.length);
    let sequenceId = '';
    try { sequenceId = decodeURIComponent(rawSequenceId); } catch {
      sendJson(res, 400, { error: '无效的 Sequence 标识。' });
      return;
    }
    const safeSequenceId = sequenceId.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safeSequenceId || safeSequenceId !== sequenceId) {
      sendJson(res, 400, { error: '无效的 Sequence 标识。' });
      return;
    }
    const framePath = path.join(relationFrameDir(runtime), `${safeSequenceId}.png`);
    const folder = await openH3PathInExplorer(runtime, framePath);
    sendJson(res, 200, { opened: true, folder });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auto/migrate-legacy-jobs') {
    const runtime = await projectRuntime();
    const migrated = await migrateLegacyAutoJobs(runtime);
    sendJson(res, 200, { project: runtime.project, migrated });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auto/backfill') {
    const runtime = await projectRuntime();
    if (AUTO_RUNS.has(runtime.projectRoot)) throw Object.assign(new Error('H3 全自动漫剧正在运行，完成后才能回填成品记录。'), { status: 409 });
    const plan = await loadAutoPlan(runtime);
    if (!plan) throw Object.assign(new Error('当前项目还没有 H3 自动规划。'), { status: 409 });
    const result = await backfillCompletedAutoResults(runtime, plan);
    sendJson(res, 200, {
      project: runtime.project,
      plan,
      workspace: result.workspace,
      backfilledResults: result.count,
      migratedLegacyJobs: result.migratedLegacyJobs,
      running: false,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auto/plan') {
    const runtime = await projectRuntime();
    if (AUTO_RUNS.has(runtime.projectRoot)) throw Object.assign(new Error('H3 全自动漫剧正在运行，不能重建规划。'), { status: 409 });
    const workspace = await loadDirectorWorkspace(runtime);
    const plan = await saveAutoPlan(runtime, planH3AutoComic(workspace, runtime));
    sendJson(res, 200, { project: runtime.project, plan, running: false });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auto/start') {
    const body = await parseJsonBody(req);
    if (body.confirmGeneration !== true) throw Object.assign(new Error('启动 H3 全自动漫剧会真实提交H3 GPU；需要 confirmGeneration=true。'), { status: 400 });
    const runtime = await projectRuntime();
    if (AUTO_RUNS.has(runtime.projectRoot)) throw Object.assign(new Error('H3 全自动漫剧已经在运行。'), { status: 409 });
    const workspace = await loadDirectorWorkspace(runtime);
    let plan = await loadAutoPlan(runtime);
    if (!plan || plan.projectId !== workspace.project.id || plan.sourceFingerprint !== workspace.project.sourceFingerprint) {
      throw Object.assign(new Error('当前项目还没有最新 H3 规划，请先点击“按 Shot 重新规划”。'), { status: 409 });
    }
    const assetGate = inspectAutoAssetGate(workspace, plan, runtime);
    if (!assetGate.ready) {
      const missing = assetGate.missing.map(item => `${item.name}（${item.sequenceId}）`).join('、') || '队列资产绑定';
      throw Object.assign(new Error(`H3 资产未就绪，禁止开始视频生成。缺少实际参考图：${missing}。请先完成资产生成、下载和“按 Shot 重新规划”。`), { status: 409 });
    }
    if (!plan.queue.length || plan.plan.rejections.length) throw Object.assign(new Error('H3 规划存在阻断项，不能开始自动生成。'), { status: 409 });
    // “开始生成”本身就是 GPU 使用意图：先完成 H3 唤醒/互斥切换，
    // 成功后再把自动队列标记为 running，避免待机状态被误判为公司端故障。
    await ensureH3Gpu();
    plan.status = 'running';
    plan.stopRequested = false;
    plan.lastError = '';
    await saveAutoPlan(runtime, plan);
    const promise = runAutoComic(runtime, plan).finally(() => AUTO_RUNS.delete(runtime.projectRoot));
    AUTO_RUNS.set(runtime.projectRoot, promise);
    sendJson(res, 202, { project: runtime.project, plan, running: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auto/stop') {
    const runtime = await projectRuntime();
    const plan = await loadAutoPlan(runtime);
    if (!plan) throw Object.assign(new Error('当前项目还没有 H3 自动规划。'), { status: 409 });
    plan.stopRequested = true;
    plan.status = AUTO_RUNS.has(runtime.projectRoot) ? 'stopping' : 'paused';
    await saveAutoPlan(runtime, plan);
    sendJson(res, 200, { project: runtime.project, plan, running: AUTO_RUNS.has(runtime.projectRoot) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/jobs') {
    const runtime = await projectRuntime();
    const doc = await loadJobs(runtime);
    const legacyJobs = await loadLegacyFreeIslandJobs(runtime);
    const currentIds = new Set(doc.jobs.map(job => job.id));
    sendJson(res, 200, {
      project: runtime.project,
      jobs: [...doc.jobs, ...legacyJobs.filter(job => !currentIds.has(job.id))],
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/preview') {
    const body = await parseJsonBody(req);
    const seconds = Number(body.seconds);
    const imageCount = Number(body.image_count || 0);
    const aspectRatio = String(body.aspect_ratio || '16:9 (Widescreen)');
    const megapixels = Number(body.megapixels || 0.9);
    const workflowPreset = normalizeH3WorkflowPreset(body.workflow_preset || 'standard');
    const requestedMode = String(body.generation_mode || '').trim();
    const firstAsFrame = imageCount > 0 && (requestedMode ? requestedMode === 'image' : Boolean(body.first_as_frame));
    if (!H3_WORKFLOW_PRESETS[workflowPreset]) throw Object.assign(new Error(`未知 H3 工作流档位：${body.workflow_preset || workflowPreset}`), { status: 400 });
    if (workflowPreset !== 'standard' && aspectRatio !== '16:9 (Widescreen)') {
      throw Object.assign(new Error(`${H3_WORKFLOW_PRESETS[workflowPreset].label} 当前只完成 16:9 实机验收。`), { status: 400 });
    }
    const imageNames = Array.from({ length: imageCount }, (_, index) => `preview-${index + 1}.png`);
    const built = buildAutoWorkflow({ prompt: body.prompt, aspectRatio, seconds, megapixels, imageNames, firstAsFrame, jobId: 'preview', workflowPreset });
    sendJson(res, 200, {
      seconds,
      length: built.length,
      image_count: imageCount,
      generation_mode: generationModeFor(imageCount, firstAsFrame),
      task_type: built.taskType,
      prompt: built.prompt,
      workflow_preset: workflowPreset,
      workflow_preset_version: H3_WORKFLOW_PRESETS[workflowPreset].version,
      megapixels: built.megapixels,
      requested_megapixels: megapixels,
      target_width: built.targetWidth,
      target_height: built.targetHeight,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/submit') {
    const form = await parseMultipart(req);
    const prompt = String(form.get('prompt') || '').trim();
    const aspectRatio = String(form.get('aspect_ratio') || '16:9 (Widescreen)');
    const seconds = Number(form.get('seconds') || 15);
    const megapixels = Number(form.get('megapixels') || 0.9);
    const workflowPreset = normalizeH3WorkflowPreset(form.get('workflow_preset') || 'standard');
    const requestedMode = String(form.get('generation_mode') || '').trim();
    const legacyFirstAsFrame = String(form.get('first_as_frame') || 'false') === 'true';
    const images = form.getAll('images').filter(item => item && typeof item.arrayBuffer === 'function');
    const firstAsFrame = images.length > 0 && (requestedMode ? requestedMode === 'image' : legacyFirstAsFrame);
    const generationMode = generationModeFor(images.length, firstAsFrame);

    if (!prompt) throw Object.assign(new Error('请先填写提示词。'), { status: 400 });
    if (!ASPECTS.has(aspectRatio)) throw Object.assign(new Error('画幅不受支持。'), { status: 400 });
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 15) {
      throw Object.assign(new Error('秒数必须是 5～15 秒的整数。'), { status: 400 });
    }
    if (!MEGAPIXELS.has(megapixels)) {
      throw Object.assign(new Error('画质仅支持 0.5、0.7、0.9、1.0、1.1 MP。'), { status: 400 });
    }
    if (!H3_WORKFLOW_PRESETS[workflowPreset]) {
      throw Object.assign(new Error(`未知 H3 工作流档位：${form.get('workflow_preset') || workflowPreset}`), { status: 400 });
    }
    if (workflowPreset !== 'standard' && aspectRatio !== '16:9 (Widescreen)') {
      throw Object.assign(new Error(`${H3_WORKFLOW_PRESETS[workflowPreset].label} 当前只完成 16:9 实机验收。`), { status: 400 });
    }
    if (images.length > 9) throw Object.assign(new Error('最多上传 9 张图片。'), { status: 400 });
    if ((requestedMode === 'image' || requestedMode === 'reference') && images.length === 0) {
      throw Object.assign(new Error('图生视频 / 参考生视频需要先上传至少 1 张图片。'), { status: 400 });
    }

    const runtime = await projectRuntime();
    const jobId = `h3-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const targetWidth = workflowPreset === 'best_dynamic' ? 1408 : workflowPreset === 'ultra_refine' ? 1920 : null;
    const targetHeight = workflowPreset === 'best_dynamic' ? 768 : workflowPreset === 'ultra_refine' ? 1088 : null;
    const job = {
      id: jobId,
      prompt_id: '',
      status: 'submitting',
      prompt,
      prompt_sent: normalizedPrompt(prompt),
      aspect_ratio: aspectRatio,
      seconds,
      megapixels,
      requested_megapixels: megapixels,
      target_width: targetWidth,
      target_height: targetHeight,
      workflow_preset: workflowPreset,
      workflow_preset_version: H3_WORKFLOW_PRESETS[workflowPreset].version,
      workflow_preset_source: 'manual',
      length: alignedLength(seconds),
      image_count: images.length,
      generation_mode: generationMode,
      first_as_frame: firstAsFrame,
      task_type: taskTypeFor(images.length, firstAsFrame),
      progress_phase: 'submitting',
      progress_percent: 1,
      progress_label: '正在上传参考图并准备H3 GPU',
      created_at: now,
      updated_at: now,
    };
    await saveJob(runtime, job);

    try {
      const imageNames = [];
      const referenceImages = [];
      for (let index = 0; index < images.length; index++) {
        const localCopy = await saveFreeIslandInputCopy(runtime, jobId, images[index], index);
        const remotePath = await uploadImage(images[index], jobId, index);
        imageNames.push(remotePath);
        referenceImages.push({ ...localCopy, remote_path: remotePath });
        job.reference_images = referenceImages.map(item => ({ ...item }));
        job.progress_percent = Math.max(2, Math.min(8, Math.round(((index + 1) / Math.max(1, images.length)) * 8)));
        job.progress_label = `正在上传参考图 ${index + 1}/${images.length}`;
        job.updated_at = new Date().toISOString();
        await saveJob(runtime, job);
      }

      const built = buildAutoWorkflow({
        prompt,
        aspectRatio,
        seconds,
        megapixels,
        imageNames,
        firstAsFrame,
        jobId,
        workflowPreset,
      });
      job.prompt_sent = built.prompt;
      job.megapixels = built.megapixels;
      job.target_width = built.targetWidth;
      job.target_height = built.targetHeight;
      job.length = built.length;
      job.image_count = imageNames.length;
      job.task_type = built.taskType;
      job.progress_percent = 9;
      job.progress_label = '工作流已准备，正在提交ComfyUI';
      job.updated_at = new Date().toISOString();
      await saveJob(runtime, job);

      const response = await comfyFetch('/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: built.workflow, client_id: CLIENT_ID }),
        timeoutMs: 30_000,
      });
      const queued = await response.json();
      if (!queued.prompt_id) {
        throw new Error(queued.error || 'ComfyUI 没有返回 prompt_id。');
      }

      job.prompt_id = queued.prompt_id;
      job.status = 'queued';
      job.progress_phase = 'queued';
      job.progress_percent = 10;
      job.progress_label = '已进入H3 GPU 队列';
      job.updated_at = new Date().toISOString();
      await saveJob(runtime, job);
      ACTIVE_JOBS.set(job.prompt_id, { runtime, job });
      void monitorJob(runtime, job);
      sendJson(res, 202, { job });
      return;
    } catch (error) {
      rememberFailureStage(job);
      job.status = 'failed';
      job.progress_phase = 'failed';
      job.progress_label = '提交H3 GPU 失败';
      job.error = errorMessage(error);
      job.updated_at = new Date().toISOString();
      await saveJob(runtime, job);
      throw error;
    }
  }

  const reuseJobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/reuse$/);
  if (req.method === 'GET' && reuseJobMatch) {
    const runtime = await projectRuntime();
    const jobId = decodeURIComponent(reuseJobMatch[1]);
    const doc = await loadJobs(runtime);
    const job = doc.jobs.find(item => item.id === jobId);
    if (!job) {
      sendJson(res, 404, { error: '找不到要复用的 H3 历史任务。' });
      return;
    }
    let recovered = [];
    let warning = '';
    try {
      recovered = await recoverFreeIslandReferenceImages(runtime, job);
      if (recovered.length) {
        job.reference_images = recovered.map(item => ({ ...item }));
        job.updated_at = new Date().toISOString();
        await saveJob(runtime, job);
      } else if (Number(job.image_count || 0) > 0) {
        warning = '原任务有参考图，但当前已无法从历史输入中恢复；提示词已复用。';
      }
    } catch (error) {
      warning = `提示词已复用，但参考图暂时无法恢复：${errorMessage(error)}`;
    }
    sendJson(res, 200, {
      job_id: job.id,
      prompt: job.prompt || '',
      generation_mode: job.generation_mode || (recovered.length ? 'reference' : 'text'),
      image_count: recovered.length,
      warning,
      images: recovered.map((item, index) => ({
        index,
        name: item.name || `参考图${index + 1}`,
        url: `/api/jobs/${encodeURIComponent(job.id)}/reuse-images/${index}`,
      })),
    });
    return;
  }

  const reuseImageMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/reuse-images\/(\d+)$/);
  if (req.method === 'GET' && reuseImageMatch) {
    const runtime = await projectRuntime();
    const jobId = decodeURIComponent(reuseImageMatch[1]);
    const imageIndex = Number(reuseImageMatch[2]);
    const doc = await loadJobs(runtime);
    const job = doc.jobs.find(item => item.id === jobId);
    if (!job || !Number.isInteger(imageIndex) || imageIndex < 0) {
      sendJson(res, 404, { error: '找不到要复用的参考图。' });
      return;
    }
    const recovered = await recoverFreeIslandReferenceImages(runtime, job);
    const image = recovered[imageIndex];
    const localPath = image ? ensureFreeIslandReusePath(runtime, image.local_path) : '';
    if (!localPath || !existsSync(localPath)) {
      sendJson(res, 404, { error: '参考图已经不存在。' });
      return;
    }
    res.writeHead(200, {
      'content-type': fileType(localPath),
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(image.name || path.basename(localPath))}`,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    createReadStream(localPath).pipe(res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/open-output-folder') {
    const runtime = await projectRuntime();
    await mkdir(runtime.outputDir, { recursive: true });
    if (process.platform !== 'win32') {
      throw Object.assign(new Error('当前系统不支持直接打开 Windows 文件夹。'), { status: 501 });
    }
    const explorer = spawn('explorer.exe', [runtime.outputDir], { detached: true, stdio: 'ignore' });
    explorer.unref();
    sendJson(res, 200, { opened: true, path: runtime.outputDir });
    return;
  }

  const autoJobFolderMatch = url.pathname.match(/^\/api\/auto\/jobs\/([^/]+)\/open-folder$/);
  if (req.method === 'POST' && autoJobFolderMatch) {
    const runtime = await projectRuntime();
    const jobId = decodeURIComponent(autoJobFolderMatch[1]);
    const doc = await loadJobs(runtime, 'auto');
    const job = doc.jobs.find(item => item.id === jobId);
    if (!job?.output_path) {
      throw Object.assign(new Error('这条 H3 成品还没有可打开的本地文件。'), { status: 409 });
    }
    const folder = await openH3PathInExplorer(runtime, job.output_path);
    sendJson(res, 200, { opened: true, folder });
    return;
  }

  const autoOutputMatch = url.pathname.match(/^\/api\/auto\/jobs\/([^/]+)\/output$/);
  if (req.method === 'GET' && autoOutputMatch) {
    await serveOutput(req, res, decodeURIComponent(autoOutputMatch[1]), 'auto');
    return;
  }

  const outputMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/output$/);
  if (req.method === 'GET' && outputMatch) {
    await serveOutput(req, res, decodeURIComponent(outputMatch[1]));
    return;
  }

  sendJson(res, 404, { error: 'API 不存在。' });
}

async function serveStatic(res, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  const safePath = path.join(PUBLIC_DIR, file);
  if (!safePath.startsWith(PUBLIC_DIR) || !existsSync(safePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const contentType = file.endsWith('.html') ? 'text/html; charset=utf-8'
    : file.endsWith('.js') ? 'text/javascript; charset=utf-8'
    : file.endsWith('.css') ? 'text/css; charset=utf-8'
    : 'application/octet-stream';
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  createReadStream(safePath).pipe(res);
}

await mkdir(PUBLIC_DIR, { recursive: true });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, error?.status || 500, { error: errorMessage(error) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MiniMax H3 执行台 listening at http://127.0.0.1:${PORT}/`);
  void connectProgressSocket();
  void resumePendingJobs();
});
