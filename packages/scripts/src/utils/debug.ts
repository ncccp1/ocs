import { $, $store } from 'easy-us';
import { createPanelLogger, PANEL_LOG_NAMESPACES, writePanelLog } from './logger';

/**
 * 调试模式
 *
 * - 总开关和“试运行”都在 后台 -> 开发者调试 里设置，默认关闭
 * - 调试日志写入 后台 -> 调试日志，可在开发者调试页面导出（连同页面元素快照）
 * - 关闭调试模式时，$debug 的所有方法都是空操作，不会产生任何额外开销
 */

const DEV_NAMESPACE = 'background.dev';

export const DEBUG_STORE_KEYS = {
	enabled: $.namespaceKey(DEV_NAMESPACE, 'debugEnabled'),
	dryRun: $.namespaceKey(DEV_NAMESPACE, 'dryRun')
};

function readBoolean(key: string) {
	try {
		const value = $store.get(key, false) as unknown;
		return value === true || value === 'true';
	} catch {
		return false;
	}
}

/** 是否开启了调试模式 */
export function isDebugEnabled() {
	return readBoolean(DEBUG_STORE_KEYS.enabled);
}

/**
 * 是否开启了试运行：照常搜题、答题、记录日志，
 * 但不会提交、不会保存、不会自动跳转章节，方便在真实页面上验证流程而不产生任何不可逆的后果。
 */
export function isDryRun() {
	return readBoolean(DEBUG_STORE_KEYS.dryRun);
}

function framePrefix() {
	try {
		return self === top ? '' : '[iframe] ';
	} catch {
		return '[iframe] ';
	}
}

const debugConsole = createPanelLogger(PANEL_LOG_NAMESPACES.debug, 'debug');

type DebugLevel = 'info' | 'warn' | 'error';

function emit(level: DebugLevel, module: string, message: string, detail?: unknown) {
	if (!isDebugEnabled()) {
		return;
	}
	const content = `${framePrefix()}[${module}] ${message}`;
	try {
		if (detail === undefined) {
			debugConsole[level](content);
		} else {
			debugConsole[level](content, detail);
		}
	} catch {
		// 日志写入失败不影响主流程
	}
	// 同时输出到浏览器控制台，方便直接用 F12 查看
	// eslint-disable-next-line no-console
	console.debug('[ncp-debug]', content, detail === undefined ? '' : detail);
}

export const $debug = {
	/** 记录一条调试信息，module 是模块名（如 cx.job），message 说明发生了什么 */
	log(module: string, message: string, detail?: unknown) {
		emit('info', module, message, detail);
	},
	/** 记录“脚本没有做某件事”以及原因，这类信息最有助于定位“卡住不动”的问题 */
	skip(module: string, message: string, detail?: unknown) {
		emit('warn', module, '跳过：' + message, detail);
	},
	warn(module: string, message: string, detail?: unknown) {
		emit('warn', module, message, detail);
	},
	error(module: string, message: string, detail?: unknown) {
		emit('error', module, message, detail);
	}
};

/** 切换试运行开关（窗口标题栏的“试运行”按钮使用） */
export function toggleDryRun() {
	const next = !isDryRun();
	$store.set(DEBUG_STORE_KEYS.dryRun, next);
	return next;
}

/**
 * 试运行拦截。
 * 在即将执行“提交 / 保存 / 跳转”这类不可逆操作之前调用：
 * 返回 true 表示当前处于试运行，调用方应当直接跳过这个操作。
 */
export function skipInDryRun(action: string, module = 'dry-run') {
	if (!isDryRun()) {
		return false;
	}
	const message = `试运行模式：已跳过「${action}」`;
	writePanelLog(PANEL_LOG_NAMESPACES.system, 'system', 'warn', message);
	$debug.skip(module, action);
	return true;
}
