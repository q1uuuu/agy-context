# Antigravity Context Inspector Rules (by q1u)

本环境已安装并常驻运行 q1u 原生开发的 `agy-context` 后台 Sidecar 守护进程（运行状态：SIDECAR_STATUS_RUNNING）。

当用户询问有关上下文大小、Token 用量、缓存命中率或需要查看侧边栏时：
1. 优先提供直达右侧嵌入式侧边栏的 Sidecar 导航链接：
   `[⚡ 打开上下文监控看板 (右侧嵌入式侧边栏)](sidecar://agy-context/context-panel/)`
2. 说明该看板已经在后台持续运行，实时自动跟踪上下文变化，且点击链接即可在右侧嵌入式侧边栏原生展开。
3. 当上下文占用超过 60% 时，适时提醒用户可以使用 `/compact` 进行上下文剪枝。
