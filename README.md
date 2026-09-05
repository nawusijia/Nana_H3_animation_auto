# Nana H3 Animation Auto

娜乌斯嘉 / Nana 使用并持续迭代的 **MiniMax H3 全自动漫剧导演台** 独立开源版。

这个仓库不是完整的 Nana Director Console 2.0。它只抽出了 H3 生产链：

**剧本 → GLM-5.3 剧本分析 → 资产设计 → Scene → Shot → H3 Sequence → GLM Sequence Prompt → 资产门禁 → MiniMax H3 串行生成 → 自动关系帧接力 → 审片 / 批注**

同一 Scene 内严格串行：上一条 Sequence 完成后自动截取末帧作为下一条的空间关系参考；跨 Scene 自动清空关系帧，重新从正式资产起链。

> 仓库不包含 MiniMax H3 模型权重、ComfyUI、本地生成模型或任何 API Key。

## 两个入口

启动后访问：

- 全自动导演台：`http://127.0.0.1:8797/`
- H3 自由岛单条测试：`http://127.0.0.1:8797/free-island.html`

建议第一次安装先用自由岛跑一条 5 秒小样，确认 H3 / ComfyUI 后端正常，再进入全自动导演台。

## 当前能力

- 独立 H3 项目管理，不依赖 Nana Director Console 2.0
- GLM-5.3 自动提取人物、场景、道具与自然 Scene
- GLM-5.3 自动拆原子 Shot
- 自动把同 Scene Shot 顺序组装为 5–15 秒 H3 Sequence
- GLM-5.3 为每条 Sequence 编译独立 H3 视频提示词
- 资产参考图设计提示词与构成规划
- 直接上传 / 替换人物、场景、道具参考图
- 资产门禁：缺参考图时禁止误提交 H3
- 三档 H3 工作流：极速文戏 / 动态增强 / 极致精修 1080P
- 每条 Sequence 可自动导演选档，也可手动覆盖
- 同 Scene 严格串行生成
- 上一条成片自动截空间关系帧，下一条以 Ref2VA 参考方式续接
- 跨 Scene 自动清空空间关系帧
- 实时任务进度、结果视频、关系帧预览
- Sequence Prompt 查看 / 复制
- Sequence 批注记录
- H3 自由岛支持文生视频、图生视频、参考生视频与 0.5–1.1 MP 极速档测试

## 环境要求

推荐：

- Windows 10 / 11
- Node.js 22+
- npm 10+
- 一套可以独立运行的 ComfyUI + MiniMax H3 环境
- 足够的显存 / 内存运行你选择的 H3 工作流

本仓库只负责导演、工作流编译、队列与 UI；**不会自动下载模型或安装 ComfyUI**。

## MiniMax H3 / ComfyUI 前置条件

当前内置工作流来自 Nana 已验收的 MiniMax H3 T8 工作流栈。你的 ComfyUI 需要安装兼容的 H3 / T8 自定义节点，并能识别代码中使用的节点类型。

内置工作流当前会寻找这些主要模型文件名：

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

常见自定义节点包括 `MiniMaxH3AudioConditioningT8`、`MiniMaxH3DualClockSamplerT8`、`MiniMaxH3AVDecodeT8`、`MiniMaxH3LearnedLatentUpscaleT8Advanced`、`H3SigmaRefiner`、`VHS_VideoCombine` 等。缺节点时 ComfyUI 会在提交工作流时直接报出缺失的 class type，可按报错补齐对应节点。

## 快速开始

```bash
git clone https://github.com/Indimor/Nana_H3_animation_auto.git
cd Nana_H3_animation_auto
npm install
```

复制环境变量示例：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`：

```text
GLM_API_KEY=你的GLM_API_KEY
NANA_H3_COMFY_URL=http://127.0.0.1:8188
```

启动：

```bash
npm start
```

打开：

```text
http://127.0.0.1:8797/
```

## GLM-5.3

GLM 只负责导演 / 剧本规划和 Sequence Prompt 编译，不负责 H3 视频生成。

默认配置：

```text
GLM_BASE_URL=https://open.bigmodel.cn/api/anthropic
GLM_MODEL=glm-5.3
```

可在 `.env` 中替换。

“开始全自动规划”只调用 GLM API，不会提交 H3 视频。真正开始 H3 视频生成前，执行页还会进行资产门禁并要求你再次确认。

## H3 三档工作流

### 极速文戏

适合普通对白、低动态、人物脸部占比较大的镜头。自由岛支持：

```text
0.5 MP
0.7 MP
0.9 MP（默认）
1.0 MP
1.1 MP（实验 / 极限）
```

### 动态增强

适合战斗、粒子、火焰、能量、烟尘、水花与复杂多部件运动。

当前固定为已验收的 16:9 动态增强路线。

### 极致精修 1080P

用于人物大全景 / 全景 / 中远景、大中景等“小脸景别”或门面镜头，优先保证脸部清晰度。

自动导演优先级：

```text
手动指定
> 小脸景别强制 1080P
> 高动态中档候选
> 普通近景文戏极速
```

## 资产参考图

全自动执行前，每个 Sequence 使用到的人物 / 场景 / 道具必须有实际参考图。

公开版不强绑定任何生图平台：你可以用任意图像模型生成资产图，然后在“自动执行 / 审片”页直接点击 **上传参考图**。

上传后图片会复制到当前 H3 项目自己的 `assets/` 目录，并自动重新检查资产门禁。

## 数据目录

默认所有运行数据都保存在仓库旁边：

```text
./data/
  .nana-h3/
  H3Projects/
  H3output/
  media-downloads/
```

`data/` 已加入 `.gitignore`，不会推到 GitHub。

也可以通过：

```text
NANA_H3_DATA_DIR
```

把项目数据放到其他磁盘。

## 可选：GPU Switch Bridge

普通单机 H3 用户**不需要**这个配置。

只有当你的同一块 GPU 会在 H3、LLM 或其他服务之间切换时，才需要设置：

```text
NANA_GPU_SWITCH_URL=http://127.0.0.1:xxxx
```

自定义服务需要提供：

```text
POST /switch/h3
GET  /health
```

留空时 H3 导演台会直接连接 ComfyUI。

## 开发检查

```bash
npm run typecheck
npm run build
npm run server:check
npm run check
```

## 安全与隐私

公开仓库不会提交：

- `.env`
- API Key
- 个人项目
- 本地生成结果
- 关系帧
- 上传的资产图
- 日志
- Nana 的家庭 / 公司网络地址与机器路径

## License

本仓库自有代码以 MIT License 开源。

MiniMax H3 模型、ComfyUI、自定义节点和其他第三方模型 / 组件仍遵循各自许可证；本仓库的 MIT License 不改变第三方内容的授权方式。

---

Made by 娜乌斯嘉 / Nana with her AI collaborators.
