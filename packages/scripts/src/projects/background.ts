import { RemotePlaywright, request } from '@ocsjs/core';
import {
	$ui,
	$gm,
	$message,
	$modal,
	$store,
	Project,
	Script,
	StoreListenerType,
	h,
	$,
	MessageElement,
	$menu
} from 'easy-us';
import { CommonProject } from './common';
import { CXProject, definedProjects, ICourseProject, IcveMoocProject, ZHSProject, ZJYProject } from '..';
import { RenderScript } from '../render';
import { SearchInfosElement } from '../elements/search.infos';
import { $render } from '../utils/render';
import { clearPanelLogs, createPanelLogger, LogType, PANEL_LOG_NAMESPACES, PanelLog } from '../utils/logger';
import { $debug, isDebugEnabled, isDryRun } from '../utils/debug';
import { exportDebugLogs, exportPageSnapshot, installSnapshotResponder } from '../utils/snapshot';

const state = {
	console: {
		listenerIds: {
			logs: 0 as StoreListenerType,
			searchLogs: 0 as StoreListenerType,
			debugLogs: 0 as StoreListenerType
		}
	},
	app: {
		listenerIds: {
			sync: 0 as StoreListenerType,
			connected: 0 as StoreListenerType,
			closeSync: 0 as StoreListenerType
		}
	}
};

/** 发布文件所在目录（脚本管理器的自动更新与脚本内的更新提示都读取这里） */
const RELEASE_BASE_URL = 'https://raw.githubusercontent.com/ncccp1/ocs/main/release/';
/** 检查更新的间隔：1 小时 */
const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;

/** 比较版本号，remote 比 local 新时返回 true */
function isNewerVersion(remote: string, local: string) {
	const a = remote.split('.').map((n) => parseInt(n, 10) || 0);
	const b = local.split('.').map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] || 0) - (b[i] || 0);
		if (diff !== 0) {
			return diff > 0;
		}
	}
	return false;
}

type RequestList = {
	id: string;
	url: string;
	method: string;
	type: string;
	data: any;
	headers: any;
	response?: string;
	error?: string;
	time: number;
}[];

const getTypeDesc = (type: LogType) =>
	type === 'info' ? '信息' : type === 'error' ? '错误' : type === 'warn' ? '警告' : type === 'debug' ? '调试' : '日志';

const getCategoryDesc = (category?: PanelLog['category']) =>
	category === 'search' ? '搜题' : category === 'debug' ? '调试' : '系统';

function renderLogPanel(
	script: Script,
	panel: { body: HTMLElement },
	listenerRef: 'logs' | 'searchLogs' | 'debugLogs',
	namespace: string,
	title: string
) {
	const createLog = (log: PanelLog) => {
		const date = new Date(log.time);
		const item = h(
			'div',
			{
				title: '双击复制日志信息',
				className: 'item'
			},
			[
				h(
					'span',
					{ className: 'time' },
					`${date.getHours().toFixed(0).padStart(2, '0')}:${date.getMinutes().toFixed(0).padStart(2, '0')} `
				),
				h('span', { className: 'warn' }, `[${getCategoryDesc(log.category)}]`),
				h('span', { className: log.type }, `[${getTypeDesc(log.type)}]`),
				h('span', ':' + log.content),
				...(log.detail
					? [
							h('details', { style: { marginTop: '4px' } }, [
								h('summary', { style: { cursor: 'pointer' } }, '查看详情'),
								h('pre', log.detail)
							])
					  ]
					: [])
			]
		);

		item.addEventListener('dblclick', () => {
			navigator.clipboard.writeText(
				Object.keys(log)
					.map((key) => `${key}: ${(log as any)[key]}`)
					.join('\n')
			);
		});

		return item;
	};

	const isScrollBottom = (div: HTMLElement) => {
		const { scrollHeight, scrollTop, clientHeight } = div;
		return scrollTop + clientHeight + 50 > scrollHeight;
	};

	const list = h('div', { className: 'card console' });
	const toolbar = h('div', { style: { marginBottom: '8px', textAlign: 'right' } }, [
		h('button', '清空日志', (button) => {
			button.className = 'base-style-button';
			button.onclick = () => {
				clearPanelLogs(namespace);
			};
		})
	]);

	const showLogs = (logs: PanelLog[]) => {
		if (logs.length) {
			list.replaceChildren(...logs.map((log) => createLog(log)));
		} else {
			list.replaceChildren(
				h('div', `暂无${title}`, (div) => {
					div.style.textAlign = 'center';
				})
			);
		}
	};

	const logs = (script.cfg.logs || []) as PanelLog[];
	showLogs(logs);

	script.offConfigChange(state.console.listenerIds[listenerRef]);
	state.console.listenerIds[listenerRef] = script.onConfigChange('logs', (currentLogs: PanelLog[]) => {
		const latest = currentLogs[currentLogs.length - 1];
		if (!latest) {
			showLogs(currentLogs || []);
			return;
		}

		if (!list.children.length || list.textContent?.includes(`暂无${title}`)) {
			showLogs(currentLogs);
			return;
		}

		const item = createLog(latest);
		list.append(item);
		setTimeout(() => {
			if (isScrollBottom(list)) {
				item.scrollIntoView();
			}
		}, 10);
	});

	panel.body.replaceChildren(toolbar, list);
	setTimeout(() => {
		list.lastElementChild?.scrollIntoView();
	}, 10);
}

/** 后台进程，处理与PC软件端的通讯，以及其他后台操作 */
export const BackgroundProject = Project.create({
	name: '后台',
	domains: [],
	scripts: {
		elementRegister: new Script({
			name: '🔗 元素注册',
			hideInPanel: true,
			matches: [['所有页面', /.*/]],
			onstart() {
				// 注册自定义元素
				$.loadCustomElements([SearchInfosElement]);
			}
		}),
		console: new Script({
			name: '📄 日志输出',
			matches: [['所有', /.*/]],
			namespace: 'render.console',
			configs: {
				logs: {
					defaultValue: [] as PanelLog[]
				}
			},
			onrender({ panel }) {
				renderLogPanel(this, panel, 'logs', PANEL_LOG_NAMESPACES.system, '系统日志');
			}
		}),
		searchConsole: new Script({
			name: '🔍 搜题日志',
			matches: [['所有', /.*/]],
			namespace: 'render.search-console',
			configs: {
				logs: {
					defaultValue: [] as PanelLog[]
				}
			},
			onrender({ panel }) {
				renderLogPanel(this, panel, 'searchLogs', PANEL_LOG_NAMESPACES.search, '搜题日志');
			}
		}),
		debugConsole: new Script({
			name: '🐞 调试日志',
			matches: [['所有', /.*/]],
			namespace: 'render.debug-console',
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'调试日志：记录脚本“为什么这样做/为什么没做”，用于排查问题和开发新功能。',
						'需要先在 后台 -> 开发者调试 中开启“调试模式”，关闭时不会产生任何记录。',
						'日志可在 后台 -> 开发者调试 中导出，连同页面元素快照一起发给开发者即可。'
					]).outerHTML
				},
				logs: {
					defaultValue: [] as PanelLog[]
				}
			},
			onrender({ panel }) {
				renderLogPanel(this, panel, 'debugLogs', PANEL_LOG_NAMESPACES.debug, '调试日志');
			}
		}),
		debugResponder: new Script({
			name: '🐞 页面快照响应器',
			hideInPanel: true,
			matches: [['所有页面', /.*/]],
			onstart() {
				// 每一层页面（包括 iframe）都要响应“导出页面元素”的请求
				installSnapshotResponder();
			}
		}),
		appConfigSync: new Script({
			name: '🔄️ 软件配置同步',
			namespace: 'background.app',
			matches: [['所有页面', /./]],
			// 如果是在桌面启动器环境中则不显示此页面
			hideInPanel: $gm.getInfos() === undefined,
			configs: {
				notes: {
					defaultValue: $ui.notes([
						[
							'如果您使用兼容的桌面启动器启动浏览器，并配合此脚本使用，',
							'我们会同步启动器中的配置到此脚本上，方便多个浏览器的管理。',
							'窗口设置以及后台面板所有设置不会进行同步。'
						],
						[
							'项目说明：',
							h('a', { href: 'https://github.com/ncccp1/ocs', target: '_blank' }, 'https://github.com/ncccp1/ocs')
						],
						'如果不是，您可以忽略此脚本。'
					]).outerHTML
				},
				sync_status: {
					defaultValue: 'unconnect' as 'not_playwright_environment' | 'unconnect' | 'not_open_sync' | 'synced'
				},
				closeSync: {
					defaultValue: false,
					label: '关闭同步',
					attrs: {
						type: 'checkbox'
					}
				}
			},

			onrender({ panel }) {
				// 同步面板不会被锁定
				panel.lockWrapper.remove();
				panel.configsContainer.classList.remove('lock');

				const update = () => {
					if (this.cfg.closeSync) {
						const tip = h('div', { className: 'notes card' }, ['已关闭同步。']);
						panel.body.replaceChildren(h('hr'), tip);
					} else if (this.cfg.sync_status === 'synced') {
						const tip = h('div', { className: 'notes card' }, [`已成功同步软件中的配置.`]);
						panel.body.replaceChildren(h('hr'), tip);
					} else if (this.cfg.sync_status === 'unconnect') {
						const tip = h('div', { className: 'notes card' }, ['未同步软件配置，可能是桌面软件未启动。']);
						panel.body.replaceChildren(h('hr'), tip);
					} else if (this.cfg.sync_status === 'not_playwright_environment') {
						const tip = h('div', { className: 'notes card' }, ['当前浏览器不是由桌面端软件启动，无法同步配置。']);
						panel.body.replaceChildren(h('hr'), tip);
					} else if (this.cfg.sync_status === 'not_open_sync') {
						const tip = h('div', { className: 'notes card' }, ['桌面端软件未开启配置同步功能']);
						panel.body.replaceChildren(h('hr'), tip);
					} else if (this.cfg.sync_status === 'empty_config') {
						const tip = h('div', { className: 'notes card' }, ['已成功连接到软件，但配置为空。']);
						panel.body.replaceChildren(h('hr'), tip);
					} else {
						const tip = h('div', { className: 'notes card' }, ['同步状态未知，请稍后重试。']);
						panel.body.replaceChildren(h('hr'), tip);
					}
				};
				update();

				this.offConfigChange(state.app.listenerIds.sync);
				this.offConfigChange(state.app.listenerIds.connected);
				this.offConfigChange(state.app.listenerIds.closeSync);
				state.app.listenerIds.connected = this.onConfigChange('sync_status', update);
				state.app.listenerIds.closeSync = this.onConfigChange('closeSync', (closeSync) => {
					if (closeSync) {
						this.cfg.sync_status = 'not_open_sync';
						$message.success({ content: '已关闭同步，刷新页面后生效' });
					}
				});
			},
			async onactive() {
				if ($.isInTopWindow()) {
					if (this.cfg.closeSync) {
						$console.log('配置同步已关闭');
						return;
					}
					this.cfg.sync_status = 'unconnect';
					try {
						const res = await request('http://localhost:15319/browser', {
							type: 'GM_xmlhttpRequest',
							method: 'get',
							responseType: 'json'
						});
						if (!res) {
							this.cfg.sync_status = 'unconnect';
							return;
						}
						const open_sync = await request('http://localhost:15319/is-browser-config-sync', {
							type: 'GM_xmlhttpRequest',
							method: 'get',
							responseType: 'text'
						});

						if (open_sync !== 'true') {
							this.cfg.sync_status = 'not_open_sync';
							return;
						}

						if (Object.keys(res).length === 0) {
							this.cfg.sync_status = 'not_open_sync';
							return;
						}

						// 自桌面启动器 2.8.21 版本后特殊字段，用于标记不进行同步的字段
						// 通过 Playwright 启动的浏览器会自动返回数据
						// 不使用 http 防止某些 Content-Security-Policy 限制
						const environment_res = await request('/ocs-environment', {
							type: 'fetch',
							method: 'get'
						});
						const environment = environment_res?.environment;
						if (!environment || environment !== 'playwright') {
							this.cfg.sync_status = 'not_playwright_environment';
							return;
						}

						// 排除几个特殊的设置
						for (const key in res) {
							if (Object.prototype.hasOwnProperty.call(res, key)) {
								// 排除渲染脚本的设置
								if (RenderScript.namespace && key.startsWith(RenderScript.namespace)) {
									Reflect.deleteProperty(res, key);
								}
								// 排除后台脚本的设置
								for (const scriptKey in BackgroundProject.scripts) {
									if (Object.prototype.hasOwnProperty.call(BackgroundProject.scripts, scriptKey)) {
										const script: Script = Reflect.get(BackgroundProject.scripts, scriptKey);
										if (script.namespace && key.startsWith(script.namespace)) {
											Reflect.deleteProperty(res, key);
										}
									}
								}
							}
						}

						// 排除那些不用同步的配置
						for (const project of definedProjects()) {
							for (const key in project.scripts) {
								if (Object.prototype.hasOwnProperty.call(project.scripts, key)) {
									const script = project.scripts[key];
									for (const ck in script.configs) {
										if (Object.prototype.hasOwnProperty.call(script.configs, ck)) {
											if (script.configs[ck].extra?.appConfigSync === false) {
												Reflect.deleteProperty(res, $.namespaceKey(script.namespace, ck));
											}
										}
									}
								}
							}
						}

						// 同步所有的配置
						for (const key in res) {
							if (Object.prototype.hasOwnProperty.call(res, key)) {
								$store.set(key, res[key]);
							}
						}

						// 锁定面板
						for (const project of definedProjects()) {
							// 排除后台脚本的锁定
							if (project.name === BackgroundProject.name) {
								continue;
							}
							for (const key in project.scripts) {
								if (Object.prototype.hasOwnProperty.call(project.scripts, key)) {
									const script = project.scripts[key];
									const originalRender = script.onrender;
									// 重新定义渲染函数。在渲染后添加锁定面板的代码
									script.onrender = ({ panel, header }) => {
										originalRender?.({ panel, header });
										if (panel.configsContainer.children.length) {
											panel.configsContainer.classList.add('lock');
											panel.lockWrapper.style.width = (panel.configsContainer.clientWidth ?? panel.clientWidth) + 'px';
											panel.lockWrapper.style.height =
												(panel.configsContainer.clientHeight ?? panel.clientHeight) + 'px';
											panel.configsContainer.prepend(panel.lockWrapper);

											panel.lockWrapper.title =
												'🚫已同步桌面启动器配置，如需修改请优先在启动器的通用设置中处理。\n\n或者前往脚本悬浮窗:后台-软件配置同步 关闭配置同步功能。\n\n可双击强制修改，并关闭同步配置';
											panel.lockWrapper = $ui.tooltip(panel.lockWrapper);
											panel.lockWrapper.addEventListener('dblclick', () => {
												panel.configsContainer.classList.remove('lock');
												panel.lockWrapper.remove();
												script.onrender = originalRender;
												$message.warn({
													content: '已解除配置同步，可正常修改配置。想开启同步请前往：后台-软件配置同步',
													duration: 10
												});
												this.cfg.closeSync = true;
												if (script.panel && script.header) {
													script.onrender?.({ panel: script.panel, header: script.header });
												}
											});
										}
									};
									// 重新执行渲染
									if (script.panel && script.header) {
										script.onrender({ panel: script.panel, header: script.header });
									}
								}
							}
						}

						this.cfg.sync_status = 'synced';
					} catch (e) {
						console.error(e);
						this.cfg.sync_status = 'unconnect';
					}
				}
			}
		}),
		update: new Script({
			name: '📥 更新模块',
			matches: [['所有页面', /.*/]],
			namespace: 'background.update',
			configs: {
				notes: {
					defaultValue: '脚本每 1 小时自动检查一次更新，发现新版本时会在页面上提醒；也可以在下方手动检查。'
				},
				autoNotify: {
					defaultValue: true,
					label: '开启更新通知',
					attrs: { type: 'checkbox', title: '当有最新的版本时在页面上提醒，默认开启' }
				},
				notToday: {
					defaultValue: -1
				},
				ignoreVersions: {
					defaultValue: [] as string[]
				},
				/** 上一次检查更新的时间戳，避免频繁换页时重复请求 */
				lastCheck: {
					defaultValue: 0
				},
				/** 已经发送过系统通知的版本，避免每小时重复通知同一个版本 */
				notifiedVersion: {
					defaultValue: ''
				}
			},
			methods() {
				/** 全域名通用版使用独立的发布文件 */
				const releaseName = () =>
					($gm.getInfos()?.script?.name || '').includes('全域名通用版') ? 'nanchengpai.common' : 'nanchengpai';

				type UpdateResult = { status: 'latest' | 'new' | 'error'; last: string; current: string; checkedAt: number };
				let lastResult: UpdateResult | undefined;
				let promptMessage: MessageElement | undefined;

				const getDownloadUrl = () => RELEASE_BASE_URL + releaseName() + '.user.js';

				const getLastVersion = async () => {
					let version = '';
					try {
						// 读取的是脚本管理器自动更新用的同一个元数据文件，保证提示的版本一定可以下载到
						const meta = (await request(RELEASE_BASE_URL + releaseName() + '.meta.js?t=' + Date.now(), {
							method: 'get',
							type: 'GM_xmlhttpRequest',
							responseType: 'text'
						})) as string;
						version = String(meta).match(/@version\s+([0-9][0-9.]*)/)?.[1] || '';
					} catch (e) {
						console.warn('[update] 读取最新版本失败', e);
					}
					return {
						'last-version': version || 'unknown',
						resource: {},
						notes: []
					} as { 'last-version': string; resource: Record<string, string>; notes: string[] };
				};

				/** 在页面上提醒有新版本（使用不会遮挡页面的消息，避免打断正在运行的自动答题） */
				const showPrompt = (last: string, current: string) => {
					if (promptMessage?.isConnected) {
						return;
					}

					const today = Math.floor(Date.now() / 86400000);
					const button = (text: string, primary: boolean, onClick: () => void) => {
						const btn = h('button', { className: primary ? 'base-style-button' : 'base-style-button-secondary' }, text);
						btn.style.marginRight = '8px';
						btn.onclick = onClick;
						return btn;
					};

					promptMessage = $message.info({
						duration: 0,
						content: h('div', { style: { lineHeight: '1.8' } }, [
							h('div', [h('b', `发现新版本 ${last}`), `（当前 ${current}）`]),
							h(
								'div',
								{ style: { fontSize: '12px', opacity: '0.8' } },
								'点击“立即更新”，在脚本管理器打开的页面里确认安装即可。'
							),
							h('div', { style: { marginTop: '6px' } }, [
								button('立即更新', true, () => {
									window.open(getDownloadUrl(), '_blank');
									promptMessage?.remove();
								}),
								button('更新日志', false, () => CommonProject.scripts.apps.methods.showChangelog()),
								button('今天不再提示', false, () => {
									this.cfg.notToday = today;
									promptMessage?.remove();
								}),
								button('忽略此版本', false, () => {
									this.cfg.ignoreVersions = [...this.cfg.ignoreVersions, last];
									promptMessage?.remove();
								})
							])
						])
					});
				};

				/**
				 * 检查更新。
				 * manual 为 true 时（用户在面板里点击检查）只返回结果，不弹出提醒，也不受“今天不再提示”影响。
				 */
				const check = async (manual = false): Promise<UpdateResult> => {
					const infos = $gm.getInfos();
					const current = infos?.script?.version || '';
					const last = (await getLastVersion())['last-version'];
					const now = Date.now();
					this.cfg.lastCheck = now;

					const status: UpdateResult['status'] =
						last === 'unknown' ? 'error' : isNewerVersion(last, current) ? 'new' : 'latest';
					lastResult = { status, last, current, checkedAt: now };
					$debug.log('update', '检查更新', lastResult);

					if (!manual && status === 'new' && this.cfg.autoNotify) {
						const today = Math.floor(now / 86400000);
						if (!this.cfg.ignoreVersions.includes(last) && this.cfg.notToday !== today) {
							showPrompt(last, current);
							// 系统通知每个版本只发一次，之后每小时的检查只更新页面上的提醒
							if (this.cfg.notifiedVersion !== last) {
								this.cfg.notifiedVersion = last;
								CommonProject.scripts.settings.methods.notificationBySetting(
									`南城派网课助手有新版本 ${last}，当前 ${current}`,
									{ extraTitle: '南城派网课助手' }
								);
							}
						}
					}

					return lastResult;
				};

				return {
					getDownloadUrl,
					getLastVersion,
					check,
					getLastResult: () => lastResult
				};
			},
			onrender({ panel }) {
				const infos = $gm.getInfos();
				if (!infos) {
					return;
				}

				const current = infos.script.version;
				const updateUrl = this.methods.getDownloadUrl();

				const statusEl = h('span', { style: { fontWeight: 'bold' } }, '检查中...');
				const latestEl = h('span', '...');
				const timeEl = h('div', { style: { fontSize: '12px', opacity: '0.75', marginTop: '4px' } }, '');
				const checkBtn = h('button', { className: 'base-style-button' }, '🔄 立即检查更新') as HTMLButtonElement;
				const installBtn = h('button', { className: 'base-style-button' }, '⬇️ 立即更新') as HTMLButtonElement;
				installBtn.style.display = 'none';
				installBtn.style.marginLeft = '8px';
				installBtn.onclick = () => window.open(updateUrl, '_blank');

				const changeLog = h('button', { className: 'base-style-button-secondary' }, '📄 更新日志') as HTMLButtonElement;
				changeLog.style.marginLeft = '8px';
				changeLog.onclick = () => CommonProject.scripts.apps.methods.showChangelog();

				const showResult = (result: { status: string; last: string; checkedAt: number }) => {
					latestEl.textContent = result.last === 'unknown' ? '未知' : result.last;
					if (result.status === 'new') {
						statusEl.textContent = '🆕 发现新版本';
						statusEl.style.color = '#e67e22';
					} else if (result.status === 'latest') {
						statusEl.textContent = '✅ 已是最新版本';
						statusEl.style.color = '#2e9e5b';
					} else {
						statusEl.textContent = '⚠️ 检查失败（可能无法访问 GitHub，请稍后重试）';
						statusEl.style.color = '#d9534f';
					}
					installBtn.style.display = result.status === 'new' ? 'inline-block' : 'none';
					timeEl.textContent = '上次检查：' + new Date(result.checkedAt).toLocaleTimeString();
				};

				const runCheck = async () => {
					checkBtn.disabled = true;
					checkBtn.textContent = '检查中...';
					statusEl.textContent = '检查中...';
					statusEl.style.color = '';
					try {
						showResult(await this.methods.check(true));
					} finally {
						checkBtn.disabled = false;
						checkBtn.textContent = '🔄 立即检查更新';
					}
				};
				checkBtn.onclick = runCheck;

				panel.body.replaceChildren(
					h('div', { className: 'card' }, [
						h('div', { style: { lineHeight: '1.9' } }, [
							h('div', ['当前版本：', h('b', current)]),
							h('div', ['最新版本：', latestEl]),
							h('div', ['状态：', statusEl]),
							timeEl
						]),
						h('div', { style: { margin: '10px 0' } }, [checkBtn, installBtn, changeLog]),
						h('hr'),
						h('div', { style: { fontSize: '12px', opacity: '0.8', lineHeight: '1.7' } }, [
							h('div', `脚本管理器：${infos.scriptHandler}`),
							h('div', ['更新地址：', h('a', { target: '_blank', href: updateUrl }, updateUrl)]),
							h(
								'div',
								'脚本会每 1 小时自动检查一次；脚本管理器（Tampermonkey、脚本猫等）也有自己的更新检查周期，可在其设置中调整。'
							)
						])
					])
				);

				// 打开面板时展示上一次的结果，没有结果再检查一次
				const previous = this.methods.getLastResult();
				if (previous) {
					showResult(previous);
				} else {
					runCheck();
				}
			},
			async oncomplete() {
				// 只在顶层页面检查，避免页面内的 iframe 重复提醒
				if (window.top !== window) {
					return;
				}
				const infos = $gm.getInfos();
				// 调试版本从本地文件加载，不检查更新
				if (!infos || /\(dev\)/i.test(infos.script.name || '')) {
					return;
				}

				const run = async () => {
					if (!this.cfg.autoNotify) {
						return;
					}
					try {
						await this.methods.check(false);
					} catch (error) {
						console.warn('[update] 检查更新出错', error);
					}
				};

				// 页面加载时检查；频繁换页（例如章节自动跳转）时，1 小时内只请求一次
				if (Date.now() - (this.cfg.lastCheck || 0) >= UPDATE_CHECK_INTERVAL) {
					run();
				}
				// 页面长时间不刷新（例如一直在刷课）时，每小时再检查一次
				setInterval(run, UPDATE_CHECK_INTERVAL);
			}
		}),
		dev: new Script({
			name: '🛠️ 开发者调试',
			namespace: 'background.dev',
			matches: [['所有页面', /./]],
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'开发人员调试用，用户可忽略此页面。',
						'开启“调试模式”后，脚本会把关键决策（任务点为什么被跳过、跳转走了哪个分支、缓存命中情况等）记录到 后台 -> 调试日志。',
						'“试运行”：照常搜题、答题和记录日志，但不会提交、不会保存、不会自动跳转章节，适合在真实页面上验证流程。',
						'遇到“卡住”“找不到元素”等问题时，点击下方“导出页面元素”，把下载的文件发给开发者。'
					]).outerHTML
				},
				debugEnabled: {
					label: '开启调试模式',
					defaultValue: false,
					attrs: { type: 'checkbox', title: '记录详细的调试日志（后台 -> 调试日志），并在浏览器控制台输出，默认关闭。' }
				},
				dryRun: {
					label: '试运行（不提交/不保存/不跳转）',
					defaultValue: false,
					attrs: {
						type: 'checkbox',
						title: '开启后脚本会照常搜题、填写答案，但不会提交、保存，也不会自动跳转到下一个章节/小节。'
					}
				},
				show_debug_cursor: {
					defaultValue: true,
					label: '软件辅助点击时显示鼠标位置',
					attrs: { type: 'checkbox' }
				}
			},
			methods() {
				return {
					getRemotePlaywrightCurrentPage: () => {
						return RemotePlaywright.getRemotePage(this.cfg.show_debug_cursor, console.debug);
					}
				};
			},
			onrender({ panel }) {
				const injectBtn = h('button', { className: 'base-style-button' }, '点击注入全局变量');
				injectBtn.addEventListener('click', () => {
					$gm.unsafeWindow.NCP_CONTEXT = self;
					$gm.unsafeWindow.OCS_CONTEXT = self;
				});

				const showTabDataBtn = h('button', { className: 'base-style-button' }, '显示Tab存储');
				$gm.getTab((tab) => {
					const els: HTMLElement[] = [];
					for (const key in tab) {
						if (Object.prototype.hasOwnProperty.call(tab, key)) {
							els.push(h('div', [h('b', key + ' : '), h('code', JSON.stringify(tab[key]))]));
						}
					}
					showTabDataBtn.addEventListener('click', () => {
						$modal.simple({
							content: h('div', els),
							width: window.document.documentElement.clientWidth / 2
						});
					});
				});

				const runExport = async (mode: 'structure' | 'full', button: HTMLButtonElement) => {
					const text = button.textContent;
					button.disabled = true;
					button.textContent = '导出中...';
					try {
						const result = await exportPageSnapshot(mode);
						const kb = Math.round(result.size / 1024);
						$message.success({
							content: `已导出 ${result.filename}（${result.frameCount} 层页面，${kb} KB）${
								result.truncated ? '，部分页面过大已截断' : ''
							}`,
							duration: 8
						});
					} catch (error) {
						$message.error({ content: '导出页面元素失败：' + String(error) });
					} finally {
						button.disabled = false;
						button.textContent = text;
					}
				};

				const structureBtn = h(
					'button',
					{ className: 'base-style-button' },
					'导出页面元素（推荐）'
				) as HTMLButtonElement;
				structureBtn.title = '导出所有层级页面的结构，文本只保留前 40 个字符，已隐藏账号相关参数';
				structureBtn.onclick = () => runExport('structure', structureBtn);

				const fullBtn = h('button', { className: 'base-style-button-secondary' }, '导出完整HTML') as HTMLButtonElement;
				fullBtn.title = '保留完整文本，可能包含姓名、学校等个人信息，发送前请自行检查';
				fullBtn.onclick = () => runExport('full', fullBtn);

				const logsBtn = h('button', { className: 'base-style-button-secondary' }, '导出日志') as HTMLButtonElement;
				logsBtn.onclick = () => {
					const result = exportDebugLogs();
					$message.success({ content: `已导出 ${result.filename}`, duration: 5 });
				};

				const clearDebugBtn = h(
					'button',
					{ className: 'base-style-button-secondary' },
					'清空调试日志'
				) as HTMLButtonElement;
				clearDebugBtn.onclick = () => {
					clearPanelLogs(PANEL_LOG_NAMESPACES.debug);
					$message.success({ content: '调试日志已清空', duration: 3 });
				};

				const status = h(
					'div',
					{ style: { margin: '8px 0', fontSize: '12px', opacity: '0.8' } },
					`当前状态：调试模式${isDebugEnabled() ? '已开启' : '未开启'}，试运行${isDryRun() ? '已开启' : '未开启'}`
				);

				const row = (...buttons: HTMLElement[]) =>
					h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', margin: '8px 0' } }, buttons);

				panel.body.replaceChildren(
					h('div', { className: 'card' }, [
						status,
						h('b', '页面元素'),
						row(structureBtn, fullBtn),
						h('b', '日志'),
						row(logsBtn, clearDebugBtn),
						h('b', '其他'),
						row(injectBtn, showTabDataBtn)
					])
				);
			},
			oncomplete() {
				if (isDebugEnabled()) {
					$debug.log('debug', '调试模式已开启', { dryRun: isDryRun(), url: window.location.href });
				}
			}
		}),
		appLoginHelper: new Script({
			name: '软件登录辅助',
			matches: [
				['超星登录', 'passport2.chaoxing.com/login'],
				['智慧树登录', 'passport.zhihuishu.com/login'],
				['职教云登录', 'zjy2.icve.com.cn/portal/login.html'],
				['智慧职教登录', 'sso.icve.com.cn/sso/auth']
			],
			hideInPanel: true,
			oncomplete() {
				// 将面板移动至左侧顶部，防止挡住软件登录
				if ($.isInTopWindow()) {
					$render.moveToEdge();
				}
			}
		}),

		errorHandle: new Script({
			name: '全局错误捕获',
			matches: [['', /.*/]],
			hideInPanel: true,
			onstart() {
				const projects = definedProjects();
				for (const project of projects) {
					for (const key in project.scripts) {
						if (Object.prototype.hasOwnProperty.call(project.scripts, key)) {
							const script = project.scripts[key];
							script.on('scripterror', (err) => {
								const msg = `[${project.name} - ${script.name}] : ${err}`;
								console.error(msg);
								$console.error(msg);
							});
						}
					}
				}
			}
		}),
		requestList: new Script({
			name: '📄 请求记录',
			matches: [['', /.*/]],
			priority: 99,
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'开发人员请求调试记录页面，小白勿入，最多只记录最近的100个请求数据',
						'可打开F12控制台查看请求日志，或者下方的请求列表'
					]).outerHTML
				},
				enable: {
					label: '开启请求记录',
					attrs: { type: 'checkbox' },
					defaultValue: false
				},
				methodFilter: {
					label: '方法过滤',
					tag: 'select',
					attrs: { placeholder: '选择选项' },
					options: [['none', '无'], ['GET'], ['POST'], ['OPTIONS'], ['HEAD']],
					defaultValue: 'none'
				},
				typeFilter: {
					label: '类型过滤',
					tag: 'select',
					attrs: { placeholder: '选择选项' },
					options: [
						['none', '无'],
						['gmxhr', '油猴API请求（gmxhr）'],
						['fetch', '普通请求（fetch）']
					],
					defaultValue: 'none'
				},
				searchValue: {
					label: '内容搜索',
					attrs: { placeholder: '搜索 URL/请求体/响应' },
					defaultValue: ''
				},
				list: {
					defaultValue: [] as RequestList
				}
			},
			methods() {
				const render = (list: RequestList) => {
					this.panel?.body.replaceChildren();
					this.panel?.body.append(
						h('div', { className: 'card' }, [
							h('div', { style: { padding: '8px 0px', textAlign: 'end' } }, [
								h(
									'button',
									{
										className: 'base-style-button-secondary',
										style: { marginRight: '12px' },
										innerText: '🗑️清空记录'
									},
									(btn) => {
										btn.onclick = () => {
											this.cfg.list = [];
											render(this.cfg.list);
										};
									}
								),
								h('button', { className: 'base-style-button', innerText: '🔍执行搜索' }, (btn) => {
									btn.onclick = () => {
										if (
											this.cfg.methodFilter === 'none' &&
											this.cfg.typeFilter === 'none' &&
											this.cfg.searchValue === ''
										) {
											render(this.cfg.list);
										} else {
											const list = this.cfg.list
												.filter((item) => {
													if (
														this.cfg.methodFilter !== 'none' &&
														item.method.toLowerCase() !== this.cfg.methodFilter.toLowerCase()
													) {
														return false;
													}
													return true;
												})
												.filter((item) => {
													if (this.cfg.typeFilter !== 'none' && item.type !== this.cfg.typeFilter) {
														return false;
													}
													return true;
												})
												.filter((item) => {
													if (
														(this.cfg.searchValue && item.url.includes(this.cfg.searchValue)) ||
														item.data?.includes(this.cfg.searchValue) ||
														item.response?.includes(this.cfg.searchValue)
													) {
														return true;
													}

													return false;
												});
											render(list);
										}
									};
								})
							]),
							h(
								'div',
								{ style: { backgroundColor: '#292929', overflow: 'auto', maxHeight: window.innerHeight / 2 + 'px' } },
								[
									...(list.length === 0
										? [h('div', { style: { color: 'white', textAlign: 'center' } }, '暂无数据')]
										: []),
									...list.map((item) =>
										// @ts-ignore
										h(
											'div',
											{
												title: Object.entries(item)
													.map(([key, val]) =>
														key === 'time'
															? `${key} : ${new Date(val).toLocaleString().replace(/\//g, '-')}`
															: `${key} : ${val}`
													)
													.join('\n'),
												style: {
													maxWidth: '800px',
													padding: '4px 0px',
													margin: '4px 0px',
													// @ts-ignore
													textWrap: 'nowrap'
												}
											},
											[
												h('div', [
													h('span', { style: { marginRight: '8px' } }, new Date(item.time).toLocaleTimeString()),
													h(
														'span',
														{
															style: {
																backgroundColor: '#2196f3a3',
																color: '#ececec',
																marginRight: '8px',
																padding: '0px 2px'
															}
														},
														item.method
													),
													h(
														'span',
														{ style: { color: item.response ? '#4eb74e' : '#eb6262', marginRight: '8px' } },
														'●'
													),
													h(
														'div',
														{ style: { display: 'inline-block', color: '#ececec' } },
														item.url ? (item.url.length > 100 ? item.url.slice(0, 100) + '...' : item.url) : '-'
													)
												]),
												h(
													'div',
													{ style: { overflow: 'hidden', fontSize: '12px', color: '#8f8f8f' } },
													item.data ? 'data: ' + item.data : ''
												),
												h(
													'div',
													{ style: { overflow: 'hidden', fontSize: '12px', color: '#8f8f8f' } },
													item.response ? 'resp: ' + item.response : item.error ? 'err : ' + item.error : ''
												)
											]
										)
									)
								]
							)
						])
					);
				};
				return {
					render: render
				};
			},
			onrender() {
				this.methods.render(this.cfg.list);
			},
			onstart() {
				// 兼容其他环境
				if ($gm.isInGMContext() === false) {
					return;
				}
				/* global GM_xmlhttpRequest  RequestInfo RequestInit */
				/* eslint-disable no-global-assign */
				const gmRequest = GM_xmlhttpRequest;
				const originalFetch = fetch;

				const getId = () => Math.random().toString(16).slice(2);

				const addRecord = (item: (typeof this.cfg.list)[number]) => {
					this.cfg.list = [item, ...this.cfg.list];
					if (this.cfg.list.length > 100) {
						this.cfg.list = this.cfg.list.slice(0, 100);
					}
				};

				const setItem = (id: string, response: string | undefined, error: string | undefined) => {
					const list: typeof this.cfg.list = JSON.parse(JSON.stringify(this.cfg.list));
					const index = list.findIndex((item) => item.id === id);
					if (index !== -1) {
						list[index].response = response;
						list[index].error = error;
					}
					this.cfg.list = list;
				};

				// @ts-ignore
				GM_xmlhttpRequest = (details: any) => {
					if (this.cfg.enable) {
						const id = getId();
						const data = {
							id: id,
							url: details.url,
							method: details.method || 'unknown',
							type: 'gmxhr',
							data: details.data,
							headers: details.headers,
							response: '',
							error: '',
							time: Date.now()
						};
						addRecord(data);
						const onload = details.onload;
						const onerror = details.onerror;

						details.onload = function (response: any) {
							setItem(id, response.responseText, '');
							data.response = details.responseType === 'json' ? response.response : response.responseText;
							console.log('%c [请求成功]', 'color: green; font-weight: bold', data.url, data);
							onload?.apply(this, [response]);
						};
						details.onerror = function (response: any) {
							setItem(id, '', response.error);
							data.error = response.error;
							console.log('%c [请求失败]', 'color: red; font-weight: bold', data.url, data);
							onerror?.apply(this, [response]);
						};
					}

					return gmRequest.apply(this, [details as any]);
				};
				// @ts-ignore
				fetch = (input: URL | RequestInfo, init?: RequestInit | undefined) => {
					if (this.cfg.enable) {
						const id = getId();
						const data = {
							id: id,
							url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
							method: init?.method || 'unknown',
							type: 'fetch',
							data: init?.body,
							headers: init?.headers,
							response: '',
							error: '',
							time: Date.now()
						};
						addRecord(data);
						const res = originalFetch.apply(this, [input, init]);
						res
							.then((result) => {
								return result.clone().text();
							})
							.then((result) => {
								setItem(id, result, '');
								data.response = result;
								console.log('%c [请求成功]', 'color: green; font-weight: bold', data.url, data);
							});

						res.catch((err) => {
							setItem(id, '', String(err));
							data.error = String(err);
							console.log('%c [请求失败]', 'color: red; font-weight: bold', data.url, data);
						});
						return res;
					} else {
						return originalFetch.apply(this, [input, init]);
					}
				};
			}
		}),
		environmentDetect: new Script({
			name: '🤖 环境检测',
			matches: [['所有页面', /.*/]],
			hideInPanel: true,
			oncomplete() {
				if (self !== top) return;

				const matches = [
					CXProject.scripts.studyDispatcher.matches,
					ZHSProject.scripts['gxk-study'].matches,
					ZHSProject.scripts.hike.matches,
					ZHSProject.scripts['smart-study'].matches,
					ZHSProject.scripts['wisdom-study'].matches,
					ZHSProject.scripts['xnk-study'].matches,
					ICourseProject.scripts.study.matches,
					IcveMoocProject.scripts.study.matches,
					ZJYProject.scripts.study.matches
				]
					.flat()
					.map((m) => (Array.isArray(m) ? m[1] : m));

				const url = window.location.href;
				const match = matches.some((regex) => {
					return typeof regex === 'string' ? url.includes(regex) : regex.test(url);
				});
				if (!match) {
					return;
				}

				let messageElement: MessageElement | undefined;
				visibleDetect();

				function visibleDetect() {
					setTimeout(() => {
						if (!messageElement?.isConnected) messageElement = undefined;

						if (document.visibilityState === 'hidden' && !messageElement) {
							messageElement = $message.warn({
								content:
									'⚠️检测到浏览器最小化/切屏，脚本可能无法正常运行，请保持网课页面在前台！（如果您正在全屏游戏中可以忽略此警告）',
								duration: 0
							});
						}
						visibleDetect();
					}, 1000);
				}
			}
		}),
		menus: new Script({
			name: '📁 菜单管理',
			hideInPanel: true,
			matches: [['所有页面', /.*/]],
			async onactive() {
				const currentStudyScript = [
					[CXProject.scripts.studyDispatcher, CXProject.scripts.study],
					CXProject.scripts.work,
					ZHSProject.scripts['gxk-study'],
					ZHSProject.scripts['xnk-study'],
					ZHSProject.scripts.hike,
					ZHSProject.scripts['smart-study'],
					ZHSProject.scripts['wisdom-study'],
					ZHSProject.scripts['xnk-study'],
					ZHSProject.scripts['gxk-work'],
					ZHSProject.scripts['xnk-work'],
					ZHSProject.scripts['hike-work'],
					ZHSProject.scripts['smart-work'],
					ZHSProject.scripts['xnk-work'],
					[ICourseProject.scripts.dispatcher, ICourseProject.scripts.study],
					ICourseProject.scripts.work,
					[ZJYProject.scripts.dispatcher, ZJYProject.scripts.study],
					ZJYProject.scripts.work,
					IcveMoocProject.scripts.study,
					IcveMoocProject.scripts.work
				]
					.map((m) => {
						const url = window.location.href;

						const data = {
							matches: Array.isArray(m) ? m[0].matches : m.matches,
							target: Array.isArray(m) ? m[1] : m
						};

						if (
							data.matches.some((regexp) => {
								const r = Array.isArray(regexp) ? regexp[1] : regexp;
								return typeof r === 'string' ? url.includes(r) : r.test(url);
							})
						) {
							return data.target;
						}

						return undefined;
					})
					.find((m) => m !== undefined);

				// 注册快捷菜单
				await $menu('🏠', { scriptPanelLink: CommonProject.scripts.guide });
				if (currentStudyScript) await $menu('🖥️', { scriptPanelLink: currentStudyScript });
				await $menu('🔎', { scriptPanelLink: CommonProject.scripts.workResults });
				await $menu('⚙️', { scriptPanelLink: CommonProject.scripts.settings });
				await $menu('📥', { scriptPanelLink: BackgroundProject.scripts.update });
				await $menu('📄', { scriptPanelLink: BackgroundProject.scripts.console });
				await $menu('🧾', { scriptPanelLink: BackgroundProject.scripts.searchConsole });
				// 调试模式开启时，提供调试日志的快捷入口
				if (isDebugEnabled()) {
					await $menu('🐞', { scriptPanelLink: BackgroundProject.scripts.debugConsole });
				}
			}
		})
	}
});

type Console = Record<LogType, (...msg: any[]) => void>;

/** 日志对象，存储日志并显示在日志面板 */
export const $console: Console = createPanelLogger(PANEL_LOG_NAMESPACES.system, 'system');
