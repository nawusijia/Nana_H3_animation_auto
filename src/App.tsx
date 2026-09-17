import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { H3AutoComicWorkbench } from './H3AutoComicWorkbench';
import './app.css';

type H3Project = { id: string; name: string; path?: string; isActive?: boolean };

type AgentBootstrap = {
  kind?: string;
  policy?: {
    mode?: string;
    owner?: string;
    agentOnly?: boolean;
    disabledProviders?: string[];
  };
  project?: { id?: string; name?: string; root?: string };
  pipeline?: {
    nextStage?: string;
    completedStages?: string[];
    missingPrerequisites?: string[];
  };
  stage?: {
    id?: string;
    contract?: { goal?: string; artifactShape?: string; required?: string[] } | null;
    contextApi?: string | null;
    delivery?: { completionApi?: string; method?: string } | null;
  };
  workflowSummary?: {
    stage?: string;
    sourceChars?: number;
    scenes?: number;
    shots?: number;
    sequences?: number;
    prompts?: number;
  };
};

const agentStageLabels: Record<string, string> = {
  script: '剧本输入',
  outline: 'Scene / 故事分析',
  assets: '资产规划',
  shots: 'Shot 设计',
  sequences: 'Sequence 组装',
  prompts: 'H3 Prompt 编译',
  reviewer: 'Agent 审核',
  execution: 'H3 执行',
};

const agentPipeline = ['outline', 'assets', 'shots', 'sequences', 'prompts', 'reviewer', 'execution'];

async function jsonRequest(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body instanceof FormData ? options.headers : { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.message || `${path} HTTP ${response.status}`);
  return payload;
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
  const [bootstrap, setBootstrap] = useState<AgentBootstrap | null>(null);
  const [copied, setCopied] = useState(false);

  const activeLabel = useMemo(() => activeProject?.name || '尚未选择项目', [activeProject]);
  const nextStage = bootstrap?.pipeline?.nextStage || (sourceText.trim() ? 'outline' : 'script');
  const completedStages = bootstrap?.pipeline?.completedStages || [];
  const planningReady = nextStage === 'execution';

  const refreshBootstrap = useCallback(async () => {
    if (!activeProject) {
      setBootstrap(null);
      return;
    }
    try {
      const payload = await jsonRequest('/api/agent/bootstrap', { cache: 'no-store' });
      setBootstrap(payload);
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    }
  }, [activeProject]);

  async function refreshProjects() {
    const payload = await jsonRequest('/api/projects', { cache: 'no-store' });
    setProjects(payload.registry?.projects || []);
    setActiveProject(payload.activeProject || null);
    if (payload.activeProject) {
      const workflowPayload = await jsonRequest('/api/workflow', { cache: 'no-store' });
      setSourceText(String(workflowPayload.workflow?.sourceText || ''));
      setIsOtome(Boolean(workflowPayload.workflow?.isOtome));
    } else {
      setSourceText('');
      setBootstrap(null);
    }
  }

  useEffect(() => {
    void refreshProjects().catch((cause) => setError(cause?.message || String(cause)));
  }, []);

  useEffect(() => {
    if (!activeProject) return undefined;
    void refreshBootstrap();
    const timer = window.setInterval(() => void refreshBootstrap(), 10_000);
    return () => window.clearInterval(timer);
  }, [activeProject, refreshBootstrap]);

  async function createProject() {
    const name = newProjectName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError('');
    setStatus('正在建立独立开源 H3 项目…');
    try {
      await jsonRequest('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
      setNewProjectName('');
      await refreshProjects();
      setStatus('项目已建立。粘贴剧本后，交给你的本地 Agent 接管规划即可。');
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function activateProject(id: string) {
    if (!id || busy) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await jsonRequest('/api/projects/activate', { method: 'POST', body: JSON.stringify({ id }) });
      await refreshProjects();
      setExecutionKey((value) => value + 1);
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function prepareAgentTakeover() {
    if (!activeProject) {
      setError('请先新建或选择一个 H3 项目。');
      return;
    }
    if (!sourceText.trim()) {
      setError('请先粘贴剧本原文。');
      return;
    }
    if (busy) return;
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      const payload = await jsonRequest('/api/agent/source', {
        method: 'PUT',
        body: JSON.stringify({ sourceText, isOtome, scriptMode: 'original' }),
      });
      setBootstrap(payload.bootstrap || null);
      setStatus('Agent 接管入口已准备好。无需配置任何大模型 API Key；把下方接管指令发给你正在使用的本地 Agent 即可。');
      setExecutionKey((value) => value + 1);
    } catch (cause: any) {
      setError(cause?.message || String(cause));
      setStatus('');
    } finally {
      setBusy(false);
    }
  }

  const takeoverInstruction = useMemo(() => {
    const origin = typeof window === 'undefined' ? 'http://127.0.0.1:8797' : window.location.origin;
    return [
      '请接管当前 Nana H3 Animation Auto 开源版项目的导演规划。',
      '先读取当前仓库根目录 AGENTS.md，并严格遵守其中的 OPEN-SOURCE 隔离规则；不要访问或修改任何 Nana 私有导演台目录。',
      `然后读取 ${origin}/api/agent/bootstrap，只执行 pipeline.nextStage；按 contextApi 取得当前输入，完成后通过 delivery.completionApi 回填。`,
      '每完成一阶段重新读取 bootstrap，继续到 pipeline.nextStage=execution 为止。',
      '默认 Agent-owned 模式不需要、也不要向我索要 GLM/OpenAI/Anthropic API Key，不要绕过 checkpoint 直接改 workspace.json。',
      '到 execution 后告诉我规划已完成，并说明还缺哪些真实参考图；不要未经确认直接提交 H3 GPU 生成。',
    ].join('\n');
  }, []);

  async function copyTakeoverInstruction() {
    try {
      await navigator.clipboard.writeText(takeoverInstruction);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('当前浏览器拒绝了剪贴板访问，请手动选中接管指令复制。');
    }
  }

  const completedCount = agentPipeline.filter((stage) => stage === 'execution' ? planningReady : completedStages.includes(stage)).length;

  return (
    <div className="nana-h3-app">
      <div className="nana-h3-launchbar">
        <div className="nana-h3-launchbrand">
          <b>H3</b>
          <span>
            <strong>Nana H3 Animation Auto</strong>
            <small>独立开源版 · Agent-owned → MiniMax H3</small>
          </span>
        </div>
        <div className="nana-h3-projects">
          <select value={activeProject?.id || ''} onChange={(event) => void activateProject(event.target.value)} disabled={busy}>
            <option value="">选择 H3 项目</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="新项目名称" disabled={busy} />
          <button onClick={() => void createProject()} disabled={busy || !newProjectName.trim()}>新建</button>
        </div>
        <div className="nana-h3-tabs">
          <button className={tab === 'planner' ? 'active' : ''} onClick={() => setTab('planner')}>01 Agent 导演</button>
          <button className={tab === 'execute' ? 'active' : ''} onClick={() => setTab('execute')} disabled={!activeProject}>02 自动执行 / 审片</button>
        </div>
      </div>

      {tab === 'planner' ? (
        <main className="nana-h3-planner">
          <section className="nana-h3-planner-card intro">
            <div>
              <span className="kicker">PUBLIC OPEN-SOURCE · AGENT OWNED</span>
              <h1>{activeLabel}</h1>
              <p>这个版本不再要求你配置大模型 API。剧本分析、Scene、Shot、Sequence、Prompt 与审核由你正在使用的本地 Agent 接管；本应用只保存状态、做门禁并执行 MiniMax H3。</p>
            </div>
            <label className="otome"><input type="checkbox" checked={isOtome} onChange={(event) => setIsOtome(event.target.checked)} disabled={busy} />乙女模式（女主不露正脸）</label>
          </section>

          <section className="nana-h3-planner-card editor">
            <div className="planner-head">
              <div><span className="kicker">STORY INPUT</span><h2>粘贴完整剧本</h2></div>
              <span>Agent → Scene → Shot → Sequence → H3 Prompt</span>
            </div>
            <textarea
              value={sourceText}
              onChange={(event) => setSourceText(event.target.value)}
              placeholder="粘贴完整剧本原文。保存后，把页面生成的接管指令交给 Codex / Claude Code / ChatGPT 等能访问本机项目的 Agent。"
              disabled={busy}
            />
            <div className="planner-actions">
              <button className="primary" onClick={() => void prepareAgentTakeover()} disabled={busy || !activeProject || !sourceText.trim()}>{busy ? '正在准备…' : '保存剧本 · 准备 Agent 接管'}</button>
              <span>默认不会调用 GLM / OpenAI / Anthropic API，也不需要模型 API Key。</span>
            </div>
            {status && <div className="planner-status">{status}</div>}
            {error && <div className="planner-error">{error}</div>}
          </section>

          {activeProject && sourceText.trim() && (
            <section className="nana-h3-planner-card editor agent-card">
              <div className="planner-head">
                <div><span className="kicker">AGENT TAKEOVER</span><h2>把这一段发给你的本地 Agent</h2></div>
                <span>{bootstrap?.policy?.agentOnly === false ? 'Legacy provider opt-in' : '无需 API Key'}</span>
              </div>
              <textarea className="agent-instruction" value={takeoverInstruction} readOnly spellCheck={false} aria-label="Agent 接管指令" />
              <div className="planner-actions">
                <button className="primary" onClick={() => void copyTakeoverInstruction()}>{copied ? '已复制' : '复制 Agent 接管指令'}</button>
                <button onClick={() => void refreshBootstrap()} disabled={busy}>同步 Agent 进度</button>
                {planningReady && <button onClick={() => { setExecutionKey((value) => value + 1); setTab('execute'); }}>进入 H3 执行</button>}
              </div>

              <div className="agent-progress" aria-label="Agent 导演进度">
                {agentPipeline.map((stage, index) => {
                  const done = stage === 'execution' ? planningReady : completedStages.includes(stage);
                  const active = nextStage === stage;
                  return (
                    <React.Fragment key={stage}>
                      <div className={`agent-progress-step ${done ? 'done' : ''} ${active ? 'active' : ''}`}>
                        <span>{String(index + 1).padStart(2, '0')}</span>
                        <strong>{agentStageLabels[stage]}</strong>
                      </div>
                      {index < agentPipeline.length - 1 && <i>→</i>}
                    </React.Fragment>
                  );
                })}
              </div>

              <div className="agent-stage-status">
                <div><span>当前阶段</span><strong>{agentStageLabels[nextStage] || nextStage}</strong></div>
                <div><span>已完成</span><strong>{completedCount}/{agentPipeline.length}</strong></div>
                <div><span>Scene</span><strong>{bootstrap?.workflowSummary?.scenes || 0}</strong></div>
                <div><span>Shot</span><strong>{bootstrap?.workflowSummary?.shots || 0}</strong></div>
                <div><span>Sequence</span><strong>{bootstrap?.workflowSummary?.sequences || 0}</strong></div>
                <div><span>Prompt</span><strong>{bootstrap?.workflowSummary?.prompts || 0}</strong></div>
              </div>

              {bootstrap?.stage?.contract?.goal && (
                <div className="planner-status">当前 Agent 任务：{bootstrap.stage.contract.goal}</div>
              )}
            </section>
          )}
        </main>
      ) : (
        activeProject ? <H3AutoComicWorkbench key={`${activeProject.id}-${executionKey}`} /> : <div className="nana-h3-empty">请先建立或选择 H3 项目。</div>
      )}
    </div>
  );
}
