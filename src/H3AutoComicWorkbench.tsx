import React, { useCallback, useEffect, useMemo, useState } from 'react';
import './h3-auto-comic.css';
import './h3-auto-comic-media.css';

type RunStatus = 'idle' | 'ready' | 'running' | 'stopping' | 'paused' | 'completed' | 'failed';
type ItemStatus = 'waiting' | 'running' | 'extracting_frame' | 'completed' | 'failed' | 'blocked';

interface QueueItem {
  sequenceId: string;
  sceneId: string;
  sceneTitle: string;
  sceneOrder: number;
  sequenceOrder: number;
  durationSeconds: number;
  status: ItemStatus;
  resultId?: string;
  jobId?: string;
  outputPath?: string;
  outputName?: string;
  shotIds: string[];
  assetIds: string[];
  assetPaths: string[];
  assetBindings?: Array<{ assetId: string; path: string }>;
  prompt: string;
  workflowPreset?: 'standard' | 'best_dynamic' | 'ultra_refine' | string;
  workflowPresetVersion?: string;
  workflowPresetSource?: 'auto' | 'manual' | string;
  routeReason?: string;
  relationFrameIn?: string;
  relationFrameOut?: string;
  relationFrameNote?: string;
  progressPhase?: string;
  progressPercent?: number;
  progressLabel?: string;
  progressValue?: number;
  progressMax?: number;
  progressUpdatedAt?: string;
  error?: string;
}

interface AutoState {
  kind: 'nana-director-h3-auto-comic';
  version: 1;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  projectId: string;
  projectName: string;
  currentSequenceId: string | null;
  stopRequested: boolean;
  queue: QueueItem[];
  rejections?: Array<{ reason?: string; message?: string; assetIds?: string[] }>;
  assetGate?: { ready?: boolean; required?: number; bound?: number } | null;
  lastError: string;
  lastErrorAt?: string;
  lastErrorSequenceId?: string;
  settings: { relationFrameRatios: number[]; pollSeconds: number };
}

interface H3Shot {
  id: string;
  sceneId: string;
  order: number;
  durationSeconds: number;
  sourceText: string;
  characterIds?: string[];
  assetIds?: string[];
  speech?: Array<{ speaker?: string; text?: string; type?: string }>;
}

interface H3Sequence {
  id: string;
  sceneId: string;
  order: number;
  durationSeconds?: number;
  shotIds?: string[];
  title?: string;
  name?: string;
  description?: string;
}

interface H3Asset {
  id: string;
  name?: string;
  description?: string;
  prompt?: string;
  kind?: string;
  uri?: string;
  referencePlan?: { main?: string; multiAngle?: string[]; details?: string[] };
}

interface H3Settings {
  overview?: string;
  style?: string;
  characters?: H3Asset[];
  scenes?: H3Asset[];
  assets?: H3Asset[];
}

type MediaFolderTarget =
  | { kind: 'asset'; id: string }
  | { kind: 'relation-frame'; id: string }
  | { kind: 'job'; id: string };

type PreviewState = {
  kind: 'image' | 'video';
  src: string;
  title: string;
  meta?: string;
  folderTarget?: MediaFolderTarget;
} | null;

interface H3Annotation {
  id: string;
  text: string;
  createdAt: string;
  promptFingerprint?: string;
}

interface H3Workflow {
  stage?: string;
  sourceText?: string;
  settings?: H3Settings;
  outline?: { settings?: H3Settings; sceneOutlines?: Array<{ id?: string; title?: string; rawText?: string; description?: string }> };
  shots?: H3Shot[];
  sequences?: H3Sequence[];
  prompts?: Record<string, string>;
}

interface SceneGroup {
  id: string;
  title: string;
  order: number;
  items: QueueItem[];
}

const runLabels: Record<RunStatus, string> = {
  idle: '尚未规划',
  ready: '等待启动',
  running: '自动生成中',
  stopping: '当前条完成后暂停',
  paused: '已暂停',
  completed: '全部完成',
  failed: '遇到错误并停止',
};

const itemLabels: Record<ItemStatus, string> = {
  waiting: '等待',
  running: 'H3 生成中',
  extracting_frame: '提取关系帧',
  completed: '已完成',
  failed: '失败',
  blocked: '阻塞',
};

const assetKindLabels: Record<string, string> = {
  character: '人物',
  scene_reference: '场景',
  prop: '道具',
  scene: '场景',
};

const workflowPresetLabels: Record<string, string> = {
  standard: '极速文戏',
  best_dynamic: '动态增强·中档',
  ultra_refine: '极致精修 1080P',
  best_dynamic_short: '动态增强·中档',
  best_dynamic_long: '动态增强·中档',
};

function readError(payload: any, fallback: string) {
  return String(payload?.error || payload?.message || fallback);
}

function frameSequenceId(framePath: string) {
  const file = String(framePath || '').split(/[\\/]/).pop() || '';
  return file.replace(/\.png$/i, '');
}

function sceneSource(workflow: H3Workflow | null, sceneId: string) {
  return workflow?.outline?.sceneOutlines?.find((scene) => String(scene.id) === sceneId);
}

function sequenceTitle(workflow: H3Workflow | null, item: QueueItem) {
  const sequence = workflow?.sequences?.find((candidate) => candidate.id === item.sequenceId);
  return sequence?.title || sequence?.name || item.sequenceId;
}

function promptFor(workflow: H3Workflow | null, item: QueueItem) {
  return item.prompt || workflow?.prompts?.[item.sequenceId] || '';
}

function normalizedWorkflowPreset(value?: string) {
  if (value === 'best_dynamic_short' || value === 'best_dynamic_long') return 'best_dynamic';
  return value || 'standard';
}

export function H3AutoComicWorkbench() {
  const [state, setState] = useState<AutoState | null>(null);
  const [workflow, setWorkflow] = useState<H3Workflow | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activeSceneId, setActiveSceneId] = useState('');
  const [selectedSequenceId, setSelectedSequenceId] = useState('');
  const [copiedSequenceId, setCopiedSequenceId] = useState('');
  const [preview, setPreview] = useState<PreviewState>(null);
  const [notice, setNotice] = useState('');
  const [openingFolderKey, setOpeningFolderKey] = useState('');
  const [annotations, setAnnotations] = useState<Record<string, H3Annotation[]>>({});
  const [annotationDrafts, setAnnotationDrafts] = useState<Record<string, string>>({});
  const [savingAnnotationSequenceId, setSavingAnnotationSequenceId] = useState('');
  const [savingPresetSequenceId, setSavingPresetSequenceId] = useState('');
  const [generatingAssetId, setGeneratingAssetId] = useState('');

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/auto', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(readError(payload, `HTTP ${response.status}`));
      setState(payload.plan || null);
      setRunning(Boolean(payload.running));
      setError('');
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    }
  }, []);

  const refreshWorkflow = useCallback(async () => {
    try {
      const response = await fetch('/api/workflow', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(readError(payload, `HTTP ${response.status}`));
      setWorkflow(payload.workflow || null);
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    }
  }, []);

  const refreshAnnotations = useCallback(async () => {
    try {
      const response = await fetch('/api/auto/annotations', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(readError(payload, `HTTP ${response.status}`));
      setAnnotations(payload.annotations && typeof payload.annotations === 'object' ? payload.annotations : {});
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshWorkflow();
    void refreshAnnotations();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => window.clearInterval(timer);
  }, [refresh, refreshWorkflow, refreshAnnotations]);

  const scenes = useMemo<SceneGroup[]>(() => {
    const groups = new Map<string, SceneGroup>();
    for (const item of state?.queue || []) {
      const group = groups.get(item.sceneId) || {
        id: item.sceneId,
        title: item.sceneTitle || item.sceneId,
        order: item.sceneOrder,
        items: [],
      };
      group.items.push(item);
      groups.set(item.sceneId, group);
    }
    for (const [index, scene] of (workflow?.outline?.sceneOutlines || []).entries()) {
      const id = String(scene.id || '');
      if (!id || groups.has(id)) continue;
      groups.set(id, { id, title: String(scene.title || id), order: index, items: [] });
    }
    return [...groups.values()]
      .sort((a, b) => a.order - b.order)
      .map((scene) => ({ ...scene, items: [...scene.items].sort((a, b) => a.sequenceOrder - b.sequenceOrder) }));
  }, [state, workflow]);

  useEffect(() => {
    if (!scenes.length) return;
    if (!scenes.some((scene) => scene.id === activeSceneId)) setActiveSceneId(scenes[0].id);
  }, [scenes, activeSceneId]);

  const activeScene = scenes.find((scene) => scene.id === activeSceneId) || scenes[0];
  const activeItems = activeScene?.items || [];

  useEffect(() => {
    if (!activeItems.length) return;
    if (!activeItems.some((item) => item.sequenceId === selectedSequenceId)) {
      setSelectedSequenceId(activeItems[0].sequenceId);
    }
  }, [activeItems, selectedSequenceId]);

  useEffect(() => {
    if (!preview) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreview(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [preview]);

  const settings = workflow?.settings || workflow?.outline?.settings || {};
  const assetCatalog = useMemo(() => ([
    ...(settings.characters || []).map((asset) => ({ ...asset, kind: asset.kind || 'character' })),
    ...(settings.scenes || []).map((asset) => ({ ...asset, kind: asset.kind || 'scene_reference' })),
    ...(settings.assets || []).map((asset) => ({ ...asset, kind: asset.kind || 'prop' })),
  ]), [settings]);
  const assetMap = useMemo(() => new Map(assetCatalog.map((asset) => [String(asset.id), asset])), [assetCatalog]);
  const shotMap = useMemo(() => new Map((workflow?.shots || []).map((shot) => [shot.id, shot])), [workflow]);

  const counts = useMemo(() => {
    const queue = state?.queue || [];
    return {
      total: queue.length,
      completed: queue.filter((item) => item.status === 'completed').length,
      waiting: queue.filter((item) => item.status === 'waiting').length,
      failed: queue.filter((item) => item.status === 'failed' || item.status === 'blocked').length,
      shots: workflow?.shots?.length || queue.reduce((sum, item) => sum + item.shotIds.length, 0),
    };
  }, [state, workflow]);

  const progress = counts.total ? Math.round((counts.completed / counts.total) * 100) : 0;
  const currentItem = useMemo(() => {
    const queue = state?.queue || [];
    if (state?.currentSequenceId) {
      const exact = queue.find((item) => item.sequenceId === state.currentSequenceId);
      if (exact) return exact;
    }
    return queue.find((item) => item.status === 'running' || item.status === 'extracting_frame') || null;
  }, [state]);
  const currentPreset = currentItem ? normalizedWorkflowPreset(currentItem.workflowPreset) : '';
  const currentProgress = Math.max(0, Math.min(100, Number(currentItem?.progressPercent || 0)));
  const recentErrorItem = useMemo(() => {
    const queue = state?.queue || [];
    if (state?.lastErrorSequenceId) {
      const exact = queue.find((item) => item.sequenceId === state.lastErrorSequenceId);
      if (exact) return exact;
    }
    return [...queue].reverse().find((item) => Boolean(item.error)) || null;
  }, [state]);
  const storyText = String(workflow?.sourceText || '').trim();
  const activeSource = activeScene ? sceneSource(workflow, activeScene.id) : undefined;
  const assetReadiness = useMemo(() => {
    const queue = state?.queue || [];
    const missingBySequence = queue.filter((item) => (
      !item.assetIds?.length || !Array.isArray(item.assetPaths) || item.assetPaths.length < item.assetIds.length
    ));
    const requiredIds = [...new Set(queue.flatMap((item) => item.assetIds || []))];
    const boundIds = [...new Set(queue.flatMap((item) => (
      (item.assetBindings || []).filter((binding) => Boolean(binding.path)).map((binding) => binding.assetId)
    )))];
    return {
      ready: Boolean(queue.length) && !state?.rejections?.length && state?.assetGate?.ready !== false && missingBySequence.length === 0,
      required: state?.assetGate?.required ?? requiredIds.length,
      bound: state?.assetGate?.bound ?? boundIds.length,
      missingBySequence,
    };
  }, [state]);

  const pipelineSteps = [
    { label: '剧本', done: Boolean(storyText) },
    { label: '资产', done: assetReadiness.ready },
    { label: 'Scene', done: scenes.length > 0 },
    { label: 'Shot', done: counts.shots > 0 },
    { label: 'Sequence', done: counts.total > 0 },
    { label: 'Agent Prompt', done: (state?.queue || []).some((item) => Boolean(promptFor(workflow, item))) },
    { label: 'H3 视频', done: counts.completed > 0 },
    { label: '关系帧', done: (state?.queue || []).some((item) => Boolean(item.relationFrameOut)) },
  ];

  async function post(path: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(readError(payload, `HTTP ${response.status}`));
      setState(payload.plan || null);
      if (payload.running !== undefined) setRunning(Boolean(payload.running));
      return payload;
    } catch (cause: any) {
      setError(cause?.message || String(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  }

  const rebuild = async () => {
    if (running) return;
    await post('/api/auto/plan');
    await refreshWorkflow();
  };

  const uploadAsset = async (asset: H3Asset, file: File) => {
    if (running || generatingAssetId || !file) return;
    setGeneratingAssetId(asset.id);
    setError('');
    setNotice(`${asset.name || asset.id} 正在上传参考图…`);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const response = await fetch(`/api/auto/assets/${encodeURIComponent(asset.id)}/upload`, {
        method: 'POST',
        body: form,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(readError(payload, `HTTP ${response.status}`));
      await refreshWorkflow();
      await post('/api/auto/plan');
      setNotice(`${asset.name || asset.id} 已上传并绑定；H3 队列资产门禁已重新检查。`);
    } catch (cause: any) {
      setError(cause?.message || String(cause));
      setNotice('');
    } finally {
      setGeneratingAssetId('');
    }
  };

  const start = async () => {
    const confirmed = window.confirm(
      '开始后会真实提交 MiniMax H3 到你配置的 ComfyUI，并按 Scene 自动串行生成。\n\n同一 Scene：上一条完成 → 自动截取空间关系帧 → 下一条。\n跨 Scene：关系帧清空，从正式资产重新起链。\n\n确认开始？',
    );
    if (!confirmed) return;
    await post('/api/auto/start', { confirmGeneration: true });
  };

  const stop = async () => {
    await post('/api/auto/stop');
  };

  const copyPrompt = async (item: QueueItem) => {
    const text = promptFor(workflow, item);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedSequenceId(item.sequenceId);
      window.setTimeout(() => setCopiedSequenceId(''), 1500);
    } catch {
      setError('当前浏览器拒绝了剪贴板访问，请直接选中 Prompt 复制。');
    }
  };

  const saveAnnotation = async (item: QueueItem) => {
    const text = String(annotationDrafts[item.sequenceId] || '').trim();
    if (!text || savingAnnotationSequenceId === item.sequenceId) return;
    setSavingAnnotationSequenceId(item.sequenceId);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/auto/sequences/${encodeURIComponent(item.sequenceId)}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(readError(payload, `HTTP ${response.status}`));
      setAnnotationDrafts((current) => ({ ...current, [item.sequenceId]: '' }));
      await refreshAnnotations();
      setNotice('批注已保存到当前 H3 项目，可继续围绕这一条 Sequence 迭代。');
      window.setTimeout(() => setNotice(''), 3500);
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    } finally {
      setSavingAnnotationSequenceId('');
    }
  };

  const setWorkflowPreset = async (item: QueueItem, preset: string) => {
    if (running || savingPresetSequenceId === item.sequenceId) return;
    setSavingPresetSequenceId(item.sequenceId);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/auto/sequences/${encodeURIComponent(item.sequenceId)}/workflow-preset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(readError(payload, `HTTP ${response.status}`));
      setState(payload.plan || null);
      if (payload.running !== undefined) setRunning(Boolean(payload.running));
      await refreshWorkflow();
      const label = preset === 'auto' ? '自动导演' : workflowPresetLabels[preset] || preset;
      setNotice(`${sequenceTitle(workflow, item)} 已切换为 ${label}；自动队列已按新档位重建。`);
      window.setTimeout(() => setNotice(''), 3500);
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    } finally {
      setSavingPresetSequenceId('');
    }
  };

  const openImagePreview = (src: string, title: string, meta: string, folderTarget?: MediaFolderTarget) => {
    setPreview({ kind: 'image', src, title, meta, folderTarget });
  };

  const openVideoPreview = (src: string, title: string, meta: string, folderTarget?: MediaFolderTarget) => {
    setPreview({ kind: 'video', src, title, meta, folderTarget });
  };

  const openMediaFolder = async (target: MediaFolderTarget) => {
    const key = `${target.kind}:${target.id}`;
    if (openingFolderKey === key) return;
    const endpoint = target.kind === 'asset'
      ? `/api/auto/assets/${encodeURIComponent(target.id)}/open-folder`
      : target.kind === 'relation-frame'
        ? `/api/auto/relation-frame/${encodeURIComponent(target.id)}/open-folder`
        : `/api/auto/jobs/${encodeURIComponent(target.id)}/open-folder`;
    setOpeningFolderKey(key);
    setError('');
    setNotice('');
    try {
      const response = await fetch(endpoint, { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(readError(payload, `HTTP ${response.status}`));
      setNotice(`已打开所在文件夹${payload.folder ? `：${payload.folder}` : ''}`);
      window.setTimeout(() => setNotice(''), 3500);
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    } finally {
      setOpeningFolderKey('');
    }
  };

  const startDisabled = busy || running || !assetReadiness.ready || Boolean(state?.rejections?.length) || counts.failed > 0 || state?.status === 'completed';

  return (
    <main className="h3aw-root">
      <header className="h3aw-header">
        <div className="h3aw-brand">
          <div className="h3aw-mark">H3</div>
          <div>
            <div className="h3aw-eyebrow">NANA ISLAND · SERIAL PRODUCTION</div>
            <h1>H3 全自动漫剧工作台</h1>
            <p>独立项目档案 · 同 Scene 严格串行 · 成品关系帧自动接力</p>
          </div>
        </div>
        <div className="h3aw-header-right">
          <div className="h3aw-project-chip"><span>当前 H3 项目</span><strong>{state?.projectName || '未加载项目'}</strong></div>
          <span className={`h3aw-run-status ${state?.status || 'idle'}`}>{runLabels[state?.status || 'idle']}</span>
          <div className="h3aw-progress"><span>{counts.completed}/{counts.total || 0}</span><i><b style={{ width: `${progress}%` }} /></i><em>{progress}%</em></div>
          {running || state?.status === 'stopping' ? (
            <button type="button" className="h3aw-button danger" onClick={stop} disabled={busy || state?.status === 'stopping'}>当前条完成后暂停</button>
          ) : (
            <button type="button" className="h3aw-button primary" onClick={start} disabled={startDisabled}>{state?.status === 'paused' || state?.status === 'failed' ? '继续自动生成' : '开始自动生成'}</button>
          )}
        </div>
      </header>

      <section className={`h3aw-run-monitor ${state?.status || 'idle'}`} aria-label="H3 后台生成流程">
        <div className="h3aw-run-monitor-head">
          <div>
            <span>BACKGROUND RUN / 后台流程</span>
            <strong>{currentItem ? sequenceTitle(workflow, currentItem) : (state?.status === 'completed' ? '本轮队列已完成' : '等待开始或下一条 Sequence')}</strong>
          </div>
          <small>总进度 {counts.completed}/{counts.total || 0} · 每 10 秒刷新一次，无需持续盯守</small>
        </div>
        <div className="h3aw-run-monitor-grid">
          <div><span>当前档位</span>{currentItem ? <b className={`h3aw-workflow-badge ${currentPreset}`}>{workflowPresetLabels[currentPreset] || currentPreset}</b> : <strong>—</strong>}</div>
          <div><span>当前阶段</span><strong>{currentItem?.progressLabel || (currentItem ? itemLabels[currentItem.status] : runLabels[state?.status || 'idle'])}</strong></div>
          <div><span>当前条进度</span><strong>{currentItem ? `${currentProgress}%${currentItem.progressMax ? ` · ${currentItem.progressValue || 0}/${currentItem.progressMax}` : ''}` : '—'}</strong></div>
          <div><span>队列统计</span><strong>完成 {counts.completed} · 等待 {counts.waiting} · 异常 {counts.failed}</strong></div>
        </div>
        <div className="h3aw-run-monitor-bar"><i style={{ width: `${currentItem ? currentProgress : progress}%` }} /></div>
        {state?.lastError && (
          <div className="h3aw-run-monitor-error">
            <b>最近错误{recentErrorItem ? ` · ${sequenceTitle(workflow, recentErrorItem)}` : ''}</b>
            <span>{state.lastError}</span>
            {state.lastErrorAt && <small>{state.lastErrorAt.replace('T', ' ').slice(0, 19)}</small>}
          </div>
        )}
      </section>

      {error && <div className="h3aw-error">{error}</div>}
      {notice && <div className="h3aw-notice">{notice}</div>}
      <section className={`h3aw-asset-gate ${assetReadiness.ready ? 'ready' : 'blocked'}`}>
        <div><strong>{assetReadiness.ready ? '资产门禁已通过' : '资产门禁未通过'}</strong><span>{assetReadiness.ready ? `已绑定 ${assetReadiness.bound || assetReadiness.required} 项实际参考图，允许提交 H3。` : '每条 Sequence 必须先绑定可上传的实际参考图；资产未齐时禁止启动视频生成。'}</span></div>
        <span className="h3aw-asset-gate-count">{assetReadiness.bound}/{assetReadiness.required || assetCatalog.length} 已绑定</span>
        {!assetReadiness.ready && <button type="button" className="h3aw-button secondary" onClick={rebuild} disabled={busy || running}>重建并检查资产</button>}
      </section>

      <div className="h3aw-pipeline" aria-label="H3 自动漫剧生产流程">
        {pipelineSteps.map((step, index) => (
          <React.Fragment key={step.label}>
            <div className={`h3aw-pipeline-step ${step.done ? 'done' : ''}`}><span>{String(index + 1).padStart(2, '0')}</span><strong>{step.label}</strong></div>
            {index < pipelineSteps.length - 1 && <i>→</i>}
          </React.Fragment>
        ))}
      </div>

      <div className="h3aw-body">
        <aside className="h3aw-sidebar">
          <div className="h3aw-sidebar-heading"><span>PROJECT ARCHIVE</span><strong>{state?.projectName || 'H3 项目'}</strong></div>
          <div className="h3aw-sidebar-stat"><span>剧本 / {counts.shots} Shots / {counts.total} Sequences</span><b>{settings.style || '等待 H3 项目规划'}</b></div>
          <div className="h3aw-sidebar-label">SCENE 导航</div>
          <nav className="h3aw-scene-nav" aria-label="H3 Scene 导航">
            {scenes.map((scene, index) => {
              const done = scene.items.length > 0 && scene.items.every((item) => item.status === 'completed');
              return (
                <button key={scene.id} type="button" className={`h3aw-scene-item ${scene.id === activeScene?.id ? 'active' : ''}`} onClick={() => setActiveSceneId(scene.id)}>
                  <span className="h3aw-scene-index">SCENE {String(index + 1).padStart(2, '0')}</span>
                  <strong>{scene.title}</strong>
                  <small>{scene.items.length || '—'} Sequence · {done ? '已完成' : '待执行'}</small>
                  <div className="h3aw-scene-dots">{scene.items.map((item) => <i key={item.sequenceId} className={item.status} />)}</div>
                </button>
              );
            })}
          </nav>
          <div className="h3aw-sidebar-script">
            <div className="h3aw-section-label">剧本原文</div>
            <p>{storyText || '还没有读取到 H3 项目的剧本。'}</p>
          </div>
          <div className="h3aw-isolation-note"><span>PUBLIC H3 ONLY</span><p>独立开源版只读写当前 H3 项目档案；不会读取娜娜私有导演台。</p></div>
        </aside>

        <section className="h3aw-content">
          <section className="h3aw-story-card">
            <div className="h3aw-story-copy"><div className="h3aw-section-label">STORY / 项目总览</div><h2>{settings.overview || storyText || '等待剧本'}</h2><p>{settings.style || '尚未读取全局风格设定。'}</p></div>
            <div className="h3aw-story-metrics"><div><span>Scene</span><strong>{scenes.length}</strong></div><div><span>Shot</span><strong>{counts.shots}</strong></div><div><span>Sequence</span><strong>{counts.total}</strong></div><div><span>完成</span><strong>{counts.completed}</strong></div></div>
          </section>

          <section className="h3aw-asset-bank">
            <div className="h3aw-section-label">ASSET BANK / 资产索引</div>
            <div className="h3aw-asset-grid">
              {assetCatalog.length ? assetCatalog.map((asset) => (
                <article key={`${asset.kind}-${asset.id}`} className="h3aw-asset-card">
                  <div className="h3aw-asset-media">
                    <button
                      type="button"
                      className={'h3aw-media-button h3aw-asset-thumb ' + (asset.uri ? '' : 'empty')}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (asset.uri) openImagePreview(
                          '/api/assets/' + encodeURIComponent(asset.id) + '/media',
                          asset.name || asset.id,
                          `${assetKindLabels[asset.kind || ''] || '资产'} · 参考图`,
                          { kind: 'asset', id: asset.id },
                        );
                      }}
                      disabled={!asset.uri}
                      aria-label={`放大查看${asset.name || asset.id}`}
                    >
                      {asset.uri ? <img src={'/api/assets/' + encodeURIComponent(asset.id) + '/media'} alt={(asset.name || asset.id) + '参考图'} loading="lazy" /> : <span>无图</span>}
                    </button>
                    {asset.uri && <button type="button" className="h3aw-media-folder-button" onClick={(event) => { event.stopPropagation(); void openMediaFolder({ kind: 'asset', id: asset.id }); }}>打开所在文件夹</button>}
                  </div>
                  <div className={`h3aw-asset-icon ${asset.kind}`}>{assetKindLabels[asset.kind || ''] || '资产'}</div>
                  <div className="h3aw-asset-copy"><strong>{asset.name || asset.id}</strong><span>{asset.description || asset.referencePlan?.main || '已登记到 H3 项目资产库'}</span><em className={asset.uri ? 'bound' : 'missing'}>{asset.uri ? '已绑定参考图' : '缺少参考图'}</em></div>
                  <div className="h3aw-asset-generate-row">
                    <label className="h3aw-button secondary h3aw-asset-generate-button" style={{ cursor: running || Boolean(generatingAssetId) ? 'not-allowed' : 'pointer' }}>
                      {generatingAssetId === asset.id ? '上传中…' : asset.uri ? '替换参考图' : '上传参考图'}
                      <input
                        type="file"
                        accept="image/*"
                        hidden
                        disabled={running || Boolean(generatingAssetId)}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void uploadAsset(asset, file);
                          event.currentTarget.value = '';
                        }}
                      />
                    </label>
                  </div>
                </article>
              )) : <div className="h3aw-no-data">当前 H3 项目尚未登记可展示的资产条目。</div>}
            </div>
          </section>

          {activeScene ? (
            <section className="h3aw-scene-workbench">
              <div className="h3aw-scene-heading">
                <div><div className="h3aw-section-label">SCENE {String(activeScene.order + 1).padStart(2, '0')} / 审阅工作区</div><h2>{activeScene.title}</h2><p>{activeSource?.rawText || activeSource?.description || '当前 Scene 没有额外的原文说明。'}</p></div>
                <div className="h3aw-scene-heading-meta"><span>{activeItems.length} 个 Sequence</span><span>{activeItems.reduce((sum, item) => sum + item.durationSeconds, 0)}s 执行时长</span></div>
              </div>

              {!activeItems.length ? (
                <div className="h3aw-empty-scene"><strong>这个 Scene 还没有进入 H3 队列</strong><span>先在 H3 项目中完成 Sequence Prompt，再点击“重建自动队列”。</span><button type="button" className="h3aw-button secondary" onClick={rebuild} disabled={busy || running}>重建自动队列</button></div>
              ) : (
                <div className="h3aw-sequence-stack">
                  {activeItems.map((item) => {
                    const shots = item.shotIds.map((id) => shotMap.get(id)).filter(Boolean) as H3Shot[];
                    const usedAssetIds = [...new Set([
                      ...item.assetIds,
                      ...(item.assetBindings || []).map((binding) => binding.assetId),
                      ...shots.flatMap((shot) => [...(shot.characterIds || []), ...(shot.assetIds || [])]),
                    ])];
                    const assets = usedAssetIds.map((id) => assetMap.get(id)).filter(Boolean) as H3Asset[];
                    const bindingByAssetId = new Map<string, { assetId: string; path: string }>((item.assetBindings || []).map((binding) => [binding.assetId, binding]));
                    const boundAssets = assets.filter((asset) => Boolean(bindingByAssetId.get(asset.id)?.path || asset.uri));
                    const prompt = promptFor(workflow, item);
                    const selected = item.sequenceId === selectedSequenceId;
                    const videoUrl = item.jobId ? `/api/auto/jobs/${encodeURIComponent(item.jobId)}/output` : '';
                    const inputFrameId = frameSequenceId(item.relationFrameIn || '');
                    const inputFrameUrl = inputFrameId ? `/api/auto/relation-frame/${encodeURIComponent(inputFrameId)}?v=${encodeURIComponent(state?.updatedAt || '')}` : '';
                    const outputFrameUrl = item.relationFrameOut ? `/api/auto/relation-frame/${encodeURIComponent(item.sequenceId)}?v=${encodeURIComponent(state?.updatedAt || '')}` : '';
                    const sequenceAnnotations = annotations[item.sequenceId] || [];
                    const annotationDraft = annotationDrafts[item.sequenceId] || '';
                    const savingAnnotation = savingAnnotationSequenceId === item.sequenceId;
                    const activePreset = normalizedWorkflowPreset(item.workflowPreset);
                    const presetSelection = item.workflowPresetSource === 'manual' ? activePreset : 'auto';
                    const savingPreset = savingPresetSequenceId === item.sequenceId;
                    return (
                      <article key={item.sequenceId} className={`h3aw-sequence-card ${item.status} ${selected ? 'selected' : ''}`} onClick={() => setSelectedSequenceId(item.sequenceId)}>
                        <header className="h3aw-sequence-header">
                          <div><span className="h3aw-sequence-kicker">SEQUENCE {String(item.sequenceOrder + 1).padStart(2, '0')}</span><h3>{sequenceTitle(workflow, item)}</h3><p>{item.sequenceId} · {item.shotIds.length} Shots · {item.durationSeconds}s</p></div>
                          <div className="h3aw-sequence-header-right">
                            <span className={`h3aw-item-status ${item.status}`}>{itemLabels[item.status]}</span>
                            <span className={`h3aw-workflow-badge ${activePreset}`}>{workflowPresetLabels[activePreset] || activePreset}</span>
                            <span className="h3aw-engine-badge">Agent → H3</span>
                            <label className="h3aw-workflow-control" onClick={(event) => event.stopPropagation()}>
                              <span>工作流</span>
                              <select
                                value={presetSelection}
                                disabled={running || savingPreset}
                                onChange={(event) => void setWorkflowPreset(item, event.target.value)}
                                aria-label={`${item.sequenceId} H3 工作流档位`}
                              >
                                <option value="auto">自动导演</option>
                                <option value="standard">极速文戏</option>
                                <option value="best_dynamic">动态增强·中档</option>
                                <option value="ultra_refine">极致精修 1080P</option>
                              </select>
                            </label>
                            <small className="h3aw-route-reason" title={item.routeReason || ''}>{savingPreset ? '切换中…' : item.routeReason || (item.workflowPresetSource === 'manual' ? '手动指定' : '自动判断')}</small>
                          </div>
                        </header>

                        <div className="h3aw-sequence-grid">
                          <div className="h3aw-sequence-plan">
                            <div className="h3aw-subhead"><strong>SHOT PLAN</strong><span>{shots.length} 个镜头 · 组合后提交为一条 Sequence</span></div>
                            <div className="h3aw-shot-list">
                              {shots.length ? shots.map((shot, shotIndex) => (
                                <div key={shot.id} className="h3aw-shot-row">
                                  <span className="h3aw-shot-number">{String(shotIndex + 1).padStart(2, '0')}</span><div className="h3aw-shot-line"><strong>{shot.id}</strong><span>{shot.durationSeconds}s</span><p>{shot.sourceText || '暂无镜头原文'}</p>{shot.speech?.map((speech, speechIndex) => <em key={`${shot.id}-speech-${speechIndex}`}>{speech.speaker || '台词'}：{speech.text || ''}</em>)}</div>
                                </div>
                              )) : <div className="h3aw-no-data">没有读取到这条 Sequence 的 Shot 明细。</div>}
                            </div>
                            <div className="h3aw-subhead asset-head"><strong>SEQUENCE ASSETS / 本条上传</strong><span>{boundAssets.length}/{assets.length} 项已绑定 · H3 已上传</span></div>
                            <div className="h3aw-sequence-assets">{assets.length ? assets.map((asset) => {
                              const binding = bindingByAssetId.get(asset.id);
                              const isBound = Boolean(binding?.path || asset.uri);
                              const assetMediaUrl = asset.uri ? `/api/assets/${encodeURIComponent(asset.id)}/media` : '';
                              return <div key={asset.id} className={`h3aw-sequence-asset-card ${isBound ? 'bound' : 'missing'}`}>
                                {assetMediaUrl ? <button type="button" className="h3aw-sequence-asset-thumb" onClick={(event) => { event.stopPropagation(); openImagePreview(assetMediaUrl, `${sequenceTitle(workflow, item)} · ${asset.name || asset.id}`, `${assetKindLabels[asset.kind || ''] || '资产'} · 本条 Sequence 上传参考图`, { kind: 'asset', id: asset.id }); }} aria-label={`放大查看${asset.name || asset.id}`}><img src={assetMediaUrl} alt={`${asset.name || asset.id}参考图`} loading="lazy" /></button> : <div className="h3aw-sequence-asset-thumb empty">无图</div>}
                                <div className="h3aw-sequence-asset-copy"><div><b>{assetKindLabels[asset.kind || ''] || '资产'}</b><strong>{asset.name || asset.id}</strong></div><span>{binding?.path || asset.uri || '未绑定实际文件'}</span><em>{isBound ? '已绑定到本条 Sequence' : '缺少实际文件'}</em></div>
                              </div>;
                            }) : <span className="h3aw-no-data">本条 Sequence 没有绑定资产</span>}</div>
                          </div>

                          <div className="h3aw-sequence-review">
                            <div className="h3aw-prompt-head"><div><strong>AGENT SEQUENCE PROMPT</strong><span>Agent 回填的 H3 执行提示词 · 只读审阅</span></div><button type="button" onClick={(event) => { event.stopPropagation(); void copyPrompt(item); }} disabled={!prompt}>{copiedSequenceId === item.sequenceId ? '已复制' : '复制 Prompt'}</button></div>
                            <textarea className="h3aw-prompt" value={prompt} readOnly spellCheck={false} aria-label={`${item.sequenceId} Agent H3 Prompt`} />
                            <div className="h3aw-continuity-head"><strong>CONTINUITY / 空间关系接力</strong><span>{item.relationFrameIn ? '承接上一条成品关系帧' : '本 Scene 从正式资产起链'}</span></div>
                            <div className="h3aw-frame-grid">
                              <div className="h3aw-frame-tile">
                                {inputFrameId ? <>
                                  <button type="button" className="h3aw-media-button h3aw-frame-media" onClick={(event) => { event.stopPropagation(); openImagePreview(inputFrameUrl, `${sequenceTitle(workflow, item)} · 输入关系帧`, '上一个Sequence的连续性参考帧', { kind: 'relation-frame', id: inputFrameId }); }}><img src={inputFrameUrl} alt="上一条 Sequence 关系帧" /></button>
                                  <button type="button" className="h3aw-media-folder-button" onClick={(event) => { event.stopPropagation(); void openMediaFolder({ kind: 'relation-frame', id: inputFrameId }); }}>打开所在文件夹</button>
                                </> : <div className="h3aw-frame-placeholder"><b>START</b><span>Scene 起始不携带上一 Scene 关系帧</span></div>}
                                <small>输入关系帧</small>
                              </div>
                              <div className="h3aw-frame-tile">
                                {outputFrameUrl ? <>
                                  <button type="button" className="h3aw-media-button h3aw-frame-media" onClick={(event) => { event.stopPropagation(); openImagePreview(outputFrameUrl, `${sequenceTitle(workflow, item)} · 输出关系帧`, '当前Sequence完成后截取的连续性参考帧', { kind: 'relation-frame', id: item.sequenceId }); }}><img src={outputFrameUrl} alt="当前 Sequence 关系帧" /></button>
                                  <button type="button" className="h3aw-media-folder-button" onClick={(event) => { event.stopPropagation(); void openMediaFolder({ kind: 'relation-frame', id: item.sequenceId }); }}>打开所在文件夹</button>
                                </> : <div className="h3aw-frame-placeholder"><b>WAIT</b><span>成品完成后自动截取</span></div>}
                                <small>输出关系帧</small>
                              </div>
                            </div>
                            {item.relationFrameNote && <p className="h3aw-frame-note">{item.relationFrameNote}</p>}
                          </div>
                        </div>

                        <div className="h3aw-result-section">
                          <div className="h3aw-subhead"><strong>RESULT / 生成结果</strong><span>{item.jobId ? `Job ${item.jobId}` : '尚未提交 H3'}</span></div>
                          {videoUrl ? <div className="h3aw-result-media"><button type="button" className="h3aw-video-preview" onClick={(event) => { event.stopPropagation(); openVideoPreview(videoUrl, sequenceTitle(workflow, item), `${item.durationSeconds}s · H3 MP4`, item.jobId ? { kind: 'job', id: item.jobId } : undefined); }} aria-label={`放大预览${sequenceTitle(workflow, item)}`}><video muted preload="metadata" playsInline src={videoUrl} /> <span>点击放大预览</span></button><div className="h3aw-result-actions"><span>{item.outputName || 'H3 MP4 成品已归档到独立项目'}</span><div className="h3aw-result-buttons"><button type="button" className="h3aw-media-folder-button" onClick={(event) => { event.stopPropagation(); if (item.jobId) void openMediaFolder({ kind: 'job', id: item.jobId }); }}>打开所在文件夹</button><a href={`${videoUrl}?download=1`} download={item.outputName || `${item.jobId}.mp4`}>下载 MP4</a></div></div></div> : <div className="h3aw-result-empty">{item.error || '这条 Sequence 尚未生成结果。完成后，视频、输出关系帧和归档路径会显示在这里。'}</div>}
                        </div>
                        <div className="h3aw-annotation-box" onClick={(event) => event.stopPropagation()}>
                          <div className="h3aw-annotation-header"><strong>娜娜批注</strong><span>{sequenceAnnotations.length} 条历史批注</span></div>
                          <textarea
                            value={annotationDraft}
                            onChange={(event) => setAnnotationDrafts((current) => ({ ...current, [item.sequenceId]: event.target.value }))}
                            placeholder="写这一版需要修改什么：情绪、动作、镜头、特效或资产问题……"
                            rows={3}
                            aria-label={`${item.sequenceId} 娜娜批注`}
                          />
                          <div className="h3aw-annotation-actions"><button type="button" disabled={!annotationDraft.trim() || savingAnnotation} onClick={() => void saveAnnotation(item)}>{savingAnnotation ? '保存中…' : '提交批注'}</button></div>
                          {sequenceAnnotations.length > 0 && (
                            <div className="h3aw-annotation-history">
                              {[...sequenceAnnotations].reverse().map((annotation) => (
                                <div key={annotation.id}><time>{new Date(annotation.createdAt).toLocaleString('zh-CN')}</time><p>{annotation.text}</p></div>
                              ))}
                            </div>
                          )}
                        </div>
                        {item.error && <div className="h3aw-item-error">{item.error}</div>}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          ) : (
            <section className="h3aw-empty-scene"><strong>还没有可显示的 H3 Scene</strong><span>读取独立 H3 项目后，这里会按 Scene → Shot → Sequence 展开。</span></section>
          )}
        </section>
      </div>
      {preview && (
        <div className="h3aw-preview-backdrop" role="presentation" onClick={() => setPreview(null)}>
          <section className="h3aw-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="h3aw-preview-title" onClick={(event) => event.stopPropagation()}>
            <header className="h3aw-preview-header">
              <div><span>{preview.kind === 'image' ? 'IMAGE PREVIEW' : 'VIDEO PREVIEW'}</span><h2 id="h3aw-preview-title">{preview.title}</h2></div>
              <button type="button" className="h3aw-preview-close" onClick={() => setPreview(null)} aria-label="关闭预览">×</button>
            </header>
            <div className="h3aw-preview-stage">
              {preview.kind === 'image' ? <img src={preview.src} alt={preview.title} /> : <video controls autoPlay playsInline src={preview.src}>您的浏览器不支持视频播放。</video>}
            </div>
            <footer className="h3aw-preview-footer">
              <span>{preview.meta}</span>
              {preview.folderTarget && <button type="button" className="h3aw-media-folder-button" onClick={() => void openMediaFolder(preview.folderTarget!)}>打开所在文件夹</button>}
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}

export default H3AutoComicWorkbench;
