import { AnswererWrapper, Result, SearchInformation, defaultAnswerWrapperHandler } from '@ocsjs/core';
import { $, $store } from 'easy-us';
import md5 from 'md5';
import { $searchConsole } from './logger';

export type SearchScene = 'auto' | 'manual-single' | 'manual-batch';

export type SearchEnv = {
	title?: string;
	options?: string;
	type?: string;
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

export const DEFAULT_METO_AUTH_CONFIG: MetoAuthConfig = {
	server: 'https://m.metst.cn',
	tkUid: '397265',
	poolId: '2efc793b-661c-1760-d1ad-e51614113424',
	pp: '9ffb0a9f',
	userId: ''
};

const METO_DEFAULT_SERVERS = ['https://m.metst.cn', 'https://m.metost.com'];
const METO_MAX_RETRY_COUNT = 2;

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

function normalizeQuestion(text: string) {
	return String(text || '')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;|&#160;/gi, '')
		.replace(/\s+/g, '')
		.replace(/[[\]（）()【】]/g, '')
		.replace(/[。．.、,，;；:：!！?？]/g, '')
		.trim();
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

async function postJson(url: string, body: Record<string, any>) {
	const gmRequest = globalThis.GM_xmlhttpRequest;
	if (typeof gmRequest !== 'undefined') {
		return new Promise<MetoRequestResponse>((resolve, reject) => {
			gmRequest({
				url,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json; charset=utf-8',
					Accept: 'application/json'
				},
				data: JSON.stringify(body),
				onload: (response) => {
					resolve({
						url,
						status: response.status,
						requestBody: body,
						text: response.responseText || '',
						json: parseResponseText(response.responseText || '')
					});
				},
				onerror: (error) => reject(error)
			});
		});
	}

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			Accept: 'application/json'
		},
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

async function requestMeto(
	path: string,
	payload: Record<string, any>,
	scene: SearchScene,
	question: string
): Promise<MetoRequestResponse> {
	const auth = getResolvedMetoAuthConfig();
	if (!auth.tkUid) {
		throw new Error('MeTo 认证配置缺少 tk_uid，请前往 通用-全局设置 补充。');
	}
	if (!auth.poolId) {
		throw new Error('MeTo 认证配置缺少 poolId，请前往 通用-全局设置 补充，或者填写 user_id + pp 自动计算。');
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
				const response = await postJson(url, requestBody);
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

export async function searchAnswerInWrappers(wrappers: AnswererWrapper[], env: SearchEnv, scene: SearchScene = 'auto') {
	const infos: SearchInformation[] = [];
	for (const wrapper of wrappers) {
		if (isMetoWrapper(wrapper)) {
			infos.push(await searchMetoQuestion(wrapper, env, scene));
		} else {
			infos.push(await searchGenericWrapper(wrapper, env, scene));
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

	for (const wrapper of wrappers) {
		if (isMetoWrapper(wrapper)) {
			const metoResults = await searchMetoQuestions(wrapper, normalizedQuestions, scene);
			for (const result of metoResults) {
				const current = results.find((item) => item.question === result.question);
				if (current) {
					current.infos.push(...result.infos);
				}
			}
		} else {
			for (const result of results) {
				result.infos.push(await searchGenericWrapper(wrapper, { ...baseEnv, title: result.question }, scene));
			}
		}
	}

	return results;
}
