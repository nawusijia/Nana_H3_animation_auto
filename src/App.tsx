import React, { useEffect, useMemo, useState } from 'react';
import { H3AutoComicWorkbench } from './H3AutoComicWorkbench';
import './app.css';

type H3Project = { id: string; name: string; path?: string; isActive?: boolean };
type Shot = { id: string; sceneId: string; order: number; durationSeconds: number; characterIds?: string[]; assetIds?: string[]; [key: string]: any };
type SceneOutline = { id: string; title?: string; rawText?: string; locationId?: string; [key: string]: any };

async function jsonRequest(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body instanceof FormData ? options.headers : { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.message || `${path} HTTP ${response.status}`);
  return payload;
}

function groupShotsIntoSequences(scene: SceneOutline, shots: Shot[]) {
  const ordered = shots.filter((shot) => shot.sceneId === scene.id).sort((a, b) => a.order - b.order);
  const groups: Shot[][] = [];
  let current: Shot[] = [];
  let duration = 0;
  for (const shot of ordered) {
    const shotDuration = Math.max(1, Math.min(15, Math.round(Number(shot.durationSeconds) || 3)));
    if (current.length && duration + shotDuration > 15) {
      groups.push(current);
      current = [];
      duration = 0;
    }
    current.push({ ...shot, durationSeconds: shotDuration });
    duration += shotDuration;
  }
  if (current.length) groups.push(current);
  return groups.map((group, index) => {
    const rawDuration = group.reduce((sum, shot) => sum + Number(shot.durationSeconds || 0), 0);
    const durationSeconds = Math.max(5, Math.min(15, Math.round(rawDuration)));
    return {
      id: `${scene.id}-sequence-${index + 1}`,
      sceneId: scene.id,
      sceneTitle: scene.title || scene.id,
      order: index,
      title: `${scene.title || scene.id} · Sequence ${index + 1}`,
      shotIds: group.map((shot) => shot.id),
      durationSeconds,
      assetIds: [...new Set(group.flatMap((shot) => [...(shot.characterIds || []), ...(shot.assetIds || [])]))],
    };
  });
}

export default function App() {
  const [projects, setProjects] = useState<H3Project[]>([]);
  const [activeProject, setActiveProject] = useState<H3Project | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [isOtome, setIsOtome] = useState(false);
  const [tab, setTab] = useState<'planner' | 'execute'>('planner');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [executionKey, setExecutionKey] = useState(0);

  const activeLabel = useMemo(() => activeProject?.name || '尚未选择项目', [activeProject]);

  async function refreshProjects() {
    const payload = await jsonRequest('/api/projects', { cache: 'no-store' });
    setProjects(payload.registry?.projects || []);
    setActiveProject(payload.activeProject || null);
    if (payload.activeProject) {
      const workflowPayload = await jsonRequest('/api/workflow', { cache: 'no-store' });
      setSourceText(String(workflowPayload.workflow?.sourceText || ''));
    }
  }

  useEffect(() => {
    void refreshProjects().catch((cause) => setError(cause?.message || String(cause)));
  }, []);

  async function createProject() {
    const name = newProjectName.trim();
    if (!name || busy) return;
    setBusy(true); setError(''); setStatus('正在建立独立 H3 项目…');
    try {
      await jsonRequest('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
      setNewProjectName('');
      await refreshProjects();
      setStatus('项目已建立。粘贴剧本后即可开始 AI 规划。');
    } catch (cause: any) { setError(cause?.message || String(cause)); }
    finally { setBusy(false); }
  }

  async function activateProject(id: string) {
    if (!id || busy) return;
    setBusy(true); setError('');
    try {
      await jsonRequest('/api/projects/activate', { method: 'POST', body: JSON.stringify({ id }) });
      await refreshProjects();
      setExecutionKey((value) => value + 1);
    } catch (cause: any) { setError(cause?.message || String(cause)); }
    finally { setBusy(false); }
  }

  async function saveWorkflow(workflow: any) {
    await jsonRequest('/api/workflow', { method: 'PUT', body: JSON.stringify(workflow) });
  }

  async function buildProject() {
    if (!activeProject) { setError('请先新建或选择一个 H3 项目。'); return; }
    if (!sourceText.trim()) { setError('请先粘贴剧本原文。'); return; }
    if (busy) return;
    setBusy(true); setError('');
    try {
      setStatus('1/5 · GLM-5.3 正在分析剧本、人物、场景与资产…');
      const outlineResponse = await jsonRequest('/api/workflow/analyze-outline', {
        method: 'POST', body: JSON.stringify({ sourceText, isOtome }),
      });
      const outline = outlineResponse.result;
      let settings = outline.settings || {};
      await saveWorkflow({ version: 1, stage: 'outline', sourceText, outline, settings });

      setStatus('2/5 · GLM-5.3 正在生成资产参考图设计提示词…');
      const assetResponse = await jsonRequest('/api/workflow/generate-asset-designs', {
        method: 'POST', body: JSON.stringify({ settings }),
      });
      settings = assetResponse.result?.settings || settings;
      outline.settings = settings;
      await saveWorkflow({ version: 1, stage: 'assets', sourceText, outline, settings });

      setStatus('3/5 · GLM-5.3 正在逐 Scene 拆解原子 Shot…');
      const shots: Shot[] = [];
      const sceneOutlines: SceneOutline[] = Array.isArray(outline.sceneOutlines) ? outline.sceneOutlines : [];
      for (let sceneIndex = 0; sceneIndex < sceneOutlines.length; sceneIndex += 1) {
        setStatus(`3/5 · 拆 Shot ${sceneIndex + 1}/${sceneOutlines.length}：${sceneOutlines[sceneIndex].title || sceneOutlines[sceneIndex].id}`);
        const response = await jsonRequest('/api/workflow/generate-shots', {
          method: 'POST', body: JSON.stringify({ outline, sceneIndex }),
        });
        shots.push(...(response.result || []));
      }

      const sequences = sceneOutlines.flatMap((scene) => groupShotsIntoSequences(scene, shots));
      if (!sequences.length) throw new Error('没有生成可提交 H3 的 Sequence。');
      await saveWorkflow({ version: 1, stage: 'shots', sourceText, outline, settings, shots, sequences });

      setStatus(`4/5 · GLM-5.3 正在编译 ${sequences.length} 条 Sequence Prompt…`);
      const prompts: Record<string, string> = {};
      const directorReads: Record<string, any> = {};
      const generationAudits: Record<string, any> = {};
      const sequenceEndStates: Record<string, string> = {};
      let lastSceneId = '';
      let previousEndState = '';
      for (let index = 0; index < sequences.length; index += 1) {
        const sequence = sequences[index];
        if (sequence.sceneId !== lastSceneId) previousEndState = '';
        lastSceneId = sequence.sceneId;
        const scene = sceneOutlines.find((candidate) => candidate.id === sequence.sceneId) || {};
        const sequenceShots = sequence.shotIds.map((id: string) => shots.find((shot) => shot.id === id)).filter(Boolean);
        setStatus(`4/5 · 编译 Sequence Prompt ${index + 1}/${sequences.length}`);
        const response = await jsonRequest('/api/workflow/generate-sequence-prompt', {
          method: 'POST',
          body: JSON.stringify({
            sequence,
            scene,
            shots: sequenceShots,
            characters: settings.characters || [],
            assets: [...(settings.scenes || []), ...(settings.assets || [])],
            style: settings.style || '',
            previousEndState,
          }),
        });
        const result = response.result || {};
        prompts[sequence.id] = result.videoPrompt || '';
        directorReads[sequence.id] = result.directorRead || null;
        generationAudits[sequence.id] = result.generationAudit || null;
        previousEndState = result.endState || '';
        sequenceEndStates[sequence.id] = previousEndState;
      }

      setStatus('5/5 · 写入 H3 独立项目并建立自动执行队列…');
      await jsonRequest('/api/workflow/commit', {
        method: 'POST',
        body: JSON.stringify({
          projectName: activeProject.name,
          sourceText,
          outline,
          settings,
          shots,
          sequences,
          prompts,
          directorReads,
          generationAudits,
          sequenceEndStates,
        }),
      });
      await jsonRequest('/api/auto/plan', { method: 'POST', body: '{}' });
      setStatus('规划完成。下一步上传每个资产的参考图，资产门禁通过后即可自动生成。');
      setExecutionKey((value) => value + 1);
      setTab('execute');
    } catch (cause: any) {
      setError(cause?.message || String(cause));
      setStatus('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="nana-h3-app">
      <div className="nana-h3-launchbar">
        <div className="nana-h3-launchbrand"><b>H3</b><span><strong>Nana H3 Animation Auto</strong><small>独立开源版 · GLM-5.3 → MiniMax H3</small></span></div>
        <div className="nana-h3-projects">
          <select value={activeProject?.id || ''} onChange={(event) => void activateProject(event.target.value)} disabled={busy}>
            <option value="">选择 H3 项目</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="新项目名称" disabled={busy} />
          <button onClick={() => void createProject()} disabled={busy || !newProjectName.trim()}>新建</button>
        </div>
        <div className="nana-h3-tabs">
          <button className={tab === 'planner' ? 'active' : ''} onClick={() => setTab('planner')}>01 剧本规划</button>
          <button className={tab === 'execute' ? 'active' : ''} onClick={() => setTab('execute')} disabled={!activeProject}>02 自动执行 / 审片</button>
        </div>
      </div>

      {tab === 'planner' ? (
        <main className="nana-h3-planner">
          <section className="nana-h3-planner-card intro">
            <div><span className="kicker">ACTIVE PROJECT</span><h1>{activeLabel}</h1><p>这一页只负责把剧本规划成 H3 可执行工程，不会提交视频生成。完成后到“自动执行 / 审片”上传参考图并确认开跑。</p></div>
            <label className="otome"><input type="checkbox" checked={isOtome} onChange={(event) => setIsOtome(event.target.checked)} disabled={busy} />乙女模式（女主不露正脸）</label>
          </section>
          <section className="nana-h3-planner-card editor">
            <div className="planner-head"><div><span className="kicker">STORY INPUT</span><h2>粘贴完整剧本</h2></div><span>Scene → Shot → Sequence → GLM Prompt</span></div>
            <textarea value={sourceText} onChange={(event) => setSourceText(event.target.value)} placeholder="粘贴完整剧本原文。GLM-5.3 会提取人物/场景/道具，按自然场次拆 Scene，再拆 Shot，并自动组成 5–15 秒 H3 Sequence。" disabled={busy} />
            <div className="planner-actions"><button className="primary" onClick={() => void buildProject()} disabled={busy || !activeProject || !sourceText.trim()}>{busy ? 'AI 规划中…' : '开始全自动规划'}</button><span>不会扣 H3 视频生成额度；本阶段只调用你配置的 GLM API。</span></div>
            {status && <div className="planner-status">{status}</div>}
            {error && <div className="planner-error">{error}</div>}
          </section>
        </main>
      ) : (
        activeProject ? <H3AutoComicWorkbench key={`${activeProject.id}-${executionKey}`} /> : <div className="nana-h3-empty">请先建立或选择 H3 项目。</div>
      )}
    </div>
  );
}
