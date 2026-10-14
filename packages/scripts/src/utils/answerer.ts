import {
	AnswererWrapper,
	AnswerWrapperHandlerConfig,
	Result,
	SearchInformation,
	defaultAnswerWrapperHandler
} from '@ocsjs/core';
import { $, $message, $store } from 'easy-us';
import md5 from 'md5';
import { $searchConsole } from './logger';
import { $debug } from './debug';
import { isAnswerUsableForOptions, normalizeText, textSimilarity } from './option-match';

export type SearchScene = 'auto' | 'manual-single' | 'manual-batch';

export type SearchEnv = {
	title?: string;
	options?: string;
	type?: string;
	/** 题目来源场景：视频播放过程中弹出的题目（AI 看不到视频内容，提示词会有所不同） */
	scenario?: 'video-quiz';
	/** 视频内题目所属的视频/任务点名称，作为 AI 的上下文 */
	videoName?: string;
	[x: string]: any;
};

export type QuestionSearchResult = {
	question: string;
	infos: SearchInformation[];
};

export type MetoAuthConfig = {
	server: string;
	tkUid: string;
	poolId: string;
	pp: string;
	userId: string;
};

/**
 * MeTo 认证信息必须由用户自己填写（通用 -> 全局设置），脚本不再内置任何默认账号。
 * 获取方法见 通用 -> 全局设置 里的“MeTo 认证获取教程”，或仓库中的 MeTo题库API文档.md。
 */
export const DEFAULT_METO_AUTH_CONFIG: MetoAuthConfig = {
	server: 'https://m.metst.cn',
	tkUid: '',
	poolId: '',
	pp: '',
	userId: ''
};

const METO_DEFAULT_SERVERS = ['https://m.metst.cn', 'https://m.metost.com'];
const METO_MAX_RETRY_COUNT = 2;
/** MeTo 单次请求的超时时间（毫秒），超时后会按重试逻辑换服务器重试 */
const METO_REQUEST_TIMEOUT = 30 * 1000;

const COMMON_SETTINGS_NAMESPACE = 'common.settings';

const METO_STORE_KEYS = {
	server: $.namespaceKey(COMMON_SETTINGS_NAMESPACE, 'metoServer'),
	tkUid: $.namespaceKey(COMMON_SETTINGS_NAMESPACE, 'metoTkUid'),
	poolId: $.namespaceKey(COMMON_SETTINGS_NAMESPACE, 'metoPoolId'),
	pp: $.namespaceKey(COMMON_SETTINGS_NAMESPACE, 'metoPp'),
	userId: $.namespaceKey(COMMON_SETTINGS_NAMESPACE, 'metoUserId')
};

type MetoRequestResponse = {
	url: string;
	status: number;
	requestBody: Record<string, any>;
	json?: any;
	text: string;
};

function normalizeMetoServer(server: string) {
	return (server || DEFAULT_METO_AUTH_CONFIG.server).trim().replace(/\/+$/, '');
}

function stringifyError(error: unknown) {
	if (error instanceof Error) {
		return error.message;
	}

	return typeof error === 'string' ? error : JSON.stringify(error);
}

/** 题干规范化：与题库缓存、搜题可信度判断共用同一套规则（option-match 的 normalizeText），避免各处判断不一致 */
function normalizeQuestion(text: string) {
	return normalizeText(String(text || '').replace(/&nbsp;|&#160;/gi, ''));
}

function getMetoServerCandidates(server: string) {
	const normalizedServer = normalizeMetoServer(server);
	const candidates = [normalizedServer];

	if (METO_DEFAULT_SERVERS.includes(normalizedServer)) {
		candidates.push(...METO_DEFAULT_SERVERS.filter((item) => item !== normalizedServer));
	}

	return Array.from(new Set(candidates));
}

function shouldRetryMetoResponse(response: MetoRequestResponse) {
	return (
		response.status === 0 ||
		response.status === 408 ||
		response.status === 409 ||
		response.status === 425 ||
		response.status === 429 ||
		(response.status >= 500 && response.status <= 599) ||
		(response.status >= 520 && response.status <= 530) ||
		(response.status === 200 && !response.text && !response.json)
	);
}

function getErrorMessage(response?: MetoRequestResponse) {
	const resultMessage = response?.json?.results?.find((item: any) => item?.message)?.message;
	return resultMessage || response?.json?.message || response?.json?.data || response?.text || '题库请求失败';
}

function parseAnswer(answer: any) {
	if (typeof answer === 'string') {
		try {
			const parsed = JSON.parse(answer);
			return Array.isArray(parsed) ? parsed.join('#') : String(parsed ?? '');
		} catch {
			return answer;
		}
	}

	if (Array.isArray(answer)) {
		return answer.join('#');
	}

	return String(answer ?? '');
}

function toUuid(hash: string) {
	return (
		hash.slice(0, 8) +
		'-' +
		hash.slice(8, 12) +
		'-' +
		hash.slice(12, 16) +
		'-' +
		hash.slice(16, 20) +
		'-' +
		hash.slice(20, 32)
	);
}

function createEmptySearchInfo(wrapper: AnswererWrapper, error: string, response?: any, data?: any): SearchInformation {
	return {
		name: wrapper.name,
		homepage: wrapper.homepage,
		url: wrapper.url,
		results: [],
		error,
		response,
		data
	};
}

function toSearchInfo(wrapper: AnswererWrapper, results: Result[], response?: any, data?: any): SearchInformation {
	return {
		name: wrapper.name,
		homepage: wrapper.homepage,
		url: wrapper.url,
		results,
		response,
		data
	};
}

function getMetoAuthConfig() {
	const server = normalizeMetoServer($store.get(METO_STORE_KEYS.server, DEFAULT_METO_AUTH_CONFIG.server));
	const tkUid = String($store.get(METO_STORE_KEYS.tkUid, DEFAULT_METO_AUTH_CONFIG.tkUid) || '').trim();
	const poolId = String($store.get(METO_STORE_KEYS.poolId, DEFAULT_METO_AUTH_CONFIG.poolId) || '').trim();
	const pp = String($store.get(METO_STORE_KEYS.pp, DEFAULT_METO_AUTH_CONFIG.pp) || '').trim();
	const userId = String($store.get(METO_STORE_KEYS.userId, DEFAULT_METO_AUTH_CONFIG.userId) || '').trim();

	return { server, tkUid, poolId, pp, userId };
}

export function calculateMetoPoolId(userId: string, pp: string) {
	const hash = md5(md5(userId) + pp);
	return toUuid(hash);
}

export function getResolvedMetoAuthConfig() {
	const config = getMetoAuthConfig();
	const resolvedPoolId =
		config.poolId || (config.userId && config.pp ? calculateMetoPoolId(config.userId, config.pp) : '');

	return {
		...config,
		poolId: resolvedPoolId
	};
}

export function createMetoAnswererWrapper() {
	const config = getResolvedMetoAuthConfig();
	return {
		name: 'MeTo题库',
		url: `${config.server}/tiku/api/v1/queryProblems`,
		homepage: config.server,
		method: 'post',
		type: 'GM_xmlhttpRequest',
		contentType: 'json',
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
		data: {
			poolId: config.poolId,
			userId: config.tkUid,
			token: '__OCS_METO_DYNAMIC_TOKEN__',
			querry: '__OCS_METO_DYNAMIC_QUERY__'
		},
		handler: 'return () => undefined;',
		__meto: true
	} as AnswererWrapper;
}

export function isMetoWrapper(wrapper: AnswererWrapper) {
	const maybeWrapper = wrapper as AnswererWrapper & { __meto?: boolean };
	return (
		maybeWrapper.__meto === true ||
		wrapper.name === 'MeTo题库' ||
		/tiku\/api\/v1\/queryProblems$/i.test(wrapper.url || '')
	);
}

function getMetoToken() {
	const timeErrorRate = parseInt(localStorage.getItem('time_error_rate') || '0');
	const chars = '0123456789abcdef';
	let timePart = (Math.floor((Date.now() - timeErrorRate) / 1000) % 10000).toString();
	let hex = '';

	while (timePart.length < 4) {
		timePart = '0' + timePart;
	}

	for (let index = 0; index < 32; index++) {
		hex += chars[Math.floor(Math.random() * chars.length)];
	}

	return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + timePart + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
}

function parseResponseText(text: string) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function trySyncMetoTime(response: MetoRequestResponse) {
	const raw = response.json?.data;
	const matchedTime = typeof raw === 'string' ? raw.match(/(\d{10,13})/) : null;
	if ((response.status === 400 || response.status === 401) && matchedTime) {
		const serverTime = Number(matchedTime[1]);
		const timeOffset = Date.now() - (serverTime > 1000000000000 ? serverTime : serverTime * 1000);
		localStorage.setItem('time_error_rate', String(timeOffset));
		$searchConsole.info(`MeTo 时间校准成功，offset=${timeOffset}ms`, response.json);
		return true;
	}

	return false;
}

async function postJson(
	url: string,
	body: Record<string, any>,
	extraHeaders: Record<string, string> = {},
	timeout = 0
) {
	const headers = {
		'Content-Type': 'application/json; charset=utf-8',
		Accept: 'application/json',
		...extraHeaders
	};
	const gmRequest = globalThis.GM_xmlhttpRequest;
	if (typeof gmRequest !== 'undefined') {
		return new Promise<MetoRequestResponse>((resolve, reject) => {
			gmRequest({
				url,
				method: 'POST',
				headers,
				data: JSON.stringify(body),
				...(timeout ? { timeout } : {}),
				onload: (response) => {
					resolve({
						url,
						status: response.status,
						requestBody: body,
						text: response.responseText || '',
						json: parseResponseText(response.responseText || '')
					});
				},
				onerror: (error) => reject(error),
				ontimeout: () => reject(new Error('请求超时'))
			});
		});
	}

	const response = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(body)
	});

	const text = await response.text();
	return {
		url,
		status: response.status,
		requestBody: body,
		text,
		json: parseResponseText(text)
	};
}

/**
 * 解析 SSE（text/event-stream）格式的 chat/completions 流式响应，
 * 合并成与非流式响应相同的结构，下游代码无需关心是否为流式。
 */
function parseChatStream(text: string) {
	let content = '';
	let reasoning = '';
	let finishReason: string | undefined;
	let usage: unknown;
	let error: unknown;
	let sawEvent = false;

	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (!line.startsWith('data:')) {
			continue;
		}
		const data = line.slice(5).trim();
		if (!data || data === '[DONE]') {
			continue;
		}
		const json = parseResponseText(data);
		if (!json || typeof json !== 'object') {
			continue;
		}
		sawEvent = true;
		if (json.error) {
			error = json.error;
			continue;
		}
		const choice = json.choices?.[0];
		const delta = choice?.delta;
		if (typeof delta?.content === 'string') {
			content += delta.content;
		}
		if (typeof delta?.reasoning_content === 'string') {
			reasoning += delta.reasoning_content;
		}
		if (choice?.finish_reason) {
			finishReason = choice.finish_reason;
		}
		if (json.usage) {
			usage = json.usage;
		}
	}

	return { sawEvent, content, reasoning, finishReason, usage, error };
}

export function buildChatResponse(
	url: string,
	requestBody: Record<string, any>,
	status: number,
	text: string
): MetoRequestResponse {
	const plain = { url, status, requestBody, text, json: parseResponseText(text.trim()) };
	if (status < 200 || status >= 300) {
		return plain;
	}

	const stream = parseChatStream(text);
	// 服务端没有按流式返回（直接返回了完整 JSON），按普通响应处理
	if (!stream.sawEvent) {
		return plain;
	}
	if (stream.error) {
		return { url, status: 502, requestBody, text, json: { error: stream.error } };
	}

	return {
		url,
		status,
		requestBody,
		text: stream.content,
		json: {
			choices: [
				{
					message: { content: stream.content, reasoning_content: stream.reasoning },
					finish_reason: stream.finishReason
				}
			],
			usage: stream.usage
		}
	};
}

/**
 * 以流式（SSE）方式请求 chat/completions。
 *
 * 为什么用流式：AI 开启深度思考后可能思考几分钟，一次性等待完整响应只能设置一个很长的固定超时，
 * 连接真的卡死时也要傻等。流式传输时每收到一点数据都代表“还活着”，因此只需要：
 *  - idleMs：超过这么久完全没有数据，认为卡死（只在收到过数据之后才生效，兼容不支持流式回调的脚本管理器）；
 *  - totalMs：整个请求允许的最长时间。
 */
export async function postChatStream(
	url: string,
	body: Record<string, any>,
	extraHeaders: Record<string, string>,
	limits: { idleMs: number; totalMs: number }
): Promise<MetoRequestResponse> {
	const requestBody = { ...body, stream: true };
	const headers = {
		'Content-Type': 'application/json; charset=utf-8',
		Accept: 'text/event-stream',
		...extraHeaders
	};
	const startedAt = Date.now();

	const gmRequest = globalThis.GM_xmlhttpRequest;
	if (typeof gmRequest !== 'undefined') {
		return new Promise<MetoRequestResponse>((resolve, reject) => {
			let finished = false;
			let lastActivity = Date.now();
			let sawProgress = false;

			const touch = () => {
				sawProgress = true;
				lastActivity = Date.now();
			};
			const finish = (action: () => void) => {
				if (finished) {
					return;
				}
				finished = true;
				clearInterval(watchdog);
				action();
			};
			const abort = () => {
				try {
					(handle as { abort?: () => void } | undefined)?.abort?.();
				} catch {
					// 取消失败时请求会自行结束
				}
			};

			const watchdog = setInterval(() => {
				const now = Date.now();
				if (now - startedAt > limits.totalMs) {
					finish(() => {
						abort();
						reject(new Error(`AI 答题超过最长等待时间（${Math.round(limits.totalMs / 1000)} 秒）`));
					});
				} else if (sawProgress && now - lastActivity > limits.idleMs) {
					finish(() => {
						abort();
						reject(new Error(`AI 超过 ${Math.round(limits.idleMs / 1000)} 秒没有返回任何内容`));
					});
				}
			}, 2000);

			const handle = gmRequest({
				url,
				method: 'POST',
				headers,
				data: JSON.stringify(requestBody),
				onprogress: touch,
				onreadystatechange: touch,
				onload: (response: any) =>
					finish(() => resolve(buildChatResponse(url, body, response.status, response.responseText || ''))),
				onerror: (error: unknown) => finish(() => reject(error)),
				ontimeout: () => finish(() => reject(new Error('请求超时'))),
				onabort: () => finish(() => reject(new Error('请求已取消')))
			} as any) as any;
		});
	}

	// 非脚本管理器环境（例如本地调试页面）：使用 fetch 读取流
	const controller = new AbortController();
	let timedOut: string | undefined;
	let lastActivity = Date.now();
	const watchdog = setInterval(() => {
		const now = Date.now();
		if (now - startedAt > limits.totalMs) {
			timedOut = `AI 答题超过最长等待时间（${Math.round(limits.totalMs / 1000)} 秒）`;
			controller.abort();
		} else if (now - lastActivity > limits.idleMs) {
			timedOut = `AI 超过 ${Math.round(limits.idleMs / 1000)} 秒没有返回任何内容`;
			controller.abort();
		}
	}, 2000);

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(requestBody),
			signal: controller.signal
		});
		let text = '';
		if (response.body && typeof response.body.getReader === 'function') {
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				lastActivity = Date.now();
				text += decoder.decode(value, { stream: true });
			}
		} else {
			text = await response.text();
		}
		return buildChatResponse(url, body, response.status, text);
	} catch (error) {
		throw timedOut ? new Error(timedOut) : error;
	} finally {
		clearInterval(watchdog);
	}
}

async function requestMeto(
	path: string,
	payload: Record<string, any>,
	scene: SearchScene,
	question: string
): Promise<MetoRequestResponse> {
	const auth = getResolvedMetoAuthConfig();
	if (!auth.tkUid) {
		throw new Error('MeTo 认证配置缺少 tk_uid，请前往 通用-全局设置 填写（点击“MeTo 认证获取教程”查看获取方法）。');
	}
	if (!auth.poolId) {
		throw new Error(
			'MeTo 认证配置缺少 poolId，请前往 通用-全局设置 填写，或者填写 user_id + pp 自动计算（点击“MeTo 认证获取教程”查看获取方法）。'
		);
	}

	const servers = getMetoServerCandidates(auth.server);
	let lastResponse: MetoRequestResponse | undefined;
	let lastError: unknown;

	for (let serverIndex = 0; serverIndex < servers.length; serverIndex++) {
		let timeSynced = false;
		for (let retryCount = 0; retryCount <= METO_MAX_RETRY_COUNT; retryCount++) {
			const url = `${servers[serverIndex]}${path}`;
			const requestBody = {
				poolId: auth.poolId,
				token: getMetoToken(),
				userId: auth.tkUid,
				...payload
			};

			$searchConsole.info(`[${scene}] ${question || '未命名问题'} -> ${path}`, {
				url,
				requestBody: {
					...requestBody,
					token: '[hidden]'
				}
			});

			try {
				const response = await postJson(url, requestBody, {}, METO_REQUEST_TIMEOUT);
				lastResponse = response;

				$searchConsole.debug(`[${scene}] ${path} 响应状态 ${response.status}`, {
					url,
					status: response.status,
					response: response.json || response.text
				});

				if (!timeSynced && trySyncMetoTime(response)) {
					timeSynced = true;
					retryCount--;
					continue;
				}

				if (shouldRetryMetoResponse(response)) {
					const nextServer = retryCount >= METO_MAX_RETRY_COUNT ? servers[serverIndex + 1] : servers[serverIndex];
					if (nextServer) {
						$searchConsole.warn(`MeTo 请求异常，准备重试`, {
							path,
							question,
							status: response.status,
							currentUrl: url,
							nextUrl: `${nextServer}${path}`,
							retryCount: retryCount + 1
						});
						await $.sleep(400 * (retryCount + 1));
						continue;
					}
				}

				return response;
			} catch (error) {
				lastError = error;
				const nextServer = retryCount >= METO_MAX_RETRY_COUNT ? servers[serverIndex + 1] : servers[serverIndex];
				if (nextServer) {
					$searchConsole.warn(`MeTo 请求抛出异常，准备重试`, {
						path,
						question,
						currentUrl: url,
						nextUrl: `${nextServer}${path}`,
						retryCount: retryCount + 1,
						error: stringifyError(error)
					});
					await $.sleep(400 * (retryCount + 1));
					continue;
				}
			}
		}
	}

	if (lastResponse) {
		return lastResponse;
	}

	throw lastError || new Error('MeTo 请求失败');
}

async function fetchMetoRealAnswer(problemId: number, scene: SearchScene, question: string) {
	const response = await requestMeto('/tiku/api/v1/queryProblemAnswer', { problemId }, scene, question);
	if (
		response.status < 200 ||
		response.status >= 300 ||
		response.json?.status !== 'ok' ||
		!response.json?.results?.[0]
	) {
		throw new Error(getErrorMessage(response));
	}

	const data = response.json.results[0];
	return {
		answer: parseAnswer(data.answer),
		userAnswer: data.userAnswer,
		createBy: data.createBy,
		verifyStatus: data.verifyStatus
	};
}

function toMetoResult(item: any): Result {
	return {
		question: item.text || '',
		answer: parseAnswer(item.answer),
		extra_data: {
			hideAnswer: Boolean(item.hideAnswer),
			problemId: item.problemId,
			type: item.type,
			createBy: item.createBy
		}
	};
}

async function fillMetoHiddenAnswers(results: Result[], scene: SearchScene, question: string) {
	for (const result of results) {
		const extraData = (result.extra_data || {}) as Record<string, any>;
		if (extraData.hideAnswer && extraData.problemId) {
			try {
				const answer = await fetchMetoRealAnswer(Number(extraData.problemId), scene, question);
				result.answer = answer.answer;
				result.extra_data = {
					...extraData,
					hideAnswer: false,
					userAnswer: answer.userAnswer,
					createBy: answer.createBy,
					verifyStatus: answer.verifyStatus,
					realAnswer: true
				};
			} catch (error) {
				$searchConsole.warn(`MeTo 获取真实答案失败: ${problemIdText(extraData.problemId)}`, {
					question,
					error: stringifyError(error)
				});
			}
		}
	}
}

function problemIdText(problemId: any) {
	return typeof problemId === 'number' || typeof problemId === 'string'
		? `problemId=${problemId}`
		: 'problemId=unknown';
}

function pickBestMetoResults(question: string, results: Result[]) {
	const normalizedQuestion = normalizeQuestion(question);
	const exactMatches = results.filter((result) => normalizeQuestion(result.question) === normalizedQuestion);
	return exactMatches.length ? exactMatches : results;
}

async function searchMetoQuestion(wrapper: AnswererWrapper, env: SearchEnv, scene: SearchScene) {
	const title = String(env.title || '').trim();
	if (!title) {
		return createEmptySearchInfo(wrapper, '题目不能为空');
	}

	try {
		const query =
			title.length < 6
				? { operator: '==', argument1: 'problemText', argument2: title }
				: { operator: 'contains', argument1: 'problemText', argument2: title };
		const response = await requestMeto('/tiku/api/v1/queryProblems', { querry: query }, scene, title);

		if (response.status < 200 || response.status >= 300 || response.json?.status !== 'ok') {
			return createEmptySearchInfo(wrapper, getErrorMessage(response), response.json, response.requestBody);
		}

		let results = ((response.json?.results || []) as any[]).map(toMetoResult);
		const filteredResults = pickBestMetoResults(title, results);
		if (filteredResults.length !== results.length) {
			$searchConsole.info(`MeTo 单题结果已收敛到精确题干`, {
				question: title,
				before: results.length,
				after: filteredResults.length
			});
		}
		results = filteredResults;
		await fillMetoHiddenAnswers(results, scene, title);

		$searchConsole.info(`MeTo 搜题完成，命中 ${results.length} 条`, {
			scene,
			question: title,
			results: results.map((item) => ({
				question: item.question,
				answer: item.answer,
				extra_data: item.extra_data
			}))
		});

		return toSearchInfo(wrapper, results, response.json, response.requestBody);
	} catch (error) {
		$searchConsole.error(`MeTo 搜题失败: ${title}`, { scene, error: stringifyError(error) });
		return createEmptySearchInfo(wrapper, stringifyError(error));
	}
}

async function searchMetoQuestions(wrapper: AnswererWrapper, questions: string[], scene: SearchScene) {
	const trimmedQuestions = questions.map((item) => item.trim()).filter(Boolean);
	const emptyResults = trimmedQuestions.map((question) => ({
		question,
		infos: [createEmptySearchInfo(wrapper, '暂无结果')]
	}));

	if (trimmedQuestions.length === 0) {
		return emptyResults;
	}

	if (trimmedQuestions.length === 1) {
		return [
			{
				question: trimmedQuestions[0],
				infos: [await searchMetoQuestion(wrapper, { title: trimmedQuestions[0] }, scene)]
			}
		];
	}

	try {
		const response = await requestMeto(
			'/tiku/api/v1/queryProblems',
			{
				querry: {
					operator: 'mulit',
					argument1: '1',
					argument2: '2',
					problems: trimmedQuestions.map((question) => ({
						operator: '==',
						argument1: 'problemText',
						argument2: question
					}))
				}
			},
			scene,
			`批量搜题(${trimmedQuestions.length})`
		);

		if (response.status < 200 || response.status >= 300 || response.json?.status !== 'ok') {
			const errorMessage = getErrorMessage(response);
			return trimmedQuestions.map((question) => ({
				question,
				infos: [createEmptySearchInfo(wrapper, errorMessage, response.json, response.requestBody)]
			}));
		}

		const grouped = new Map<string, Result[]>();
		for (const question of trimmedQuestions) {
			grouped.set(question, []);
		}

		for (const item of response.json?.results || []) {
			const result = toMetoResult(item);
			const matchedQuestion =
				trimmedQuestions.find((question) => normalizeQuestion(question) === normalizeQuestion(result.question)) ||
				result.question;

			if (!grouped.has(matchedQuestion)) {
				grouped.set(matchedQuestion, []);
			}
			grouped.get(matchedQuestion)?.push(result);
		}

		for (const [question, results] of grouped.entries()) {
			await fillMetoHiddenAnswers(results, scene, question);
		}

		return trimmedQuestions.map((question) => ({
			question,
			infos: [toSearchInfo(wrapper, grouped.get(question) || [], response.json, response.requestBody)]
		}));
	} catch (error) {
		const errorMessage = stringifyError(error);
		$searchConsole.error(`MeTo 批量搜题失败(${trimmedQuestions.length}题)`, {
			scene,
			error: errorMessage,
			questions: trimmedQuestions
		});
		return trimmedQuestions.map((question) => ({
			question,
			infos: [createEmptySearchInfo(wrapper, errorMessage)]
		}));
	}
}

async function searchGenericWrapper(wrapper: AnswererWrapper, env: SearchEnv, scene: SearchScene) {
	const question = String(env.title || '').trim();
	$searchConsole.info(`[${scene}] ${wrapper.name} 开始搜题`, {
		question,
		env: {
			...env,
			title: question
		}
	});

	const infos = await defaultAnswerWrapperHandler([wrapper], env);
	const info = infos[0] || createEmptySearchInfo(wrapper, '题库未返回任何结果');

	$searchConsole.info(`[${scene}] ${wrapper.name} 搜题结束，命中 ${info.results.length} 条`, {
		question,
		error: info.error,
		results: info.results
	});

	return info;
}

/**
 * AI 兜底搜题（OpenAI 兼容的 chat/completions 接口，默认 DeepSeek）
 * 仅当所有题库都没有搜到结果时才会调用。
 */
export const DEFAULT_AI_CONFIG = {
	baseUrl: 'https://api.deepseek.com',
	model: 'deepseek-flash'
};

const AI_STORE_KEYS = {
	enable: $.namespaceKey(COMMON_SETTINGS_NAMESPACE, 'aiEnable'),
	baseUrl: $.namespaceKey(COMMON_SETTINGS_NAMESPACE, 'aiBaseUrl'),
	apiKey: $.namespaceKey(COMMON_SETTINGS_NAMESPACE, 'aiApiKey'),
	model: $.namespaceKey(COMMON_SETTINGS_NAMESPACE, 'aiModel'),
	extraBody: $.namespaceKey(COMMON_SETTINGS_NAMESPACE, 'aiExtraBody'),
	useImages: $.namespaceKey(COMMON_SETTINGS_NAMESPACE, 'aiUseImages'),
	thinking: $.namespaceKey(COMMON_SETTINGS_NAMESPACE, 'aiThinking'),
	webSearch: $.namespaceKey(COMMON_SETTINGS_NAMESPACE, 'aiWebSearch'),
	maxWait: $.namespaceKey(COMMON_SETTINGS_NAMESPACE, 'aiMaxWait')
};

/** AI 单道题默认最长等待时间（秒），含思考、联网搜索和重试，可在 通用 -> 全局设置 中调整 */
export const DEFAULT_AI_MAX_WAIT_SECONDS = 600;
/** 流式传输时，超过这个时间没有收到任何数据，认为连接已经卡死（毫秒） */
const AI_IDLE_TIMEOUT = 120 * 1000;
/** 剩余时间低于这个值时，不再发起新的可选请求（联网搜索、重新作答），避免超过总时限 */
const AI_MIN_REMAINING_FOR_OPTIONAL = 20 * 1000;
const AI_SYSTEM_PROMPT = [
	'你是严谨的题库答题助手。根据给出的题型、题目和选项作答，只输出一个 JSON 对象，不要输出任何其他内容。',
	'JSON 格式：{"answer": "答案", "option": "", "reason": "一句话理由", "confidence": "high", "search_query": "", "insufficient": false}',
	'规则：',
	'1. 单选题/多选题：answer 为所选选项的完整文字内容（与选项文字一致，不要带 A. B. 之类的字母前缀，也不要只写字母）；多选题的多个选项用 # 连接。',
	'2. 判断题：answer 只能是 对 或 错。',
	'3. 填空题：有多个空时按顺序用 # 连接，每个空只写答案本身。',
	'4. 简答题等其他题型：answer 为简明扼要的答案。',
	'5. 完全无法确定时，answer 返回空字符串，不要瞎猜。',
	'6. confidence：有把握为 high；不确定、需要联网查证资料时为 low，并在 search_query 中给出一个适合联网搜索的简短关键词（不要包含选项）。',
	'7. 单选题/多选题/判断题：option 和 answer 必须同时返回，不能只返回其中一个：option 为所选选项的字母（如 B，多选如 AC），answer 为对应选项的完整文字内容；选项是图片时，answer 简要描述所选选项图片的内容；其他题型 option 留空。',
	'8. insufficient 固定为 false。',
	'9. 如果用户消息中提供了“联网搜索结果”，请结合搜索结果作答，但要自行甄别，搜索结果可能不准确。'
].join('\n');

/** 视频内题目：AI 看不到视频，题目可能与视频内容强相关，此时标记信息不足，但仍需给出最可能的答案 */
const AI_VIDEO_QUIZ_SYSTEM_PROMPT = [
	'你是严谨的答题助手。下面的题目是学生观看教学视频过程中弹出的随堂题，你看不到视频内容，只能依据题目、选项和视频名称作答。只输出一个 JSON 对象，不要输出任何其他内容。',
	'JSON 格式：{"answer": "答案", "option": "", "reason": "一句话理由", "insufficient": false}',
	'规则：',
	'1. 单选题/多选题：answer 为所选选项的完整文字内容（与选项文字一致，不要带 A. B. 之类的字母前缀，也不要只写字母）；多选题的多个选项用 # 连接。',
	'2. 判断题：answer 只能是 对 或 错。',
	'3. 填空题：有多个空时按顺序用 # 连接，每个空只写答案本身。',
	'4. 如果题目靠通用知识就能作答，insufficient 为 false。',
	'5. 如果题目明显依赖视频内容（例如“刚才讲了什么”“这节课主要讲什么”“视频中提到的是”），仅凭题目无法确定，则 insufficient 设为 true，但仍然必须给出你认为最可能的答案（可结合视频名称和选项的合理性推测）。',
	'6. 无论 insufficient 是否为 true，answer 都不能为空，必须从选项中选出最可能的答案。',
	'7. 单选题/多选题/判断题：option 和 answer 必须同时返回：option 为所选选项的字母（如 B，多选如 AC），answer 为对应选项的完整文字内容。'
].join('\n');

const AI_TYPE_LABELS: Record<string, string> = {
	single: '单选题',
	multiple: '多选题',
	judgement: '判断题',
	completion: '填空题'
};

function getAiConfig() {
	const enableRaw = $store.get(AI_STORE_KEYS.enable, false) as unknown;
	const baseUrl = String($store.get(AI_STORE_KEYS.baseUrl, DEFAULT_AI_CONFIG.baseUrl) || '').trim();
	const model = String($store.get(AI_STORE_KEYS.model, DEFAULT_AI_CONFIG.model) || '').trim();

	return {
		enable: enableRaw === true || enableRaw === 'true',
		baseUrl: (baseUrl || DEFAULT_AI_CONFIG.baseUrl).replace(/\/+$/, ''),
		apiKey: String($store.get(AI_STORE_KEYS.apiKey, '') || '').trim(),
		model: model || DEFAULT_AI_CONFIG.model,
		extraBody: String($store.get(AI_STORE_KEYS.extraBody, '') || '').trim(),
		useImages: ($store.get(AI_STORE_KEYS.useImages, true) as unknown) !== false,
		thinking: ($store.get(AI_STORE_KEYS.thinking, true) as unknown) !== false,
		webSearch: ($store.get(AI_STORE_KEYS.webSearch, true) as unknown) !== false,
		maxWaitSeconds: normalizeAiMaxWait($store.get(AI_STORE_KEYS.maxWait, DEFAULT_AI_MAX_WAIT_SECONDS))
	};
}

function normalizeAiMaxWait(value: unknown) {
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		return DEFAULT_AI_MAX_WAIT_SECONDS;
	}
	return Math.min(1800, Math.max(60, Math.round(seconds)));
}

/** AI 答题开启时，答题线程需要额外等待的秒数（用于设置 AnswerWrapperHandlerConfig.extra_wait_seconds） */
export function getAiExtraWaitSeconds() {
	const config = getAiConfig();
	return config.enable ? config.maxWaitSeconds + 30 : 0;
}

/** 同步答题线程的等待时间：AI 答题可能思考很久，不能被默认的搜题超时误判为失败 */
export function syncAiWaitConfig() {
	AnswerWrapperHandlerConfig.extra_wait_seconds = getAiExtraWaitSeconds();
}

function createAiWrapper(url: string, model: string) {
	return {
		name: `AI 答题 (${model})`,
		url,
		homepage: 'https://api-docs.deepseek.com/',
		method: 'post',
		type: 'GM_xmlhttpRequest',
		contentType: 'json',
		headers: {},
		data: {},
		handler: 'return () => undefined;'
	} as AnswererWrapper;
}

/** 解析 AI 返回的 JSON，兼容被 ```json 包裹的情况 */
function parseAiContent(content: string):
	| {
			answer: string;
			option?: string;
			reason?: string;
			insufficient?: boolean;
			confidence?: string;
			searchQuery?: string;
	  }
	| undefined {
	const text = content
		.trim()
		.replace(/^```(?:json)?/i, '')
		.replace(/```$/, '')
		.trim();
	const parsed = parseResponseText(text) || parseResponseText(text.match(/\{[\s\S]*\}/)?.[0] || '');
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}

	const answer = parseAnswer(parsed.answer).trim();
	return {
		answer,
		reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
		insufficient: parsed.insufficient === true || parsed.insufficient === 'true',
		confidence: typeof parsed.confidence === 'string' ? parsed.confidence.toLowerCase() : undefined,
		option:
			parseAnswer(parsed.option)
				.toUpperCase()
				.replace(/[^A-H]/g, '') || undefined,
		searchQuery: typeof parsed.search_query === 'string' ? parsed.search_query.trim() : undefined
	};
}

const AI_MAX_IMAGES = 8;
const AI_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 从题干/选项文本中提取图片链接（脚本会把 <img> 的地址追加到题干文本中） */
export function extractImageUrls(...texts: string[]) {
	const urls: string[] = [];
	for (const text of texts) {
		for (const matched of String(text || '').match(/https?:\/\/[^\s"'<>，,）)]+/gi) || []) {
			const url = matched.replace(/[.。;；]+$/, '');
			const isImage = /\.(png|jpe?g|gif|webp|bmp)(\?|#|$)/i.test(url) || /\/(star\d?|image|img|ananas)/i.test(url);
			if (isImage && !urls.includes(url)) {
				urls.push(url);
			}
		}
	}
	return urls.slice(0, AI_MAX_IMAGES);
}

/** 下载图片并转成 data URL，失败时返回 undefined（此时直接把原始链接交给 AI 服务端下载） */
function downloadImageAsDataUrl(url: string) {
	return new Promise<string | undefined>((resolve) => {
		const gmRequest = globalThis.GM_xmlhttpRequest;
		if (typeof gmRequest === 'undefined') {
			resolve(undefined);
			return;
		}

		gmRequest({
			url,
			method: 'GET',
			responseType: 'arraybuffer',
			timeout: 20 * 1000,
			onload: (response) => {
				try {
					const buffer = response.response as ArrayBuffer | undefined;
					if (
						response.status < 200 ||
						response.status >= 300 ||
						!buffer ||
						buffer.byteLength === 0 ||
						buffer.byteLength > AI_MAX_IMAGE_BYTES
					) {
						resolve(undefined);
						return;
					}

					const bytes = new Uint8Array(buffer);
					let binary = '';
					for (let index = 0; index < bytes.length; index += 0x8000) {
						binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(index, index + 0x8000)));
					}
					const type = /content-type:\s*([^\r\n;]+)/i.exec(response.responseHeaders || '')?.[1]?.trim() || '';
					resolve(`data:${/^image\//i.test(type) ? type : 'image/jpeg'};base64,${btoa(binary)}`);
				} catch {
					resolve(undefined);
				}
			},
			onerror: () => resolve(undefined),
			ontimeout: () => resolve(undefined)
		});
	});
}

type AiImagePart = { type: 'image_url'; image_url: { url: string } };

/** AI 兜底答题是否已开启并填写了 API Key（此时即使没有配置题库也可以答题） */
export function isAiAnswererAvailable() {
	const config = getAiConfig();
	return config.enable && Boolean(config.apiKey);
}

const NATIVE_SEARCH_TIMEOUT = 300 * 1000;

/**
 * DeepSeek 原生联网搜索。
 * 只有 Anthropic 兼容接口（/anthropic/v1/messages）支持服务端的 web_search 工具，
 * Chat Completions 和 Responses 接口都不支持。模型会自行多轮搜索，并给出最终答案。
 * 不可用（不是 DeepSeek 官方地址、接口报错、没有给出答案）时返回 undefined，调用方回退到网页抓取。
 */
async function nativeWebSearchAnswer(options: {
	baseUrl: string;
	apiKey: string;
	model: string;
	userText: string;
	images: AiImagePart[];
	timeoutMs?: number;
}) {
	let origin = '';
	try {
		const parsedUrl = new URL(options.baseUrl);
		if (parsedUrl.hostname !== 'api.deepseek.com') {
			return undefined;
		}
		origin = parsedUrl.origin;
	} catch {
		return undefined;
	}

	const content: any[] = options.images.map((image) => {
		const matched = /^data:([^;]+);base64,(.+)$/.exec(image.image_url.url);
		return matched
			? { type: 'image', source: { type: 'base64', media_type: matched[1], data: matched[2] } }
			: { type: 'image', source: { type: 'url', url: image.image_url.url } };
	});
	content.push({ type: 'text', text: options.userText });

	const response = await postJson(
		`${origin}/anthropic/v1/messages`,
		{
			model: options.model,
			max_tokens: 8192,
			system:
				AI_SYSTEM_PROMPT +
				'\n你可以使用 web_search 工具联网查证。完成查证后，最终只输出一个 JSON 对象，不要输出其他内容。',
			tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
			messages: [{ role: 'user', content }]
		},
		{ 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' },
		Math.min(NATIVE_SEARCH_TIMEOUT, options.timeoutMs || NATIVE_SEARCH_TIMEOUT)
	);

	if (response.status < 200 || response.status >= 300 || !Array.isArray(response.json?.content)) {
		$searchConsole.warn('DeepSeek 原生联网搜索不可用，改为抓取网页搜索', {
			status: response.status,
			message: response.json?.error?.message || response.text?.slice(0, 200)
		});
		return undefined;
	}

	const blocks = response.json.content as any[];
	const queries = blocks
		.filter((block) => block.type === 'server_tool_use')
		.map((block) => String(block.input?.query || ''))
		.filter(Boolean);
	const texts = blocks.filter((block) => block.type === 'text').map((block) => String(block.text || ''));

	// 最终答案是最后一段能解析出答案的文本（前面的文本是搜索过程中的说明）
	for (let index = texts.length - 1; index >= 0; index--) {
		const parsed = parseAiContent(texts[index]);
		if (parsed?.answer) {
			return { parsed, queries };
		}
	}

	$searchConsole.warn('DeepSeek 原生联网搜索没有给出答案，改为抓取网页搜索', {
		stop_reason: response.json.stop_reason,
		queries
	});
	return undefined;
}

/** 联网搜索：依次尝试 Bing 和 DuckDuckGo 的网页结果，返回前几条的标题和摘要，没有结果时返回空字符串 */
async function searchWeb(query: string) {
	const keyword = stripUrls(query).trim().slice(0, 120);
	const gmRequest = globalThis.GM_xmlhttpRequest;
	if (!keyword || typeof gmRequest === 'undefined') {
		return '';
	}

	const fetchHtml = (url: string) =>
		new Promise<string>((resolve) => {
			gmRequest({
				url,
				method: 'GET',
				timeout: 15 * 1000,
				onload: (response) =>
					resolve(response.status >= 200 && response.status < 300 ? response.responseText || '' : ''),
				onerror: () => resolve(''),
				ontimeout: () => resolve('')
			});
		});

	const parse = (html: string, itemSelector: string, titleSelector: string, snippetSelector: string) => {
		if (!html) {
			return [] as string[];
		}
		const doc = new DOMParser().parseFromString(html, 'text/html');
		return Array.from(doc.querySelectorAll(itemSelector))
			.map((item) => {
				const title = item.querySelector(titleSelector)?.textContent?.trim() || '';
				const snippet = item.querySelector(snippetSelector)?.textContent?.trim() || '';
				return title || snippet ? `${title}${snippet ? '\n' + snippet : ''}` : '';
			})
			.filter(Boolean)
			.slice(0, 5);
	};

	const encoded = encodeURIComponent(keyword);
	let lines = parse(
		await fetchHtml(`https://cn.bing.com/search?q=${encoded}&setlang=zh-Hans`),
		'.b_algo',
		'h2',
		'.b_caption p, .b_lineclamp2, .b_lineclamp3, .b_algoSlug'
	);
	if (lines.length === 0) {
		lines = parse(
			await fetchHtml(`https://html.duckduckgo.com/html/?q=${encoded}`),
			'.result',
			'.result__a',
			'.result__snippet'
		);
	}

	return lines
		.map((line, index) => `${index + 1}. ${line}`)
		.join('\n')
		.slice(0, 3000);
}

/**
 * 带重试的 POST：网络错误/超时重试 1 次；限流（429）、超时（408）和服务端错误（5xx）最多重试 2 次，等待时间递增。
 * 只重试“瞬时错误”，401/402/403 这类需要用户处理的错误直接返回。
 */
async function postJsonWithRetry(
	url: string,
	body: Record<string, any>,
	headers: Record<string, string>,
	timeout: number,
	/** 使用流式传输：timeout 为总时限，同时启用“长时间无数据”检测 */
	stream = false
) {
	let lastError: unknown;
	for (let attempt = 0; attempt <= 2; attempt++) {
		try {
			const response = stream
				? await postChatStream(url, body, headers, { idleMs: AI_IDLE_TIMEOUT, totalMs: timeout })
				: await postJson(url, body, headers, timeout);
			const retryable =
				response.status === 408 ||
				response.status === 409 ||
				response.status === 425 ||
				response.status === 429 ||
				response.status >= 500;
			if (retryable && attempt < 2) {
				$searchConsole.warn(`AI 请求异常（HTTP ${response.status}），准备第 ${attempt + 1} 次重试`);
				await $.sleep(1500 * (attempt + 1));
				continue;
			}
			return response;
		} catch (error) {
			lastError = error;
			if (attempt >= 1) {
				break;
			}
			$searchConsole.warn(`AI 请求出错（${stringifyError(error)}），准备重试`);
			await $.sleep(1500);
		}
	}

	throw lastError || new Error('AI 请求失败');
}

let lastAiNotifyTime = 0;
let aiFatalNotified = false;

/**
 * 在页面上提示 AI 答题失败，避免只能到“搜题日志”里才能发现。
 * 普通失败 15 秒内只提示一次；Key 无效/余额不足等致命错误只提示一次，并且一直显示。
 */
function notifyAiFailure(title: string, reason: string, fatal = false) {
	try {
		if (fatal) {
			if (aiFatalNotified) {
				return;
			}
			aiFatalNotified = true;
			$message.error({
				content: `AI 答题不可用：${reason}。请检查 通用-全局设置 里的 API Key 或账户余额。`,
				duration: 0
			});
			return;
		}

		const now = Date.now();
		if (now - lastAiNotifyTime < 15 * 1000) {
			return;
		}
		lastAiNotifyTime = now;
		$message.warn({
			content: `AI 答题失败：${reason}（${title.slice(0, 20)}…），这题需要手动处理，详情见 后台-搜题日志。`,
			duration: 8
		});
	} catch {
		// 提示失败不影响答题流程
	}
}

/**
 * 有些平台选项的字母和内容在不同的行里（“A.” 一行，“E，B，C” 下一行），
 * 按行拆分选项时会把字母行也当成一个选项，这里把它们合并成 “A. E，B，C”。
 */
function mergeOptionLabelLines(text: string) {
	const labelOnly = /^[A-H]\s*[.、:：．]?$/;
	const lines = String(text || '')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	const merged: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const next = lines[index + 1];
		if (labelOnly.test(lines[index]) && next !== undefined && !labelOnly.test(next)) {
			merged.push(`${lines[index].replace(/[.、:：．\s]+$/, '')}. ${next}`);
			index++;
		} else {
			merged.push(lines[index]);
		}
	}
	return merged.join('\n');
}

async function searchAiQuestion(env: SearchEnv, scene: SearchScene): Promise<SearchInformation | undefined> {
	const config = getAiConfig();
	if (!config.enable) {
		return undefined;
	}

	const title = String(env.title || '').trim();
	if (!title) {
		return undefined;
	}

	const url = /\/chat\/completions$/.test(config.baseUrl) ? config.baseUrl : `${config.baseUrl}/chat/completions`;
	const wrapper = createAiWrapper(url, config.model);

	/** 单道题的总时限：思考、联网搜索、重试都计入其中，超过后返回已有结果或失败 */
	const startedAt = Date.now();
	const maxWaitMs = config.maxWaitSeconds * 1000;
	const remaining = () => Math.max(0, maxWaitMs - (Date.now() - startedAt));
	const authHeaders = { Authorization: `Bearer ${config.apiKey}` };

	if (!config.apiKey) {
		$searchConsole.warn('已开启 AI 答题，但未填写 API Key，请前往 通用-全局设置 配置。');
		return createEmptySearchInfo(wrapper, '未填写 AI API Key');
	}

	let extraBody: Record<string, any> = {};
	if (config.extraBody) {
		const parsed = parseResponseText(config.extraBody);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			extraBody = parsed;
		} else {
			$searchConsole.warn('AI 额外请求参数不是合法的 JSON 对象，已忽略。');
		}
	}

	const isVideoQuiz = env.scenario === 'video-quiz';
	/** 填空题的空数（页面上输入框的数量），用于要求 AI 给出相同数量的答案 */
	const blankCount = String(env.type) === 'completion' ? Number(env.blankCount) || 0 : 0;

	// 图片题：把题干/选项里的图片链接替换成【图片N】，并把图片作为 image_url 附在消息后面
	let promptTitle = title;
	let promptOptions = mergeOptionLabelLines(String(env.options || ''));
	let imageParts: AiImagePart[] = [];
	/** 选项本身是图片（例如公式、电路图）：此时选项没有文字，要求 AI 只回答选项字母 */
	let imageChoiceMode = false;
	if (config.useImages) {
		// 题干里只识别常见的图片链接；选项里出现的链接基本都是选项图片（公式等），不要求有图片后缀
		const optionUrls = (promptOptions.match(/https?:\/\/[^\s"'<>，,）)]+/gi) || []).map((url) =>
			url.replace(/[.。;；]+$/, '')
		);
		const imageUrls = Array.from(new Set([...extractImageUrls(title), ...optionUrls])).slice(0, AI_MAX_IMAGES);

		for (let index = 0; index < imageUrls.length; index++) {
			const imageUrl = imageUrls[index];
			promptTitle = promptTitle.split(imageUrl).join(`【图片${index + 1}】`);
			promptOptions = promptOptions.split(imageUrl).join(`【图片${index + 1}】`);
		}
		// 并行下载图片，避免多张图片逐张等待占用答题的总时限
		const dataUrls = await Promise.all(imageUrls.map((imageUrl) => downloadImageAsDataUrl(imageUrl)));
		imageUrls.forEach((imageUrl, index) => {
			imageParts.push({ type: 'image_url', image_url: { url: dataUrls[index] || imageUrl } });
		});

		// 选项（大部分）是图片时，补全 A/B/C/D 字母，让 AI 回答字母
		if (imageParts.length) {
			const lines = promptOptions
				.split('\n')
				.map((line) => line.trim())
				.filter(Boolean);
			const merged: string[] = [];
			for (let index = 0; index < lines.length; index++) {
				// 字母和图片分在两行时合并：A / 【图片1】 -> A. 【图片1】
				if (/^[A-H]$/.test(lines[index]) && lines[index + 1] !== undefined) {
					merged.push(`${lines[index]}. ${lines[index + 1]}`);
					index++;
				} else {
					merged.push(lines[index]);
				}
			}

			const isImageLine = (line: string) => /^(?:[A-H]\s*[.、:：．]?\s*)?(?:【图片\d+】\s*)+$/.test(line);
			if (merged.length >= 2 && merged.filter(isImageLine).length >= Math.ceil(merged.length / 2)) {
				imageChoiceMode = true;
				promptOptions = merged
					.map((line, index) =>
						/^[A-H](?:\s*[.、:：．]|\s+)/.test(line) ? line : `${String.fromCharCode(65 + index)}. ${line}`
					)
					.join('\n');
			}
		}
	}

	// 选择题：给每个选项加上字母，并记录纯文字选项，用于把 AI 返回的选项字母换算成准确的选项文字
	let optionTexts: string[] = [];
	if (promptOptions && String(env.type) !== 'completion') {
		const lines = promptOptions
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean);
		if (lines.length >= 2 && lines.length <= 12) {
			const letterPrefix = /^([A-H])(?:\s*[.、:：．]\s*|\s+)(.*)$/;
			if (lines.every((line) => letterPrefix.test(line))) {
				optionTexts = lines.map((line) => line.replace(letterPrefix, '$2').trim());
			} else if (!imageChoiceMode && lines.length <= 8) {
				optionTexts = lines;
				promptOptions = lines.map((line, index) => `${String.fromCharCode(65 + index)}. ${line}`).join('\n');
			}
		}
	}

	/**
	 * 最终答案：AI 返回了选项字母时，换算成对应的选项文字（与页面选项完全一致，最容易匹配）；
	 * 选项是图片时只返回字母。
	 */
	const finalizeAnswer = (r: { answer: string; option?: string }) => {
		let letters = r.option || '';
		if (String(env.type) === 'single' || String(env.type) === 'judgement') {
			letters = letters.slice(0, 1);
		}
		if (!letters) {
			return r.answer;
		}
		if (imageChoiceMode) {
			return letters;
		}
		const texts = Array.from(letters).map((letter) => optionTexts[letter.charCodeAt(0) - 65]);
		return texts.length && texts.every(Boolean) ? texts.join('#') : r.answer;
	};

	const buildUserText = (images: AiImagePart[], searchContext = '', extraHint = '') =>
		[
			isVideoQuiz && env.videoName ? `视频名称：${env.videoName}` : '',
			`题型：${AI_TYPE_LABELS[String(env.type)] || '未知题型（请根据题目判断）'}`,
			`题目：${promptTitle}`,
			promptOptions ? `选项：\n${promptOptions}` : '',
			images.length ? `题目中包含 ${images.length} 张图片（【图片1】等），已按顺序附在下方，请结合图片作答。` : '',
			imageChoiceMode
				? '注意：选项是图片，请在 option 中填写所选选项的字母（单选如 A，多选如 AC），并在 answer 中简要描述所选选项图片的内容。'
				: '',
			blankCount > 1
				? `注意：这道填空题共有 ${blankCount} 个空，answer 必须恰好包含 ${blankCount} 个答案，` +
				  '按空的先后顺序用 # 连接，每个答案只写该空的最终结果（含单位时带单位）。涉及计算时请先认真计算再作答。'
				: '',
			searchContext ? `联网搜索结果（仅供参考，可能不准确，请自行甄别）：\n${searchContext}` : '',
			extraHint
		]
			.filter(Boolean)
			.join('\n');

	const buildRequestBody = (images: AiImagePart[], thinking: boolean, searchContext = '', extraHint = '') => {
		const userContent = buildUserText(images, searchContext, extraHint);

		return {
			model: config.model,
			messages: [
				{ role: 'system', content: isVideoQuiz ? AI_VIDEO_QUIZ_SYSTEM_PROMPT : AI_SYSTEM_PROMPT },
				{
					role: 'user',
					content: images.length ? [{ type: 'text', text: userContent }, ...images] : userContent
				}
			],
			response_format: { type: 'json_object' },
			// 深度思考的推理内容也会占用输出长度，需要放宽，否则正文会被截断导致返回空内容
			max_tokens: thinking ? 8192 : 1024,
			temperature: 0,
			thinking: { type: thinking ? 'enabled' : 'disabled' },
			stream: false,
			...extraBody
		};
	};

	/** 去掉 base64 图片数据，避免日志和搜索结果里保存巨大的字符串 */
	const toLoggableBody = (body: ReturnType<typeof buildRequestBody>) => ({
		...body,
		messages: body.messages.map((message) =>
			Array.isArray(message.content)
				? {
						...message,
						content: message.content.map((part: any) =>
							part.type === 'image_url' && String(part.image_url?.url).startsWith('data:')
								? { type: 'image_url', image_url: { url: '[base64 image]' } }
								: part
						)
				  }
				: message
		)
	});

	// 深度思考默认开启（准确率更高）；返回空内容（例如推理内容占满输出长度）时，下一次尝试会自动关闭思考
	let useThinking = config.thinking;
	let requestBody = buildRequestBody(imageParts, useThinking);

	try {
		// DeepSeek 的 JSON 输出偶尔会返回空内容，这里最多尝试两次
		for (let attempt = 0; attempt < 2; attempt++) {
			$searchConsole.info(`[${scene}] AI 答题 -> ${title}`, {
				url,
				model: config.model,
				images: imageParts.length,
				attempt: attempt + 1
			});

			if (remaining() < 5000) {
				$searchConsole.warn(`AI 答题已超过最长等待时间（${config.maxWaitSeconds} 秒）: ${title}`);
				notifyAiFailure(title, `超过最长等待时间 ${config.maxWaitSeconds} 秒`);
				return createEmptySearchInfo(wrapper, `AI 答题超过最长等待时间（${config.maxWaitSeconds} 秒）`);
			}

			$debug.log('ai', '开始请求', {
				title: title.slice(0, 40),
				attempt: attempt + 1,
				remainingSeconds: Math.round(remaining() / 1000)
			});
			const response = await postJsonWithRetry(url, requestBody, authHeaders, remaining(), true);
			$debug.log('ai', '收到响应', {
				status: response.status,
				elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
				reasoningChars: String(response.json?.choices?.[0]?.message?.reasoning_content || '').length
			});
			if (response.status < 200 || response.status >= 300) {
				const message = response.json?.error?.message || response.text || `HTTP ${response.status}`;

				// 模型不支持图片输入时，退回纯文字重试一次
				if (response.status === 400 && imageParts.length) {
					$searchConsole.warn(`AI 请求带图片失败，改为仅文字重试: ${message}`);
					imageParts = [];
					requestBody = buildRequestBody(imageParts, useThinking);
					attempt--;
					continue;
				}

				$searchConsole.error(`AI 答题请求失败: ${title}`, { status: response.status, message });
				notifyAiFailure(
					title,
					`HTTP ${response.status} ${String(message).slice(0, 60)}`,
					[401, 402, 403].includes(response.status)
				);
				return createEmptySearchInfo(wrapper, `AI 请求失败：${message}`);
			}

			const content = String(response.json?.choices?.[0]?.message?.content || '');
			const parsed = content ? parseAiContent(content) : undefined;
			if (!parsed) {
				const choice = response.json?.choices?.[0];
				$searchConsole.warn(`AI 返回内容为空或格式错误: ${title}`, {
					finish_reason: choice?.finish_reason,
					usage: response.json?.usage,
					content: content.slice(0, 200),
					hasReasoning: Boolean(choice?.message?.reasoning_content)
				});
				// 开启深度思考时，下一次尝试关闭思考，确保能拿到正文
				if (useThinking) {
					useThinking = false;
					requestBody = buildRequestBody(imageParts, false);
				}
				continue;
			}
			let result = parsed;
			let finalResponse = response;
			let searchedQuery = '';

			// AI 不确定（没有答案或信心不足）时，强制联网搜索，把搜索结果交给 AI 再答一次（视频内题目与视频强相关，搜索没有意义）
			if (
				config.webSearch &&
				!isVideoQuiz &&
				(!parsed.answer || parsed.confidence === 'low') &&
				remaining() >= AI_MIN_REMAINING_FOR_OPTIONAL
			) {
				const query = parsed.searchQuery || promptTitle;
				$searchConsole.info(`AI 不确定，正在联网搜索: ${query}`, { title });

				// 优先使用 DeepSeek 原生联网搜索（Anthropic 兼容接口），不可用时回退到网页抓取
				let native: Awaited<ReturnType<typeof nativeWebSearchAnswer>>;
				try {
					native = await nativeWebSearchAnswer({
						baseUrl: config.baseUrl,
						apiKey: config.apiKey,
						model: config.model,
						userText: buildUserText(imageParts),
						images: imageParts,
						timeoutMs: remaining()
					});
				} catch (error) {
					native = undefined;
					$searchConsole.warn(`DeepSeek 原生联网搜索失败: ${stringifyError(error)}`);
				}

				if (native) {
					result = native.parsed;
					searchedQuery = native.queries.join(' / ') || query;
				} else {
					const snippets = await searchWeb(query);

					if (snippets && remaining() >= AI_MIN_REMAINING_FOR_OPTIONAL) {
						const searchBody = buildRequestBody(imageParts, useThinking, snippets);
						try {
							const searchResponse = await postChatStream(url, searchBody, authHeaders, {
								idleMs: AI_IDLE_TIMEOUT,
								totalMs: Math.max(remaining(), 10 * 1000)
							});
							const searchContent = String(searchResponse.json?.choices?.[0]?.message?.content || '');
							const searchParsed =
								searchResponse.status >= 200 && searchResponse.status < 300 && searchContent
									? parseAiContent(searchContent)
									: undefined;
							if (searchParsed?.answer) {
								result = searchParsed;
								finalResponse = searchResponse;
								requestBody = searchBody;
								searchedQuery = query;
							}
						} catch (error) {
							$searchConsole.warn(`联网搜索后重新作答失败: ${stringifyError(error)}`);
						}
					} else {
						$searchConsole.warn(`联网搜索没有得到结果: ${query}`);
					}
				}
			}

			if (!result.answer) {
				$searchConsole.info(`AI 无法确定答案: ${title}`, { reason: result.reason });
				return createEmptySearchInfo(wrapper, 'AI 无法确定答案');
			}

			// 答案没有落到题目上时（选择题对应不到任何选项；多空填空题答案数量与空数不一致），
			// 带上上一次的回答再请求一次，说明问题并要求重新作答
			const answerParts = result.answer.split(/#|===|---|\|/).filter((part) => part.trim()).length;
			let followHint = '';
			if (
				String(env.type) !== 'completion' &&
				(imageChoiceMode || optionTexts.length >= 2) &&
				!result.option &&
				(imageChoiceMode || !isAnswerUsableForOptions([result.answer], optionTexts))
			) {
				followHint =
					`你上一次的回答是「${result.answer}」，但它没有对应到任何选项。请重新阅读题目和各选项（选项是图片时见附图，按 A、B、C… 的顺序），` +
					'在 option 中填写你选择的选项字母（单选如 B，多选如 AC），answer 填写该选项的内容。';
			} else if (blankCount > 1 && answerParts !== blankCount) {
				followHint =
					`这道填空题共有 ${blankCount} 个空，但你上一次的回答「${result.answer}」只有 ${answerParts} 个答案。` +
					`请重新作答：answer 恰好包含 ${blankCount} 个答案，按空的先后顺序用 # 连接。`;
			}

			if (followHint && remaining() >= AI_MIN_REMAINING_FOR_OPTIONAL) {
				$searchConsole.warn(`AI 的答案不符合题目要求，重新请求: ${title}`, { answer: result.answer, blankCount });
				try {
					const followBody = buildRequestBody(imageParts, useThinking, '', followHint);
					const followResponse = await postJsonWithRetry(
						url,
						followBody,
						authHeaders,
						Math.max(remaining(), 10 * 1000),
						true
					);
					const followContent = String(followResponse.json?.choices?.[0]?.message?.content || '');
					const followParsed =
						followResponse.status >= 200 && followResponse.status < 300 && followContent
							? parseAiContent(followContent)
							: undefined;
					const followParts = (followParsed?.answer || '').split(/#|===|---|\|/).filter((part) => part.trim()).length;
					const accepted = followParsed && (blankCount > 1 ? followParts === blankCount : Boolean(followParsed.option));
					if (followParsed && accepted) {
						result = {
							...result,
							option: followParsed.option,
							answer: followParsed.answer || result.answer,
							reason: followParsed.reason || result.reason
						};
						requestBody = followBody;
					}
				} catch (error) {
					$searchConsole.warn(`重新请求失败: ${stringifyError(error)}`);
				}
			}

			const finalAnswer = finalizeAnswer(result);
			$searchConsole.info(`AI 答题完成: ${title}`, {
				answer: finalAnswer,
				option: result.option,
				answerText: result.answer,
				reason: result.reason,
				confidence: result.confidence,
				webSearch: Boolean(searchedQuery),
				elapsedSeconds: Math.round((Date.now() - startedAt) / 1000)
			});
			return toSearchInfo(
				wrapper,
				[
					{
						question: title,
						answer: finalAnswer,
						extra_data: {
							ai: true,
							reason: result.reason,
							...(result.option ? { option: result.option } : {}),
							// 选项是图片时，用于匹配的答案只有字母，AI 对所选图片内容的描述保存在这里供查看
							...(result.answer && result.answer !== finalAnswer ? { answerText: result.answer } : {}),
							// 题目与视频内容强相关，AI 信息不足，答案只是猜测
							...(isVideoQuiz && result.insufficient ? { insufficient: true } : {}),
							...(searchedQuery ? { webSearch: true, searchQuery: searchedQuery } : {})
						}
					}
				],
				finalResponse.json,
				toLoggableBody(requestBody)
			);
		}

		notifyAiFailure(title, 'AI 返回内容为空或格式错误');
		return createEmptySearchInfo(wrapper, 'AI 返回内容为空或格式错误');
	} catch (error) {
		$searchConsole.error(`AI 答题失败: ${title}`, { scene, error: stringifyError(error) });
		notifyAiFailure(title, stringifyError(error).slice(0, 80));
		return createEmptySearchInfo(wrapper, stringifyError(error));
	}
}

/** 题库结果与题目的相似度低于该值时，认为是无关结果（题库模糊匹配经常返回不相关的题目） */
const CREDIBLE_SIMILARITY = 0.5;
/** 题库返回的“占位”答案，不能当作真正的答案 */
const PLACEHOLDER_ANSWER = /^(见题干|见题目|见图|见上图|见下图|见附图|不确定|不知道|不清楚|略|无|暂无|无答案|未知)$/;

function stripUrls(text: string) {
	return String(text || '').replace(/https?:\/\/\S+/g, '');
}

/**
 * 判断一条题库结果是否可信：有实际答案，并且题干与要搜索的题目足够相似。
 * 题库没有返回题干（无法判断）或结果来自本地缓存时，视为可信。
 */
export function isCredibleAnswer(title: string, result: { question?: string; answer?: string; extra_data?: unknown }) {
	const answer = String(result.answer || '')
		.replace(/\s+/g, '')
		.trim();
	if (!answer || PLACEHOLDER_ANSWER.test(answer)) {
		return false;
	}

	if ((result.extra_data as { cache?: boolean } | undefined)?.cache) {
		return true;
	}

	const question = stripUrls(result.question || '');
	if (!normalizeText(question)) {
		return true;
	}

	const target = stripUrls(title);
	const nq = normalizeText(question);
	const nt = normalizeText(target);
	// 题库的题干包含了要搜索的题目（或相反），例如题库题干带有额外的描述
	if (Math.min(nq.length, nt.length) >= 6 && (nq.includes(nt) || nt.includes(nq))) {
		return true;
	}

	return textSimilarity(target, question) >= CREDIBLE_SIMILARITY;
}

/**
 * 是否已经有可用的结果：题库结果必须可信（题干相似、答案不是占位内容），
 * 并且（题目带有文字选项时）答案能匹配到其中一个选项；否则交给 AI 兜底。
 */
function hasCredibleResult(title: string, infos: SearchInformation[], optionsText = '') {
	const credible = infos.flatMap((info) => info.results).filter((result) => isCredibleAnswer(title, result));
	if (credible.length === 0) {
		return false;
	}

	const optionTexts = mergeOptionLabelLines(String(optionsText || ''))
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	return isAnswerUsableForOptions(
		credible.map((result) => result.answer),
		optionTexts
	);
}

/**
 * 为单个题库的搜题加上总时限（题库超时设置，默认 120 秒）。
 * 通用题库自带超时，但 MeTo 等直连题库没有，一次卡死会让整个答题流程一直等待。
 */
async function searchWrapperWithDeadline(wrapper: AnswererWrapper, env: SearchEnv, scene: SearchScene) {
	const seconds = AnswerWrapperHandlerConfig.timeout_seconds || 60;
	const startedAt = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;

	const work = isMetoWrapper(wrapper)
		? searchMetoQuestion(wrapper, env, scene)
		: searchGenericWrapper(wrapper, env, scene);
	const timeout = new Promise<SearchInformation>((resolve) => {
		timer = setTimeout(() => {
			$searchConsole.warn(`${wrapper.name} 超过 ${seconds} 秒没有响应，已放弃`, { question: env.title });
			resolve(createEmptySearchInfo(wrapper, `题库请求超时（超过 ${seconds} 秒）`));
		}, seconds * 1000);
	});

	try {
		const info = await Promise.race([work, timeout]);
		$debug.log('answerer', `${wrapper.name} 完成`, {
			results: info.results.length,
			error: info.error,
			elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10
		});
		return info;
	} catch (error) {
		return createEmptySearchInfo(wrapper, stringifyError(error));
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

export async function searchAnswerInWrappers(wrappers: AnswererWrapper[], env: SearchEnv, scene: SearchScene = 'auto') {
	// 所有题库并行搜索，总耗时取决于最慢的一个，而不是所有题库耗时相加
	const infos: SearchInformation[] = await Promise.all(
		wrappers.map((wrapper) => searchWrapperWithDeadline(wrapper, env, scene))
	);

	// 所有题库都没有可信的结果（没有结果，或只有不相关/占位的答案）时，使用 AI 兜底
	const credible = hasCredibleResult(String(env.title || ''), infos, String(env.options || ''));
	$debug.log('answerer', credible ? '题库已有可信结果' : '题库没有可信结果，尝试 AI 兜底', {
		title: String(env.title || '').slice(0, 40),
		wrappers: wrappers.length,
		results: infos.map((info) => info.results.length)
	});
	if (!credible) {
		const aiInfo = await searchAiQuestion(env, scene);
		if (aiInfo) {
			// AI 有答案时放在最前面，避免不相关的题库结果（例如判断题里的“T”）被优先采用
			if (aiInfo.results.length) {
				infos.unshift(aiInfo);
			} else {
				infos.push(aiInfo);
			}
		}
	}

	return infos;
}

export async function searchQuestionsInWrappers(
	wrappers: AnswererWrapper[],
	questions: string[],
	baseEnv: Omit<SearchEnv, 'title'> = {},
	scene: SearchScene = 'manual-batch'
) {
	const normalizedQuestions = questions.map((item) => item.trim()).filter(Boolean);
	const results: QuestionSearchResult[] = normalizedQuestions.map((question) => ({ question, infos: [] }));

	// 各题库并行搜索；同一个题库内部仍然逐题请求，避免短时间内发出大量请求
	const perWrapper = await Promise.all(
		wrappers.map(async (wrapper): Promise<QuestionSearchResult[]> => {
			if (isMetoWrapper(wrapper)) {
				return await searchMetoQuestions(wrapper, normalizedQuestions, scene);
			}
			const list: QuestionSearchResult[] = [];
			for (const question of normalizedQuestions) {
				list.push({
					question,
					infos: [await searchWrapperWithDeadline(wrapper, { ...baseEnv, title: question }, scene)]
				});
			}
			return list;
		})
	);

	// 按题库顺序合并，保证搜索结果的顺序与题库配置顺序一致
	for (const wrapperResults of perWrapper) {
		for (const result of wrapperResults) {
			const current = results.find((item) => item.question === result.question);
			if (current) {
				current.infos.push(...result.infos);
			}
		}
	}

	// 没有搜到结果的题目，使用 AI 兜底
	for (const result of results) {
		if (!hasCredibleResult(result.question, result.infos, String(baseEnv.options || ''))) {
			const aiInfo = await searchAiQuestion({ ...baseEnv, title: result.question }, scene);
			if (aiInfo) {
				if (aiInfo.results.length) {
					result.infos.unshift(aiInfo);
				} else {
					result.infos.push(aiInfo);
				}
			}
		}
	}

	return results;
}
