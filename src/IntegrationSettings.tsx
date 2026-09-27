import React, { useEffect, useMemo, useState } from 'react';

type Capabilities = any;
type FormState = {
  directorMode: 'agent' | 'api';
  imageMode: 'none' | 'cli' | 'api';
  videoMode: 'h3' | 'cli' | 'api';
  maxSequenceSeconds: 15 | 30;
};

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.message || `HTTP ${response.status}`);
  return payload;
}

export function IntegrationSettings() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [form, setForm] = useState<FormState>({ directorMode: 'agent', imageMode: 'none', videoMode: 'h3', maxSequenceSeconds: 15 });
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  async function refresh() {
    const next = await request('/api/integrations/capabilities', { cache: 'no-store' });
    setCaps(next);
    setForm({
      directorMode: next.director?.selected === 'api' ? 'api' : 'agent',
      imageMode: ['cli', 'api'].includes(next.image?.selected) ? next.image.selected : 'none',
      videoMode: ['cli', 'api'].includes(next.video?.selected) ? next.video.selected : 'h3',
      maxSequenceSeconds: Number(next.duration?.configuredMaxSeconds) === 30 ? 30 : 15,
    });
  }

  useEffect(() => { void refresh().catch((e) => setError(e.message)); }, []);

  const effective = form.videoMode === 'h3' ? 15 : form.maxSequenceSeconds;
  const presets = caps?.video?.h3?.presets?.presets || [];
  const warnings = useMemo(() => {
    const items: string[] = [];
    if (form.directorMode === 'api' && !caps?.director?.api?.configured) items.push('导演 API 尚未检测到 Key / Base URL，请在 .env 填好后重启。');
    if (form.imageMode === 'cli' && !caps?.image?.cliConfigured) items.push('生图 CLI 尚未配置命令。');
    if (form.imageMode === 'api' && !caps?.image?.apiConfigured) items.push('生图 API 尚未配置 Base URL / Key。');
    if (form.videoMode === 'cli' && !caps?.video?.cliConfigured) items.push('视频 CLI 尚未配置命令。');
    if (form.videoMode === 'api' && !caps?.video?.apiConfigured) items.push('视频 API 尚未配置 Base URL / Key。');
    return items;
  }, [caps, form]);

  async function save() {
    setStatus(''); setError('');
    try {
      const payload = await request('/api/integrations/config', { method: 'PUT', body: JSON.stringify(form) });
      setCaps(payload.capabilities);
      setStatus('已保存并即时生效。密钥、URL 与 CLI 命令仍从本机 .env 读取，不会在网页中回显。');
    } catch (e: any) { setError(e.message || String(e)); }
  }

  return <main className="nana-settings">
    <section className="settings-hero">
      <div><span className="kicker">PUBLIC SETUP CENTER</span><h1>傻瓜式配置中心</h1><p>先选“谁来导演”，再选生图与生视频方式。模式可以在这里直接切；账号密钥和本机 CLI 路径只放在 <code>.env</code>，网页不读取明文。</p></div>
      <div className="settings-edition">公开独立版<br/><b>{caps?.edition || 'loading…'}</b></div>
    </section>

    <section className="settings-card">
      <div className="settings-title"><div><span>01</span><h2>导演方式</h2></div><small>二选一</small></div>
      <div className="choice-grid two">
        <button className={form.directorMode === 'agent' ? 'selected' : ''} onClick={() => setForm(v => ({...v,directorMode:'agent'}))}><b>Agent 模式</b><span>推荐 · 不需要模型 API Key</span><p>Codex / Claude Code / ChatGPT 等本地 Agent 按 Stage Contract 接管导演流程。</p></button>
        <button className={form.directorMode === 'api' ? 'selected' : ''} onClick={() => setForm(v => ({...v,directorMode:'api'}))}><b>API 模式</b><span>OpenAI-compatible</span><p>由你自己的模型 Provider 直连导演接口，适合有 API 的用户。</p></button>
      </div>
    </section>

    <section className="settings-card">
      <div className="settings-title"><div><span>02</span><h2>生图 Provider</h2></div><small>资产生成</small></div>
      <div className="choice-grid three">
        {([['none','手动上传','不自动生图'],['cli','CLI','接 Dreamina / Lovart / 自己的脚本'],['api','API','接第三方 HTTP 生图服务']] as const).map(([id,title,desc]) =>
          <button key={id} className={form.imageMode === id ? 'selected' : ''} onClick={() => setForm(v => ({...v,imageMode:id}))}><b>{title}</b><span>{desc}</span></button>)}
      </div>
    </section>

    <section className="settings-card">
      <div className="settings-title"><div><span>03</span><h2>生视频 Provider</h2></div><small>执行引擎</small></div>
      <div className="choice-grid three">
        {([['h3','MiniMax H3','内置 ComfyUI 工作流 · 最长 15s'],['cli','CLI','接任意本地视频 CLI'],['api','API','接第三方视频生成服务']] as const).map(([id,title,desc]) =>
          <button key={id} className={form.videoMode === id ? 'selected' : ''} onClick={() => setForm(v => ({...v,videoMode:id}))}><b>{title}</b><span>{desc}</span></button>)}
      </div>
      <div className="duration-row"><div><b>Sequence 最长时长</b><span>这是视频引擎能力，不改变导演规则。</span></div><div className="segmented"><button className={form.maxSequenceSeconds===15?'active':''} onClick={()=>setForm(v=>({...v,maxSequenceSeconds:15}))}>15s</button><button disabled={form.videoMode==='h3'} className={form.maxSequenceSeconds===30&&form.videoMode!=='h3'?'active':''} onClick={()=>setForm(v=>({...v,maxSequenceSeconds:30}))}>30s</button></div><strong>当前实际上限 {effective}s</strong></div>
    </section>

    <section className="settings-card">
      <div className="settings-title"><div><span>04</span><h2>H3 工作流包</h2></div><small>{caps?.video?.h3?.presets?.version || '读取中'}</small></div>
      <div className="preset-grid">{presets.map((item:any)=><div key={item.id} className="preset-item"><div><b>{item.label}</b><span>{item.packagedTemplate ? '已打包' : '内置参数档'}</span></div><p>{item.description}</p><small>{item.targetWidth}×{item.targetHeight} · {item.id}</small></div>)}</div>
    </section>

    {warnings.length > 0 && <div className="settings-warning"><b>还需要配置：</b>{warnings.map(x=><span key={x}>• {x}</span>)}</div>}
    {status && <div className="planner-status">{status}</div>}
    {error && <div className="planner-error">{error}</div>}
    <div className="settings-actions"><button onClick={()=>void refresh()}>重新检测</button><button className="primary" onClick={()=>void save()}>保存并应用</button></div>
  </main>;
}
