import { $, $elements, $gm, $store } from 'easy-us';
import { getPanelLogs, PANEL_LOG_NAMESPACES } from './logger';

/**
 * 页面元素快照（临时导出页面结构，用于排查“卡住”“找不到元素”之类的问题）
 *
 * 为什么不直接 outerHTML：
 *  - 超星等页面是多层 iframe，章节内容在 iframe 里，必须每一层都导出；
 *  - 页面中有账号相关的参数（enc、token、uid 等），导出前必须脱敏；
 *  - 脚本自己的面板不应该出现在快照里。
 *
 * 工作方式：
 *  - 顶层页面把导出请求写入脚本存储（GM 存储在页面脚本里读不到，也能跨 iframe 共享）；
 *  - 每个 iframe 里的脚本监听到请求后，各自导出本层文档并写回存储；
 *  - 顶层页面等待片刻，汇总所有层的结果，下载为一个 JSON 文件。
 */

export type SnapshotMode = 'structure' | 'full';

export type FrameSnapshot = {
	/** 层级路径，顶层为空字符串，第一个 iframe 的第二个子 iframe 为 0/1 */
	path: string;
	url: string;
	title: string;
	mode: SnapshotMode;
	readyState: string;
	visibility: string;
	nodeCount: number;
	truncated: boolean;
	html: string;
	/** 各模块注册的额外信息（任务点、章节、配置等） */
	extras: Record<string, unknown>;
	error?: string;
};

const REQUEST_KEY = 'ncp.snapshot.request';
const RESPONSE_PREFIX = 'ncp.snapshot.response.';
const INSTANCE_ID = $.uuid();
/** 等待各层 iframe 返回结果的时间 */
const COLLECT_WAIT_MS = 2500;

type SnapshotRequest = {
	id: string;
	mode: SnapshotMode;
	requester: string;
	topUrl: string;
	topOrigin: string;
	time: number;
};

/* ------------------------------ 额外信息收集器 ------------------------------ */

const collectors = new Map<string, () => unknown>();

/**
 * 注册一个额外信息收集器：导出快照时，每一层 iframe 都会调用自己已注册的收集器。
 * 新增平台/功能时，把“排查问题需要知道的状态”注册进来即可。
 */
export function registerSnapshotCollector(name: string, collector: () => unknown) {
	collectors.set(name, collector);
}

function runCollectors() {
	const extras: Record<string, unknown> = {};
	collectors.forEach((collector, name) => {
		try {
			extras[name] = collector();
		} catch (error) {
			extras[name] = { error: String(error) };
		}
	});
	return extras;
}

/* --------------------------------- 脱敏 --------------------------------- */

/** 链接参数中包含这些名字的，值会被替换（只匹配个人身份/会话相关的参数，章节、课程 id 保留） */
const SENSITIVE_PARAM = new RegExp(
	'^(' +
		[
			...['enc', 'token', 'uid', 'puid', 'userid', 'user_id', 'cpi', 'openc', 'ticket', 'key', 'secret'],
			...['password', 'pwd', 'sign', 'signature', 'auth', 'authorization', 'session', 'sessionid'],
			...['jsessionid', 'code', 'access_token', 'refresh_token']
		].join('|') +
		')$',
	'i'
);
/** 存储项/隐藏输入框的名字中包含这些词的，整个值不导出 */
const SENSITIVE_NAME =
	/(api[-_]?key|apikey|token|password|passwd|secret|poolid|tkuid|\.pp$|userid|user_id|cookie|authorization|enc$)/i;

export function redactUrl(url: string) {
	if (!url) {
		return url;
	}
	try {
		const parsed = new URL(url, location.href);
		let changed = false;
		parsed.searchParams.forEach((_, key) => {
			if (SENSITIVE_PARAM.test(key)) {
				parsed.searchParams.set(key, '[redacted]');
				changed = true;
			}
		});
		return changed || /^https?:/i.test(url) ? parsed.toString().replace(/%5Bredacted%5D/g, '[redacted]') : url;
	} catch {
		return url.replace(/([?&](?:enc|token|uid|puid|userid|cpi|openc|ticket|key)=)[^&#]*/gi, '$1[redacted]');
	}
}

/* ------------------------------ 文档序列化 ------------------------------ */

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META']);
const VOID_TAGS = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'SOURCE', 'TRACK', 'WBR']);
/** 结构模式下保留的属性 */
const STRUCTURE_ATTRS = new Set([
	'id',
	'class',
	'name',
	'type',
	'role',
	'href',
	'src',
	'action',
	'for',
	'title',
	'alt',
	'placeholder',
	'onclick',
	'tabindex',
	'cardid',
	'jobid',
	'objectid',
	'mid',
	'data',
	'target',
	'disabled',
	'checked',
	'selected',
	'hidden'
]);

function cut(text: string, max: number) {
	return text.length > max ? text.slice(0, max) + `…(${text.length})` : text;
}

function escapeAttr(value: string) {
	return value.replace(/"/g, '&quot;').replace(/\n/g, ' ');
}

function serializeAttributes(el: Element, mode: SnapshotMode) {
	const parts: string[] = [];
	for (const attr of Array.from(el.attributes)) {
		const name = attr.name.toLowerCase();
		let value = attr.value;

		if (mode === 'structure') {
			const keep = STRUCTURE_ATTRS.has(name) || name.startsWith('data-') || name.startsWith('aria-');
			if (!keep) {
				if (name === 'style' && /display|visibility|opacity/i.test(value)) {
					value = cut(value, 80);
				} else {
					continue;
				}
			}
		}

		if (name === 'value') {
			// 输入框的值可能是个人信息，结构模式不导出内容
			continue;
		}
		if (SENSITIVE_NAME.test(name)) {
			value = '[redacted]';
		} else if (/^(href|src|action|data-src|data-url|data-href)$/.test(name) || /^https?:\/\//i.test(value)) {
			value = redactUrl(value);
		} else if (name === 'data') {
			// 超星任务点的 data 属性是 JSON，里面可能带有 enc 等字段
			value = value.replace(/("(?:enc|token|uid|puid|userid|cpi|openc)"\s*:\s*")[^"]*"/gi, '$1[redacted]"');
		}

		const max = name === 'onclick' ? 200 : name === 'data' ? 800 : mode === 'full' ? 2000 : 160;
		parts.push(` ${name}="${escapeAttr(cut(value, max))}"`);
	}
	return parts.join('');
}

function serializeDocument(doc: Document, mode: SnapshotMode) {
	const limit = mode === 'full' ? 40000 : 15000;
	const maxDepth = 90;
	const textMax = mode === 'full' ? 2000 : 40;
	const skipRoots = new Set<Node>();
	for (const el of [$elements.root, $elements.tooltipContainer]) {
		if (el) {
			skipRoots.add(el as Node);
		}
	}

	const out: string[] = [];
	let count = 0;
	let truncated = false;
	let iframeIndex = 0;

	const walk = (node: Node, depth: number) => {
		if (count >= limit) {
			truncated = true;
			return;
		}
		if (depth > maxDepth) {
			truncated = true;
			return;
		}
		const indent = '  '.repeat(Math.min(depth, 40));

		if (node.nodeType === Node.TEXT_NODE) {
			const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
			if (text) {
				out.push(indent + cut(text, textMax));
			}
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) {
			return;
		}

		const el = node as Element;
		if (skipRoots.has(el) || SKIP_TAGS.has(el.tagName)) {
			return;
		}
		count++;

		const tag = el.tagName.toLowerCase();
		let attrs = serializeAttributes(el, mode);

		// iframe 标注顺序号，便于和各层 iframe 的快照对应
		if (tag === 'iframe' || tag === 'frame') {
			attrs += ` data-ncp-frame="${iframeIndex++}"`;
		}
		// 输入框只导出内容长度
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
			const hidden = el instanceof HTMLInputElement && el.type === 'hidden';
			const name = el.name || el.id || '';
			if (hidden && !SENSITIVE_NAME.test(name)) {
				// 隐藏域通常保存的是章节 id、课程 id 等状态，保留
				attrs += ` data-ncp-value="${escapeAttr(cut(el.value, 120))}"`;
			} else {
				attrs += ` data-ncp-value-length="${el.value.length}"`;
			}
			if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
				attrs += ` data-ncp-checked="${el.checked}"`;
			}
		}
		if (el instanceof HTMLSelectElement) {
			attrs += ` data-ncp-selected="${el.selectedIndex}"`;
		}

		// SVG 不展开内部（路径数据很大）
		if (el instanceof SVGElement && tag !== 'svg') {
			return;
		}

		if (VOID_TAGS.has(el.tagName) || el.childNodes.length === 0 || tag === 'svg') {
			out.push(`${indent}<${tag}${attrs}${tag === 'svg' ? ' …' : ''}/>`);
			return;
		}

		out.push(`${indent}<${tag}${attrs}>`);
		for (const child of Array.from(el.childNodes)) {
			walk(child, depth + 1);
		}
		out.push(`${indent}</${tag}>`);
	};

	const root = doc.documentElement;
	if (root) {
		const title = doc.title ? cut(doc.title, 80) : '';
		out.push(`<!-- title: ${title.replace(/--/g, '- -')} -->`);
		const body = doc.body;
		if (body) {
			walk(body, 0);
		}
	}

	return { html: out.join('\n'), nodeCount: count, truncated };
}

/** 计算当前页面在 iframe 树中的路径，顶层为空字符串 */
function computeFramePath() {
	try {
		const parts: number[] = [];
		let current: Window = window;
		let guard = 0;
		while (current !== current.parent && guard++ < 20) {
			const parent: Window = current.parent;
			let index = -1;
			for (let i = 0; i < parent.frames.length; i++) {
				if (parent.frames[i] === current) {
					index = i;
					break;
				}
			}
			parts.unshift(index);
			current = parent;
		}
		return parts.map((n) => (n < 0 ? '?' : String(n))).join('/');
	} catch {
		return '?';
	}
}

function isTopWindow() {
	try {
		return self === top;
	} catch {
		return false;
	}
}

export function collectFrameSnapshot(mode: SnapshotMode): FrameSnapshot {
	try {
		const { html, nodeCount, truncated } = serializeDocument(document, mode);
		return {
			path: isTopWindow() ? '' : computeFramePath(),
			url: redactUrl(location.href),
			title: document.title,
			mode,
			readyState: document.readyState,
			visibility: document.visibilityState,
			nodeCount,
			truncated,
			html,
			extras: runCollectors()
		};
	} catch (error) {
		return {
			path: isTopWindow() ? '' : computeFramePath(),
			url: redactUrl(location.href),
			title: '',
			mode,
			readyState: document.readyState,
			visibility: document.visibilityState,
			nodeCount: 0,
			truncated: false,
			html: '',
			extras: {},
			error: String(error)
		};
	}
}

/* ------------------------------- 请求与响应 ------------------------------- */

function getTopOrigin() {
	try {
		return window.top ? window.top.location.origin : location.origin;
	} catch {
		const origins = (location as any).ancestorOrigins as DOMStringList | undefined;
		return origins && origins.length ? origins[origins.length - 1] : '';
	}
}

/** 判断请求是否来自同一个标签页（GM 存储是跨标签页共享的，其他标签页也会收到请求） */
function isRequestForThisTab(request: SnapshotRequest) {
	try {
		if (window.top) {
			return window.top.location.href === request.topUrl;
		}
	} catch {
		// 顶层是跨域页面，无法读取地址，退而比较来源
	}
	const origin = getTopOrigin();
	return Boolean(origin) && origin === request.topOrigin;
}

let responderInstalled = false;

/**
 * 在每一层页面（包括 iframe）里安装响应器，收到导出请求时返回本层的快照。
 * 应当在脚本启动时对所有页面调用一次。
 */
export function installSnapshotResponder() {
	if (responderInstalled) {
		return;
	}
	responderInstalled = true;

	let lastHandled = '';
	$store.addChangeListener(REQUEST_KEY, (curr: SnapshotRequest | undefined) => {
		if (!curr || typeof curr !== 'object' || !curr.id || curr.id === lastHandled) {
			return;
		}
		// 发起导出的页面自己直接收集，不通过监听器
		if (curr.requester === INSTANCE_ID) {
			return;
		}
		if (!isRequestForThisTab(curr)) {
			return;
		}
		lastHandled = curr.id;
		const snapshot = collectFrameSnapshot(curr.mode === 'full' ? 'full' : 'structure');
		$store.set(`${RESPONSE_PREFIX}${curr.id}.${INSTANCE_ID}`, snapshot);
	});
}

/* --------------------------------- 导出 --------------------------------- */

function redactSettings() {
	const result: Record<string, unknown> = {};
	let keys: string[] = [];
	try {
		keys = $store.list();
	} catch {
		return result;
	}

	for (const key of keys) {
		if (key.startsWith('_tab_change_') || key.startsWith('ncp.snapshot.')) {
			continue;
		}
		let value: unknown;
		try {
			value = $store.get(key);
		} catch {
			continue;
		}

		if (SENSITIVE_NAME.test(key)) {
			result[key] = '[redacted]';
		} else if (/\.(logs|searchLogs|list)$/.test(key)) {
			result[key] = Array.isArray(value) ? `[${value.length} items]` : '[omitted]';
		} else if (/localQuestionCaches$/.test(key)) {
			result[key] = Array.isArray(value) ? `[${value.length} caches]` : '[omitted]';
		} else if (/answererWrappers$/.test(key) && Array.isArray(value)) {
			result[key] = value.map((w: any) => ({ name: w?.name, url: redactUrl(String(w?.url || '')), method: w?.method }));
		} else if (typeof value === 'string') {
			result[key] = cut(value, 200);
		} else if (Array.isArray(value) && value.length > 30) {
			result[key] = `[${value.length} items]`;
		} else {
			result[key] = value;
		}
	}
	return result;
}

function tailLogs(namespace: string, count: number) {
	try {
		return getPanelLogs(namespace)
			.slice(-count)
			.map((log) => ({
				time: new Date(log.time).toISOString(),
				type: log.type,
				content: log.content,
				detail: log.detail
			}));
	} catch {
		return [];
	}
}

function download(filename: string, content: string) {
	const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.style.display = 'none';
	document.body.appendChild(a);
	a.click();
	setTimeout(() => {
		a.remove();
		URL.revokeObjectURL(url);
	}, 2000);
}

export type SnapshotBundle = {
	kind: 'ncp-page-snapshot';
	version: 1;
	createdAt: string;
	mode: SnapshotMode;
	script: { name?: string; version?: string; handler?: string };
	page: { url: string; title: string; userAgent: string; viewport: string };
	frames: FrameSnapshot[];
	settings: Record<string, unknown>;
	logs: { system: unknown[]; search: unknown[]; debug: unknown[] };
	notes: string[];
};

/**
 * 导出当前标签页的页面元素快照（需要在顶层页面调用）。
 * 返回导出的文件名和概要信息，便于界面提示。
 */
export async function exportPageSnapshot(mode: SnapshotMode = 'structure') {
	const id = $.uuid();
	const request: SnapshotRequest = {
		id,
		mode,
		requester: INSTANCE_ID,
		topUrl: location.href,
		topOrigin: location.origin,
		time: Date.now()
	};

	$store.set(REQUEST_KEY, request);
	const own = collectFrameSnapshot(mode);

	// 等待各层 iframe 写回结果
	await new Promise((resolve) => setTimeout(resolve, COLLECT_WAIT_MS));

	const prefix = `${RESPONSE_PREFIX}${id}.`;
	const frames: FrameSnapshot[] = [own];
	try {
		for (const key of $store.list()) {
			if (key.startsWith(prefix)) {
				const value = $store.get(key) as FrameSnapshot | undefined;
				if (value && typeof value === 'object') {
					frames.push(value);
				}
				$store.delete(key);
			}
		}
		$store.delete(REQUEST_KEY);
	} catch {
		// 清理失败不影响导出
	}

	frames.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));

	const infos = $gm.getInfos();
	const bundle: SnapshotBundle = {
		kind: 'ncp-page-snapshot',
		version: 1,
		createdAt: new Date().toISOString(),
		mode,
		script: {
			name: infos?.script?.name,
			version: infos?.script?.version,
			handler: infos?.scriptHandler
		},
		page: {
			url: redactUrl(location.href),
			title: document.title,
			userAgent: navigator.userAgent,
			viewport: `${window.innerWidth}x${window.innerHeight}`
		},
		frames,
		settings: redactSettings(),
		logs: {
			system: tailLogs(PANEL_LOG_NAMESPACES.system, 100),
			search: tailLogs(PANEL_LOG_NAMESPACES.search, 50),
			debug: tailLogs(PANEL_LOG_NAMESPACES.debug, 400)
		},
		notes: [
			mode === 'structure'
				? '结构模式：文本最多保留 40 个字符，输入框只记录内容长度。'
				: '完整模式：保留完整文本，可能包含姓名、学校等个人信息，发送前请自行检查。',
			'链接中的 enc / token / uid / puid / cpi 等参数已替换为 [redacted]。',
			'没有返回结果的 iframe 一般是跨域广告或脚本未运行的页面。'
		]
	};

	const host = (() => {
		try {
			return location.hostname.replace(/[^a-z0-9.-]/gi, '_');
		} catch {
			return 'page';
		}
	})();
	const time = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
	const filename = `ncp-snapshot-${mode}-${host}-${time}.json`;
	const json = JSON.stringify(bundle, null, 1);
	download(filename, json);

	return {
		filename,
		frameCount: frames.length,
		size: json.length,
		truncated: frames.some((f) => f.truncated)
	};
}

/** 导出调试日志（JSON 文件） */
export function exportDebugLogs() {
	const infos = $gm.getInfos();
	const content = JSON.stringify(
		{
			kind: 'ncp-debug-logs',
			createdAt: new Date().toISOString(),
			script: { name: infos?.script?.name, version: infos?.script?.version },
			page: redactUrl(location.href),
			logs: {
				system: tailLogs(PANEL_LOG_NAMESPACES.system, 200),
				search: tailLogs(PANEL_LOG_NAMESPACES.search, 200),
				debug: tailLogs(PANEL_LOG_NAMESPACES.debug, 400)
			}
		},
		null,
		1
	);
	const filename = `ncp-debug-logs-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.json`;
	download(filename, content);
	return { filename, size: content.length };
}
