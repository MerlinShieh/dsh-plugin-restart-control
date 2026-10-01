/**
 * dsh-plugin-restart-control —— 宿主半区。
 *
 * 把两个动作经一条受信任栅栏保护的 JSON RPC 暴露给设置页：
 *
 * - `{method:"reload"}`  —— **重载内核**：向当前 profile 的 `cordis.patch.yml`
 *   追加/更新一行带时间戳的注释，让 DSH 自己的 HMR 检测到配置层变化并
 *   **重新组合整棵插件树**。进程与窗口保留——这正是官方认可的那条 "no restart"
 *   路径（`dsh-market` 的插件启停走的是同一机制）。
 * - `{method:"restart"}` —— **重启应用**：交给 `./restart-helper.js` 生成的
 *   分离助手，按 PID 结束外壳再重新拉起。
 *
 * 为什么"重载内核"不等于"重启 host 进程"：桌面版的 host 是 Electron 的子进程，
 * 而主进程把 host 的任何主动退出都判为失败（`dsh desktop host stopped` /
 * `acknowledged an unrequested shutdown`），随后弹崩溃恢复对话框；插件也够不到
 * 主进程的 `app.relaunch()`（IPC 是封闭白名单）。所以这一档提供的是官方语义下
 * 可达成的最强形态：内核级重载。
 *
 * 路由安全沿用 `dsh-dream-skin` / `dsh-better-sidebar` 的信任栅栏：回环（或
 * `webRuntime.trustedHosts` 里声明的权威）Host + 同源浏览器标记。这是
 * 防 DNS-rebinding / 跨站请求的栅栏，不是身份认证。
 *
 * @module dsh-plugin-restart-control
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { HELPER_ENV, RESTART_HELPER_SOURCE } from './restart-helper.js'

/** 插件身份（Cordis loader 条目名）。 */
export const name = 'dsh-plugin-restart-control'
/** 挂载前需要的服务：HTTP 路由与信任主机清单。 */
export const inject = ['webServer', 'webRuntime']

/** 本插件独占的路由前缀。 */
const API_PREFIX = '/dsh-plugin-restart-control/api'
/** 请求体上限：这里只有小 JSON，不需要大 body。 */
const MAX_BODY_BYTES = 64 * 1024
/** 触发 HMR 重新组合的那行注释的固定前缀。 */
const RELOAD_MARKER = '# dsh-plugin-restart-control: kernel reload marker'
/** 助手日志相对 $DSH_HOME 的位置。 */
const LOG_RELATIVE = join('dsh-plugin-restart-control', 'restart.log')
/** 重启窗口期：这段时间内拒绝重复的重启请求。 */
const RESTART_BUSY_MS = 60_000

/** 解析 Harness 主目录：优先环境变量，其次 `~/.dsh`。 */
function dshHome() {
	const fromEnv = process.env.DSH_HOME
	return fromEnv !== undefined && fromEnv.trim() !== '' ? resolve(fromEnv.trim()) : join(homedir(), '.dsh')
}

/** 助手日志绝对路径。 */
function logPath() {
	return join(dshHome(), LOG_RELATIVE)
}

/**
 * 定位当前 profile 的用户 patch 文件。
 *
 * 顺序：`DSH_PROFILE_DIR`（桌面版与 CLI 都会设）→ `ctx.profileContext.dir`。
 * 命中后仍要确认文件存在——我们**不去创建**一个空的 patch 层，因为官方约定
 * 空文件或"仅注释"会让启动失败（该层停用的正确写法是 `[]`）。
 *
 * @param ctx - 宿主上下文。
 * @returns patch 文件绝对路径，或 undefined。
 */
function resolveProfilePatch(ctx) {
	const candidates = []
	const profileDir = process.env.DSH_PROFILE_DIR
	if (profileDir !== undefined && profileDir.trim() !== '') candidates.push(join(resolve(profileDir.trim()), 'cordis.patch.yml'))
	try {
		const context = ctx.profileContext
		if (context !== undefined && typeof context.dir === 'string' && context.dir !== '') {
			candidates.push(join(resolve(context.dir), 'cordis.patch.yml'))
		}
	} catch {
		/* profileContext 只是补充来源，读不到就跳过 */
	}
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
		} catch {
			/* 继续找下一个候选 */
		}
	}
	return undefined
}

// ── 信任栅栏（镜像 dsh-dream-skin / dsh-better-sidebar 的实现） ──────────────

/** 把 Host 头的权威解析成 URL，无法解析时返回 undefined。 */
function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`)
	} catch {
		return undefined
	}
}

/** hostname 是否指向本机回环。 */
function isLoopbackHostname(hostname) {
	if (hostname === 'localhost' || hostname === '[::1]') return true
	const parts = hostname.split('.')
	return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** 权威的规范形式：hostname，或写了端口时的 hostname:port。 */
function canonicalAuthority(entry, entryUrl) {
	const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
	return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** 校验一条 trustedHosts 是裸权威（host 或 host:port），否则 fail loud。 */
function assertTrustedAuthority(entry) {
	const entryUrl = parseAuthority(entry)
	if (entryUrl !== undefined && canonicalAuthority(entry, entryUrl) === entry.toLowerCase()) return
	throw new Error(`dsh-plugin-restart-control: trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`)
}

/** 请求权威是否命中 trustedHosts（精确或省略端口）。 */
function isTrustedAuthority(hostUrl, trustedHosts) {
	return trustedHosts.some((entry) => {
		assertTrustedAuthority(entry)
		const entryUrl = parseAuthority(entry)
		if (entryUrl === undefined) return false
		return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
			? entryUrl.hostname === hostUrl.hostname
			: entryUrl.host === hostUrl.host
	})
}

/**
 * 判断一个请求是否允许进入本插件的路由。
 * @param req - Node 请求对象。
 * @param trustedHosts - 本部署声明的非回环权威。
 * @returns Host 属于我们（回环或受信任）且浏览器标记同源时为 true。
 */
function isTrustedApiRequest(req, trustedHosts) {
	const host = typeof req.headers.host === 'string' ? req.headers.host : undefined
	if (host === undefined) return false
	const hostUrl = parseAuthority(host)
	if (hostUrl === undefined) return false
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
	if (req.headers['sec-fetch-site'] === 'cross-site') return false
	const origin = req.headers.origin
	if (origin === undefined) return true
	try {
		return new URL(origin).host === hostUrl.host
	} catch {
		return false
	}
}

// ── JSON 收发 ───────────────────────────────────────────────────────────────

/** 读一个受限大小的 JSON 请求体；非 JSON 返回 null，超限返回超大哨兵。 */
const PAYLOAD_TOO_LARGE = Symbol('payload-too-large')
function readJsonBody(req) {
	return new Promise((resolve) => {
		const chunks = []
		let size = 0
		let aborted = false
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > MAX_BODY_BYTES && !aborted) {
				aborted = true
				req.destroy()
				resolve(PAYLOAD_TOO_LARGE)
				return
			}
			if (!aborted) chunks.push(chunk)
		})
		req.on('end', () => {
			if (aborted) return
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
			} catch {
				resolve(null)
			}
		})
		req.on('error', () => {
			if (!aborted) resolve(null)
		})
	})
}

/** 写一个 JSON 响应。 */
function writeJson(res, status, value) {
	const body = JSON.stringify(value)
	res.writeHead(status, {
		'content-type': 'application/json',
		'cache-control': 'no-store',
	})
	res.end(body)
}

/** 统一的错误形状：前端只认 code 与 message。 */
function fail(res, status, code, message) {
	writeJson(res, status, { ok: false, error: { code, message } })
}

// ── 动作实现 ────────────────────────────────────────────────────────────────

/**
 * 当前是否有正在跑的工作——用于设置页的占用提示。
 *
 * 只读；任一服务不可用都按"未知"处理，权限问题不该让状态接口整个失败。
 */
function inspectActivity(ctx) {
	const result = { active: false, known: false, agents: 0, jobs: 0 }
	try {
		const agents = ctx.get('agents')
		if (agents === undefined || typeof agents.list !== 'function') return result
		const roster = agents.list()
		if (!Array.isArray(roster)) return result
		result.known = true
		result.agents = roster.length
		result.active = roster.some((agent) =>
			agent?.status === 'running' || (agent?.inbox?.nextTurn?.length ?? 0) > 0 || (agent?.inbox?.nextStep?.length ?? 0) > 0)
		const jobs = ctx.get('jobs')
		if (jobs !== undefined && typeof jobs.list === 'function') {
			for (const agent of [undefined, ...roster]) {
				const list = jobs.list(agent?.id)
				if (!Array.isArray(list)) continue
				for (const job of list) {
					result.jobs += 1
					if (job?.status === 'running' || job?.status === 'stopping') result.active = true
				}
			}
		}
		return result
	} catch {
		return result
	}
}

/**
 * 触发一次内核重载：更新 profile patch 里的标记行，让 HMR 重新组合插件树。
 *
 * 只增删我们自己那一行注释，绝不改动用户的任何既有内容。
 *
 * @param patchPath - profile patch 文件绝对路径。
 * @returns 是否真的产生了变化，以及写入的标记行。
 */
function triggerKernelReload(patchPath) {
	const previous = readFileSync(patchPath, 'utf8')
	const newline = previous.includes('\r\n') ? '\r\n' : '\n'
	const kept = previous.split(/\r?\n/).filter((line) => !line.startsWith(RELOAD_MARKER))
	while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
	const marker = `${RELOAD_MARKER} ${new Date().toISOString()}`
	const next = `${kept.join(newline)}${newline}${newline}${marker}${newline}`
	const changed = next !== previous
	if (changed) writeFileSync(patchPath, next, 'utf8')
	return { changed, marker }
}

/**
 * 安排一次"重启应用"：起一个分离助手，由它结束外壳并重新拉起。
 * @param port - 当前 Web 端口，助手用它判断新实例是否接上。
 * @returns 助手 PID、日志路径与相关进程号。
 */
function scheduleAppRestart(port) {
	const executable = process.execPath
	const requestId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
	const environment = {
		...process.env,
		ELECTRON_RUN_AS_NODE: '1',
		[HELPER_ENV.executable]: executable,
		[HELPER_ENV.mainPid]: String(process.ppid),
		[HELPER_ENV.hostPid]: String(process.pid),
		[HELPER_ENV.port]: String(port ?? 0),
		[HELPER_ENV.logPath]: logPath(),
		[HELPER_ENV.requestId]: requestId,
	}
	const helper = spawn(executable, ['-e', RESTART_HELPER_SOURCE], {
		env: environment,
		detached: true,
		stdio: 'ignore',
		windowsHide: true,
	})
	helper.unref()
	return { helperPid: helper.pid ?? null, logPath: logPath(), requestId, shellPid: process.ppid, hostPid: process.pid, executable }
}

/** 助手日志尾部，供设置页排障。 */
function readRestartLog(limit = 40) {
	const file = logPath()
	if (!existsSync(file)) return { exists: false, logPath: file, tail: '' }
	try {
		const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line !== '')
		return { exists: true, logPath: file, tail: lines.slice(-limit).join('\n') }
	} catch (error) {
		return { exists: true, logPath: file, tail: '', error: error instanceof Error ? error.message : String(error) }
	}
}

/** 当前 profile 名：环境变量优先，其次启动器提供的 profile 上下文。 */
function profileName(ctx) {
	const fromEnv = process.env.DSH_PROFILE
	if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
	try {
		const context = ctx.profileContext
		if (context !== undefined && typeof context.name === 'string' && context.name !== '') return context.name
	} catch {
		/* profileContext 是补充来源 */
	}
	return null
}

/**
 * 客户端半区的自检：`/plugins` 下的 bundle 路由是否已被 client-modules 注册。
 *
 * 这不是装饰——设置页能不能出现这个分区，取决于 bundle 是否进了客户端模块图，
 * 而那条路由只有在模块系统收录了本包之后才存在。把结论直接放进 status，
 * 排障时就不必猜"页面没显示"到底是插件没装、bundle 没收录，还是页面没刷新。
 */
function inspectClientSide(ctx) {
	const result = { available: false, bundleRouteRegistered: null, bundlePath: '/plugins/dsh-plugin-restart-control/client.js' }
	try {
		const registry = ctx.get('clientModules')
		result.available = registry !== undefined
		if (registry !== undefined) {
			const methods = []
			for (const key of ['list', 'entries', 'graph', 'snapshot', 'describe', 'get', 'has', 'registry']) {
				if (typeof registry[key] === 'function') methods.push(key)
			}
			result.methods = methods
		}
	} catch (error) {
		result.error = error instanceof Error ? error.message : String(error)
	}
	try {
		result.bundleRouteRegistered = ctx.webServer.match(result.bundlePath) != null
	} catch (error) {
		result.routeError = error instanceof Error ? error.message : String(error)
	}
	return result
}

/** 处理一条控制请求。 */
async function handleApi(ctx, req, res, state) {
	if (req.method !== 'POST') {
		fail(res, 405, 'method-error', 'method not allowed')
		return
	}
	const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].toLowerCase() : ''
	if (!contentType.startsWith('application/json')) {
		fail(res, 415, 'unsupported-media-type', 'content-type must be application/json')
		return
	}
	const payload = await readJsonBody(req)
	if (payload === PAYLOAD_TOO_LARGE) {
		fail(res, 413, 'payload-too-large', 'request body too large')
		return
	}
	if (payload === null || typeof payload !== 'object' || typeof payload.method !== 'string') {
		fail(res, 400, 'bad-request', 'bad request')
		return
	}

	if (payload.method === 'status') {
		const patchPath = resolveProfilePatch(ctx)
		const activity = inspectActivity(ctx)
		writeJson(res, 200, {
			ok: true,
			value: {
				plugin: name,
				profile: profileName(ctx),
				hostPid: process.pid,
				shellPid: process.ppid,
				client: inspectClientSide(ctx),
				kernel: {
					reloadAvailable: patchPath !== undefined,
					patchPath: patchPath ?? null,
					reason: patchPath === undefined ? 'profile-patch-not-found' : null,
				},
				application: {
					restartAvailable: true,
					executable: process.execPath,
					logPath: logPath(),
				},
				activity,
				busy: Date.now() < state.restartingUntil,
			},
		})
		return
	}

	if (payload.method === 'reload') {
		const patchPath = resolveProfilePatch(ctx)
		if (patchPath === undefined) {
			fail(res, 409, 'patch-missing', 'profile patch file was not found; kernel reload is unavailable on this host')
			return
		}
		try {
			const result = triggerKernelReload(patchPath)
			ctx.logger?.info?.('dsh-plugin-restart-control: kernel reload marker written to %s', patchPath)
			writeJson(res, 200, { ok: true, value: { mode: 'kernel-reload', changed: result.changed, patchPath, marker: result.marker, scheduledAt: new Date().toISOString() } })
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			ctx.logger?.warn?.('dsh-plugin-restart-control: kernel reload failed: %s', message)
			fail(res, 500, 'reload-failed', message)
		}
		return
	}

	if (payload.method === 'restart') {
		if (Date.now() < state.restartingUntil) {
			fail(res, 409, 'already-scheduled', 'a restart is already scheduled')
			return
		}
		try {
			const result = scheduleAppRestart(ctx.webServer.port)
			state.restartingUntil = Date.now() + RESTART_BUSY_MS
			ctx.logger?.info?.('dsh-plugin-restart-control: restart scheduled, helper pid=%s shell pid=%s', result.helperPid, result.shellPid)
			writeJson(res, 202, { ok: true, value: { mode: 'application-restart', ...result, scheduledAt: new Date().toISOString() } })
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			ctx.logger?.warn?.('dsh-plugin-restart-control: restart scheduling failed: %s', message)
			fail(res, 500, 'restart-failed', message)
		}
		return
	}

	if (payload.method === 'log') {
		writeJson(res, 200, { ok: true, value: readRestartLog() })
		return
	}

	fail(res, 404, 'not-found', `unknown method "${payload.method}"`)
}

/**
 * 挂载宿主半区。
 * @param ctx - 宿主上下文（webServer、webRuntime）。
 */
export function apply(ctx) {
	const state = { restartingUntil: 0 }
	try {
		mkdirSync(dirname(logPath()), { recursive: true })
	} catch {
		/* 建不出目录不影响挂载，写日志时会再试 */
	}
	ctx.effect(() => ctx.webServer.register({
		kind: 'prefix',
		path: API_PREFIX,
		handler: async (req, res) => {
			if (!isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)) {
				fail(res, 403, 'forbidden', 'forbidden')
				return
			}
			try {
				await handleApi(ctx, req, res, state)
			} catch (error) {
				// 不把内部错误回显给浏览器：受信任页面也不需要文件路径等细节。
				console.error('[dsh-plugin-restart-control] control API error:', error)
				fail(res, 500, 'internal', 'internal error')
			}
		},
	}), 'dsh-plugin-restart-control: control API')
}
