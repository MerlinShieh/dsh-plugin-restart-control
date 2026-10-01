/**
 * dsh-plugin-restart-control —— detached 重启助手的源码。
 *
 * 为什么需要它：桌面版的 host 是 Electron 的子进程，而插件与 Electron 主进程
 * 之间的 IPC 是一张**封闭白名单**（见 `@deepseek-ai/dsh-desktop-host` 的
 * `process.on("message")`：只认 shutdown / quit-inspection / update-tasks，
 * 发出白名单外的消息会被主进程直接 SIGTERM）。所以插件无法请求外壳执行
 * `app.relaunch()`。唯一不依赖外壳配合的办法，是在一个**分离的进程**里：
 * 等这一轮 HTTP 响应送出去 → 结束当前外壳 → 重新拉起同一个可执行文件。
 *
 * 助手用 `process.execPath` 以 `ELECTRON_RUN_AS_NODE=1` 模式运行，因此不需要
 * 系统另外安装 Node。但它因此与目标进程**同名**，所以这里一律按 PID 结束
 * 进程，绝不按镜像名（`taskkill /IM "DeepSeek Harness.exe"` 会把它自己也带走）。
 *
 * 结束顺序是有意的：先结束外壳主进程——主进程一退出，host 的 IPC 通道断开，
 * `dsh-desktop-host` 的 `process.once("disconnect", ...)` 就会走优雅关闭；
 * 助手再兜底等待并强杀 host，最后等端口释放，才拉起新实例。
 *
 * 参数全部经环境变量传入（不拼命令行），避免任何转义问题。
 *
 * @module dsh-plugin-restart-control/restart-helper
 */

/** 助手读取的环境变量名。 */
export const HELPER_ENV = Object.freeze({
	/** 要重新拉起的可执行文件（Electron 外壳）。 */
	executable: 'DSH_RC_EXE',
	/** 外壳主进程 PID。 */
	mainPid: 'DSH_RC_MAIN_PID',
	/** 当前 host（内核）进程 PID。 */
	hostPid: 'DSH_RC_HOST_PID',
	/** 当前 Web 端口，用来判断新实例是否接上。 */
	port: 'DSH_RC_PORT',
	/** 助手日志文件路径。 */
	logPath: 'DSH_RC_LOG',
	/** 本次重启的标识，仅用于日志关联。 */
	requestId: 'DSH_RC_REQUEST_ID',
});

/**
 * 助手脚本源码（CommonJS，`node -e` / Electron node 模式可直接执行）。
 *
 * 它只使用 Node 内置模块；失败一律写日志而不是抛出，因为没有人能接住一个
 * 分离进程的异常——能查的证据只有日志文件。
 */
export const RESTART_HELPER_SOURCE = String.raw`
const { spawn } = require('node:child_process')
const { appendFileSync, mkdirSync } = require('node:fs')
const { dirname } = require('node:path')
const net = require('node:net')

const exe = process.env.DSH_RC_EXE
const mainPid = Number(process.env.DSH_RC_MAIN_PID)
const hostPid = Number(process.env.DSH_RC_HOST_PID)
const port = Number(process.env.DSH_RC_PORT)
const logPath = process.env.DSH_RC_LOG
const requestId = process.env.DSH_RC_REQUEST_ID || 'unknown'

const log = (line) => {
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, '[' + new Date().toISOString() + '] [' + requestId + '] ' + line + '\n')
  } catch {}
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error && error.code === 'EPERM' }
}
const portFree = (p) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port: p })
  let settled = false
  const done = (value) => { if (settled) return; settled = true; try { socket.destroy() } catch {} ; resolve(value) }
  socket.once('connect', () => done(false))
  socket.once('error', () => done(true))
  setTimeout(() => done(true), 800)
})

;(async () => {
  log('start exe=' + exe + ' main=' + mainPid + ' host=' + hostPid + ' port=' + port)
  if (!exe) { log('abort: DSH_RC_EXE is empty'); return }

  // 1) 先把这一轮 HTTP 响应送出去，避免调用方看到连接被掐断。
  await sleep(1200)

  // 2) 结束外壳主进程：它的退出会断开 host 的 IPC，host 随之优雅关闭。
  try { process.kill(mainPid, 'SIGTERM'); log('sent SIGTERM to shell pid=' + mainPid) }
  catch (error) { log('shell kill failed: ' + (error && error.message)) }

  // 3) 等 host 收尾；超时则强杀，保证端口不会再被旧内核占着。
  let waited = 0
  while (waited < 10000 && alive(hostPid)) { await sleep(250); waited += 250 }
  if (alive(hostPid)) {
    try { process.kill(hostPid, 'SIGKILL'); log('host still alive after ' + waited + 'ms, sent SIGKILL') }
    catch (error) { log('host SIGKILL failed: ' + (error && error.message)) }
    await sleep(500)
  } else {
    log('host exited after ' + waited + 'ms')
  }

  // 4) 等端口释放：新实例若撞上旧端口会直接起不来。
  let freed = false
  for (let i = 0; i < 80; i++) { if (await portFree(port)) { freed = true; break } await sleep(250) }
  log('port ' + port + ' freed=' + freed)

  // 5) 拉起新实例。关键：清掉 ELECTRON_RUN_AS_NODE，否则新进程也会是 node 模式。
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.DSH_RC_EXE
  delete env.DSH_RC_MAIN_PID
  delete env.DSH_RC_HOST_PID
  delete env.DSH_RC_PORT
  delete env.DSH_RC_LOG
  delete env.DSH_RC_REQUEST_ID
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', env, windowsHide: false })
    child.unref()
    log('relaunched shell pid=' + child.pid)
  } catch (error) {
    log('relaunch failed: ' + (error && error.message))
  }
})()
`
