import { $, $const, $elements, $gm, $store, enableElementDraggable } from 'easy-us';
import type { Script } from 'easy-us';
import { CommonProject } from '../projects/common';
import { definedProjects } from '..';
import { RenderScript } from '../render';
import { icon } from './icons';
import { isDryRun, toggleDryRun } from './debug';
import {
	TASK_KIND_LABEL,
	TaskKind,
	TaskState,
	getTaskState,
	getUpdateInfo,
	installTaskStateSync,
	isTaskStale,
	onTaskStateChange,
	onUpdateInfoChange,
	sendTaskCommand,
	toggleTaskPause
} from './task-state';

/**
 * 工作台外壳
 *
 * easy-us 负责创建窗口和面板，这里在它创建的窗口基础上接管外观：
 *  - 标题栏：当前任务、暂停 / 跳过 / 试运行、最小化
 *  - 左侧导航：按功能分组的所有页面
 *  - 底部状态栏：题库、AI、提交阈值、跳转方式、用时、更新提示
 *  - 收起状态：44px 圆点，图标表示任务类型，圆环颜色表示状态，弧度表示进度，悬浮显示百分比
 *
 * 窗口原有的面板（课程学习、全局设置……）仍然渲染在中间的内容区，功能不受影响。
 */

/* ------------------------------ 视图模型 ------------------------------ */

const RING_COLOR = {
	run: '#3ddc84',
	busy: '#5ea8ff',
	warn: '#e8b339',
	pause: '#8b93a1',
	done: '#2fbf9b',
	err: '#f0605d',
	idle: '#5f6b7a'
};

const KIND_ICON: Record<TaskKind, string> = {
	video: 'play',
	audio: 'headphones',
	document: 'file',
	quiz: 'pencil',
	homework: 'notebook',
	exam: 'clipboard',
	other: 'school'
};

interface TaskView {
	status: TaskState['status'];
	/** 圆点中间的图标 */
	icon: string;
	/** 圆环颜色 */
	color: string;
	/** 0 ~ 100，无法确定时为 null */
	percent: number | null;
	/** 圆环是否显示为“进行中、进度未知”的旋转状态 */
	indeterminate: boolean;
	/** 简短标签：章节测验 · 3/8 */
	label: string;
	/** 悬浮提示的第二行：任务名称或补充说明 */
	detail: string;
	kind: TaskKind;
	title: string;
	canSkip: boolean;
}

function formatSeconds(total: number) {
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function buildView(raw: TaskState): TaskView {
	const stale = isTaskStale(raw);
	const state: TaskState = stale ? { ...raw, status: 'idle', busy: undefined } : raw;
	const percent = state.progress === null || state.progress === undefined ? null : Math.round(state.progress * 100);

	let iconName = KIND_ICON[state.kind];
	let color = RING_COLOR.run;
	let label = TASK_KIND_LABEL[state.kind];

	if (state.status === 'idle') {
		iconName = 'moon';
		color = RING_COLOR.idle;
		label = '待机';
	} else if (state.status === 'done') {
		iconName = 'check';
		color = RING_COLOR.done;
		label = '全部完成';
	} else if (state.status === 'error') {
		iconName = 'alert';
		color = RING_COLOR.err;
		label = '出错';
	} else if (state.status === 'attention' || state.busy === 'captcha') {
		iconName = 'shield';
		color = RING_COLOR.warn;
		label = '需要你处理';
	} else if (state.status === 'paused') {
		iconName = 'pause';
		color = RING_COLOR.pause;
		label = `已暂停 · ${TASK_KIND_LABEL[state.kind]}`;
	} else if (state.busy === 'ai') {
		iconName = 'sparkles';
		color = RING_COLOR.busy;
		label = `AI 思考 · ${TASK_KIND_LABEL[state.kind]}`;
	} else if (state.busy === 'search') {
		color = RING_COLOR.busy;
		label = `${TASK_KIND_LABEL[state.kind]} · 搜题中`;
	}

	const isQuestionTask = state.kind === 'quiz' || state.kind === 'homework' || state.kind === 'exam';
	if (state.total && isQuestionTask && state.status !== 'idle' && state.status !== 'done') {
		label += ` · ${state.current ?? 0}/${state.total}`;
	}

	let detail = state.title || '';
	if (state.status === 'attention' && state.message) {
		detail = state.message;
	} else if (state.status === 'error' && state.message) {
		detail = state.message;
	} else if (state.status === 'idle') {
		detail = stale ? '页面已离开或没有响应' : '没有进行中的任务';
	} else if (!isQuestionTask && state.remainingSeconds !== undefined && state.status === 'running') {
		detail = `剩余 ${formatSeconds(state.remainingSeconds)}${state.title ? ' · ' + state.title : ''}`;
	}

	return {
		status: state.status,
		icon: iconName,
		color,
		percent: state.status === 'done' ? 100 : percent,
		indeterminate: state.status === 'running' && percent === null,
		label,
		detail,
		kind: state.kind,
		title: state.title || '',
		canSkip: Boolean(state.canSkip) && (state.status === 'running' || state.status === 'paused')
	};
}

/* ------------------------------ 导航 ------------------------------ */

interface NavItem {
	id: string;
	label: string;
	icon: string;
	script: Script;
	projectName: string;
}

interface NavGroup {
	title: string;
	items: NavItem[];
}

const NAV_ICON: Record<string, string> = {
	'common.overview': 'dashboard',
	'common.guide': 'book',
	'common.settings': 'sliders',
	'common.work-results': 'search',
	'common.online-search': 'search',
	'common.apps': 'apps',
	'render.panel': 'expand',
	'render.console': 'terminal',
	'render.search-console': 'search',
	'render.debug-console': 'bug',
	'background.app': 'refresh',
	'background.update': 'download',
	'background.dev': 'bug'
};

/** 通用 / 后台项目里的脚本所属分组 */
const NAV_GROUP_OF_NAMESPACE: Record<string, string> = {
	'common.overview': '总览',
	'common.work-results': '工具',
	'common.online-search': '工具',
	'common.apps': '工具',
	'common.settings': '设置',
	'render.panel': '设置',
	'background.app': '设置',
	'render.console': '记录',
	'render.search-console': '记录',
	'render.debug-console': '记录',
	'background.update': '系统',
	'background.dev': '系统',
	'common.guide': '帮助'
};

const NAV_GROUP_ORDER = ['总览', '__platform__', '工具', '设置', '记录', '系统', '帮助'];

function stripEmoji(name: string) {
	return name.replace(/^[^一-龥A-Za-z0-9]+/, '').trim();
}

function navIconOf(script: Script, projectName: string) {
	if (script.namespace && NAV_ICON[script.namespace]) {
		return NAV_ICON[script.namespace];
	}
	if (projectName === '后台' && script.name.includes('请求')) {
		return 'link';
	}
	if (/作业|考试|答题/.test(script.name)) {
		return 'notebook';
	}
	if (/阅读/.test(script.name)) {
		return 'file';
	}
	if (/学习|课程/.test(script.name)) {
		return 'play';
	}
	if (/提示|教程/.test(script.name)) {
		return 'help';
	}
	return 'chevron';
}

async function collectNav(): Promise<NavGroup[]> {
	const urls = ((await $store.getTab($const.TAB_URLS)) as string[] | undefined) || [location.href];
	const groups = new Map<string, NavItem[]>();
	const push = (title: string, item: NavItem) => {
		const list = groups.get(title) || [];
		list.push(item);
		groups.set(title, list);
	};

	for (const project of definedProjects()) {
		const scripts = ($ as any).getMatchedScripts([project], urls).filter((s: Script) => !s.hideInPanel) as Script[];
		for (const script of scripts) {
			const item: NavItem = {
				id: `${project.name}-${script.name}`,
				label: stripEmoji(script.name),
				icon: navIconOf(script, project.name),
				script,
				projectName: project.name
			};

			const isPlatform = project.name !== '通用' && project.name !== '后台';
			if (isPlatform) {
				push(project.name, item);
			} else {
				push(
					(script.namespace && NAV_GROUP_OF_NAMESPACE[script.namespace]) || (project.name === '后台' ? '记录' : '工具'),
					item
				);
			}
		}
	}

	const platformTitles = Array.from(groups.keys()).filter((title) => !NAV_GROUP_ORDER.includes(title));
	const ordered: NavGroup[] = [];
	for (const title of NAV_GROUP_ORDER) {
		if (title === '__platform__') {
			for (const platform of platformTitles) {
				ordered.push({ title: platform, items: groups.get(platform) || [] });
			}
		} else if (groups.has(title)) {
			ordered.push({ title, items: groups.get(title) || [] });
		}
	}
	return ordered;
}

/* ------------------------------ 状态栏文本 ------------------------------ */

function describeUpload(value: unknown) {
	if (value === 'save') return '答完自动保存';
	if (value === 'nomove') return '答完不提交';
	if (value === 'force') return '答完强制提交';
	if (value === '100' || value === 100) return '全部命中才提交';
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? `${n}% 自动提交` : '';
}

function describeJump(mode: unknown) {
	if (mode === 'next') return '完成后跳转下一节';
	if (mode === 'job') return '跳转未完成任务点';
	if (mode === 'manually') return '完成后手动跳转';
	return '';
}

function statusBarItems() {
	const items: { icon: string; text: string; warn?: boolean }[] = [];
	try {
		const settings = CommonProject.scripts.settings.cfg;
		const wrappers = (settings.answererWrappers || []) as { name?: string }[];
		const metoReady =
			Boolean(settings.metoTkUid) && Boolean(settings.metoPoolId || (settings.metoUserId && settings.metoPp));
		if (wrappers.length) {
			const names = wrappers.map((w) => w.name || '').join(' ');
			items.push({
				icon: 'book',
				text: names.includes('MeTo') && !metoReady ? 'MeTo 未配置' : `题库 ${wrappers.length} 个`,
				warn: names.includes('MeTo') && !metoReady
			});
		} else {
			items.push({ icon: 'book', text: '未配置题库', warn: !(settings.aiEnable && settings.aiApiKey) });
		}
		const aiOn = settings.aiEnable === true || (settings.aiEnable as unknown) === 'true';
		items.push({
			icon: 'sparkles',
			text: aiOn ? (settings.aiApiKey ? 'AI 已开启' : 'AI 缺少 Key') : 'AI 未开启',
			warn: aiOn && !settings.aiApiKey
		});
		const upload = describeUpload(settings.upload);
		if (upload) items.push({ icon: 'check', text: upload });
	} catch {
		// 设置尚未就绪时不显示
	}
	try {
		const cx = (definedProjects().find((p) => p.name === '超星学习通')?.scripts as any)?.study?.cfg;
		const jump = describeJump(cx?.mode);
		if (jump) items.push({ icon: 'skip', text: jump });
	} catch {
		// 忽略
	}
	return items;
}

/* ------------------------------ 构建窗口外壳 ------------------------------ */

let installed = false;

function el(tag: string, className?: string, html?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (html !== undefined) node.innerHTML = html;
	return node;
}

/**
 * 安装工作台外壳。只在顶层页面执行；窗口由 easy-us 在页面可交互后创建，所以这里轮询等待。
 */
export function installWorkbench() {
	if (installed) {
		return;
	}
	try {
		if (self !== top) {
			return;
		}
	} catch {
		return;
	}
	installed = true;
	installTaskStateSync();

	let tries = 0;
	const timer = setInterval(() => {
		const root = $elements.root as ShadowRoot | undefined;
		const container = root?.querySelector('container-element') as HTMLElement | null | undefined;
		if (container && container.querySelector('header-element')) {
			clearInterval(timer);
			try {
				build(container);
			} catch (error) {
				console.error('[workbench] 构建窗口外壳失败，保留原有界面', error);
			}
		} else if (++tries > 150) {
			clearInterval(timer);
		}
	}, 200);
}

function build(container: HTMLElement) {
	const infos = $gm.getInfos();
	const version = infos?.script?.version || '';
	const sessionStart = Date.now();

	/* ---- 标题栏 ---- */
	const titlebar = el('div', 'ncp-titlebar');
	const logo = el('span', 'ncp-logo', icon('school', 18));
	const name = el('span', 'ncp-name', '南城派');
	const ver = el('span', 'ncp-ver', version);
	const chip = el('span', 'ncp-chip');
	const taskTitle = el('span', 'ncp-task-title');
	const spacer = el('span', 'ncp-spacer');
	const btnPause = el('button', 'ncp-btn primary');
	const btnSkip = el('button', 'ncp-btn', `${icon('skip', 14)}<span>跳过</span>`);
	const btnDry = el('button', 'ncp-btn', `${icon('flask', 14)}<span>试运行</span>`);
	const btnMin = el('button', 'ncp-btn icon-only', icon('minus', 16));
	btnMin.title = '收起为小圆点';
	btnSkip.title = '跳过当前任务点（仅视频、音频等支持）';
	btnDry.title = '试运行：照常答题，但不提交、不保存、不跳转';
	titlebar.append(logo, name, ver, chip, taskTitle, spacer, btnPause, btnSkip, btnDry, btnMin);

	/* ---- 导航 ---- */
	const nav = el('div', 'ncp-nav');

	/* ---- 状态栏 ---- */
	const statusbar = el('div', 'ncp-statusbar');
	const statusItems = el('div', 'ncp-status-items');
	const statusRight = el('div', 'ncp-status-right');
	statusbar.append(statusItems, statusRight);

	/* ---- 收起的圆点 ---- */
	const dot = el('div', 'ncp-dot');
	const circ = 2 * Math.PI * 18;

	// 悬停时从圆点“长出来”的胶囊：百分比、任务说明、进度条和两个按钮
	const capsule = el('div', 'ncp-capsule');
	const capBody = el('div', 'ncp-cap-body');
	const capPct = el('b', 'ncp-cap-pct');
	const capText = el('div', 'ncp-cap-text');
	const capPause = el('button', 'ncp-cap-btn', icon('pause', 12));
	capPause.title = '暂停 / 继续';
	capBody.title = '点击展开窗口';
	capBody.append(capPct, capText, capPause);
	const capBar = el('i', 'ncp-cap-bar');
	capsule.append(capBody, capBar);
	dot.append(capsule);

	const ring = el(
		'div',
		'ncp-dot-face',
		`<svg class="ncp-dot-ring" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">` +
			`<circle cx="22" cy="22" r="21" fill="#1f2937"/>` +
			`<circle cx="22" cy="22" r="18" fill="none" stroke="#3b4350" stroke-width="3"/>` +
			`<circle class="ncp-dot-arc" cx="22" cy="22" r="18" fill="none" stroke="#3ddc84" stroke-width="3" ` +
			`stroke-linecap="round" stroke-dasharray="0 ${circ.toFixed(1)}" transform="rotate(-90 22 22)"/></svg>` +
			`<span class="ncp-dot-icon"></span><span class="ncp-badge tl"></span><span class="ncp-badge br"></span>`
	);
	dot.append(ring);
	const dotArc = dot.querySelector('.ncp-dot-arc') as SVGCircleElement;
	const dotIcon = dot.querySelector('.ncp-dot-icon') as HTMLElement;
	const badgeTl = dot.querySelector('.ncp-badge.tl') as HTMLElement;
	const badgeBr = dot.querySelector('.ncp-badge.br') as HTMLElement;

	container.append(titlebar, nav, statusbar, dot);

	/* ---- 位置：保证窗口 / 圆点始终完整显示在屏幕内 ---- */
	const MARGIN = 8;
	const clampIntoViewport = () => {
		const rect = container.getBoundingClientRect();
		if (!rect.width || !rect.height) {
			return;
		}
		const maxLeft = Math.max(MARGIN, window.innerWidth - rect.width - MARGIN);
		const maxTop = Math.max(MARGIN, window.innerHeight - rect.height - MARGIN);
		const left = Math.min(Math.max(MARGIN, rect.left), maxLeft);
		const top = Math.min(Math.max(MARGIN, rect.top), maxTop);
		if (Math.abs(left - rect.left) > 0.5 || Math.abs(top - rect.top) > 0.5) {
			container.style.left = left + 'px';
			container.style.top = top + 'px';
		}
	};

	const savePosition = () => {
		clampIntoViewport();
		RenderScript.cfg.x = container.offsetLeft;
		RenderScript.cfg.y = container.offsetTop;
	};
	enableElementDraggable(titlebar, container, savePosition);
	enableElementDraggable(dot, container, savePosition);

	// 圆点：拖动移动位置，几乎没有位移的点击视为“展开”
	let downX = 0;
	let downY = 0;
	dot.addEventListener('mousedown', (e) => {
		downX = e.clientX;
		downY = e.clientY;
	});
	dot.addEventListener('click', (e) => {
		if ((e.target as HTMLElement | null)?.closest?.('.ncp-cap-btn')) {
			return;
		}
		const moved = Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY);
		if (moved < 4) {
			CommonProject.scripts.render.methods.normal();
		}
	});

	// 悬停提示向空间更大的一侧展开，并且宽度不会超出屏幕
	const CAPSULE_MAX = 232;
	dot.addEventListener('mouseenter', () => {
		const rect = container.getBoundingClientRect();
		const spaceRight = window.innerWidth - rect.right - MARGIN;
		const spaceLeft = rect.left - MARGIN;
		const toLeft = spaceLeft > spaceRight;
		const room = (toLeft ? spaceLeft : spaceRight) + 44;
		dot.classList.toggle('flip', toLeft);
		dot.style.setProperty('--ncp-cap-w', Math.max(150, Math.min(CAPSULE_MAX, room)) + 'px');
	});

	/*
	 * 收起 / 展开时，让圆点出现在“收起”按钮所在的位置（窗口右上角），展开时再回到原来的位置。
	 * 这样点一下收起，圆点就在手边，不会跑到屏幕左上角。
	 */
	type Mode = 'normal' | 'minimize' | 'hidden';
	const modeOf = (): Mode =>
		container.classList.contains('minimize')
			? 'minimize'
			: container.classList.contains('hidden')
			? 'hidden'
			: 'normal';
	let mode: Mode = modeOf();
	let lastWidth = 820;
	// “收起”按钮中心相对窗口右上角的偏移
	let offX = 28;
	let offY = 23;
	const measureNormal = () => {
		if (modeOf() !== 'normal') {
			return;
		}
		const c = container.getBoundingClientRect();
		if (c.width) {
			lastWidth = c.width;
		}
		const r = btnMin.getBoundingClientRect();
		if (r.width && c.width) {
			offX = c.right - (r.left + r.width / 2);
			offY = r.top + r.height / 2 - c.top;
		}
	};

	let applyingPosition = false;
	const onModeChange = () => {
		const next = modeOf();
		if (next === mode || applyingPosition) {
			return;
		}
		const prev = mode;
		mode = next;
		applyingPosition = true;
		try {
			const left = container.offsetLeft;
			const top = container.offsetTop;
			if (prev === 'normal' && next === 'minimize') {
				// 圆点中心 = 收起按钮中心
				container.style.left = left + lastWidth - offX - 22 + 'px';
				container.style.top = top + offY - 22 + 'px';
			} else if (prev === 'minimize' && next === 'normal') {
				container.style.left = left + 22 + offX - lastWidth + 'px';
				container.style.top = top + 22 - offY + 'px';
			}
		} finally {
			applyingPosition = false;
		}
		requestAnimationFrame(() => {
			clampIntoViewport();
			RenderScript.cfg.x = container.offsetLeft;
			RenderScript.cfg.y = container.offsetTop;
			measureNormal();
		});
	};
	new MutationObserver(onModeChange).observe(container, { attributes: true, attributeFilter: ['class'] });

	// 窗口尺寸变化（首次渲染、浏览器缩放、调整浏览器大小）后也要保证完整可见
	const onLayoutChange = () => {
		requestAnimationFrame(() => {
			clampIntoViewport();
			measureNormal();
		});
	};
	if (typeof ResizeObserver !== 'undefined') {
		new ResizeObserver(onLayoutChange).observe(container);
	}
	window.addEventListener('resize', onLayoutChange);
	onLayoutChange();

	/* ---- 按钮 ---- */
	const minimize = () => CommonProject.scripts.render.methods.minimize();
	btnMin.onclick = minimize;
	btnPause.onclick = () => {
		toggleTaskPause();
	};
	capPause.onclick = (e) => {
		e.stopPropagation();
		toggleTaskPause();
	};
	btnSkip.onclick = () => {
		sendTaskCommand('skip');
	};
	btnDry.onclick = () => {
		toggleDryRun();
		renderAll();
	};

	/* ---- 导航渲染 ---- */
	let currentPanel = '';
	const renderNav = async () => {
		const groups = await collectNav();
		currentPanel = ((await $store.getTab($const.TAB_CURRENT_PANEL_NAME)) as string | undefined) || '';
		nav.replaceChildren();
		for (const group of groups) {
			if (group.title !== '总览') {
				nav.append(el('div', 'ncp-nav-group', group.title));
			}
			for (const item of group.items) {
				const active = item.id === currentPanel || item.script.namespace === currentPanel;
				const node = el(
					'div',
					'ncp-nav-item' + (active ? ' active' : ''),
					`${icon(item.icon, 16)}<span>${item.label}</span>`
				);
				node.title = item.label;
				node.onclick = () => {
					$store.setTab($const.TAB_CURRENT_PANEL_NAME, item.id);
				};
				nav.append(node);
			}
		}
	};

	// 窗口在切换面板时会重建原有的头部，借此刷新导航的选中状态
	const header = container.querySelector('header-element');
	if (header) {
		let pending = false;
		new MutationObserver(() => {
			if (pending) return;
			pending = true;
			setTimeout(() => {
				pending = false;
				renderNav();
			}, 30);
		}).observe(header, { childList: true });
	}

	/* ---- 状态渲染 ---- */
	let view = buildView(getTaskState());

	const renderTask = () => {
		view = buildView(getTaskState());
		const dry = isDryRun();

		// 圆点
		dotIcon.innerHTML = icon(view.icon, 20);
		dotArc.setAttribute('stroke', view.color);
		dot.classList.toggle('indeterminate', view.indeterminate);
		const fraction = view.percent === null ? (view.indeterminate ? 0.25 : 1) : view.percent / 100;
		const full =
			view.status === 'idle' ||
			view.status === 'paused' ||
			view.status === 'attention' ||
			view.status === 'error' ||
			view.status === 'done';
		dotArc.setAttribute(
			'stroke-dasharray',
			`${((full && view.percent === null ? 1 : fraction) * circ).toFixed(1)} ${circ.toFixed(1)}`
		);
		badgeTl.textContent = dry ? '试' : '';
		badgeTl.style.display = dry ? 'block' : 'none';
		const isExam = view.kind === 'exam' && view.status !== 'idle' && view.status !== 'done';
		badgeBr.textContent = isExam ? '考' : '';
		badgeBr.style.display = isExam ? 'block' : 'none';

		// 悬停胶囊：百分比 + 任务说明 + 进度条
		capPct.textContent = view.percent === null ? '--' : `${view.percent}%`;
		capText.innerHTML = `<span class="l1">${escapeHtml(view.label)}</span><span class="l2">${escapeHtml(
			view.detail
		)}</span>`;
		capBar.style.width = `${view.percent ?? 0}%`;
		capBar.style.background = view.color;
		capPause.innerHTML = icon(getTaskState().status === 'paused' ? 'play' : 'pause', 12);
		capPause.style.display = view.status === 'running' || view.status === 'paused' ? 'inline-flex' : 'none';

		// 标题栏
		chip.dataset.status = view.status;
		chip.innerHTML = `${icon(view.icon, 14)}<span>${view.label}${
			view.percent !== null && view.status !== 'idle' ? ` · ${view.percent}%` : ''
		}</span>`;
		taskTitle.textContent = view.title && view.status !== 'idle' ? view.title : '';
		const paused = getTaskState().status === 'paused' && view.status === 'paused';
		btnPause.innerHTML = `${icon(paused ? 'play' : 'pause', 14)}<span>${paused ? '继续' : '暂停'}</span>`;
		btnPause.style.display = view.status === 'running' || view.status === 'paused' ? 'inline-flex' : 'none';
		btnSkip.style.display = view.canSkip ? 'inline-flex' : 'none';
		btnDry.classList.toggle('on', dry);
		btnDry.title = dry
			? '试运行已开启：不会提交、保存或跳转（点击关闭）'
			: '试运行：照常答题，但不提交、不保存、不跳转';
	};

	const renderStatusBar = () => {
		statusItems.replaceChildren();
		for (const item of statusBarItems()) {
			const node = el(
				'span',
				'ncp-status-item' + (item.warn ? ' warn' : ''),
				`${icon(item.icon, 13)}<span>${item.text}</span>`
			);
			statusItems.append(node);
		}

		statusRight.replaceChildren();
		const update = getUpdateInfo();
		if (update?.status === 'new') {
			const node = el('span', 'ncp-status-item update', `${icon('download', 13)}<span>新版本 ${update.last}</span>`);
			node.onclick = () => {
				$store.setTab($const.TAB_CURRENT_PANEL_NAME, '后台-📥 更新模块');
			};
			statusRight.append(node);
		}
		const state = getTaskState();
		const startedAt = state.startedAt && state.status !== 'idle' ? state.startedAt : sessionStart;
		statusRight.append(
			el(
				'span',
				'ncp-status-item',
				`${icon('clock', 13)}<span>已用时 ${formatSeconds(Math.floor((Date.now() - startedAt) / 1000))}</span>`
			)
		);
	};

	const renderAll = () => {
		renderTask();
		renderStatusBar();
	};

	onTaskStateChange(renderTask);
	onUpdateInfoChange(renderStatusBar);
	setInterval(() => {
		// 用时、过期判断需要定时刷新；窗口收起时只更新圆点
		renderTask();
		if (container.classList.contains('normal')) {
			renderStatusBar();
		}
	}, 1000);
	RenderScript.onConfigChange('fontsize', () => applyFont(container));
	applyFont(container);

	// 内容区：统一各个面板的标题和设置项说明
	const body = container.querySelector('.body') as HTMLElement | null;
	if (body) {
		let enhancePending = false;
		const scheduleEnhance = () => {
			if (enhancePending) return;
			enhancePending = true;
			setTimeout(() => {
				enhancePending = false;
				enhancePanel(body);
			}, 30);
		};
		new MutationObserver(scheduleEnhance).observe(body, { childList: true, subtree: true });
		scheduleEnhance();
	}

	renderNav();
	renderAll();
}

/**
 * 统一各个面板的外观：
 *  - 面板标题去掉名称前面的 emoji（导航里已经有图标）
 *  - 设置项的提示文字（原本只有鼠标悬浮才能看到）直接显示在名称下面，不用到处悬浮找说明
 * 只改显示，不改任何设置项的行为；重复执行是安全的。
 */
function enhancePanel(body: HTMLElement) {
	body.querySelectorAll<HTMLElement>('script-panel-element > .separator').forEach((title) => {
		if (title.dataset.ncp) return;
		title.dataset.ncp = '1';
		title.textContent = stripEmoji(title.textContent || '');
	});

	body.querySelectorAll<HTMLElement>('config-element').forEach((cfg) => {
		if (cfg.dataset.ncpDesc) return;
		cfg.dataset.ncpDesc = '1';
		const provider = cfg.querySelector<HTMLElement>(
			'.config-wrapper input, .config-wrapper textarea, .config-wrapper select'
		);
		const label = cfg.querySelector('label');
		const desc = (provider?.getAttribute('data-title') || '').replace(/\s*\n\s*/g, ' ').trim();
		if (label && desc) {
			const node = document.createElement('div');
			node.className = 'cfg-desc';
			node.textContent = desc;
			label.append(node);
		}
	});
}

function applyFont(container: HTMLElement) {
	container.style.setProperty(
		'font-family',
		'-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
		'important'
	);
}

function escapeHtml(text: string) {
	return String(text).replace(
		/[&<>"]/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)
	);
}
