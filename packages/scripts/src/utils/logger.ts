import { $, $store } from 'easy-us';

export type LogType = 'log' | 'info' | 'debug' | 'warn' | 'error';
export type LogCategory = 'system' | 'search';

export interface PanelLog {
	type: LogType;
	category: LogCategory;
	content: string;
	time: number;
	stack: string;
	detail?: string;
}

const MAX_LOGS = 200;

export const PANEL_LOG_NAMESPACES = {
	system: 'render.console',
	search: 'render.search-console'
} as const;

function getLogsStoreKey(namespace: string) {
	return $.namespaceKey(namespace, 'logs');
}

function getLogStack() {
	const stack = Error().stack || '';
	const stacks = stack
		.replace('Error', '')
		.match(/at (.*) \(.+:\/\/.+:(.+):(.+)\)/g)
		?.map((item) => {
			const match = item.match(/at (.*) \(.+:\/\/.+:(.+):(.+)\)/) || [];
			return [match[1], match[2], match[3]];
		});

	return JSON.stringify([stack.split('\n')[0], ...(stacks || [])]);
}

function stringifyLogValue(value: any) {
	if (typeof value === 'string') {
		return value;
	}

	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function getPanelLogs(namespace: string): PanelLog[] {
	return $store.get(getLogsStoreKey(namespace), []) || [];
}

export function clearPanelLogs(namespace: string) {
	$store.set(getLogsStoreKey(namespace), []);
}

export function writePanelLog(
	namespace: string,
	category: LogCategory,
	type: LogType,
	content: string,
	detail?: unknown
) {
	let logs = getPanelLogs(namespace);
	if (logs.length >= MAX_LOGS) {
		logs = logs.slice(-(MAX_LOGS - 1));
	}

	logs = logs.concat({
		type,
		category,
		content,
		time: Date.now(),
		stack: getLogStack(),
		detail: detail === undefined ? undefined : stringifyLogValue(detail)
	});

	$store.set(getLogsStoreKey(namespace), logs);
}

export function createPanelLogger(namespace: string, category: LogCategory): Record<LogType, (...msg: any[]) => void> {
	return new Proxy({} as Record<LogType, (...msg: any[]) => void>, {
		get(_, key) {
			return (...msg: any[]) => {
				const [content, detail] = msg;
				if (msg.length <= 1) {
					writePanelLog(namespace, category, key.toString() as LogType, stringifyLogValue(content));
					return;
				}

				if (msg.length === 2 && typeof content === 'string') {
					writePanelLog(namespace, category, key.toString() as LogType, content, detail);
					return;
				}

				writePanelLog(
					namespace,
					category,
					key.toString() as LogType,
					msg.map((item) => stringifyLogValue(item)).join(' '),
					detail
				);
			};
		}
	});
}

export const $searchConsole = createPanelLogger(PANEL_LOG_NAMESPACES.search, 'search');
