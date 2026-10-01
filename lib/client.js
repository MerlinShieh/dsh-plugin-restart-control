// dsh-plugin-restart-control — browser half (client plugin bundle).
//
// Loaded by dsh-client-modules at /plugins/dsh-plugin-restart-control/client.js and
// executed through the vendored cordis Loader's lazy-CJS module table
// (window.__ModuleLoader__.load). The factory body is plain CJS with
// require() resolved against the shell's platform module table — the same
// shape the shipped ui-* packages emit. Only platform seed names and
// registered client bundles may be required.
//
// 这一半只做两件事：把「重启 / Restart」注册进设置左导航，并在用户按下按钮时
// 调用宿主半区的 JSON RPC（宿主实现见 ../index.js）。
//
// 这是**源码即产物**：文件本身就是可分发的客户端 bundle，不需要构建步骤。
// 代价是不能用 JSX，全部经 `react/jsx-runtime` 的 jsx/jsxs 调用表达。
//
// 平台 seed 解析刻意包在 try 里：一个抛异常的 loader factory 会聚合进
// "entries did not activate" 并把整个 Web 外壳带下去。任何一个必需 seed 缺失时，
// 这里退化成"不可见但无害"的空插件，只在控制台留一条警告。
window.__ModuleLoader__.load({
	id: "dsh-plugin-restart-control",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** 平台 seed 解析：拿不到就返回 null，绝不抛出。 */
		const seedProbe = { lastError: null };
		const requireSeed = (name) => {
			try {
				return require(name);
			} catch (err) {
				seedProbe.lastError = err;
				return null;
			}
		};
		const jsxRuntime = requireSeed("react/jsx-runtime");
		const react = requireSeed("react");
		if (jsxRuntime === null || react === null) {
			try {
				console.warn(
					"[dsh-plugin-restart-control] required host modules unavailable — plugin disabled for this session:",
					seedProbe.lastError && seedProbe.lastError.message
				);
			} catch {}
			exports.apply = () => {};
			exports.inject = [];
			return module.exports;
		}

		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;
		const { useCallback, useEffect, useState } = react;

		/**
		 * 宿主 RPC 端点。用 document.baseURI 解析成同源绝对路径——桌面版与 Web 版
		 * 的页面来源不同（`http://127.0.0.1:<port>` 或外壳协议），相对 baseURI 是
		 * 两种载体都成立的写法（与 dsh-dream-skin 的持久化 API 同一手法）。
		 */
		const API_PATH = new URL("dsh-plugin-restart-control/api", document.baseURI || "http://localhost/").pathname;

		/** 调一次宿主 RPC，把 {ok:false} 与网络错误统一成异常。 */
		async function call(method, extra) {
			const response = await fetch(API_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ method, ...(extra === undefined ? {} : extra) }),
			});
			let body = null;
			try {
				body = await response.json();
			} catch {
				body = null;
			}
			if (!response.ok || body === null || body.ok !== true) {
				const message = body && body.error && body.error.message ? body.error.message : `HTTP ${response.status}`;
				throw new Error(message);
			}
			return body.value;
		}

		// ── 样式 ────────────────────────────────────────────────────────────
		// 全部走内联样式与 currentColor，避免写死颜色在深浅主题下不协调。
		const styles = {
			wrap: { display: "flex", flexDirection: "column", gap: "14px", padding: "4px 0" },
			lede: { margin: 0, opacity: 0.72, fontSize: "12.5px", lineHeight: 1.6 },
			card: {
				border: "1px solid color-mix(in srgb, currentColor 16%, transparent)",
				borderRadius: "10px",
				padding: "12px 14px",
				display: "flex",
				flexDirection: "column",
				gap: "8px",
			},
			cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
			title: { margin: 0, fontSize: "13.5px", fontWeight: 600 },
			desc: { margin: 0, fontSize: "12px", opacity: 0.68, lineHeight: 1.55 },
			meta: { margin: 0, fontSize: "11px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", opacity: 0.55, wordBreak: "break-all" },
			row: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
			button: {
				appearance: "none",
				border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
				borderRadius: "8px",
				padding: "6px 12px",
				fontSize: "12.5px",
				fontWeight: 500,
				background: "color-mix(in srgb, currentColor 7%, transparent)",
				color: "inherit",
				cursor: "pointer",
			},
			danger: {
				border: "1px solid color-mix(in srgb, #e5484d 55%, transparent)",
				background: "color-mix(in srgb, #e5484d 14%, transparent)",
				color: "inherit",
			},
			primary: { background: "color-mix(in srgb, currentColor 13%, transparent)" },
			buttonDisabled: { opacity: 0.55, cursor: "not-allowed" },
			notice: { fontSize: "12px", lineHeight: 1.55, margin: 0, padding: "8px 10px", borderRadius: "8px", background: "color-mix(in srgb, currentColor 8%, transparent)" },
			error: { fontSize: "12px", lineHeight: 1.55, margin: 0, padding: "8px 10px", borderRadius: "8px", background: "color-mix(in srgb, #e5484d 16%, transparent)" },
			warn: { fontSize: "12px", lineHeight: 1.55, margin: 0, padding: "8px 10px", borderRadius: "8px", background: "color-mix(in srgb, #f5a524 16%, transparent)" },
			log: {
				margin: 0,
				padding: "8px 10px",
				borderRadius: "8px",
				background: "color-mix(in srgb, currentColor 6%, transparent)",
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: "11px",
				lineHeight: 1.5,
				whiteSpace: "pre-wrap",
				maxHeight: "160px",
				overflow: "auto",
			},
		};

		/** 生成一个按钮，带极轻的悬停反馈（内联样式写不了 :hover）。 */
		function makeButton(label, onClick, options) {
			const opts = options === undefined ? {} : options;
			const disabled = opts.disabled === true;
			const base = { ...styles.button };
			if (opts.danger === true) Object.assign(base, styles.danger);
			else if (opts.primary === true) Object.assign(base, styles.primary);
			if (disabled) Object.assign(base, styles.buttonDisabled);
			return jsx("button", {
				type: "button",
				style: base,
				disabled,
				onClick,
				onMouseEnter: (event) => {
					if (!disabled) event.currentTarget.style.filter = "brightness(1.1)";
				},
				onMouseLeave: (event) => {
					event.currentTarget.style.filter = "";
				},
				children: label,
			});
		}

		/**
		 * 设置分区主体：状态 + 两个动作 + 二次确认 + 助手日志。
		 */
		function RestartSection() {
			const [status, setStatus] = useState(null);
			const [busy, setBusy] = useState(null);
			const [error, setError] = useState(null);
			const [notice, setNotice] = useState(null);
			const [confirming, setConfirming] = useState(false);
			const [log, setLog] = useState(null);

			const refresh = useCallback(async () => {
				try {
					const value = await call("status");
					setStatus(value);
					setError(null);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			}, []);

			useEffect(() => {
				void refresh();
			}, [refresh]);

			const onReload = useCallback(async () => {
				setBusy("reload");
				setError(null);
				setNotice(null);
				try {
					const value = await call("reload");
					setNotice(
						value.changed
							? "已触发内核重载：插件树正在按当前配置重新组合（进程与窗口保留）。"
							: "配置层没有变化，未触发重载。"
					);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(null);
				}
			}, []);

			const onRestart = useCallback(async () => {
				setBusy("restart");
				setError(null);
				setNotice(null);
				try {
					await call("restart");
					setConfirming(false);
					setNotice("正在重启应用：外壳会退出并自动重新启动，本页会在应用回来后恢复。若 30 秒内没有回来，请手动启动。");
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(null);
				}
			}, []);

			const onShowLog = useCallback(async () => {
				try {
					const value = await call("log");
					setLog(value);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			}, []);

			const kernel = status ? status.kernel : null;
			const application = status ? status.application : null;
			const activity = status ? status.activity : null;
			const reloadAvailable = kernel !== null && kernel.reloadAvailable === true;
			const restartAvailable = application !== null && application.restartAvailable === true;

			const children = [
				jsx("p", {
					style: styles.lede,
					children:
						"两个档位对应 DSH 自己的两条路径：重载内核 = 经官方 HMR 重新组合插件树（进程与窗口保留）；重启应用 = 完整重启外壳（更彻底，但会中断正在运行的任务）。",
				}),
			];

			if (error !== null) children.push(jsx("p", { style: styles.error, children: `错误：${error}` }));
			if (notice !== null) children.push(jsx("p", { style: styles.notice, children: notice }));
			if (activity !== null && activity.active === true) {
				children.push(
					jsx("p", {
						style: styles.warn,
						children: `当前有正在运行的任务（${activity.agents} 个会话 / ${activity.jobs} 个后台作业）。重启应用会中断它们，重载内核不会。`,
					})
				);
			}

			// 卡片一：重载内核
			children.push(
				jsxs("div", {
					style: styles.card,
					children: [
						jsxs("div", {
							style: styles.cardHead,
							children: [
								jsx("h4", { style: styles.title, children: "重载内核 / Reload kernel" }),
								makeButton(busy === "reload" ? "重载中…" : "重载内核", onReload, {
									disabled: busy !== null || !reloadAvailable,
									primary: true,
								}),
							],
						}),
						jsx("p", {
							style: styles.desc,
							children:
								"向当前 profile 的 cordis.patch.yml 写入一行带时间戳的注释，触发 DSH 自身的 HMR 重新组合整棵插件树。用于让配置改动、插件启停在不重启进程的前提下生效。换包版本或原生模块仍需要重启应用。",
						}),
						kernel === null
							? null
							: jsx("p", {
									style: styles.meta,
									children: kernel.reloadAvailable
										? `patch: ${kernel.patchPath}`
										: `不可用（${kernel.reason}）`,
								}),
					].filter((node) => node !== null),
				})
			);

			// 卡片二：重启应用
			const restartControls = confirming
				? [
						makeButton("确认重启", onRestart, { disabled: busy !== null, danger: true }),
						makeButton("取消", () => setConfirming(false), { disabled: busy !== null }),
					]
				: [makeButton(busy === "restart" ? "重启中…" : "重启应用", () => setConfirming(true), { disabled: busy !== null || !restartAvailable, danger: true })];

			children.push(
				jsxs("div", {
					style: styles.card,
					children: [
						jsxs("div", {
							style: styles.cardHead,
							children: [
								jsx("h4", { style: styles.title, children: "重启应用 / Restart application" }),
								jsx("div", { style: styles.row, children: restartControls }),
							],
						}),
						jsx("p", {
							style: styles.desc,
							children:
								"结束当前外壳进程并重新启动同一个可执行文件。由一个分离的助手进程执行（先结束外壳，等端口释放，再拉起新实例），因此不依赖外壳提供任何接口。会中断正在运行的任务。",
						}),
						confirming
							? jsx("p", { style: styles.warn, children: "确认要重启应用吗？正在运行的任务会被中断。" })
							: null,
						application === null
							? null
							: jsx("p", { style: styles.meta, children: `exe: ${application.executable}` }),
						jsxs("div", {
							style: styles.row,
							children: [
								makeButton("查看重启日志", onShowLog, {}),
								log === null
									? null
									: makeButton("收起日志", () => setLog(null), {}),
							].filter((node) => node !== null),
						}),
						log === null
							? null
							: jsx("pre", { style: styles.log, children: log.exists ? log.tail || "(空)" : `尚无日志：${log.logPath}` }),
					].filter((node) => node !== null),
				})
			);

			return jsx("div", { style: styles.wrap, children });
		}

		/** 客户端半区需要的服务：slot 注册表与本地化。 */
		const inject = ["slots", "locale"];

		/**
		 * 客户端插件主体：把「重启」注册成设置里的一个分区。
		 * @param ctx - 客户端 cordis 上下文。
		 */
		function apply(ctx) {
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "restart-control",
						order: 60,
						label: "重启 / Restart",
					},
					RestartSection
				)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
