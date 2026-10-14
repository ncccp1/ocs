import { SimplifyWorkResult, WorkerEvents, WorkResult, SearchInformation } from '@ocsjs/core';
import { $ui, $message, MessageElement, Script, h, CommonEventEmitter, cors, $elements } from 'easy-us';
import { CommonProject } from '../projects/common';
import { CommonWorkOptions, workPreCheckMessage } from '.';
import { searchAnswerInWrappers } from './answerer';

export let globalControlPanel: HTMLElement | null = null;
let globalFloatingBar: HTMLElement | null = null;

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
			searchResultBox.innerHTML = `<span style="color:#ff7b72">搜索失败: ${e?.message || e}</span>`;
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

	// --- 整体布局 ---
	const bar = h(
		'div',
		{
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
			searchInput,
			searchBtn,
			closeResultBtn,
			searchResultBox
		]
	);

	globalFloatingBar = bar;
	document.body.appendChild(bar);
	return { bar, btn: pauseBtn };
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

		// 创建悬浮控制条
		let paused = false;
		const floatingCtrl = createFloatingBar(
			() => {
				paused = !paused;
				worker?.emit?.(paused ? 'stop' : 'continuate');
				controlBtn.value = paused ? '▶️继续' : '⏸️暂停';
			},
			() => paused
		);

		worker?.once('done', () => {
			running = false;
			globalControlPanel = null;
			controlBtn.disabled = true;
			floatingCtrl.btn.textContent = '✓ 完成';
			floatingCtrl.btn.style.background = '#4caf50';
			floatingCtrl.btn.onclick = null;
			setTimeout(() => floatingCtrl.bar.remove(), 5000);
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
	let stop = false;
	let stopMessage: MessageElement | undefined;
	const startBtn = $ui.button('▶️开始答题');
	const restartBtn = $ui.button('🔃重新答题');
	const controlBtn = $ui.button('⏸暂停');

	startBtn.onclick = () => {
		startBtn.remove();
		options.onStart();
	};
	restartBtn.onclick = () => {
		// 重新答题时，清除暂停提示
		stopMessage?.remove();
		options.onRestart();
	};
	controlBtn.onclick = () => {
		stop = !stop;
		const worker = options.workerProvider();
		worker?.emit?.(stop ? 'stop' : 'continuate');
		controlBtn.value = stop ? '▶️继续' : '⏸️暂停';
		if (stop) {
			stopMessage = $message.warn({ duration: 0, content: '暂停中...' });
		} else {
			stopMessage?.remove();
		}
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
