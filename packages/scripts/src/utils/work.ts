import { SimplifyWorkResult, WorkerEvents, WorkResult, SearchInformation } from '@ocsjs/core';
import { $ui, $message, MessageElement, Script, h, CommonEventEmitter, cors, $elements } from 'easy-us';
import { CommonProject } from '../projects/common';
import { CommonWorkOptions, workPreCheckMessage } from '.';
import { searchAnswerInWrappers } from './answerer';

export let globalControlPanel: HTMLElement | null = null;
let globalFloatingBar: HTMLElement | null = null;

const FLOATING_BAR_ID = 'ncp-floating-bar';

/** 悬浮条要挂载到顶层页面：章节测验在 iframe 里运行，挂在 iframe 内会被裁剪得很小 */
function getFloatingBarHost(): Document {
	try {
		if (window.top && window.top.document) {
			return window.top.document;
		}
	} catch {
		// 顶层页面是跨域的，只能挂载在当前页面
	}
	return document;
}

/**
 * 暂停状态由答题器统一保存，面板里的按钮和悬浮条共用同一份，
 * 任何一个按钮切换后，另一个都会同步更新，不会出现“一个显示暂停、另一个显示继续”的情况。
 */
const pausedWorkers = new WeakMap<object, boolean>();
const pauseListeners = new Set<(worker: object, paused: boolean) => void>();

export function isWorkPaused(worker: object | undefined) {
	return worker ? pausedWorkers.get(worker) === true : false;
}

export function setWorkPaused(worker: CommonEventEmitter<WorkerEvents> | undefined, paused: boolean) {
	if (!worker) {
		return;
	}
	pausedWorkers.set(worker, paused);
	worker.emit?.(paused ? 'stop' : 'continuate');
	pauseListeners.forEach((listener) => listener(worker, paused));
}

const floatingBtnStyle: Partial<CSSStyleDeclaration> = {
	padding: '6px 14px',
	border: 'none',
	borderRadius: '16px',
	color: '#fff',
	fontSize: '13px',
	cursor: 'pointer',
	transition: 'opacity 0.2s'
};

/**
 * 创建全局悬浮控制条（底部固定），包含手动搜题 + 开始/暂停
 */
function createFloatingBar(onStartPause: () => void, getState: () => boolean) {
	if (globalFloatingBar) globalFloatingBar.remove();
	getFloatingBarHost().getElementById(FLOATING_BAR_ID)?.remove();

	// --- 开始/暂停按钮 ---
	const pauseBtn = h('button', { style: { ...floatingBtnStyle, background: '#7c4dff' } }, '⏸ 暂停');
	pauseBtn.onclick = () => {
		onStartPause();
		pauseBtn.textContent = getState() ? '▶ 继续' : '⏸ 暂停';
	};

	// --- 手动搜题区域 ---
	const searchInput = h('input', {
		placeholder: '输入题目搜题...',
		style: {
			flex: '1',
			minWidth: '120px',
			padding: '4px 8px',
			border: '1px solid #555',
			borderRadius: '12px',
			background: '#222',
			color: '#eee',
			fontSize: '12px',
			outline: 'none'
		}
	}) as HTMLInputElement;

	const searchResultBox = h('div', {
		style: {
			display: 'none',
			position: 'absolute',
			bottom: '48px',
			right: '0',
			width: '460px',
			maxHeight: '400px',
			overflowY: 'auto',
			background: '#1a1a2e',
			border: '1px solid #444',
			borderRadius: '10px',
			padding: '10px',
			boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
			fontSize: '13px',
			color: '#e0e0e0',
			zIndex: '999999'
		}
	});

	const searchBtn = h('button', { style: { ...floatingBtnStyle, background: '#00bfa5' } }, '搜索');
	searchBtn.onclick = async () => {
		const value = searchInput.value.trim();
		if (!value) return;
		const aws = CommonProject.scripts.settings.cfg.answererWrappers;
		if (!aws.length) {
			searchResultBox.style.display = 'block';
			searchResultBox.innerHTML = '<span style="color:#ff7b72">请先配置题库</span>';
			return;
		}
		searchBtn.textContent = '搜索中...';
		searchBtn.setAttribute('disabled', 'true');
		try {
			const infos: SearchInformation[] = await searchAnswerInWrappers(aws, { title: value }, 'manual-single');
			const totalResults = infos.map((i) => i.results).flat().length;
			const resultItems: HTMLElement[] = [];
			for (const info of infos) {
				for (const res of info.results) {
					resultItems.push(
						h(
							'div',
							{
								style: {
									borderLeft: '3px solid #7c4dff',
									padding: '6px 10px',
									marginBottom: '6px',
									borderRadius: '0 4px 4px 0',
									background: '#16213e'
								}
							},
							[
								h('div', { style: { color: '#bb86fc', fontSize: '12px', marginBottom: '2px' } }, info.name),
								h('div', { style: { color: '#ccc', fontSize: '13px' } }, res.question || value),
								h(
									'div',
									{ style: { color: '#7ee787', fontSize: '13px', marginTop: '2px' } },
									res.answer ? '答案: ' + res.answer : '未搜索到答案'
								)
							]
						)
					);
				}
			}
			searchResultBox.style.display = 'block';
			searchResultBox.replaceChildren(
				h('div', { style: { marginBottom: '6px', color: '#aaa' } }, `搜索到 ${totalResults} 个结果`),
				...resultItems
			);
		} catch (e: any) {
			searchResultBox.style.display = 'block';
			searchResultBox.replaceChildren(h('span', { style: { color: '#ff7b72' } }, `搜索失败: ${e?.message || e}`));
		}
		searchBtn.textContent = '搜索';
		searchBtn.removeAttribute('disabled');
	};
	searchInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') searchBtn.click();
	});

	// --- 关闭搜索结果 ---
	const closeResultBtn = h(
		'button',
		{
			style: {
				...floatingBtnStyle,
				background: '#555',
				padding: '4px 10px',
				fontSize: '11px',
				display: 'none'
			}
		},
		'✕'
	);
	closeResultBtn.onclick = () => {
		searchResultBox.style.display = 'none';
		closeResultBtn.style.display = 'none';
	};
	// 搜索结果出现时显示关闭按钮
	new MutationObserver(() => {
		closeResultBtn.style.display = searchResultBox.style.display === 'none' ? 'none' : 'inline-block';
	}).observe(searchResultBox, { attributes: true, attributeFilter: ['style'] });

	// --- 折叠按钮：只保留“暂停/继续”，避免控制条遮挡页面上的按钮（折叠状态会被记住） ---
	const COLLAPSE_KEY = 'ncp_floating_bar_collapsed';
	const collapseBtn = h(
		'button',
		{ style: { ...floatingBtnStyle, background: '#555', padding: '4px 8px', fontSize: '11px' } },
		''
	);
	const applyCollapsed = (collapsed: boolean) => {
		[searchInput, searchBtn].forEach((el) => {
			el.style.display = collapsed ? 'none' : '';
		});
		if (collapsed) {
			searchResultBox.style.display = 'none';
		}
		collapseBtn.textContent = collapsed ? '▸' : '▾';
		collapseBtn.title = collapsed ? '展开手动搜题' : '折叠，只保留暂停/继续';
	};
	let collapsed = false;
	try {
		collapsed = localStorage.getItem(COLLAPSE_KEY) === '1';
	} catch {
		// 无法读取本地存储时使用默认展开状态
	}
	applyCollapsed(collapsed);
	collapseBtn.onclick = () => {
		collapsed = !collapsed;
		try {
			localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
		} catch {
			// 保存失败只影响下次是否记住折叠状态
		}
		applyCollapsed(collapsed);
	};

	// --- 整体布局 ---
	const bar = h(
		'div',
		{
			id: FLOATING_BAR_ID,
			style: {
				position: 'fixed',
				bottom: '12px',
				right: '12px',
				zIndex: '999999',
				display: 'flex',
				gap: '6px',
				padding: '6px 12px',
				background: 'rgba(0,0,0,0.82)',
				borderRadius: '24px',
				boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
				alignItems: 'center',
				flexWrap: 'wrap',
				maxWidth: '480px'
			}
		},
		[
			h('span', { style: { color: '#aaa', fontSize: '11px', marginRight: '2px', fontWeight: 'bold' } }, '南城派'),
			pauseBtn,
			collapseBtn,
			searchInput,
			searchBtn,
			closeResultBtn,
			searchResultBox
		]
	);

	globalFloatingBar = bar;
	const host = getFloatingBarHost();
	(host.body || document.body).appendChild(bar);
	return { bar, btn: pauseBtn };
}

/**
 * 为一个答题器挂载悬浮控制条（暂停/继续 + 手动搜题）。
 * 作业、考试、章节测验等所有自动答题的场景都应当调用它，保证体验一致。
 * 答题器触发 done 事件后控制条显示“完成”，几秒后自动移除。
 */
export function attachWorkFloatingBar(worker: CommonEventEmitter<WorkerEvents> | undefined) {
	if (!worker) {
		return undefined;
	}

	const control = createFloatingBar(
		() => setWorkPaused(worker, !isWorkPaused(worker)),
		() => isWorkPaused(worker)
	);

	let finished = false;
	const listener = (target: object, paused: boolean) => {
		if (target === worker && !finished) {
			control.btn.textContent = paused ? '▶ 继续' : '⏸ 暂停';
		}
	};
	pauseListeners.add(listener);

	const remove = () => {
		pauseListeners.delete(listener);
		control.bar.remove();
		if (globalFloatingBar === control.bar) {
			globalFloatingBar = null;
		}
	};

	worker.once('done', () => {
		finished = true;
		control.btn.textContent = '✓ 完成';
		control.btn.style.background = '#4caf50';
		control.btn.onclick = null;
		setTimeout(remove, 5000);
	});

	// 页面（例如章节测验所在的 iframe）被切换走后，事件处理函数已经失效，控制条也要一起移除
	window.addEventListener('pagehide', remove);

	return control;
}

/**
 * 通用作业考试工具方法
 */
export function commonWork(
	script: Script,
	options: {
		start_delay_seconds?: number;
		enable_control_panel?: boolean;
		workerProvider: (opts: CommonWorkOptions) => CommonEventEmitter<WorkerEvents> | undefined;
		beforeRunning?: () => void | Promise<void>;
		onRestart?: () => void | Promise<void>;
		onWorkerCreated?: (worker: CommonEventEmitter<WorkerEvents>) => void | Promise<void>;
	}
) {
	// 置顶当前脚本
	CommonProject.scripts.render.methods.pin(script);
	let worker: CommonEventEmitter<WorkerEvents> | undefined;

	/**
	 * 是否已经按下了开始按钮
	 */
	let startBtnPressed = false;
	/**
	 * 是否检查失败
	 */
	let checkFailed = false;

	/**
	 * 是否正在运行
	 */
	let running = false;

	/** 显示答题控制按钮 */
	const createWorkControlPanel = () => {
		const { controlBtn, restartBtn, startBtn } = createWorkerControl({
			workerProvider: () => worker,
			onStart: async () => {
				startBtnPressed = true;
				if (checkMessage instanceof MessageElement) {
					checkMessage.remove();
				}
				await closeAnswerWrapperEmptyWarning();
				start();
			},
			onRestart: async () => {
				worker?.emit('close');
				await options.onRestart?.();
				start();
			}
		});

		startBtn.style.flex = '1';
		startBtn.style.padding = '4px';
		restartBtn.style.flex = '1';
		restartBtn.style.padding = '4px';
		controlBtn.style.flex = '1';
		controlBtn.style.padding = '4px';

		const container = h(
			'div',
			{ style: { marginTop: '12px', display: 'flex' } },
			running ? [controlBtn, restartBtn] : [startBtn]
		);

		globalControlPanel = container;

		return { container, startBtn, restartBtn, controlBtn };
	};
	const workResultPanel = () => CommonProject.scripts.workResults.methods.createWorkResultsPanel();

	const sync_script = [script];
	if (options.enable_control_panel) {
		sync_script.push(CommonProject.scripts.workResults);
	}

	for (const script of sync_script) {
		script.on('render', () => {
			let gotoSettingsBtnContainer: string | HTMLElement = '';
			if (checkFailed) {
				const gotoSettingsBtn = $ui.button('👉 前往设置题库配置', {
					className: 'base-style-button',
					style: { flex: '1', padding: '4px' }
				});
				gotoSettingsBtn.style.flex = '1';
				gotoSettingsBtn.style.padding = '4px';
				gotoSettingsBtn.onclick = () => {
					CommonProject.scripts.render.methods.pin(CommonProject.scripts.settings);
				};
				gotoSettingsBtnContainer = h('div', { style: { display: 'flex' } }, [gotoSettingsBtn]);
			}

			script.panel?.body?.replaceChildren(
				h('div', { style: { marginTop: '12px' } }, [
					gotoSettingsBtnContainer,
					...(options.enable_control_panel ? [globalControlPanel || createWorkControlPanel().container] : []),
					workResultPanel()
				])
			);
		});
	}

	const workOptions = CommonProject.scripts.settings.methods.getWorkOptions();

	/**
	 * 检查题库是否配置，并询问是否开始答题
	 */
	let checkMessage = workPreCheckMessage({
		onrun: () => startBtnPressed === false && start(),
		onclose: (_, closedMsg) => (checkMessage = closedMsg),
		onNoAnswererWrappers: () => {
			checkFailed = true;
		},
		...workOptions,
		autoStart: CommonProject.scripts.settings.cfg.autoStart,
		start_delay_seconds: options.start_delay_seconds
	});

	const start = async () => {
		await options.beforeRunning?.();
		running = true;
		worker = options.workerProvider(workOptions);

		if (worker) {
			options.onWorkerCreated?.(worker);
		}

		const { container, controlBtn } = createWorkControlPanel();
		// 更新状态
		script.panel?.body?.replaceChildren(container, workResultPanel());

		// 悬浮控制条（与面板里的暂停按钮共用同一个暂停状态）
		attachWorkFloatingBar(worker);

		worker?.once('done', () => {
			running = false;
			globalControlPanel = null;
			controlBtn.disabled = true;
		});
	};
}

/**
 * 答题控制
 */
export function createWorkerControl(options: {
	workerProvider: () => CommonEventEmitter<WorkerEvents> | undefined;
	onStart: () => void;
	onRestart: () => void;
}) {
	let stopMessage: MessageElement | undefined;
	const startBtn = $ui.button('▶️开始答题');
	const restartBtn = $ui.button('🔃重新答题');
	const controlBtn = $ui.button('⏸暂停');

	// 悬浮条或其他地方切换了暂停状态时，同步面板按钮的显示
	const syncState = (worker: object, paused: boolean) => {
		if (worker !== options.workerProvider()) {
			return;
		}
		controlBtn.value = paused ? '▶️继续' : '⏸️暂停';
		if (paused) {
			if (!stopMessage?.isConnected) {
				stopMessage = $message.warn({ duration: 0, content: '暂停中...' });
			}
		} else {
			stopMessage?.remove();
		}
	};
	pauseListeners.add(syncState);

	startBtn.onclick = () => {
		startBtn.remove();
		options.onStart();
	};
	restartBtn.onclick = () => {
		// 重新答题时，清除暂停提示
		stopMessage?.remove();
		const worker = options.workerProvider();
		if (worker) {
			pausedWorkers.set(worker, false);
		}
		options.onRestart();
	};
	controlBtn.onclick = () => {
		const worker = options.workerProvider();
		// 状态更新与按钮显示由 syncState 统一处理
		setWorkPaused(worker, !isWorkPaused(worker));
	};

	return { startBtn, restartBtn, controlBtn };
}

/**
 * 图片识别，将图片链接追加到 text 中
 * 返回一个克隆的节点
 */
export function optimizationElementWithImage(root: HTMLElement, clone_node: boolean = false): HTMLElement {
	const clone = clone_node ? (root.cloneNode(true) as HTMLElement) : root;
	for (const img of Array.from(clone.querySelectorAll('img'))) {
		// 已经追加过链接的图片不再重复追加（同一个元素会被多次处理，克隆时也会带上之前追加的节点）
		const next = img.nextElementSibling as HTMLElement | null;
		if (next?.dataset?.ncpImgUrl) {
			continue;
		}

		const src = document.createElement('span');
		src.innerText = img.src;
		src.dataset.ncpImgUrl = '1';
		// 隐藏图片，但不影响 innerText 的获取
		src.style.fontSize = '0px';
		img.after(src);
	}
	return clone;
}

/**
 * 创建一个不可见的文本节点，追加到图片后面，便于文本获取
 */
export function createUnVisibleTextOfImage(img: HTMLImageElement) {
	const src = document.createElement('span');
	src.innerText = img.src;
	// 隐藏图片，但不影响 innerText 的获取
	src.style.fontSize = '0px';
	img.after(src);
}

/** 将 {@link WorkResult} 转换成 {@link SimplifyWorkResult} */
export function simplifyWorkResult(
	results: WorkResult<any>[],
	/**
	 * 标题处理方法
	 * 在答题时使用相同的处理方法，可以使答题结果显示的题目与搜题的题目保持一致
	 */
	titleTransform?: (title: (HTMLElement | undefined)[], index: number) => string
): SimplifyWorkResult[] {
	const res: SimplifyWorkResult[] = [];
	let i = 0;
	for (const wr of results) {
		const ques =
			titleTransform?.(wr.ctx?.elements.title || [], i) ||
			wr.ctx?.elements.title
				?.map((e) => e?.innerText.trim())
				.filter(Boolean)
				.join('<br>') ||
			'';
		res.push({
			requested: wr.requested,
			resolved: wr.resolved,
			error: wr.error,
			type: wr.ctx?.type,
			question: ques,
			finish: wr.result?.finish,
			searchInfos:
				wr.ctx?.searchInfos.map((sr) => ({
					error: sr.error,
					name: sr.name,
					homepage: sr.homepage,
					results: sr.results.map((ans) => [ans.question, ans.answer, ans.extra_data || {}])
				})) || []
		});
		i++;
	}

	return res;
}

/**
 * 从题目中移除指定的冗余词
 */
export function removeRedundantWords(str: string, words: string[]) {
	for (const word of words.map((w) => w.trim())) {
		str = str.replace(word, '');
	}
	return str;
}

let answererWrapperUnsetMessage: MessageElement | undefined;

export const answerWrapperEmptyWarning = cors.defineTopFunction((duration: number) => {
	const setting = h('button', { className: 'base-style-button-secondary' }, '通用-全局设置');
	setting.onclick = () => {
		CommonProject.scripts.render.methods.pin(CommonProject.scripts.settings);
		setTimeout(() => {
			$elements.root?.querySelector<HTMLElement>('[value="点击配置"]')?.click();
		}, 500);
	};

	answererWrapperUnsetMessage?.remove();
	answererWrapperUnsetMessage = $message.warn({
		content: h('span', {}, ['你还没设置题库，无法自动答题，请切换到 ', setting, ' 页面进行配置。']),
		duration: duration
	});
});

export const closeAnswerWrapperEmptyWarning = cors.defineTopFunction(() => {
	answererWrapperUnsetMessage?.remove();
	answererWrapperUnsetMessage = undefined;
});
