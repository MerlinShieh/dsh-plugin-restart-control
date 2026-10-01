# dsh-plugin-restart-control

[English](README.en.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的设置页加一个**重启 / Restart** 分区，提供两个档位：

| 档位 | 做什么 | 代价 |
|---|---|---|
| **重载内核** | 让 DSH 自己的 HMR 重新组合整棵插件树（配置重读、插件重新挂载） | 秒级；进程与窗口保留；**换包版本 / 原生模块并不生效** |
| **重启应用** | 由一个分离助手结束外壳进程并重新拉起同一个可执行文件 | 更彻底；会中断正在运行的任务；窗口重建 |

![示意](icon.svg)

## 为什么是这两档

官方桌面版（Electron 外壳 + host 子进程）里，"重启内核"有一个硬约束：

- **插件够不到外壳**。host 与 Electron 主进程之间的 IPC 是一张封闭白名单（`dsh-desktop-host` 的 `process.on("message")` 只认 `shutdown` / `quit-inspection` / `update-tasks`），发出白名单外的消息会被主进程直接 `SIGTERM`。所以插件无法请求外壳执行 `app.relaunch()`。
- **host 也不能自己重启**。主进程把 host 的任何主动退出都判为失败：`dsh desktop host stopped`、`acknowledged an unrequested shutdown` → 弹崩溃恢复对话框。只有主进程自己在更新流程里会"停 host 再拉起 host"。

因此本插件提供的是**官方语义下可达成的最强两档**，也正是 DSH 自己使用的两条路径：

- **重载内核** = 官方 HMR 路径。向当前 profile 的 `cordis.patch.yml` 追加/更新一行带时间戳的注释（`# dsh-plugin-restart-control: kernel reload marker …`），HMR 检测到配置层变化后重新组合插件树。这与 `dsh-market` 做插件启停时用的机制完全相同——**只增删自己那一行注释，不改动你的任何既有配置**。
- **重启应用** = 分离助手路径。助手用 `process.execPath` 以 `ELECTRON_RUN_AS_NODE=1` 启动（不要求系统另装 Node），先结束外壳（外壳退出会断开 host 的 IPC，host 随之优雅关闭），兜底强杀 host，等端口释放后再拉起新实例。全程按 **PID** 结束进程——助手与目标同名，`taskkill /IM` 会把它自己也带走。

## 安装

> ⚠️ **装完必须启用**：`dsh plugin add` 只把包装进 profile，**不会**写 profile 的组合包列表。装好后要到 **设置 → 插件** 打开 `dsh-plugin-restart-control` 的开关（等价于把它加进 `dsh.profile.bundles`），否则它不会被加载。官方插件管理器（设置页 / `plugin_manager` 工具）会替你做这一步。

### 方式一：GitHub（推荐）

```bash
dsh plugin --profile <profile> add "github:MerlinShieh/dsh-plugin-restart-control"
```

实测 pnpm 约 5 秒完成安装，包会解析为 `dsh-plugin-restart-control`。

### 方式二：Release tarball（离线 / 内网）

```bash
dsh plugin --profile <profile> add https://github.com/MerlinShieh/dsh-plugin-restart-control/releases/download/v0.1.0/dsh-plugin-restart-control-0.1.0.tgz
```

### 方式三：官方桌面版（设置页）

官方桌面版独占 `desktop` profile：外部 CLI 会对它报 `profile "desktop" is managed exclusively by the Electron application`。请在 **设置 → 插件 → 添加插件** 里填入上面任一种安装源，再打开组合包开关。

### 方式四：本地路径（开发迭代）

```bash
pnpm add file:/绝对路径/dsh-plugin/restart-control
```

注意 `file:` 安装是**快照**：改了插件源码后要重新 `pnpm add` 才生效；而且插件位于 `node_modules`，不参与 DSH 的 HMR 监视，**宿主半区的代码改动需要重启应用**。

> **npm 包尚未发布**：`dsh-plugin-restart-control` 目前还没有发布到 npm。发布之后即可用更短的 `dsh plugin --profile <profile> add dsh-plugin-restart-control`，安装体验与官方插件完全一致（支持版本范围与 `pnpm update`）。

## 使用

装好后打开 **设置 → 重启 / Restart**：

- **重载内核**：点一下即写入标记行并触发热重载；界面会提示"插件树正在重新组合"。
- **重启应用**：点击后进入**二次确认**（避免误点中断任务）；确认后界面提示"正在重启"，应用回来后本页自动恢复。
- **查看重启日志**：助手把每一步写进 `$DSH_HOME/dsh-plugin-restart-control/restart.log`，设置页可直接查看尾部——重启失败时这是唯一的证据来源。

若当前有正在运行的任务，分区顶部会给出橙色提示；重启应用会中断它们。

## 安全模型

控制路由只接受：

- **回环**（或 `webRuntime.trustedHosts` 里声明的权威）Host 头；
- **同源**浏览器标记（`Sec-Fetch-Site` 不是 `cross-site`，`Origin` 与 Host 一致）；
- `content-type: application/json` 的 POST，body 上限 64 KiB。

这是防 DNS-rebinding / 跨站请求的栅栏，不是身份认证——与 `dsh-dream-skin`、`dsh-better-sidebar` 的路由策略一致。

## 兼容性

- `peerDependencies` 使用范围声明（`>=0.1.0-rc.6 <0.3.0-0`），因此在 DSH `0.2.0-rc.2` 上通过官方兼容性检查。
- 宿主半区需要 `webServer` 与 `webRuntime` 两个服务；缺失时插件不会被挂载（不会让启动失败）。
- 客户端半区只需要 `slots` 与 `locale`；平台 seed（`react`、`react/jsx-runtime`）解析失败时退化成"不可见但无害"，只在控制台留一条警告。

## 已知限制

- **"重载内核"不等于重启进程**：它不会重新加载 Node 已经 import 的模块，也不解决原生模块（native addon）占用。需要那类效果时请用"重启应用"。
- **"重启应用"是强制结束**：助手按 PID 结束外壳，不会走 `before-quit` 的确认流程。DSH 的会话日志是追加写入的，风险较低，但正在运行的任务会被中断。
- **失败恢复是精简版**：助手只写日志，不提供像 `dsh-market` 那样的恢复页。若应用没有自动回来，请手动启动，并在日志里查看卡在哪一步。
- 触发器依赖 profile 的 `cordis.patch.yml` 存在且非空；该文件不存在时"重载内核"会返回 `patch-missing` 并保持禁用状态。

## 开发

本插件的客户端半区是**源码即产物**（`lib/client.js` 直接就是可分发的 bundle，内部经 `react/jsx-runtime` 调用，不用 JSX），因此**没有构建步骤**：

```
lib/index.js           宿主半区（ESM）
lib/restart-helper.js  分离助手源码（模板字符串导出）
lib/client.js          客户端 bundle（window.__ModuleLoader__.load 注册）
cordis.patch.yml       profile patch 层：insert 一个 loader 条目
locale/{zh,en}.json    插件元信息本地化
```

改动后在目标 profile 重装（`pnpm add file:...`）或直接热重载即可。

## License

MIT
