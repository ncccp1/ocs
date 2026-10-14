/* eslint-disable max-len */
import { $const, $store } from 'easy-us';
import { icon } from './icons';
import { isDryRun, toggleDryRun } from './debug';
import { getPanelLogs, PANEL_LOG_NAMESPACES } from './logger';
import {
	TASK_KIND_LABEL,
	TASK_STATUS_LABEL,
	TaskKind,
	TaskState,
	getTaskState,
	isTaskStale,
	onTaskStateChange,
	sendTaskCommand,
	toggleTaskPause
} from './task-state';

/**
 * 总览页：当前正在做什么、做到哪了、本页还有哪些任务点、答案从哪来、最近发生了什么。
 * 数据全部来自 task-state，页面本身不做任何业务判断。
 */

const KIND_ICON: Record<TaskKind, string> = {
	video: 'play',
	audio: 'headphones',
	document: 'file',
	quiz: 'pencil',
	homework: 'notebook',
	exam: 'clipboard',
	other: 'school'
};

function esc(text: unknown) {
	return String(text ?? '').replace(
		/[&<>"]/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)
	);
}

function fmt(total: number) {
	return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function goto(panelName: string) {
	$store.setTab($const.TAB_CURRENT_PANEL_NAME, panelName);
}

const LOG_TYPE_LABEL: Record<string, string> = {
	info: '信息',
	warn: '警告',
	error: '错误',
	debug: '调试',
	log: '日志'
};

function renderLogs() {
	const logs = getPanelLogs(PANEL_LOG_NAMESPACES.system).slice(-8).reverse();
	if (!logs.length) {
		return '<div class="ov-empty">暂无日志</div>';
	}
	return logs
		.map((log) => {
			const d = new Date(log.time);
			const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
			return `<div class="ov-log"><span class="t">${time}</span><span class="lv ${log.type}">${
				LOG_TYPE_LABEL[log.type] || log.type
			}</span><span class="c">${esc(log.content)}</span></div>`;
		})
		.join('');
}

function renderTaskCard(state: TaskState, stale: boolean) {
	const status = stale ? 'idle' : state.status;
	const dry = isDryRun();

	if (status === 'idle') {
		return `
			<div class="ov-card">
				<div class="ov-head"><span class="ov-chip" data-status="idle">${icon('moon', 14)}待机</span></div>
				<div class="ov-title">${stale ? '页面已离开或没有响应' : '当前没有进行中的任务'}</div>
				<div class="ov-sub">打开课程学习、作业或考试页面后，脚本会自动开始，这里会实时显示进度。</div>
				<div class="ov-actions">
					<button class="ncp-btn" data-go="通用-⚙️ 全局设置">${icon('sliders', 14)}<span>全局设置</span></button>
					<button class="ncp-btn" data-go="通用-🏠 使用教程">${icon('book', 14)}<span>使用教程</span></button>
					<button class="ncp-btn${dry ? ' on' : ''}" data-act="dry">${icon('flask', 14)}<span>试运行</span></button>
				</div>
			</div>`;
	}

	const percent = state.progress === null || state.progress === undefined ? null : Math.round(state.progress * 100);
	const isQuestionTask = state.kind === 'quiz' || state.kind === 'homework' || state.kind === 'exam';
	const busyChip =
		state.busy === 'ai'
			? `<span class="ov-chip" data-status="busy">${icon('sparkles', 13)}AI 思考中</span>`
			: state.busy === 'search'
			? `<span class="ov-chip" data-status="busy">${icon('search', 13)}搜题中</span>`
			: state.busy === 'captcha'
			? `<span class="ov-chip" data-status="attention">${icon('shield', 13)}等待你处理</span>`
			: '';

	const sub =
		state.message ||
		(isQuestionTask
			? `已处理 ${state.current ?? 0} / ${state.total ?? 0} 题`
			: state.remainingSeconds !== undefined
			? `剩余 ${fmt(state.remainingSeconds)}`
			: '');

	return `
		<div class="ov-card">
			<div class="ov-head">
				<span class="ov-chip" data-status="${status}">${icon(KIND_ICON[state.kind], 14)}${TASK_KIND_LABEL[state.kind]}</span>
				<span class="ov-chip soft" data-status="${status}">${TASK_STATUS_LABEL[status]}</span>
				${busyChip}
				<span class="ov-spacer"></span>
				${state.platform ? `<span class="ov-mute">${esc(state.platform)}</span>` : ''}
			</div>
			<div class="ov-title">${esc(state.title || TASK_KIND_LABEL[state.kind])}</div>
			<div class="ov-progress"><i style="width:${percent ?? 0}%"></i></div>
			<div class="ov-row"><span>${percent === null ? '进度未知' : percent + '%'}</span><span>${esc(sub)}</span></div>
			<div class="ov-actions">
				${
					status === 'running' || status === 'paused'
						? `<button class="ncp-btn primary" data-act="pause">${icon(
								status === 'paused' ? 'play' : 'pause',
								14
						  )}<span>${status === 'paused' ? '继续' : '暂停'}</span></button>`
						: ''
				}
				${
					state.canSkip && (status === 'running' || status === 'paused')
						? `<button class="ncp-btn" data-act="skip">${icon('skip', 14)}<span>跳过</span></button>`
						: ''
				}
				<button class="ncp-btn${dry ? ' on' : ''}" data-act="dry">${icon('flask', 14)}<span>试运行${
		dry ? '：开' : ''
	}</span></button>
			</div>
		</div>`;
}

function renderQuestions(state: TaskState) {
	if (!state.questions?.length) {
		return '';
	}
	const cells = state.questions
		.map((mark, index) => `<span class="ov-q ${mark}" title="第 ${index + 1} 题">${index + 1}</span>`)
		.join('');
	return `
		<div class="ov-card">
			<div class="ov-sec-title">题目进度</div>
			<div class="ov-qs">${cells}</div>
			<div class="ov-legend"><span class="ok">已答</span><span class="cur">当前</span><span class="pending">未答</span><span class="miss">未命中</span></div>
		</div>`;
}

function renderSteps(state: TaskState) {
	const steps = state.steps || [];
	if (!steps.length) {
		return '';
	}
	const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
	const rows = steps
		.map((step) => {
			const mark =
				step.status === 'done'
					? icon('check', 13)
					: step.status === 'running'
					? icon('loader', 13)
					: step.status === 'error'
					? icon('alert', 13)
					: step.status === 'skipped'
					? icon('minus', 13)
					: icon('clock', 13);
			const note =
				step.note ||
				{ done: '已完成', running: '进行中', pending: '等待', skipped: '已跳过', error: '出错' }[step.status];
			return `<div class="ov-step ${step.status}"><span class="m">${mark}</span><span class="k">${icon(
				KIND_ICON[step.kind],
				15
			)}</span><span class="n">${esc(step.title)}</span><span class="s">${esc(note)}</span></div>`;
		})
		.join('');
	return `
		<div class="ov-card">
			<div class="ov-sec-title">本页任务点 <span class="ov-mute">${done}/${steps.length}</span></div>
			${rows}
		</div>`;
}

function renderSources(state: TaskState) {
	const sources = state.sources;
	if (!sources || sources.cache + sources.bank + sources.ai === 0) {
		return '';
	}
	return `
		<div class="ov-card">
			<div class="ov-sec-title">答案来源</div>
			<div class="ov-chips">
				<span class="ov-chip" data-status="done">缓存命中 ${sources.cache}</span>
				<span class="ov-chip">题库 ${sources.bank}</span>
				<span class="ov-chip" data-status="busy">AI ${sources.ai}</span>
			</div>
		</div>`;
}

/**
 * 渲染总览页到面板中，面板被移除后自动停止刷新。
 */
export function renderOverview(panel: { body: HTMLElement }) {
	const root = document.createElement('div');
	root.className = 'ov-root';
	panel.body.replaceChildren(root);

	const draw = () => {
		const state = getTaskState();
		const stale = isTaskStale(state);
		const showDetail = !stale && state.status !== 'idle';
		root.innerHTML = `
			<div class="ov-grid">
				<div class="ov-col">
					${renderTaskCard(state, stale)}
					${showDetail ? renderQuestions(state) : ''}
					${showDetail ? renderSteps(state) : ''}
				</div>
				<div class="ov-col">
					${showDetail ? renderSources(state) : ''}
					<div class="ov-card">
						<div class="ov-sec-title">实时日志
							<button class="ov-link" data-go="后台-📄 日志输出">查看全部</button>
						</div>
						${renderLogs()}
					</div>
				</div>
			</div>`;
	};

	root.addEventListener('click', (event) => {
		const target = (event.target as HTMLElement).closest('[data-act],[data-go]') as HTMLElement | null;
		if (!target) {
			return;
		}
		const go = target.dataset.go;
		if (go) {
			goto(go);
			return;
		}
		const act = target.dataset.act;
		if (act === 'pause') {
			toggleTaskPause();
		} else if (act === 'skip') {
			sendTaskCommand('skip');
		} else if (act === 'dry') {
			toggleDryRun();
			draw();
		}
	});

	draw();
	const off = onTaskStateChange(draw);
	// 日志不属于任务状态，定时刷新；面板被切走（移除）后停止
	const timer = setInterval(() => {
		if (!root.isConnected) {
			clearInterval(timer);
			off();
			return;
		}
		draw();
	}, 2000);
}
