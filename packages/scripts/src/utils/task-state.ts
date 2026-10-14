import { $store, $const } from 'easy-us';

/**
 * 当前任务状态
 *
 * 脚本的各个部分（视频播放、章节测验、作业、考试、搜题、验证码等待……）把“正在做什么、做到哪了”
 * 统一上报到这里，窗口的收起圆点、标题栏、总览页、状态栏都只读取这一份数据。
 *
 * 状态保存在“标签页存储”里：同一个标签页内的所有 iframe 共享，不同标签页互不干扰。
 * 章节测验、视频运行在 iframe 中，窗口在顶层页面，二者通过这份存储通信。
 */

export type TaskKind = 'video' | 'audio' | 'document' | 'quiz' | 'homework' | 'exam' | 'other';
export type TaskStatus = 'idle' | 'running' | 'attention' | 'paused' | 'done' | 'error';
/** 正在等待外部结果：搜题 / AI 思考 / 需要人工处理（验证码、人脸识别） */
export type TaskBusy = 'search' | 'ai' | 'captcha';
export type QuestionMark = 'ok' | 'cur' | 'pending' | 'miss';

export interface TaskStep {
	id: string;
	kind: TaskKind;
	title: string;
	status: 'pending' | 'running' | 'done' | 'skipped' | 'error';
	note?: string;
}

export interface TaskState {
	kind: TaskKind;
	status: TaskStatus;
	busy?: TaskBusy;
	/** 任务名称：视频名、测验名…… */
	title: string;
	/** 平台名称，例如 超星学习通 */
	platform?: string;
	/** 0 ~ 1；null 表示无法确定进度 */
	progress: number | null;
	/** 已完成题数 / 总题数（视频类任务不使用） */
	current?: number;
	total?: number;
	remainingSeconds?: number;
	questions?: QuestionMark[];
	/** 本页所有任务点 */
	steps?: TaskStep[];
	/** 答案来源统计 */
	sources?: { cache: number; bank: number; ai: number };
	/** 当前任务是否支持“跳过” */
	canSkip?: boolean;
	/** 状态补充说明（错误原因、等待原因） */
	message?: string;
	startedAt?: number;
	updatedAt: number;
}

export const TASK_KIND_LABEL: Record<TaskKind, string> = {
	video: '视频',
	audio: '音频',
	document: '文档',
	quiz: '章节测验',
	homework: '作业',
	exam: '考试',
	other: '任务'
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
	idle: '待机',
	running: '运行中',
	attention: '需要处理',
	paused: '已暂停',
	done: '已完成',
	error: '出错'
};

const STATE_KEY = 'ncp.task-state';
const COMMAND_KEY = 'ncp.task-command';
/** 运行中的状态超过这个时间没有刷新，认为对应的页面已经离开 */
export const TASK_STALE_MS = 30 * 1000;
const FLUSH_INTERVAL = 500;
const HEARTBEAT_INTERVAL = 5 * 1000;

function createIdle(): TaskState {
	return { kind: 'other', status: 'idle', title: '', progress: null, updatedAt: 0 };
}

let local: TaskState = createIdle();
const listeners = new Set<(state: TaskState) => void>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let lastFlush = 0;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let syncInstalled = false;
/** 本页面（frame）是否是状态的产出方，只有产出方需要发送心跳 */
let owner = false;

function notify() {
	listeners.forEach((listener) => {
		try {
			listener(local);
		} catch (error) {
			console.warn('[task-state] 监听器出错', error);
		}
	});
}

async function flush() {
	flushTimer = undefined;
	lastFlush = Date.now();
	try {
		await $store.setTab(STATE_KEY, local);
	} catch {
		// 存储不可用时只在本页面内生效
	}
}

function scheduleFlush() {
	if (flushTimer) {
		return;
	}
	const wait = Math.max(0, FLUSH_INTERVAL - (Date.now() - lastFlush));
	flushTimer = setTimeout(flush, wait);
}

function ensureHeartbeat() {
	if (heartbeat) {
		return;
	}
	heartbeat = setInterval(() => {
		if (owner && (local.status === 'running' || local.status === 'attention' || local.status === 'paused')) {
			local = { ...local, updatedAt: Date.now() };
			scheduleFlush();
		}
	}, HEARTBEAT_INTERVAL);
}

/**
 * 监听其他 iframe 上报的状态。窗口所在的顶层页面和每个 iframe 都应当调用一次。
 * 重复调用是安全的。
 */
export function installTaskStateSync() {
	if (syncInstalled) {
		return;
	}
	syncInstalled = true;

	try {
		$store.getTab(STATE_KEY).then((value) => {
			const stored = value as TaskState | undefined;
			if (stored && stored.updatedAt > local.updatedAt) {
				local = stored;
				notify();
			}
		});
		$store.addTabChangeListener(STATE_KEY, (curr: TaskState | undefined) => {
			if (curr && curr.updatedAt >= local.updatedAt) {
				// 其他 frame 成为了新的产出方
				if (curr.updatedAt > local.updatedAt) {
					owner = false;
				}
				local = curr;
				notify();
			}
		});
	} catch {
		// 忽略：存储不可用
	}
}

export function getTaskState(): TaskState {
	return local;
}

/** 状态是否已经过期（运行中的页面已经离开） */
export function isTaskStale(state: TaskState = local) {
	return (
		(state.status === 'running' || state.status === 'attention') &&
		state.updatedAt > 0 &&
		Date.now() - state.updatedAt > TASK_STALE_MS
	);
}

/** 更新当前任务状态（合并更新），同一个 frame 内可以随意频繁调用 */
export function setTaskState(patch: Partial<TaskState>) {
	installTaskStateSync();
	owner = true;
	const now = Date.now();
	const startsNew = patch.kind !== undefined && patch.kind !== local.kind;
	local = {
		...(local.status === 'done' || local.status === 'idle' || startsNew
			? { ...createIdle(), platform: local.platform, steps: local.steps, sources: local.sources }
			: local),
		...patch,
		startedAt:
			patch.startedAt ?? (startsNew || local.status === 'idle' || local.status === 'done' ? now : local.startedAt),
		updatedAt: now
	};
	ensureHeartbeat();
	notify();
	scheduleFlush();
}

/** 任务结束：保留最后一次的信息，状态改为完成 */
export function finishTask(message?: string) {
	setTaskState({ status: 'done', progress: 1, busy: undefined, message, canSkip: false });
}

/** 清空任务状态（回到待机） */
export function clearTaskState() {
	owner = true;
	local = { ...createIdle(), updatedAt: Date.now() };
	notify();
	scheduleFlush();
}

export function onTaskStateChange(listener: (state: TaskState) => void) {
	installTaskStateSync();
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/* ------------------------------ 本页任务点列表 ------------------------------ */

/** 新增或更新一个任务点步骤 */
export function upsertTaskStep(step: Pick<TaskStep, 'id'> & Partial<TaskStep>) {
	const steps = [...(local.steps || [])];
	const index = steps.findIndex((item) => item.id === step.id);
	if (index === -1) {
		steps.push({ kind: 'other', title: '任务点', status: 'pending', ...step });
	} else {
		steps[index] = { ...steps[index], ...step };
	}
	// 只更新列表，不改变当前任务的状态
	const keep = { status: local.status, kind: local.kind, title: local.title, progress: local.progress };
	setTaskState({ steps, ...keep });
}

/** 开始新页面：清空上一个页面的任务点和统计 */
export function resetTaskSteps() {
	setTaskState({ steps: [], sources: { cache: 0, bank: 0, ai: 0 } });
}

/* ------------------------------ 搜题 / AI 忙碌 ------------------------------ */

const busyCounters: Record<'search' | 'ai' | 'captcha', number> = { search: 0, ai: 0, captcha: 0 };

function currentBusy(): TaskBusy | undefined {
	return busyCounters.captcha > 0
		? 'captcha'
		: busyCounters.ai > 0
		? 'ai'
		: busyCounters.search > 0
		? 'search'
		: undefined;
}

/**
 * 标记开始等待外部结果，返回一个结束函数。
 * 多个题目并发搜索时用计数处理，全部结束后才恢复。
 */
export function beginBusy(kind: TaskBusy, message?: string) {
	busyCounters[kind]++;
	const busy = currentBusy();
	setTaskState({
		busy,
		...(kind === 'captcha' ? { status: 'attention' as TaskStatus, message: message || '需要你手动处理' } : {})
	});
	let ended = false;
	return () => {
		if (ended) {
			return;
		}
		ended = true;
		busyCounters[kind] = Math.max(0, busyCounters[kind] - 1);
		const next = currentBusy();
		setTaskState({
			busy: next,
			...(kind === 'captcha' && busyCounters.captcha === 0 && local.status === 'attention'
				? { status: 'running' as TaskStatus, message: undefined }
				: {})
		});
	};
}

/* ------------------------------ 答题进度 ------------------------------ */

type ResultLike = {
	requested?: boolean;
	resolved?: boolean;
	result?: { finish?: boolean };
	ctx?: { searchInfos?: { results?: { extra_data?: unknown }[] }[] };
};

/**
 * 根据答题器的结果列表更新“题目进度、答案来源统计”。
 * kind 为当前任务类型，title 为任务名称。
 */
export function updateTaskFromResults(
	results: ResultLike[],
	options: { kind: TaskKind; title?: string; finished?: boolean }
) {
	const total = results.length;
	let resolved = 0;
	let currentIndex = -1;
	const sources = { cache: 0, bank: 0, ai: 0 };

	const questions: QuestionMark[] = results.map((result, index) => {
		if (result.resolved) {
			resolved++;
			if (result.result?.finish) {
				const infos = result.ctx?.searchInfos || [];
				const extras = infos.flatMap((info) => (info.results || []).map((r) => r.extra_data as any));
				if (extras.some((extra) => extra?.cache)) {
					sources.cache++;
				} else if (extras.some((extra) => extra?.ai)) {
					sources.ai++;
				} else {
					sources.bank++;
				}
				return 'ok';
			}
			return 'miss';
		}
		if (currentIndex === -1) {
			currentIndex = index;
		}
		return 'pending';
	});

	if (currentIndex !== -1 && !options.finished) {
		questions[currentIndex] = 'cur';
	}

	setTaskState({
		kind: options.kind,
		status: options.finished ? 'done' : 'running',
		...(options.title ? { title: options.title } : {}),
		total,
		current: resolved,
		progress: total ? resolved / total : null,
		questions,
		sources,
		canSkip: false
	});
}

/* ------------------------------ 视频进度 ------------------------------ */

/**
 * 跟踪音视频的播放进度并上报。返回取消跟踪的函数。
 */
export function trackMediaProgress(
	media: HTMLMediaElement,
	options: { kind?: 'video' | 'audio'; title?: string; platform?: string; canSkip?: boolean }
) {
	let lastReport = 0;
	const report = (force = false) => {
		const now = Date.now();
		if (!force && now - lastReport < 1000) {
			return;
		}
		lastReport = now;
		const duration = media.duration;
		const valid = Number.isFinite(duration) && duration > 0;
		setTaskState({
			kind: options.kind || 'video',
			...(options.title ? { title: options.title } : {}),
			...(options.platform ? { platform: options.platform } : {}),
			status: local.status === 'paused' || local.status === 'attention' ? local.status : 'running',
			progress: valid ? Math.min(1, media.currentTime / duration) : null,
			remainingSeconds: valid ? Math.max(0, Math.round(duration - media.currentTime)) : undefined,
			canSkip: options.canSkip ?? true
		});
	};
	const onTime = () => report();
	const onEnded = () => report(true);
	media.addEventListener('timeupdate', onTime);
	media.addEventListener('ended', onEnded);
	report(true);

	return () => {
		media.removeEventListener('timeupdate', onTime);
		media.removeEventListener('ended', onEnded);
	};
}

/* ------------------------------ 控制命令 ------------------------------ */

export type TaskCommand = 'pause' | 'resume' | 'skip';

/** 窗口（顶层页面）向正在运行任务的 iframe 发送控制命令 */
export function sendTaskCommand(command: TaskCommand) {
	return $store.setTab(COMMAND_KEY, { command, id: Math.random().toString(16).slice(2), time: Date.now() });
}

/**
 * 接收控制命令。能够执行命令的位置（视频播放、答题器）各自注册一次，返回取消函数。
 */
export function onTaskCommand(handler: (command: TaskCommand) => void) {
	let lastId = '';
	let listenerId: unknown;
	let cancelled = false;
	Promise.resolve(
		$store.addTabChangeListener(COMMAND_KEY, (curr: { command: TaskCommand; id: string; time: number }) => {
			if (cancelled || !curr || curr.id === lastId) {
				return;
			}
			// 忽略很久以前遗留的命令
			if (Date.now() - curr.time > 10 * 1000) {
				return;
			}
			lastId = curr.id;
			handler(curr.command);
		})
	).then((id) => {
		listenerId = id;
	});

	return () => {
		cancelled = true;
		try {
			$store.removeTabChangeListener(COMMAND_KEY, listenerId as number);
		} catch {
			// 忽略
		}
	};
}

/** 读取当前标签页的唯一 id（调试用） */
export function getTabId() {
	return $store.getTab($const.TAB_UID);
}

/* ------------------------------ 暂停与跳过 ------------------------------ */

let userPaused = false;

/**
 * 用户是否通过窗口按钮暂停了任务。
 * 播放器的“暂停后自动继续播放”逻辑需要先检查它，否则点了暂停也会被立刻恢复。
 */
export function isUserPaused() {
	return userPaused;
}

/**
 * 让一个音视频元素响应窗口上的 暂停 / 继续 / 跳过 按钮。返回取消函数。
 * onSkip 为空时表示当前任务不支持跳过。
 */
export function registerMediaControl(media: HTMLMediaElement, onSkip?: () => void) {
	userPaused = false;
	return onTaskCommand((command) => {
		if (command === 'pause') {
			userPaused = true;
			media.pause();
			setTaskState({ status: 'paused' });
		} else if (command === 'resume') {
			userPaused = false;
			media.play().catch(() => undefined);
			setTaskState({ status: 'running' });
		} else if (command === 'skip') {
			onSkip?.();
		}
	});
}

/** 窗口按钮：暂停 / 继续 */
export function toggleTaskPause() {
	return sendTaskCommand(local.status === 'paused' ? 'resume' : 'pause');
}

/* ------------------------------ 更新信息 ------------------------------ */

export interface UpdateInfo {
	status: 'latest' | 'new' | 'error';
	last: string;
	current: string;
	checkedAt: number;
}

let updateInfo: UpdateInfo | undefined;
const updateListeners = new Set<(info: UpdateInfo) => void>();

/** 更新模块检查完成后上报结果，状态栏据此显示“有新版本” */
export function setUpdateInfo(info: UpdateInfo) {
	updateInfo = info;
	updateListeners.forEach((listener) => listener(info));
}

export function getUpdateInfo() {
	return updateInfo;
}

export function onUpdateInfoChange(listener: (info: UpdateInfo) => void) {
	updateListeners.add(listener);
	return () => updateListeners.delete(listener);
}

/**
 * 平台脚本接入音视频进度与控制按钮的一站式入口：
 * 上报播放进度，并让窗口的 暂停 / 继续 / 跳过 按钮对这个播放器生效。返回停止函数。
 */
export function attachMediaToTask(
	media: HTMLMediaElement,
	options: { platform: string; title?: string; kind?: 'video' | 'audio'; onSkip?: () => void }
) {
	const stopTrack = trackMediaProgress(media, {
		kind: options.kind || 'video',
		title: options.title || document.title,
		platform: options.platform,
		canSkip: Boolean(options.onSkip)
	});
	const stopControl = registerMediaControl(media, options.onSkip);
	return () => {
		stopTrack();
		stopControl();
	};
}
