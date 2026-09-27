import { spawn } from 'node:child_process';

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function boolEnv(name, fallback = false) {
  const value = env(name);
  if (!value) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

let runtimeOverrides = {};

export function setPublicRuntimeConfig(patch = {}) {
  const next = { ...runtimeOverrides };
  if (patch.directorMode !== undefined) {
    if (!['agent', 'api'].includes(String(patch.directorMode))) throw new Error('directorMode must be agent or api.');
    next.directorMode = String(patch.directorMode);
  }
  if (patch.imageMode !== undefined) {
    if (!['none', 'cli', 'api'].includes(String(patch.imageMode))) throw new Error('imageMode must be none, cli or api.');
    next.imageMode = String(patch.imageMode);
  }
  if (patch.videoMode !== undefined) {
    if (!['h3', 'cli', 'api'].includes(String(patch.videoMode))) throw new Error('videoMode must be h3, cli or api.');
    next.videoMode = String(patch.videoMode);
  }
  if (patch.maxSequenceSeconds !== undefined) {
    const value = Number(patch.maxSequenceSeconds);
    if (![15, 30].includes(value)) throw new Error('maxSequenceSeconds must be 15 or 30.');
    next.maxSequenceSeconds = value;
  }
  runtimeOverrides = next;
  return publicRuntimeConfig();
}

export function publicRuntimeConfig() {
  const directorMode = String(runtimeOverrides.directorMode || env('NANA_DIRECTOR_MODE', boolEnv('NANA_H3_AGENT_ONLY', true) ? 'agent' : 'api')).toLowerCase();
  const durationMode = Number(runtimeOverrides.maxSequenceSeconds || env('NANA_VIDEO_DURATION_MAX', '15')) === 30 ? 30 : 15;
  const image = adapterConfig('IMAGE');
  const video = adapterConfig('VIDEO');
  if (runtimeOverrides.imageMode) image.mode = runtimeOverrides.imageMode;
  if (runtimeOverrides.videoMode) video.mode = runtimeOverrides.videoMode;
  return {
    director: {
      mode: directorMode === 'api' ? 'api' : 'agent',
      api: {
        provider: env('NANA_DIRECTOR_API_PROVIDER', 'openai_compatible'),
        baseUrl: env('NANA_DIRECTOR_API_BASE_URL'),
        model: env('NANA_DIRECTOR_API_MODEL'),
        apiKeyConfigured: Boolean(env('NANA_DIRECTOR_API_KEY') || env('OPENAI_API_KEY') || env('GLM_API_KEY')),
        configured: Boolean(env('NANA_DIRECTOR_API_BASE_URL') && (env('NANA_DIRECTOR_API_KEY') || env('OPENAI_API_KEY') || env('GLM_API_KEY'))),
      },
    },
    image,
    video,
    execution: {
      maxSequenceSeconds: durationMode,
      durationModes: [15, 30],
    },
  };
}

function adapterConfig(kind) {
  const prefix = `NANA_${kind}_`;
  const mode = env(`${prefix}MODE`, kind === 'VIDEO' ? 'h3' : 'none').toLowerCase();
  return {
    mode,
    provider: env(`${prefix}PROVIDER`, mode === 'api' ? 'openai_compatible' : ''),
    baseUrl: env(`${prefix}API_BASE_URL`),
    model: env(`${prefix}API_MODEL`),
    apiKeyConfigured: Boolean(env(`${prefix}API_KEY`)),
    cliCommand: env(`${prefix}CLI_COMMAND`),
    cliArgs: env(`${prefix}CLI_ARGS`),
  };
}

export function publicCapabilities(extra = {}) {
  const config = publicRuntimeConfig();
  return {
    edition: 'public-standalone',
    director: {
      selected: config.director.mode,
      modes: ['agent', 'api'],
      api: { ...config.director.api, apiKey: undefined },
    },
    image: {
      selected: config.image.mode,
      modes: ['none', 'cli', 'api'],
      cliConfigured: Boolean(config.image.cliCommand),
      apiConfigured: Boolean(config.image.baseUrl && config.image.apiKeyConfigured),
    },
    video: {
      selected: config.video.mode,
      modes: ['h3', 'cli', 'api'],
      cliConfigured: Boolean(config.video.cliCommand),
      apiConfigured: Boolean(config.video.baseUrl && config.video.apiKeyConfigured),
      h3: extra.h3 || {},
    },
    duration: {
      configuredMaxSeconds: config.execution.maxSequenceSeconds,
      effectiveMaxSeconds: config.video.mode === 'h3' ? 15 : config.execution.maxSequenceSeconds,
      modes: config.execution.durationModes,
      note: 'H3 is always capped at 15s. 30s becomes effective only for external CLI/API video providers.',
    },
  };
}

export async function callDirectorApi(payload) {
  const config = publicRuntimeConfig().director.api;
  if (!config.baseUrl) throw new Error('Director API is not configured. Set NANA_DIRECTOR_API_BASE_URL.');
  const apiKey = env('NANA_DIRECTOR_API_KEY') || env('OPENAI_API_KEY');
  const endpoint = /\/chat\/completions\/?$/i.test(config.baseUrl)
    ? config.baseUrl
    : `${config.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model: config.model || undefined, ...payload }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Director API returned ${response.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { return { ok: true, text }; }
}

export async function runCliAdapter(kind, payload) {
  const config = publicRuntimeConfig()[kind];
  if (config.mode !== 'cli' || !config.cliCommand) throw new Error(`${kind} CLI adapter is not configured.`);
  const args = config.cliArgs ? config.cliArgs.split(/\s+/).filter(Boolean) : [];
  return new Promise((resolve, reject) => {
    const child = spawn(config.cliCommand, args, {
      env: {
        ...process.env,
        NANA_ADAPTER_PAYLOAD: JSON.stringify(payload || {}),
      },
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolve({ ok: true, stdout: stdout.trim(), stderr: stderr.trim() })
      : reject(new Error(`${kind} CLI adapter exited ${code}: ${stderr || stdout}`)));
  });
}

export async function callHttpAdapter(kind, payload) {
  const config = publicRuntimeConfig()[kind];
  if (config.mode !== 'api' || !config.baseUrl) throw new Error(`${kind} API adapter is not configured.`);
  const apiKey = env(`NANA_${kind.toUpperCase()}_API_KEY`);
  const response = await fetch(config.baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model: config.model || undefined, ...payload }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${kind} API returned ${response.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { return { ok: true, text }; }
}
