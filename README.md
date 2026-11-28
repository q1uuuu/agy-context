# Antigravity Context & Token Inspector (`agy-context`)

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License: Apache 2.0"></a>
  <a href="https://github.com/q1uuuu/agy-context/releases"><img src="https://img.shields.io/github/v/release/q1uuuu/agy-context?color=blue&logo=github" alt="Release"></a>
  <a href="https://github.com/q1uuuu/agy-context"><img src="https://img.shields.io/badge/Platform-Google_Antigravity-000000.svg?logo=google" alt="Platform"></a>
  <a href="https://github.com/q1uuuu/agy-context"><img src="https://img.shields.io/badge/Node.js-%3E%3D18.0-339933.svg?logo=node.js" alt="Node.js"></a>
</p>

专为 **Google Antigravity** 打造的高性能上下文诊断、Token 用量分析与上下文窗口解锁插件。

原生嵌入 Antigravity 右侧辅助侧边栏（Auxiliary Pane），通过后台 Sidecar 守护进程常驻运行，零全局提示词开销，提供单会话上下文实时透视与性能指标、上下文 `256K` 隐式上限解锁、本地全局 Token 账单大盘分析以及一键无感热升级。

---

> ### English Overview
> **Antigravity Context & Token Inspector** (`agy-context`) is a lightweight, zero-prompt-overhead extension embedded in Google Antigravity's Auxiliary Pane. It combines real-time single-session context diagnostics (official Language Server telemetry with transcript fallback, streaming TTFT/throughput metrics, and compaction-aware growth timelines), an inline cross-platform Context Window Unlocker (`256K` / `512K` / `900K` / `dynamic` presets via `.gopclntab` symbol resolution), aggregated local token & cost analytics with OpenRouter-synced model pricing, and one-click OTA updates—styled in Antigravity 2.0 Onyx monochrome minimalism.

---

## 界面实机预览 (Screenshots)

<p align="center">
  <img src="assets/preview.jpg" alt="会话上下文（单会话视图与增长曲线）" width="48%">
  <img src="assets/preview-modal.jpg" alt="版本更新在线检查与一键无感热升级" width="48%">
</p>

<p align="center">
  <em>左图：会话上下文（窗口占用、构成明细与演进轨迹） | 右图：在线检查更新与一键无感热升级弹窗</em>
</p>

---

## 核心特性 (Key Features)

### 1. 会话上下文（单会话视图 - 默认主界面）
* **实时窗口占用与环形进度指示**：
  - 优先通过 Language Server RPC（`StreamAgentStateUpdates`）获取官方精确上下文计数，并在不可用时自动平滑回退至本地 Transcript 估算。
  - 配备高对比度 SVG 环形占用率指示器与健康阈值预警（`>60%` 警告 / `>80%` 危险），过载时建议执行 `/compact` 压缩上下文。
* **分项构成堆叠条 (Segmented Stacked Bar)**：
  - 官方遥测模式下精确呈现三维分布：**系统提示词 (System Prompt)**、**工具与上下文注入 (Tools)**、**对话消息 (Chat Messages)**；本地回退模式下提供四维分布（系统规则 / 工具 I/O / 用户输入 / 模型历史与思考）。
* **单会话流式性能条**：
  - 在概览卡片底部以单行紧凑条形式展示当前会话的 **首字延迟 (s)**、**正文速度 (tok/s)**、**总延迟速度 (tok/s)** 与 **累计交互耗时**。
* **三大深度子面板**：
  - **构成明细**：各维度 Token 绝对值、百分比占比进度条，以及内置工具调用频次与体积分布统计。
  - **演进轨迹 (Timeline & Compactions)**：SVG 平滑曲线展示会话轮次的上下文增长斜率，自动高亮 **峰值焦点 (Peak)** 与 **上下文压缩/裁剪节点**（`CHECKPOINT`、`SYSTEM_MESSAGE`、`TOKEN_DROP`），支持跨曲线与标记节点的二维悬停精确定位。
  - **上下文解锁**：内联展示桌面端 Language Server / CLI 检测状态、三道门禁状态与目标上下文档位配置，支持一键解锁与还原备份。

### 2. 上下文窗口解锁与预设管理 (Context Unlock & Presets)
* **突破官方 256K 隐式上限**：
  - 自动发现本地 Antigravity Desktop Language Server（`language_server` / `language_server.exe`）与 `agy` CLI（`agy` / `agy.exe`），跨平台支持 macOS / Linux / Windows（Mach-O / ELF / PE，arm64 & x86-64）。
* **`.gopclntab` 动态符号定位**：
  - 通过内置 [`scripts/agy-patch.py`](scripts/agy-patch.py) 动态解析 Go 二进制符号表，定位并打通三道限制门：
    - **Gate 1 (`model.SelectorModel.offersContextWindow`)**：为模型选择器开放上下文选项；
    - **Gate 2 (`store.(*Store).ContextWindow`)**：解除模型白名单与实验开关门控；
    - **Gate 3A / 3B**：移除 `256,000` (`0x3e800`) 检查点上限夹紧并清除实验覆盖硬限，恢复完整物理上下文预算（同时可选恢复 `AGY_CLI_AUTO_COMPACT_OVERRIDE` 环境变量支持）。
* **预设档位与版本绑定备份**：
  - 支持 **动态全量 (`dynamic`)**、**`256K`**、**`512K`**、**`900K`** 一键切换。
  - 「上下文解锁」子 Tab 栏实时反馈解锁状态点（未解锁呈灰色、解锁后呈绿色）并附带当前预设徽标。
  - 执行修补前自动校验 SHA-256 并将原始二进制版本绑定备份至 `~/.gemini/antigravity/plugin_data/agy-context/`（同步持久化 `context-settings.json`），支持在内联面板中随时 **一键还原备份**。

### 3. 本地全局用量大盘 (本地全局用量)
* **多时间范围筛选**：
  - 支持 **今天 / 昨天 / 近 3 天 / 近 7 天 / 近 30 天** 切换，按本机自然日历窗口精确归档统计。
* **8 项核心指标矩阵**：
  - 汇总展示 **总 Token**、**输入 Token**、**输出 Token**、**缓存命中率**、**预估费用**、**首字延迟**、**正文速度** 与 **平均输入**，实时反映吞吐表现与成本消耗。
* **本地生成记录汇总直方图**：
  - 「今天 / 昨天」展示 24 小时分时柱状图；「近 3 / 7 / 30 天」切换为按日统计柱状图；
  - 鼠标悬停任意柱体，右上角汇总看板实时联动更新对应时段的 Token、回复条数与按真实模型单价核算的预估费用。
* **模型分布与明细**：
  - **Token 用量视图**：按模型（含不同思考强度挡位）占比呈现进度条。
  - **预估费用视图**：交互式 Onyx 单色分段 SVG 环形 Donut 图，支持悬停高亮对应模型份额与费用明细。
  - **主流模型覆盖与自定义费率**：内置对齐 OpenRouter 费率的最新模型配置（包括 `Gemini 4 Neon`、`Gemini 4 Carbon`、`Gemini 4 Argon`、`Gemini 4 Hydrogen`、`Gemini 3.8 / 3.7 / 3.6 Flash`、`Gemini 3.1 Pro`、`Nano Banana 2 / 2.1`、`Claude Sonnet 4.6 / 5.5`、`Claude Opus 4.6 / 5.5`、`GPT-OSS 120B` 等），支持本地 JSON 单价覆盖。

### 4. Antigravity 2.0 Onyx 工业设计 & 在线无感升级
* **Onyx 极简双主题**：自适应 Antigravity 深色（`#0D0D11` / `#15151A`）与浅色（`#FAFAFA` / `#FFFFFF`）调色板，采用圆角悬浮卡片与高对比度单色视觉语言。
* **零侵入架构**：原生插件内置 Sidecar 守护进程，不向全局安装任何提示词规则文件；优先使用 Antigravity 内置 Node `node:sqlite` 或系统 `sqlite3` 读取本地会话数据库及归档库（Windows 支持 `winsqlite3.dll` 与 PowerShell 原生回退）。
* **在线检查更新与热重启**：静默对比 GitHub Releases，发现新版本后顶栏浮现更新徽章，可在弹窗内查阅 Release Notes 并一键完成跨平台下载、解压、覆盖与 Sidecar 热重载。

---

## 运行环境与依赖 (Requirements)

* **宿主机环境**：Google Antigravity
* **Node.js**：`>= 18.0`（桌面端插件运行时优先使用 Antigravity 内置 `node:sqlite`；独立运行或老版本环境可选系统 `sqlite3`）
* **Python 3**：仅在需要使用「上下文窗口解锁」功能对二进制执行本地修补时要求本机已安装 `python3` / `python`

---

## 安装与分发 (Quick Start)

克隆或下载解压本仓库后，在项目根目录执行对应平台的安装脚本：

### Windows (PowerShell)
```powershell
.\install.ps1
```

### macOS / Linux (Terminal)
```bash
chmod +x install.sh && ./install.sh
```

安装脚本会自动完成以下工作：
1. 环境预检（Antigravity 本地存储目录及 SQLite 读取能力检测）。
2. 将插件安装至全局插件目录（`~/.gemini/config/plugins/agy-context`，Windows 为 `%USERPROFILE%\.gemini\config\plugins\agy-context`），并清理旧版遗留目录与冗余文件。
3. 在 `~/.gemini/config/config.json` 中注册并启用 `"agy-context"`，同时尝试通过 Language Server RPC 自动热激活 Sidecar。

---

## 唤出与使用

在 Antigravity 中可通过以下方式打开看板：
1. **侧边栏原生直达**：点击 Antigravity 右上角 `...` 菜单 -> **`Extensions >`** -> 选择 **`Context Usage`**，即可在右侧 Auxiliary Pane 原生展开。
2. **对话内直达链接**：在任意会话中点击或发送：  
   `[⚡ 打开上下文监控看板](sidecar://agy-context/context-panel/)`
3. **后台静默守护**：Sidecar 随 Antigravity 自动启动与保活，实时同步当前活跃会话与本地用量记录。

---

## 自定义模型单价 (可选)

如需覆盖内置的 OpenRouter 参考单价或新增私有模型费率，可创建或编辑 `~/.gemini/antigravity/pricing_config.json`（单位：USD / 1M tokens）：

```json
{
  "rates": {
    "gemini-4-neon": { "input": 3.00, "output": 15.00, "cached": 0.15 },
    "my-custom-model": { "input": 1.00, "output": 5.00, "cached": 0.10 }
  }
}
```

---

## 一键干净卸载

如需完整移除插件，请在项目或插件目录执行卸载脚本（如曾使用过「上下文窗口解锁」，建议卸载前先在面板解锁弹窗中点击 **「还原备份」** 恢复官方原始二进制）：

* **Windows**：`.\uninstall.ps1`
* **macOS / Linux**：`./uninstall.sh`

卸载脚本会自动通知 Language Server 停用并注销 `agy-context/context-panel` Sidecar，清理插件与遗留数据目录，并移除 `~/.gemini/config/config.json` 中的注册项。

---

## License & Credits

* **Author**: [q1u](https://github.com/q1uuuu)
* **Repository**: [https://github.com/q1uuuu/agy-context](https://github.com/q1uuuu/agy-context)
* **Platform**: Google Antigravity
* **License**: [Apache License 2.0](LICENSE) - Copyright (c) 2026 q1u

---

## 致谢与交流
* **[Linuxdo](https://linux.do)**
