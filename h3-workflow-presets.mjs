import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.join(ROOT, 'workflows');

export const H3_WORKFLOW_CATALOG_VERSION = '2026-09-public-four-tier-v1';
export const H3_DEFAULT_FORMAL_PRESET = 'rapid_hd';
export const H3_PREVIEW_PRESET = 'preview_480';

export const H3_WORKFLOW_PRESETS = Object.freeze({
  preview_480: Object.freeze({
    id: 'preview_480', version: 'preview-current4step-480p-v1', label: '极速预览 480P',
    description: 'Prompt / 导演逻辑快速验证；4-step 单采，不作为正式交片档。',
    role: 'preview', autoEligible: false, megapixels: 0.42, targetWidth: 896, targetHeight: 512,
  }),
  rapid_hd: Object.freeze({
    id: 'rapid_hd', version: 't8-rapid-hd-v3-public-v1', label: '极速高清',
    description: '正式生产默认档；速度与画质平衡。', role: 'formal_default', autoEligible: true,
    megapixels: 0.5, targetWidth: 1472, targetHeight: 832, template: 'rapid-hd-v3.api.json',
  }),
  balanced_hd: Object.freeze({
    id: 'balanced_hd', version: 't8-balanced-v2-public-v1', label: '均衡高清',
    description: '通用高质量档；适合小脸景别、复杂特效与稳妥成片。', role: 'formal_quality', autoEligible: true,
    megapixels: 0.7, targetWidth: 1728, targetHeight: 960, template: 'balanced-v2.api.json',
  }),
  combat_dynamic: Object.freeze({
    id: 'combat_dynamic', version: 't8-combat-v2-public-v1', label: '战斗动态',
    description: '近身格斗 / 兵刃交锋 / 强身体动作专项。', role: 'formal_combat', autoEligible: true,
    megapixels: 0.7, targetWidth: 1728, targetHeight: 960, template: 'combat-v2.api.json',
  }),
  // Internal migration shims. Never exposed by the public preset catalog/UI.
  standard: Object.freeze({ id: 'standard', version: 'standard-v1', label: '旧极速文戏' }),
  best_dynamic: Object.freeze({ id: 'best_dynamic', version: 'best-dynamic-full-768p-v2', label: '旧动态增强' }),
  ultra_refine: Object.freeze({ id: 'ultra_refine', version: 'ultra-refine-blog-mv-1088p-9plus4-v2', label: '旧极致精修' }),
});

export const H3_WORKFLOW_PRESET_ALIASES = Object.freeze({
  standard: 'rapid_hd',
  best_dynamic: 'balanced_hd',
  best_dynamic_short: 'balanced_hd',
  best_dynamic_long: 'balanced_hd',
  ultra_refine: 'balanced_hd',
});

export function normalizeH3WorkflowPreset(value) {
  const raw = String(value || '').trim();
  return H3_WORKFLOW_PRESET_ALIASES[raw] || raw || H3_DEFAULT_FORMAL_PRESET;
}

export function h3WorkflowPresetCatalog() {
  return {
    version: H3_WORKFLOW_CATALOG_VERSION,
    defaultPreset: H3_DEFAULT_FORMAL_PRESET,
    previewPreset: H3_PREVIEW_PRESET,
    presets: ['preview_480', 'rapid_hd', 'balanced_hd', 'combat_dynamic'].map(id => {
      const { template, ...item } = H3_WORKFLOW_PRESETS[id];
      return { ...item, packagedTemplate: Boolean(template) };
    }),
    aliases: { ...H3_WORKFLOW_PRESET_ALIASES },
  };
}

function alignedLength(seconds) {
  const frames = Math.max(5, Math.round(Number(seconds) * 24));
  return frames + ((5 - (frames % 17)) % 17 + 17) % 17;
}

function taskTypeFor(imageCount, firstAsFrame) {
  if (imageCount === 0) return 'T2VA';
  if (!firstAsFrame) return 'Ref2VA';
  return imageCount === 1 ? 'I2VA' : 'Hybrid';
}

export function buildPackagedH3Workflow({ preset, prompt, aspectRatio, seconds, imageNames = [], firstAsFrame = false, jobId }) {
  const normalized = normalizeH3WorkflowPreset(preset);
  const spec = H3_WORKFLOW_PRESETS[normalized];
  if (!spec?.template) return null;
  if (aspectRatio !== '16:9 (Widescreen)') throw new Error(`${spec.label} 当前公开模板只支持 16:9。`);
  const workflow = JSON.parse(readFileSync(path.join(WORKFLOW_DIR, spec.template), 'utf8'));
  const promptText = String(prompt || '').replace(/@?图片?\s*([1-9])/g, '<Picture $1>');
  const conditionings = [];
  for (const node of Object.values(workflow)) {
    const inputs = node?.inputs || {};
    if (node?.class_type === 'PrimitiveFloat' && Object.hasOwn(inputs, 'value')) inputs.value = Number(seconds);
    if (node?.class_type === 'RandomNoise' && Object.hasOwn(inputs, 'noise_seed')) inputs.noise_seed = 123456789;
    if (node?.class_type === 'CR Prompt Text' && Object.hasOwn(inputs, 'prompt')) inputs.prompt = promptText;
    if (node?.class_type === 'VHS_VideoCombine') inputs.filename_prefix = `MiniMaxH3/nana_${jobId}`;
    if (node?.class_type === 'MiniMaxH3AudioConditioningT8') {
      for (const key of Object.keys(inputs)) if (key.startsWith('ref_images.') || key === 'first_frame' || key === 'last_frame') delete inputs[key];
      inputs.task_type = taskTypeFor(imageNames.length, firstAsFrame);
      if (typeof inputs.prompt === 'string') inputs.prompt = promptText;
      conditionings.push(inputs);
    }
  }
  imageNames.forEach((imageName, index) => {
    let numericId = 900 + index;
    while (workflow[String(numericId)]) numericId += 100;
    const nodeId = String(numericId);
    workflow[nodeId] = { class_type: 'LoadImage', inputs: { image: imageName }, _meta: { title: `Public task reference ${index + 1}` } };
    for (const conditioning of conditionings) {
      if (firstAsFrame && index === 0) conditioning.first_frame = [nodeId, 0];
      else conditioning[`ref_images.ref_image_${firstAsFrame ? index - 1 : index}`] = [nodeId, 0];
    }
  });
  return {
    workflow,
    taskType: taskTypeFor(imageNames.length, firstAsFrame),
    length: alignedLength(seconds),
    prompt: promptText,
    megapixels: spec.megapixels,
    targetWidth: spec.targetWidth,
    targetHeight: spec.targetHeight,
    workflowPreset: normalized,
    workflowPresetVersion: spec.version,
  };
}

export function chooseH3Preset(text = '') {
  const source = String(text);
  if (/(格斗|近身|兵刃|挥砍|劈砍|刺击|受击|搏斗)/i.test(source)) {
    return { preset: 'combat_dynamic', reason: '检测到近身格斗 / 兵刃交锋。' };
  }
  if (/(大全景|全景|远景|中远景|全身|粒子|火焰|能量|机械|法阵|爆炸|闪电)/i.test(source)) {
    return { preset: 'balanced_hd', reason: '检测到小脸景别或复杂特效。' };
  }
  return { preset: H3_DEFAULT_FORMAL_PRESET, reason: '正式生产默认极速高清。' };
}
