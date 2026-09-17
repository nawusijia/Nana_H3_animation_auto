# Nana H3 Animation Auto

娜乌斯嘉 / Nana 使用并持续迭代的 **MiniMax H3 全自动漫剧导演台 · 独立开源版**。

> **2026-09 Agent-owned 更新：默认不再要求 GLM / OpenAI / Anthropic 等大模型 API Key。**
>
> 剧本分析、Scene、Shot、Sequence、H3 Prompt 与审核由你正在使用的本地 Agent 接管；本仓库负责项目状态、确定性校验、资产门禁、H3 工作流、ComfyUI 队列、关系帧连续性与结果归档。

核心流程：

```text
剧本
  ↓
本地 Agent 接管
  ↓
Scene → 资产规划 → Shot → Sequence → H3 Prompt → Reviewer
  ↓
真实参考图资产门禁
  ↓
MiniMax H3 / ComfyUI
  ↓
同 Scene 串行生成 → 自动关系帧接力 → 审片 / 批注
```

MiniMax H3 / ComfyUI 在这里是 **执行引擎**，不负责导演决策。

> 仓库不包含 MiniMax H3 模型权重、ComfyUI、本地生成模型、任何 API Key、Nana 私有工程或私有导演台代码。

---

## 这次更新解决了什么？

旧版本的“开始全自动规划”会由网页直接调用 GLM-5.3，因此用户必须自己申请并配置模型 API Key。

现在默认改成 **Agent-owned**：

- 网页不会偷偷调用 GLM / OpenAI / Anthropic；
- `.env` 不需要模型 API Key；
- 用户只需要有一个能访问本机仓库和 localhost 的 Agent；
- Agent 读取 `/api/agent/bootstrap`，按服务器给出的 `nextStage` 一步步工作；
- 每个阶段都通过 completion API 回填并生成 checkpoint；
- 服务器负责校验，不能靠 Agent 跳阶段或手写第二份 UI 状态；
- 到 `execution` 后再绑定真实参考图并确认启动 H3。

因此，新用户不需要理解“怎么接大模型 API”。

---

## 开源版和 Nana 私有导演台是两套东西

这个仓库是 **公开、独立、可单独部署的 H3 工作台**。

仓库根目录提供了 `AGENTS.md`，明确要求所有 Agent：

- 只操作当前开源仓库与当前 H3 项目目录；
- 不读取、不修改 Nana 的私有导演台；
- 不把私人机器路径、网络地址、项目资产或 Key 写进仓库；
- 不把这个仓库误认为 Nana Director Console 的开发目录。

即使你的电脑上同时存在其他导演台，也应把它们当成互不关联的产品。

---

## 两个入口

启动后访问：

- 全自动导演台：`http://127.0.0.1:8797/`
- H3 自由岛单条测试：`http://127.0.0.1:8797/free-island.html`

建议第一次安装先用自由岛跑一条 5 秒小样，确认 H3 / ComfyUI 后端正常，再进入全自动导演台。

---

## 当前能力

- 独立 H3 项目管理，可单独部署运行
- **Agent-owned 导演协议：bootstrap → context → checkpoint → execution**
- Agent 自动分析剧本与自然 Scene
- Agent 自动提取人物、场景、道具与资产设计需求
- Agent 自动拆原子 Shot
- Agent 自动把同 Scene Shot 组合为 5–15 秒 H3 Sequence
- Agent 为每条 Sequence 编译独立 H3 视频 Prompt
- 服务端确定性检查 Sequence 时长、Shot 覆盖、Prompt 时间轴、台词完整性等
- 资产参考图设计信息与构成规划
- 直接上传 / 替换人物、场景、道具参考图
- 资产门禁：缺参考图时禁止误提交 H3
- 三档 H3 工作流：极速文戏 / 动态增强 / 极致精修 1080P
- 每条 Sequence 可自动导演选档，也可手动覆盖
- 同 Scene 严格串行生成
- 上一条成片自动截空间关系帧，下一条以 Ref2VA 参考方式续接
- 跨 Scene 自动清空空间关系帧
- 实时任务进度、结果视频、关系帧预览
- Agent Sequence Prompt 查看 / 复制
- Sequence 批注记录
- H3 自由岛支持文生视频、图生视频、参考生视频与 0.5–1.1 MP 测试

---

## 环境要求

推荐：

- Windows 10 / 11
- Node.js 22+
- npm 10+
- 一个能访问当前仓库与 localhost 的本地 Agent / coding Agent
- 一套可以独立运行的 ComfyUI + MiniMax H3 环境
- 足够的显存 / 内存运行你选择的 H3 工作流

本仓库负责导演状态机、工作流编译、队列与 UI；**不会自动下载模型或安装 ComfyUI**。

---

## 快速开始

### 1. 克隆

```bash
git clone https://github.com/nawusijia/Nana_H3_animation_auto.git
cd Nana_H3_animation_auto
npm install
```

### 2. 配置 H3 / ComfyUI

复制环境变量示例：

```powershell
Copy-Item .env.example .env
```

默认只需要填写你自己的 ComfyUI 地址：

```text
NANA_H3_AGENT_ONLY=true
NANA_H3_COMFY_URL=http://127.0.0.1:8188
```

**不需要填写 GLM_API_KEY。**

### 3. 启动

```bash
npm start
```

打开：

```text
http://127.0.0.1:8797/
```

### 4. 新建项目并粘贴剧本

进入：

```text
01 Agent 导演
```

新建 H3 项目，粘贴完整剧本，然后点击：

```text
保存剧本 · 准备 Agent 接管
```

页面会生成一段 **Agent 接管指令**。

### 5. 把接管指令发给你的 Agent

把页面里的整段文字复制给能操作当前仓库的 Agent。

Agent 会先读取根目录 `AGENTS.md`，然后从：

```text
GET http://127.0.0.1:8797/api/agent/bootstrap
```

开始工作。

它会严格执行：

```text
bootstrap
  ↓
nextStage
  ↓
contextApi
  ↓
生成当前阶段 artifact
  ↓
completionApi
  ↓
重新 bootstrap
```

直到：

```text
pipeline.nextStage = execution
```

页面每 10 秒自动同步一次 Agent 进度，也可以手动点“同步 Agent 进度”。

### 6. 上传真实参考图

规划完成后进入：

```text
02 自动执行 / 审片
```

在资产索引中给人物 / 场景 / 道具上传真实参考图。

每条 Sequence 需要的资产都绑定完成以后，资产门禁才会放行。

### 7. 开始 H3

点击“开始自动生成”后才会真实提交 GPU。

同一 Scene 内：

```text
Sequence 01
  ↓ H3 完成
自动截最后一帧
  ↓
Sequence 02（正式资产 + 上一条关系帧）
  ↓
Sequence 03
```

跨 Scene 会清空关系帧，从该 Scene 的正式资产重新起链。

---

## Agent 协议（给开发者 / Agent 作者）

根目录 `AGENTS.md` 是完整协议说明。

核心接口：

```text
GET  /api/agent/bootstrap
GET  /api/agent/context/:stage
PUT  /api/agent/pipeline/:stage
PUT  /api/agent/source
```

默认阶段：

```text
outline
→ assets
→ shots
→ sequences
→ prompts
→ reviewer
→ execution
```

Agent 不能跳阶段。每个阶段通过：

```json
{
  "status": "completed",
  "artifact": {}
}
```

提交。

服务器会把 checkpoint 写入当前 H3 项目自己的：

```text
execution/h3/agent/checkpoints/
```

并在 Reviewer 通过后建立权威 `workspace.json`。

Agent 不应手改第二份 UI 状态。

---

## 为什么还保留旧 GLM 代码？

为了不直接破坏已经基于旧版本做二次开发的用户，旧的 direct-provider 路径仍保留为兼容层，但**默认被禁用**。

只有明确设置：

```text
NANA_H3_AGENT_ONLY=false
```

以后，旧模型接口才允许工作；这时才需要自行配置对应 Key。

新安装用户不需要使用这一模式。

---

## MiniMax H3 / ComfyUI 前置条件

当前内置工作流来自 Nana 已验收的 MiniMax H3 T8 工作流栈。你的 ComfyUI 需要安装兼容的 H3 / T8 自定义节点，并能识别代码中使用的节点类型。

当前主要模型文件名：

### 极速文戏 `standard`

```text
minimax_h3_fl2va_int8_convrot.safetensors
minimax_h3_fl2v_turbo_4step_v0.1_comfyui_alpha8-T8-convert.safetensors
qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
minimax_h3_video_vae_fp16.safetensors
minimax_h3_audio_vae_fp32.safetensors
```

### 动态增强 `best_dynamic`

```text
DasiwaMinimaxH3_dasiwaREF2VAHybridV1.safetensors
minimax_h3_turbo_4步加速_DasiwaREF2VAHybridV1_curveproj1025_compat_v001-T8.safetensors
qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
minimax_h3_video_vae_fp16.safetensors
minimax_h3_audio_vae_fp32.safetensors
```

### 极致精修 `ultra_refine`

```text
minimax_h3_fl2va_pruned_int8_convrot.safetensors
minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors
qwen3vl_32b_minimax_h3_int8_convrot.safetensors
minimax_h3_video_vae_fp16.safetensors
minimax_h3_audio_vae_fp32.safetensors
```

如果你的模型文件名不同，可以修改 `server.mjs` 中对应工作流的 loader 文件名。

常见自定义节点包括：

```text
MiniMaxH3AudioConditioningT8
MiniMaxH3DualClockSamplerT8
MiniMaxH3AVDecodeT8
MiniMaxH3LearnedLatentUpscaleT8Advanced
H3SigmaRefiner
VHS_VideoCombine
```

缺节点时 ComfyUI 会在提交工作流时报告缺失的 `class_type`，按报错安装相应节点即可。

---

## H3 工作流档位

### 极速文戏

适合普通对白、低动态、人物脸部占比较大的镜头。

自由岛支持：

```text
0.5 MP
0.7 MP
0.9 MP（默认）
1.0 MP
1.1 MP（实验）
```

### 动态增强

适合战斗、粒子、火焰、能量、烟尘、水花与复杂多部件运动。

### 极致精修 1080P

用于人物大全景 / 全景 / 中远景、大中景等“小脸景别”或门面镜头，优先保证脸部清晰度。

自动路由仍可以根据镜头与 Prompt 选择档位，也可以手动覆盖。

---

## 资产参考图

自动执行前，每个 Sequence 使用到的人物 / 场景 / 道具必须有实际参考图。

公开版不绑定任何生图平台：你可以用任意图像模型生成资产图，然后在“自动执行 / 审片”页点击 **上传参考图**。

上传后图片会复制到当前 H3 项目自己的 `assets/` 目录，并自动重新检查资产门禁。

---

## 数据目录

默认运行数据保存在仓库旁：

```text
./data/
  .nana-h3/
  H3Projects/
  H3output/
  media-downloads/
```

`data/` 已加入 `.gitignore`，不会推到 GitHub。

也可以设置：

```text
NANA_H3_DATA_DIR
```

把数据放到其他磁盘。

---

## 可选：GPU Switch Bridge

普通单机 H3 用户不需要这个配置。

如果同一块 GPU 会在 H3、LLM 或其他服务之间切换，可以设置：

```text
NANA_GPU_SWITCH_URL=http://127.0.0.1:xxxx
```

服务需要提供：

```text
POST /switch/h3
GET  /health
```

留空时 H3 导演台直接连接 ComfyUI。

---

## 开发检查

```bash
npm run typecheck
npm run build
npm run server:check
npm run check
```

发布前至少运行：

```bash
npm run check
```

---

## 安全与隐私

公开仓库不会提交：

- `.env`
- API Key
- 个人项目
- 本地生成结果
- 关系帧
- 上传的资产图
- 日志
- Nana 私有导演台目录或项目
- 开发者私人网络地址与机器路径

---

## License

本仓库自有代码以 MIT License 开源。

MiniMax H3 模型、ComfyUI、自定义节点和其他第三方模型 / 组件仍遵循各自许可证；本仓库的 MIT License 不改变第三方内容的授权方式。

---

Made by 娜乌斯嘉 / Nana with her AI collaborators.
