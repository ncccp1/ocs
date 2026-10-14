import debounce from 'lodash/debounce';
import {
	AnswerWrapperParser,
	request,
	SimplifyWorkResult,
	$,
	WorkUploadType,
	AnswerWrapperHandlerConfig
} from '@ocsjs/core';
import { $message, h, $gm, $store, Project, Script, $modal, StoreListenerType, $ui } from 'easy-us';
import type { AnswerMatchMode, AnswererWrapper, SearchInformation } from '@ocsjs/core';
import { CXProject, ICourseProject, IcveMoocProject, ZHSProject, ZJYProject } from '../index';
import { markdown } from '../utils/markdown';
import { enableCopy } from '../utils';
import { SearchInfosElement } from '../elements/search.infos';
import { RenderScript } from '../render';
import { dropdownStyle } from '../utils/configs';
import {
	cleanBlankAnswer,
	cleanQuestionStem,
	inferChoiceType,
	isBlankAnswerJunk,
	isAnswerUsableForOptions,
	matchAnswerToOptions,
	normalizeText,
	parseQuestionWithOptions,
	textSimilarity
} from '../utils/option-match';
import { getSelectionTextWithImages } from '../utils/selection';
import {
	calculateMetoPoolId,
	createMetoAnswererWrapper,
	extractImageUrls,
	getResolvedMetoAuthConfig,
	isAiAnswererAvailable,
	isCredibleAnswer,
	searchQuestionsInWrappers
} from '../utils/answerer';

const TAB_WORK_RESULTS_KEY = 'common.work-results.results';
const PROJECT_NAME = '南城派网课助手';
const PROJECT_REPO = 'https://github.com/ncccp1/ocs';
const PROJECT_ISSUES = 'https://github.com/ncccp1/ocs/issues';
const PROJECT_CHANGELOG = 'https://raw.githubusercontent.com/ncccp1/ocs/main/CHANGELOG.md';
const PROJECT_SETTING_EXTENSION = '.ncpsetting';
const PROJECT_SETTING_IMPORT_ACCEPT = '.ncpsetting,.ocssetting';
const QUESTION_CACHE_EXPORT_EXTENSION = '.ncp-question-cache.json';
const CX_CHAPTER_RETAKE_CACHE_TAB_KEY = 'cx_chapter_auto_retake_caches';

const state = {
	workResult: {
		/**
		 * 题目位置同步处理器
		 */
		questionPositionSyncHandler: {
			cx: (index: number) => {
				const el = document.querySelectorAll<HTMLElement>('[id*="sigleQuestionDiv"], .questionLi')?.item(index);
				if (el) {
					window.scrollTo({
						top: el.getBoundingClientRect().top + window.pageYOffset - 50,
						behavior: 'smooth'
					});
				}
			},
			'zhs-gxk': (index: number) => {
				document.querySelectorAll<HTMLElement>('.answerCard_list ul li').item(index)?.click();
			},
			'zhs-xnk': (index: number) => {
				document.querySelectorAll<HTMLElement>('.jobclassallnumber-div li[questionid]').item(index)?.click();
			},
			'zhs-smart': (index: number) => {
				document.querySelectorAll<HTMLElement>('[role="treeitem"] .font-sec-style-node').item(index)?.click();
			},
			'zhs-fusion': (index: number) => {
				document.querySelectorAll<HTMLElement>('.right-box .list .item').item(index)?.click();
			},
			'zhs-hike': (index: number) => {
				document.querySelectorAll<HTMLElement>('.q_main_right .card_ul .card_li').item(index)?.click();
			},
			icve: (index: number) => {
				document.querySelectorAll<HTMLElement>(`.sheet_nums [id*="sheetSeq"]`).item(index)?.click();
			},
			zjy: (index: number) => {
				document
					.querySelectorAll<HTMLElement>('.subjectDet')
					.item(index)
					?.scrollIntoView({ behavior: 'smooth', block: 'center' });
			},
			icourse: (index: number) => {
				document
					.querySelectorAll<HTMLElement>('.u-questionItem,[class*=questionBody]')
					.item(index)
					?.scrollIntoView({ behavior: 'smooth', block: 'center' });
			}
		}
	},
	setting: {
		listenerIds: {
			aw: 0 as StoreListenerType
		}
	}
};

/**
 * 题库缓存类型
 */
type QuestionCacheSource = 'standard' | 'bank' | 'ai';

/**
 * - standard: 提交后从页面读取的标准答案（可信度最高，会覆盖同一题的其他答案）
 * - bank: 在线题库返回的答案
 * - ai: AI 生成的答案（与在线题库同级，互不覆盖；只会被标准答案覆盖）
 */
type QuestionCache = {
	title: string;
	answer: string;
	from: string;
	homepage: string;
	ai?: boolean;
	/** 课程范围，用于区分不同课程中题干相同但答案不同的题目；为空表示未知（旧缓存或无法识别课程） */
	scope?: string;
	source?: QuestionCacheSource;
	time?: number;
	/** 所选选项的字母（如 B、AC），用于展示；匹配时以 answer 为准 */
	option?: string;
	/** 所选选项的内容描述（选项是图片时，answer 只有字母，这里保存 AI 对图片内容的描述） */
	content?: string;
};

const QUESTION_CACHE_SOURCE_RANK: Record<QuestionCacheSource, number> = { standard: 3, bank: 2, ai: 2 };

/**
 * 题库缓存的题干比较键：忽略空白、标点、全/半角括号、序号和题型标记。
 * 答题页和答案详情页的同一道题，空格、括号写法、序号/题型前缀可能不同，不能用字符串完全相等来比较。
 */
export function normalizeCacheTitle(title: string) {
	return normalizeText(
		String(title || '')
			.replace(/^\s*\d+\s*[.、．)）]\s*/, '')
			.replace(
				/[【[(（]\s*(?:单选题|多选题|判断题|填空题|简答题|选择题|问答题|名词解释|论述题|计算题)\s*[】\])）]/g,
				''
			)
	);
}

export function getQuestionCacheSource(cache: Pick<QuestionCache, 'source' | 'from' | 'ai'>): QuestionCacheSource {
	if (cache.source) {
		return cache.source;
	}
	if (/回填/.test(cache.from || '')) {
		return 'standard';
	}
	return cache.ai ? 'ai' : 'bank';
}

/**
 * 获取当前页面所属的课程范围，例如 `chaoxing.com:123456`。
 * 页面链接中没有课程 id 时返回空字符串（此时无法区分课程，缓存对所有课程通用）。
 */
export function getQuestionCacheScope(): string {
	const read = (win: Window | null | undefined) => {
		try {
			if (!win) {
				return '';
			}
			const params = new URL(win.location.href).searchParams;
			const id = params.get('courseId') || params.get('courseid') || params.get('courseID') || '';
			return id ? `${win.location.hostname.split('.').slice(-2).join('.')}:${id}` : '';
		} catch {
			return '';
		}
	};

	return read(window) || read(window.top);
}

function normalizeQuestionCacheItems(input: any): QuestionCache[] {
	const rawItems = Array.isArray(input)
		? input
		: Array.isArray(input?.caches)
		? input.caches
		: Array.isArray(input?.localQuestionCaches)
		? input.localQuestionCaches
		: [];

	const items: QuestionCache[] = [];
	for (const raw of rawItems) {
		const title = String(raw?.title || raw?.question || '').trim();
		const answer = String(raw?.answer || '').trim();
		if (!title || !answer) {
			continue;
		}

		items.push({
			title,
			answer,
			from: String(raw?.from || '导入题库缓存'),
			homepage: String(raw?.homepage || ''),
			ai: Boolean(raw?.ai),
			// 旧缓存/导入的缓存没有课程信息时保持为空（对所有课程通用），避免被误归到当前课程
			scope: raw?.scope ? String(raw.scope) : '',
			source: ['standard', 'bank', 'ai'].includes(raw?.source) ? raw.source : undefined,
			time: typeof raw?.time === 'number' ? raw.time : undefined,
			option: raw?.option ? String(raw.option) : undefined,
			content: raw?.content ? String(raw.content) : undefined
		});
	}

	return items;
}

/** 推荐选择：从搜题结果中挑出与题干最相似的结果，并把答案配对到题目自带的选项上 */
function createRecommendation(question: string, infos: SearchInformation[]) {
	const parsed = parseQuestionWithOptions(question);
	const options = parsed.options;
	const target = cleanQuestionStem(parsed.stem) || question;

	const candidates = infos
		.flatMap((info) =>
			info.results
				.filter((result) => String(result.answer || '').trim())
				.map((result) => ({
					info,
					result,
					similarity: textSimilarity(target, result.question || ''),
					isAi: Boolean((result.extra_data as { ai?: boolean } | undefined)?.ai)
				}))
		)
		.sort((a, b) => b.similarity - a.similarity);

	const best = candidates[0];
	if (!best) {
		return undefined;
	}

	const answers = candidates.filter((c) => c.similarity >= best.similarity - 0.001).map((c) => c.result.answer);
	const similarityText = best.isAi ? 'AI 作答' : `题目相似度 ${(best.similarity * 100).toFixed(0)}%`;
	const lowConfidence = !best.isAi && best.similarity < 0.6;

	let text = '';
	if (options.length) {
		const type = inferChoiceType(question, options, answers);
		const indexes = matchAnswerToOptions(answers, options, type);
		text = indexes.length
			? '推荐选择：' + indexes.map((index) => `${String.fromCharCode(65 + index)} ${options[index]}`).join('；')
			: `未能把答案匹配到选项，题库答案：${best.result.answer}`;
	} else {
		text = `推荐答案：${best.result.answer}`;
	}

	return h(
		'div',
		{
			style: {
				margin: '8px 0',
				padding: '8px',
				borderRadius: '4px',
				background: lowConfidence ? '#fff7e6' : '#e8f5e9',
				border: `1px solid ${lowConfidence ? '#ffd591' : '#a5d6a7'}`,
				fontWeight: 'bold',
				wordBreak: 'break-all'
			}
		},
		[
			h('div', text),
			h(
				'div',
				{ style: { fontWeight: 'normal', fontSize: '12px', color: '#888', marginTop: '4px' } },
				`来源：${best.info.name}，${similarityText}${lowConfidence ? '（相似度较低，仅供参考）' : ''}`
			)
		]
	);
}

function createSearchInfosCard(question: string, infos: SearchInformation[]) {
	const recommendation = createRecommendation(question, infos);
	return h(
		'div',
		[
			...(recommendation ? [recommendation] : []),
			h(SearchInfosElement, {
				infos: infos.map((info) => ({
					results: info.results.map((res) => [res.question, res.answer, res.extra_data] as [string, string, object]),
					homepage: info.homepage,
					name: info.name,
					error: info.error
				})),
				question
			})
		],
		(div) => {
			div.classList.add('card');
			div.style.width = '100%';
			div.style.boxSizing = 'border-box';
			div.style.marginBottom = '12px';
		}
	);
}

function createManualSearchEntry() {
	const textarea = h(
		'textarea',
		{
			className: 'modal-input',
			placeholder: '输入单个题目直接搜；批量搜索时每行一题。',
			style: {
				minWidth: '300px',
				width: 'calc(100% - 8px)',
				maxWidth: '100%',
				minHeight: '72px'
			}
		},
		CommonProject.scripts.onlineSearch.cfg.searchValue || ''
	);
	const content = h('div', '', (div) => {
		div.style.marginTop = '12px';
	});

	/** 题目中的图片预览：识别到图片时，AI 搜题会一并发送图片 */
	const previewEl = h('div', { style: { marginTop: '8px', display: 'none' } });
	const renderPreview = () => {
		const urls = extractImageUrls(textarea.value);
		previewEl.replaceChildren();
		previewEl.style.display = urls.length ? 'block' : 'none';
		if (urls.length === 0) {
			return;
		}

		previewEl.append(
			h(
				'div',
				{ style: { color: '#888', fontSize: '12px', marginBottom: '4px' } },
				`识别到 ${urls.length} 张图片，开启 AI 兜底答题后会一并发送给 AI 识别。`
			),
			...urls.map((url) =>
				h('img', { src: url, title: url }, (img) => {
					img.style.maxHeight = '72px';
					img.style.maxWidth = '120px';
					img.style.marginRight = '6px';
					img.style.border = '1px solid #ddd';
					img.style.borderRadius = '4px';
					img.onerror = () => img.remove();
				})
			)
		);
	};
	renderPreview();

	textarea.addEventListener('input', () => {
		CommonProject.scripts.onlineSearch.cfg.searchValue = textarea.value;
		renderPreview();
	});

	// 划词自动填入（或在其他页面/标签中修改）后，同步更新搜索框
	CommonProject.scripts.onlineSearch.onConfigChange('searchValue', () => {
		const latest = String(CommonProject.scripts.onlineSearch.cfg.searchValue || '');
		if (latest !== textarea.value) {
			textarea.value = latest;
			renderPreview();
		}
	});

	const runSearch = async (mode: 'manual-single' | 'manual-batch') => {
		const value = textarea.value.trim();
		if (!value) {
			content.replaceChildren(h('span', '题目不能为空！'));
			return;
		}

		if (CommonProject.scripts.settings.cfg.answererWrappers.length === 0 && !isAiAnswererAvailable()) {
			$modal.alert({
				content: '请先在 通用-全局设置 配置题库（或开启 AI 兜底答题并填写 API Key），才能进行在线搜题。'
			});
			return;
		}

		content.replaceChildren(h('span', '搜索中...'));
		const t = Date.now();
		const questions =
			mode === 'manual-batch'
				? value
						.split('\n')
						.map((item) => item.trim())
						.filter(Boolean)
				: [value];
		// 单题搜索时，如果输入里带有选项，则把题干和选项拆开：题库用题干搜，AI 能拿到结构化的选项和题型
		let queryQuestions = questions;
		let baseEnv: Record<string, any> = {};
		let hasOptions = false;
		if (mode === 'manual-single') {
			const parsed = parseQuestionWithOptions(value);
			const stem = cleanQuestionStem(parsed.stem);
			if (parsed.options.length >= 2 && stem) {
				hasOptions = true;
				queryQuestions = [stem];
				baseEnv = {
					type: inferChoiceType(value, parsed.options),
					options: parsed.options.map((option, index) => `${String.fromCharCode(65 + index)}. ${option}`).join('\n')
				};
			}
		}
		const results = await searchQuestionsInWrappers(
			CommonProject.scripts.settings.cfg.answererWrappers,
			queryQuestions,
			baseEnv,
			mode
		);
		const total = results.reduce((count, item) => count + item.infos.flatMap((info) => info.results).length, 0);
		const resume = ((Date.now() - t) / 1000).toFixed(2);

		content.replaceChildren(
			h('div', [
				h(
					'div',
					{ style: { color: '#a1a1a1', marginBottom: '12px' } },
					`共搜索 ${results.length} 题，命中 ${total} 条结果，耗时 ${resume} 秒。详细过程请查看 后台-搜题日志。`
				),
				...results.map((item) => createSearchInfosCard(hasOptions ? value : item.question, item.infos))
			])
		);
	};

	return h('div', { className: 'card', style: { marginBottom: '12px', boxSizing: 'border-box' } }, [
		h('div', { style: { fontWeight: 'bold', marginBottom: '8px' } }, '手动搜题'),
		h(
			'div',
			{ style: { color: '#888', fontSize: '12px', marginBottom: '8px' } },
			'单题直接搜索，批量搜索请每行输入一题。开启“划词搜索”后，选中页面中的题目（含图片）会自动填入；搜索框不为空时不会被覆盖，清空后才会重新填入。'
		),
		textarea,
		previewEl,
		h('div', { style: { textAlign: 'end', marginTop: '8px' } }, [
			h('button', '清空', (button) => {
				button.className = 'base-style-button-secondary';
				button.style.width = '80px';
				button.style.marginRight = '8px';
				button.onclick = () => {
					textarea.value = '';
					CommonProject.scripts.onlineSearch.cfg.searchValue = '';
					renderPreview();
					content.replaceChildren();
				};
			}),
			h('button', '单题搜索', (button) => {
				button.className = 'base-style-button';
				button.style.width = '120px';
				button.style.marginRight = '8px';
				button.onclick = () => {
					runSearch('manual-single');
				};
			}),
			h('button', '批量搜索', (button) => {
				button.className = 'base-style-button';
				button.style.width = '120px';
				button.onclick = () => {
					runSearch('manual-batch');
				};
			})
		]),
		content
	]);
}

export const CommonProject = Project.create({
	name: '通用',
	domains: [],
	scripts: {
		guide: new Script({
			name: '🏠 使用教程',
			matches: [['所有页面', /.*/]],
			namespace: 'common.guide',
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'打开任意网课平台，进入视频、作业页面等待脚本运行，',
						'如遇问题请通过项目主页或问题反馈页面提交截图说明。',
						'温馨提示: ',
						'⚠️ 禁止与其他脚本一起使用，否则会不兼容导致无法运行！',
						'⚠️ 禁止最小化浏览器、切屏，否则可能导致脚本无法运行！'
					]).outerHTML
				}
			},
			onrender({ panel }) {
				const guide = createGuide();
				guide.style.width = '480px';
				panel.body.replaceChildren(guide);
			}
		}),
		settings: new Script({
			name: '⚙️ 全局设置',
			matches: [['所有页面', /.*/]],
			namespace: 'common.settings',
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'✨鼠标移动到按钮或者输入框，可以看到提示！',
						'想要自动答题必须设置 “题库配置” ',
						'设置后进入章节测试，作业，考试页面即可自动答题。'
					]).outerHTML
				},
				answererWrappers: {
					separator: '自动答题设置',
					defaultValue: [] as AnswererWrapper[]
				},
				/**
				 * 禁用的题库
				 */
				disabledAnswererWrapperNames: {
					defaultValue: [] as string[]
				},
				answererWrappersButton: {
					label: '题库配置',
					defaultValue: '点击配置',
					attrs: {
						type: 'button'
					},
					onload() {
						const aws: any[] = CommonProject.scripts.settings.cfg.answererWrappers || [];
						this.value = aws.length ? '当前有' + aws.length + '个可用题库，点击重新配置' : '点击配置';

						this.onclick = () => {
							const aw: any[] = CommonProject.scripts.settings.cfg.answererWrappers || [];
							const copy = $ui.copy('复制题库配置', JSON.stringify(aw, null, 4));

							const list = h('div', [
								h('div', aw.length ? ['以下是已经解析过的题库配置：', copy] : ''),
								...createAnswererWrapperList(aw)
							]);
							const textarea = h(
								'textarea',
								{
									className: 'modal-input',
									style: { minHeight: '250px', width: 'calc(100% - 20px)', maxWidth: '100%' },
									placeholder: aw.length ? '重新输入题库配置' : '输入你的题库配置...，不会请看上方填写教程'
								},
								aw.length === 0 ? '' : JSON.stringify(aw, null, 4)
							);

							const select = $ui.tooltip(
								h(
									'select',
									{
										className: 'base-style-active-form-control',
										style: { backgroundColor: '#eef2f7', borderRadius: '2px', padding: '2px 8px' }
									},
									[
										h('option', '默认'),
										h(
											'option',
											{
												value: 'MeTo',
												title:
													'MeTo题库：自动搜题并获取真实答案（两阶段请求），使用 GM_xmlhttpRequest 跨域。\n需要 @connect m.metst.cn 或使用全域名通用版。'
											},
											'MeTo题库'
										),
										h(
											'option',
											{
												title:
													'大学生网课题库接口适配器: 将不同的题库整合为一个API接口。详细查看 https://github.com/DokiDoki1103/tikuAdapter'
											},
											'TikuAdapter'
										)
									]
								)
							);

							const modal = $modal.prompt({
								width: 600,
								maskCloseable: false,
								content: $ui.notes([
									[h('div', ['题库配置填写教程：', h('a', { href: PROJECT_REPO, target: '_blank' }, PROJECT_REPO)])],
									[
										h('div', [
											'⚠️ 如果无法粘贴，请点->：',
											h('button', '读取剪贴板', (btn) => {
												btn.classList.add('base-style-button');
												btn.onclick = () => {
													navigator.clipboard.readText().then((result) => {
														textarea.value = result;
													});
												};
											}),
											'，并同意浏览器上方的剪贴板读取申请。'
										])
									],
									['⚠️ 如果想添加多个不同的题库配置，请在每个配置之间使用三个井号隔开: ###。'],
									['⚠️ 配置第三方题库出现网页弹窗的，点击永久允许连接。'],
									...(aw.length ? [list] : [])
								]),
								footer: h('div', { style: { width: '100%' } }, [
									textarea,
									h('div', { style: { display: 'flex', flexWrap: 'wrap', marginTop: '12px', fontSize: '12px' } }, [
										h('div', ['解析器：', select], (div) => {
											div.style.marginRight = '12px';
											div.style.flex = '1';
										}),
										h('div', { style: { flex: '1', display: 'flex', flexWrap: 'wrap', justifyContent: 'end' } }, [
											h('button', '清空题库配置', (btn) => {
												btn.className = 'modal-cancel-button';
												btn.style.marginRight = '48px';
												btn.onclick = () => {
													$modal.confirm({
														content: '确定要清空题库配置吗？',
														onConfirm: () => {
															$message.success({ content: '已清空，在答题前请记得重新配置。' });
															modal?.remove();
															CommonProject.scripts.settings.cfg.answererWrappers = [];
															this.value = '点击配置';
														}
													});
												};
											}),
											h('button', '关闭', (btn) => {
												btn.className = 'modal-cancel-button';
												btn.style.marginRight = '12px';
												btn.onclick = () => modal?.remove();
											}),
											h('button', '保存配置', (btn) => {
												btn.className = 'modal-confirm-button';
												btn.onclick = async () => {
													const connects: string[] = $gm.getMetadataFromScriptHead('connect');

													const value = textarea.value;

													if (!value && select.value !== 'MeTo') {
														$modal.alert({
															content: h('div', '不能为空！')
														});
														return;
													}
													if (value.includes('adapter-service/search') && (select.value === 'TikuAdapter') === false) {
														$modal.alert({
															content: h('div', [
																'检测到您可能正在使用 ',
																h(
																	'a',
																	{ href: 'https://github.com/DokiDoki1103/tikuAdapter#readme' },
																	'TikuAdapter 题库'
																),
																'，但是您选择的解析器不是 TikuAdapter，请选择 TikuAdapter 解析器，并填写接口地址即可，例如：http://localhost:8060/adapter-service/search，或者忽略此警告。'
															]),
															confirmButtonText: '切换至 TikuAdapter 解析器，并识别接口地址',
															onConfirm() {
																const origin =
																	textarea.value.match(/http:\/\/(.+)\/adapter-service\/search/)?.[1] || '';
																textarea.value = `http://${origin}/adapter-service/search`;
																select.value = 'TikuAdapter';
															}
														});
														return;
													}

													try {
														let awsResult: AnswererWrapper[] = [];
														if (select.value === 'MeTo') {
															select.value = '默认';
															const metoConfig = getResolvedMetoAuthConfig();
															if (!metoConfig.tkUid) {
																$modal.alert({ content: 'MeTo 认证缺少 tk_uid，请先在全局设置中填写。' });
																return;
															}
															if (!metoConfig.poolId) {
																$modal.alert({
																	content: 'MeTo 认证缺少 poolId，请填写 poolId，或者填写 user_id + pp 后重新计算。'
																});
																return;
															}
															awsResult.push(createMetoAnswererWrapper());
														} else if (select.value === 'TikuAdapter') {
															if (value.startsWith('http') === false) {
																$modal.alert({
																	content: h('div', [
																		'格式错误，TikuAdapter解析器只能解析 url 链接，请重新输入！或者查看：',
																		h(
																			'a',
																			{ href: 'https://github.com/DokiDoki1103/tikuAdapter#readme' },
																			'https://github.com/DokiDoki1103/tikuAdapter#readme'
																		)
																	])
																});
																return;
															}
															select.value = '默认';
															awsResult.push({
																name: 'TikuAdapter题库',
																url: value,
																homepage: 'https://github.com/DokiDoki1103/tikuAdapter',
																method: 'post',
																type: 'GM_xmlhttpRequest',
																contentType: 'json',
																headers: {},
																data: {
																	// eslint-disable-next-line no-template-curly-in-string
																	question: '${title}',
																	options: {
																		handler: "return (env)=>env.options?.split('\\n')"
																	},
																	type: {
																		handler:
																			" return (env)=> env.type === 'single' ? 0 : env.type === 'multiple' ? 1 : env.type === 'completion' ? 3 : env.type === 'judgement' ? 4 : undefined"
																	}
																},
																handler: "return (res)=>res.answer.allAnswer.map(i=>([res.question,i.join('#')]))"
															});
														} else {
															const contents = value
																.split('###')
																.map((i) => i.trim())
																.filter(Boolean);
															for (const content of contents) {
																awsResult.push(...(await AnswerWrapperParser.from(content)));
															}
														}

														// 为空判断
														if (awsResult.length === 0) {
															$modal.alert({ content: '题库配置不能为空，请重新配置。' });
															return;
														}

														// 唯一化处理
														const result_set: AnswererWrapper[] = [];
														for (const res of awsResult) {
															if (result_set.find((i) => JSON.stringify(i) === JSON.stringify(res))) {
																continue;
															}
															result_set.push(res);
														}
														awsResult = result_set;

														// 判断新旧是否一致，如果一致则提示
														if (
															JSON.stringify(CommonProject.scripts.settings.cfg.answererWrappers) ===
															JSON.stringify(awsResult)
														) {
															$modal.alert({ content: h('div', ['题库配置没有变化，请重新配置！']) });
															return;
														}

														CommonProject.scripts.settings.cfg.answererWrappers = awsResult;
														this.value = '当前有' + awsResult.length + '个可用题库';
														$modal.confirm({
															width: 600,
															content: h('div', [
																h('div', [
																	'🎉 配置成功，',
																	h('b', ' 刷新网页后 '),
																	'重新进入',
																	h('b', ' 答题页面 '),
																	'即可。',
																	'解析到的题库如下所示:'
																]),
																...createAnswererWrapperList(awsResult)
															]),
															onConfirm: () => {
																if ($gm.isInGMContext()) {
																	top?.document.location.reload();
																}
															},
															...($gm.isInGMContext()
																? {
																		confirmButtonText: '立即刷新',
																		cancelButtonText: '稍后刷新'
																  }
																: {})
														});

														// 格式化文本
														textarea.value = JSON.stringify(awsResult, null, 4);

														// 检测 connects.length 是因为 如果在软件的软件设置全局配置中，上下文的 GM_info 会变成空
														if (connects.length) {
															// 检测是否有域名白名单
															const notAllowed: string[] = [];

															// 如果是通用版本，则不检测
															if (connects.includes('*')) {
																return;
															}

															for (const aw of awsResult) {
																if (connects.some((connect) => new URL(aw.url).hostname.includes(connect)) === false) {
																	notAllowed.push(aw.url);
																}
															}
															if (notAllowed.length) {
																$modal.alert({
																	width: 600,
																	maskCloseable: false,
																	title: '⚠️警告',
																	content: h('div', [
																		h('div', [
																			'配置成功，但检测到以下 域名/ip 不在脚本的白名单中，请安装 : ',
																			h(
																				'a',
																				{
																					href: PROJECT_REPO
																				},
																				'南城派全域名通用版'
																			),
																			'，或者手动添加 @connect ，否则无法进行请求。',
																			h(
																				'ul',
																				notAllowed.map((url) => h('li', new URL(url).hostname))
																			)
																		])
																	])
																});
															}
														}
													} catch (e: any) {
														$modal.alert({
															content: h('div', [h('div', '解析失败，原因如下 :'), h('div', e.message)])
														});
													}
												};
											})
										])
									])
								])
							});
						};
					}
				},
				metoServer: {
					label: 'MeTo 服务地址',
					defaultValue: 'https://m.metst.cn',
					attrs: {
						title: '直接请求远程题库，不需要本地代理或本地端口。可切换为 https://m.metost.com。'
					}
				},
				metoTkUid: {
					label: 'MeTo tk_uid (ti_uid)',
					defaultValue: '397265',
					attrs: {
						title: 'MeTo 题库认证中的 tk_uid / ti_uid。'
					}
				},
				metoPoolId: {
					label: 'MeTo poolId',
					defaultValue: '2efc793b-661c-1760-d1ad-e51614113424',
					attrs: {
						title: 'MeTo 题库认证中的 poolId。留空时可通过 user_id + pp 自动计算。'
					}
				},
				metoPp: {
					label: 'MeTo pp (密钥种子)',
					defaultValue: '9ffb0a9f',
					attrs: {
						title: 'MeTo 题库认证中的 pp，用于重新计算 poolId。'
					}
				},
				metoUserId: {
					label: 'MeTo user_id',
					defaultValue: '',
					attrs: {
						title: '平台用户ID，可选。填写后可配合 pp 重新计算 poolId。'
					}
				},
				metoCalcPoolId: {
					label: '重算 MeTo poolId',
					defaultValue: '根据 user_id + pp 重算',
					attrs: {
						type: 'button'
					},
					onload() {
						this.onclick = () => {
							const { metoUserId, metoPp } = CommonProject.scripts.settings.cfg;
							if (!String(metoUserId || '').trim() || !String(metoPp || '').trim()) {
								$message.warn({ content: '请先填写 MeTo user_id 和 pp。' });
								return;
							}

							CommonProject.scripts.settings.cfg.metoPoolId = calculateMetoPoolId(
								String(metoUserId).trim(),
								String(metoPp).trim()
							);
							$message.success({ content: 'MeTo poolId 已重新计算。' });
						};
					}
				},
				aiEnable: {
					label: 'AI 兜底答题',
					defaultValue: false,
					attrs: {
						type: 'checkbox',
						title:
							'题库全部搜不到答案时，调用 AI（OpenAI 兼容接口，默认 DeepSeek）作答。AI 答案会写入题库缓存（与在线题库同级），取得标准答案后会被自动覆盖。'
					}
				},
				aiBaseUrl: {
					label: 'AI 接口地址',
					defaultValue: 'https://api.deepseek.com',
					showIf: 'common.settings.aiEnable',
					attrs: {
						title: 'OpenAI 兼容接口的 base URL，会自动拼接 /chat/completions。'
					}
				},
				aiApiKey: {
					label: 'AI API Key',
					defaultValue: '',
					showIf: 'common.settings.aiEnable',
					attrs: {
						type: 'password',
						title:
							'DeepSeek 开放平台创建的 API Key，仅保存在本机浏览器中。注意：“导出全部设置”的文件会包含此 Key，请勿分享设置文件。'
					}
				},
				aiModel: {
					label: 'AI 模型',
					defaultValue: 'deepseek-flash',
					showIf: 'common.settings.aiEnable',
					attrs: {
						title: 'DeepSeek Flash 模型名为 deepseek-flash（旧名 deepseek-v4-flash 已停用，仍被兼容）。'
					}
				},
				aiUseImages: {
					label: 'AI 识别图片',
					defaultValue: true,
					showIf: 'common.settings.aiEnable',
					attrs: {
						type: 'checkbox',
						title:
							'题目或选项中包含图片时，把图片一并发送给 AI（模型需支持图片输入，DeepSeek 的 deepseek-flash 支持）。接口返回不支持图片时会自动退回仅文字。'
					}
				},
				aiThinking: {
					label: 'AI 深度思考',
					defaultValue: true,
					showIf: 'common.settings.aiEnable',
					attrs: {
						type: 'checkbox',
						title:
							'开启后 AI 会先推理再回答，复杂题（计算、电路等）更准，但明显更慢也更耗费额度；如果响应太慢可以关闭。返回空内容时会自动关闭思考重试。'
					}
				},
				aiWebSearch: {
					label: 'AI 不确定时联网搜索',
					defaultValue: true,
					showIf: 'common.settings.aiEnable',
					attrs: {
						type: 'checkbox',
						title:
							'AI 没有把握（信心不足或给不出答案）时，自动联网搜索后再作答。优先使用 DeepSeek 原生联网搜索（服务端多轮搜索，较慢且更耗额度），不可用时回退为抓取 Bing / DuckDuckGo 网页结果。'
					}
				},
				aiExtraBody: {
					label: 'AI 额外请求参数',
					defaultValue: '',
					tag: 'textarea',
					showIf: 'common.settings.aiEnable',
					attrs: {
						title:
							'可选，JSON 对象，会合并到请求体中，例如 {"thinking":{"type":"disabled"}}。DeepSeek 官方接口暂无联网搜索参数，如使用支持联网的中转/网关，可在此填写其参数。',
						style: { minWidth: '200px', minHeight: '50px' }
					}
				},
				upload: {
					label: '答题完成后',
					tag: 'select',
					defaultValue: 80 as WorkUploadType,
					options: [
						['save', '自动保存', '完成后自动保存答案, 注意如果你开启了随机作答, 有可能分辨不出答案是否正确。'],
						['nomove', '不保存也不提交', '等待时间过后将会自动下一节, 适合在测试脚本时使用。'],
						...([10, 20, 30, 40, 50, 60, 70, 80, 90].map((rate) => [
							rate,
							`搜到${rate}%的题目则自动提交`,
							`例如: 100题中查询到 ${rate} 题的答案,（答案不一定正确）, 则会自动提交；未达到阈值时会自动保存。`
						]) as [any, string, string][]),
						['100', '每个题目都查到答案才自动提交', '答案不一定正确，未达到阈值时会自动保存'],
						['force', '强制自动提交', '不管答案是否正确直接强制自动提交，如需开启，请配合随机作答谨慎使用。']
					],
					attrs: {
						title:
							'自动答题完成后的保存/提交设置。超星章节测试、作业/考试均会按此完成率判断是否自动提交；未达到阈值时会优先自动保存。'
					}
				},
				thread: {
					label: '线程数量（个）',
					attrs: {
						type: 'number',
						min: 1,
						step: 1,
						max: 3,
						title:
							'同一时间内答题线程工作的数量（例子：三个线程则代表一秒内同时搜索三道题），过多可能导致题库服务器压力过大，请适当调低。'
					},
					defaultValue: 1
				},
				'work-when-no-job': {
					defaultValue: false,
					label: '(仅超星)强制答题',
					attrs: {
						type: 'checkbox',
						title:
							'当章节测试左上角并没有黄色任务点的时候依然进行答题（没有任务点说明此作业可能不计入总成绩，如果老师要求则可以开启）'
					}
				},
				'randomWork-choice': {
					defaultValue: false,
					label: '(仅超星)随机选择',
					attrs: { type: 'checkbox', title: '题库搜索不到答案时，随机选择任意一个选项' }
				},
				'randomWork-complete': {
					defaultValue: false,
					label: '(仅超星)随机填空',
					attrs: { type: 'checkbox', title: '题库搜索不到答案时，随机填写以下任意一个文案' }
				},
				'randomWork-completeTexts-textarea': {
					defaultValue: ['不会', '不知道', '不清楚', '不懂', '不会写'].join('\n'),
					label: '(仅超星)随机填空文案',
					tag: 'textarea',
					showIf: 'common.settings.randomWork-complete',
					attrs: { title: '每行一个，随机填入', style: { minWidth: '200px', minHeight: '50px' } },
					onload(el) {
						el.addEventListener('change', () => {
							if (String(el.value).trim() === '') {
								el.value = el.defaultValue;
							}
						});
					}
				},
				'chapterTest-autoRetake': {
					defaultValue: false,
					label: '(仅超星)错题回填重答',
					attrs: {
						type: 'checkbox',
						title:
							'超星章节测试/作业页未全部完成时，自动随机补答未完成题目并强制提交；提交后尝试查看正确答案、写入本地题库缓存，再点击重做并用缓存答案重新答题。'
					}
				},
				advancedSettings: {
					...dropdownStyle,
					defaultValue: false,
					label: '高级设置',
					attrs: { type: 'checkbox', title: '请谨慎使用高级设置，可能会影响答题效果，小白在未理解的情况下谨慎调整。' }
				},
				answerWrapperHandlerTimeout: {
					showIf: 'common.settings.advancedSettings',
					elementClassName: 'config-details',
					label: '搜题最大耗时（秒）',
					attrs: {
						type: 'number',
						min: 10,
						step: 1,
						max: 3 * 60,
						title: '搜题超时时间，单位为秒，超过这个时间直接放弃，进行下一题搜索。'
					},
					defaultValue: 120
				},
				stopSecondWhenFinish: {
					showIf: 'common.settings.advancedSettings',
					elementClassName: 'config-details',
					label: '答题结束后暂停（秒）',
					attrs: {
						type: 'number',
						min: 3,
						step: 1,
						max: 9999,
						title: '自动答题脚本结束后暂停的时间（方便查看和检查）。'
					},
					defaultValue: 3
				},
				period: {
					showIf: 'common.settings.advancedSettings',
					elementClassName: 'config-details',
					label: '搜题间隔（秒）',
					attrs: {
						type: 'number',
						min: 1,
						step: 1,
						max: 60,
						title: '每道题的搜题间隔时间，不建议太低，避免增加服务器压力。'
					},
					defaultValue: 3
				},
				answerSeparators: {
					showIf: 'common.settings.advancedSettings',
					elementClassName: 'config-details',
					label: '答案分隔符',
					attrs: {
						title: "分隔答案的符号，例如：答案1#答案2#答案3，分隔符为 #， 使用英文逗号进行隔开 : ',' "
					},
					defaultValue: ['===', '#', '---', '###', '|', ';', '；'].join(','),
					onload(el) {
						el.addEventListener('change', () => {
							if (String(el.value).trim() === '') {
								el.value = el.defaultValue;
							}
						});
					}
				},
				answerMatchMode: {
					showIf: 'common.settings.advancedSettings',
					elementClassName: 'config-details',
					label: '答案匹配模式',
					tag: 'select',
					defaultValue: 'similar' as AnswerMatchMode,
					options: [
						['similar', '相似匹配', '答案相似度达到60%以上就匹配'],
						['exact', '精确匹配', '答案必须完全一致才匹配']
					]
				},
				redundanceWordsText: {
					showIf: 'common.settings.advancedSettings',
					elementClassName: 'config-details',
					defaultValue: [
						'单选题(必考)',
						'填空题(必考)',
						'多选题(必考)',
						'(单选题)',
						'(多选题)',
						'(判断题)',
						'(填空题)',
						'【单选题】',
						'【多选题】',
						'【填空题】',
						'【判断题】',
						'【單選题】',
						'【多選题】',
						'【判斷题】',
						'【Single Choice】',
						'【Multiple Choice】',
						'【single choice】',
						'【multiple choice】',
						'【True or False】'
					].join('\n'),
					label: '题目冗余字段自动删除',
					tag: 'textarea',
					attrs: {
						title: '在搜题的时候自动删除多余的文字，以便提高搜题的准确度，每行一个。',
						style: { minWidth: '200px', minHeight: '50px' }
					},
					onload(el) {
						el.addEventListener('change', () => {
							if (String(el.value).trim() === '') {
								el.value = el.defaultValue;
							}
						});
					}
				},
				notification: {
					separator: '其他设置',
					label: '系统通知',
					attrs: {
						title:
							'允许脚本发送系统通知，只有重要事情发生时会发送系统通知，尽量避免用户受到骚扰（在电脑屏幕右侧显示通知弹窗，例如脚本执行完毕，图形验证码，版本更新等通知）。'
					},
					tag: 'select',
					defaultValue: 'only-notify' as 'only-notify' | 'notify-and-voice' | 'all' | 'no-notify',
					options: [
						['only-notify', '只显示右下角通知'],
						['notify-and-voice', '通知以及提示音（叮的一声）'],
						['all', '通知，提示音，以及任务栏闪烁提示'],
						['no-notify', '关闭系统通知']
					]
				},
				notificationWebhooks: {
					label: '通知回调',
					attrs: {
						title:
							// eslint-disable-next-line no-template-curly-in-string
							'发送系统通知时发送回调请求，用于专业开发人员对接其他通知系统。（每行填写一个URL，顺序发送GET请求，${message} 为消息占位符，可用于消息变量替换）'
					},
					tag: 'textarea',
					defaultValue: ''
				},
				enableQuestionCaches: {
					label: '题库缓存功能',
					defaultValue: true,
					attrs: { type: 'checkbox', title: '详情请前往 通用-其他应用-题库拓展查看。' }
				},
				cacheCrossCourse: {
					label: '跨课程使用缓存',
					defaultValue: false,
					showIf: 'common.settings.enableQuestionCaches',
					attrs: {
						type: 'checkbox',
						title:
							'默认只使用当前课程（以及未记录课程的旧缓存）中的答案，避免不同课程中题干相同但答案不同的题目互相干扰。开启后会使用所有课程的缓存。'
					}
				},
				autoStart: {
					separator: '运行控制',
					label: '自动开始',
					defaultValue: true,
					attrs: {
						type: 'checkbox',
						title: '进入学习/答题页面后是否自动开始运行，关闭后需手动点击开始按钮'
					}
				},
				scheduledShutdown: {
					label: '定时关闭',
					defaultValue: false,
					attrs: { type: 'checkbox', title: '到达设定时间后自动关闭页面，停止刷课' }
				},
				shutdownTime: {
					label: '关闭时间',
					defaultValue: '23:30',
					attrs: { type: 'time', title: '到达此时间后关闭页面（格式 HH:MM）' }
				}
			},
			methods() {
				return {
					/**
					 * 获取自动答题配置，包括题库配置
					 */
					getWorkOptions: () => {
						// 使用 json 深拷贝，防止修改原始配置
						const workOptions: typeof this.cfg = JSON.parse(JSON.stringify(this.cfg));

						/**
						 * 过滤掉被禁用的题库
						 */
						workOptions.answererWrappers = workOptions.answererWrappers.filter(
							(aw) => this.cfg.disabledAnswererWrapperNames.find((daw) => daw === aw.name) === undefined
						);

						return workOptions;
					},
					/**
					 * 根据全局设置的配置，发起通知
					 * @param content
					 * @param opts
					 */
					notificationBySetting: (
						content: string,
						opts?: {
							extraTitle?: string;
							/** 显示时间，单位为秒，默认为 30 秒， 0 则表示一直存在 */
							duration?: number;
							/** 通知点击时 */
							onclick?: () => void;
							/** 通知关闭时 */
							ondone?: () => void;
						}
					) => {
						if (this.cfg.notification !== 'no-notify') {
							$gm.notification(content, {
								extraTitle: opts?.extraTitle,
								duration: opts?.duration ?? 30,
								important: this.cfg.notification === 'all',
								silent: this.cfg.notification === 'only-notify'
							});

							const message = (opts?.extraTitle ? opts?.extraTitle + '：' : '') + content;

							const webhooks = this.cfg.notificationWebhooks
								.split('\n')
								.map((i) => i.trim())
								.filter(Boolean);

							for (const webhook of webhooks) {
								let resolved_webhook = webhook;
								// eslint-disable-next-line no-template-curly-in-string
								resolved_webhook = webhook.replace('${message}', encodeURIComponent(message));
								request(resolved_webhook, {
									method: 'get',
									type: 'GM_xmlhttpRequest'
								})
									.then((result) => {
										console.debug('通知回调成功', { webhook: resolved_webhook, result });
									})
									.catch((err) => {
										console.debug('通知回调失败', { webhook: resolved_webhook, err });
									});
							}
						}
					}
				};
			},
			// 实时更新内部设置
			oncomplete() {
				AnswerWrapperHandlerConfig.timeout_seconds = this.cfg.answerWrapperHandlerTimeout;
				this.onConfigChange('answerWrapperHandlerTimeout', (sec) => {
					AnswerWrapperHandlerConfig.timeout_seconds = sec;
				});

				// 定时关闭检查
				const checkShutdown = () => {
					if (this.cfg.scheduledShutdown && this.cfg.shutdownTime) {
						const now = new Date();
						const parts = this.cfg.shutdownTime.split(':').map(Number);
						if (now.getHours() === parts[0] && now.getMinutes() === parts[1]) {
							$message.warn({ content: '定时关闭：即将关闭页面...', duration: 5 });
							setTimeout(() => {
								try {
									window.close();
								} catch {
									// window.close() 可能被浏览器阻止
									$message.warn({ content: '浏览器阻止了自动关闭，请手动关闭页面。', duration: 0 });
								}
							}, 5000);
						}
					}
				};
				setInterval(checkShutdown, 30 * 1000);
			},
			onrender({ panel }) {
				// 因为需要用到 GM_xhr 所以判断是否处于用户脚本环境
				if ($gm.isInGMContext()) {
					panel.body.replaceChildren(...(this.cfg.answererWrappers.length ? [h('hr')] : []));
					const testNotification = h(
						'button',
						{ className: 'base-style-button', disabled: this.cfg.answererWrappers.length === 0 },
						'📢测试系统通知'
					);
					testNotification.onclick = () => {
						this.methods.notificationBySetting('这是一条测试通知');
					};
					const refresh = h(
						'button',
						{ className: 'base-style-button', disabled: this.cfg.answererWrappers.length === 0 },
						'🔄️刷新题库状态'
					);
					refresh.onclick = () => {
						updateState();
					};
					const tableContainer = h('div');
					refresh.style.display = 'none';
					tableContainer.style.display = 'none';
					panel.body.append(h('div', { style: { display: 'flex' } }, [testNotification, refresh]), tableContainer);

					// 更新题库状态
					const updateState = async () => {
						// 清空元素
						tableContainer.replaceChildren();
						let loadedCount = 0;

						if (this.cfg.answererWrappers.length) {
							refresh.style.display = 'block';
							tableContainer.style.display = 'block';
							refresh.textContent = '🚫正在加载题库状态...';
							refresh.setAttribute('disabled', 'true');

							const table = h('table');
							table.style.width = '100%';
							this.cfg.answererWrappers.forEach(async (item) => {
								const t = Date.now();
								let success = false;
								let error;
								const isDisabled = this.cfg.disabledAnswererWrapperNames.find((name) => name === item.name);

								const res = isDisabled
									? false
									: await Promise.race([
											(async () => {
												try {
													return await request(new URL(item.url).origin + '/?t=' + t, {
														type: 'GM_xmlhttpRequest',
														method: 'head',
														responseType: 'text'
													});
												} catch (err) {
													error = err;
													return false;
												}
											})(),
											(async () => {
												await $.sleep(10 * 1000);
												return false;
											})()
									  ]);
								if (typeof res === 'string') {
									success = true;
								} else {
									success = false;
								}

								const body = h('tbody');
								body.append(h('td', item.name));
								body.append(
									h('td', [
										$ui.tooltip(
											h(
												'span',
												{ title: isDisabled ? '题目已经被停用，请在上方题库配置中点击开启。' : '' },
												success ? '连接成功🟢' : isDisabled ? '已停用⚪' : error ? '连接失败🔴' : '连接超时🟡'
											)
										)
									])
								);
								body.append(h('td', `延迟 : ${success ? Date.now() - t : '---'}/ms`));
								table.append(body);
								loadedCount++;

								if (loadedCount === this.cfg.answererWrappers.length) {
									setTimeout(() => {
										refresh.textContent = '🔄️刷新题库状态';
										refresh.removeAttribute('disabled');
									}, 2000);
								}
							});
							tableContainer.append(table);
						} else {
							refresh.style.display = 'none';
							tableContainer.style.display = 'none';
						}
					};

					updateState();

					this.offConfigChange(state.setting.listenerIds.aw);
					state.setting.listenerIds.aw = this.onConfigChange('answererWrappers', (_, __, remote) => {
						if (remote === false) {
							updateState();
						}
					});
				}
			}
		}),
		workResults: new Script({
			name: '🔎 搜索结果',
			matches: [['所有页面', /.*/]],
			namespace: 'common.work-results',
			configs: {
				notes: {
					defaultValue: $ui.notes(['点击题目序号，查看搜索结果', '如果没有搜到，可能是题库没有收录该题目答案'])
						.outerHTML
				},
				/**
				 * 显示类型
				 * list: 显示为题目列表
				 * numbers: 显示为序号列表
				 */
				type: {
					label: '显示类型',
					tag: 'select',
					options: [
						['numbers', '序号列表'],
						['questions', '题目列表']
					],
					attrs: {
						title: '使用题目列表可能会造成页面卡顿。'
					},
					defaultValue: 'numbers' as 'questions' | 'numbers'
				},
				totalQuestionCount: {
					defaultValue: 0
				},
				requestedCount: {
					defaultValue: 0
				},
				resolvedCount: {
					defaultValue: 0
				},
				currentResultIndex: {
					defaultValue: 0
				},
				questionPositionSyncHandlerType: {
					defaultValue: undefined as keyof typeof state.workResult.questionPositionSyncHandler | undefined
				}
			},
			methods() {
				return {
					/**
					 * 从搜索结果中计算状态，并更新
					 */
					updateWorkStateByResults: (results: { requested: boolean; resolved: boolean }[]) => {
						this.cfg.totalQuestionCount = results.length;
						this.cfg.requestedCount = results.filter((result) => result.requested).length;
						this.cfg.resolvedCount = results.filter((result) => result.resolved).length;
					},
					/**
					 * 更新状态
					 */
					updateWorkState: (state: { totalQuestionCount: number; requestedCount: number; resolvedCount: number }) => {
						this.cfg.totalQuestionCount = state.totalQuestionCount;
						this.cfg.requestedCount = state.requestedCount;
						this.cfg.resolvedCount = state.resolvedCount;
					},
					/**
					 * 刷新状态
					 */
					refreshState: () => {
						this.cfg.totalQuestionCount = 0;
						this.cfg.requestedCount = 0;
						this.cfg.resolvedCount = 0;
					},
					/**
					 * 清空搜索结果
					 */
					clearResults: () => {
						return $store.setTab(TAB_WORK_RESULTS_KEY, []);
					},
					getResults(): Promise<SimplifyWorkResult[]> | undefined {
						return $store.getTab(TAB_WORK_RESULTS_KEY) || undefined;
					},
					setResults(results: SimplifyWorkResult[]) {
						return $store.setTab(TAB_WORK_RESULTS_KEY, results);
					},
					async appendResults(results: SimplifyWorkResult[]) {
						const data = (await $store.getTab(TAB_WORK_RESULTS_KEY)) || [];
						data.push(...results);
						return $store.setTab(TAB_WORK_RESULTS_KEY, data);
					},
					/**
					 * 刷新搜索结果状态，清空搜索结果，置顶搜索结果面板
					 */
					init(opts?: { questionPositionSyncHandlerType?: keyof typeof state.workResult.questionPositionSyncHandler }) {
						CommonProject.scripts.workResults.cfg.questionPositionSyncHandlerType =
							opts?.questionPositionSyncHandlerType;
						// 刷新搜索结果状态
						CommonProject.scripts.workResults.methods.refreshState();
						// 清空搜索结果
						CommonProject.scripts.workResults.methods.clearResults();
					},
					/**
					 * 创建搜索结果面板
					 * @param mount 挂载点
					 */
					createWorkResultsPanel: (mount?: HTMLElement) => {
						const root = mount || h('div');
						root.style.width = '400px';
						const container = h('div');
						root.replaceChildren(createManualSearchEntry(), container);
						/** 记录滚动高度 */
						let scrollPercent = 0;

						/** 列表 */
						const list = h('div', { className: 'work-result-list' });

						/** 是否悬浮在题目上 */
						let mouseoverIndex = -1;

						list.onscroll = () => {
							scrollPercent = list.scrollTop / list.scrollHeight;
						};

						/** 给序号设置样式 */
						const setNumStyle = (result: SimplifyWorkResult, num: HTMLElement, index: number) => {
							if (result.requested) {
								num.classList.add('requested');
							}

							if (index === this.cfg.currentResultIndex) {
								num.classList.add('active');
							}

							if (result.finish) {
								num.classList.add('finish');
							} else {
								if (
									result.requested &&
									result.resolved &&
									(result.error?.trim().length !== 0 || result.searchInfos.length === 0 || result.finish === false)
								) {
									num.classList.add('error');
								}
							}
						};

						/** 渲染结果面板 */
						const render = debounce(async () => {
							const results: SimplifyWorkResult[] | undefined =
								await CommonProject.scripts.workResults.methods.getResults();

							if (results?.length) {
								// 如果序号指向的结果为空，则代表已经被清空，则重新让index变成0
								if (results[this.cfg.currentResultIndex] === undefined) {
									this.cfg.currentResultIndex = 0;
								}

								// 渲染序号或者题目列表
								if (this.cfg.type === 'numbers') {
									const resultContainer = h('div', { className: 'work-result-container' });

									list.style.marginBottom = '12px';
									list.style.overflow = 'auto';
									list.style.maxHeight = '300px';

									/** 渲染序号 */
									const nums = results.map((result, index) => {
										return h('span', { className: 'search-infos-num', innerText: (index + 1).toString() }, (num) => {
											setNumStyle(result, num, index);

											num.onclick = () => {
												for (const n of nums) {
													n.classList.remove('active');
												}
												num.classList.add('active');
												// 更新显示序号
												this.cfg.currentResultIndex = index;
												// 重新渲染结果列表
												resultContainer.replaceChildren(createResult(result));
												// 触发页面题目元素同步器
												if (this.cfg.questionPositionSyncHandlerType) {
													state.workResult.questionPositionSyncHandler[this.cfg.questionPositionSyncHandlerType]?.(
														index
													);
												}
											};
										});
									});

									list.replaceChildren(...nums);
									// 初始显示指定序号的结果
									resultContainer.replaceChildren(createResult(results[this.cfg.currentResultIndex]));

									container.replaceChildren(list, resultContainer);
								} else {
									/** 左侧题目列表 */

									list.style.overflow = 'auto';
									list.style.maxHeight = window.innerHeight / 2 + 'px';

									/** 右侧结果 */
									const resultContainer = h('div', { className: 'work-result-question-container' });
									const nums: HTMLSpanElement[] = [];
									/** 左侧渲染题目列表 */
									const questions = results.map((result, index) => {
										/** 左侧序号 */
										const num = h(
											'span',
											{
												className: 'search-infos-num',
												innerHTML: (index + 1).toString()
											},
											(num) => {
												num.style.marginRight = '12px';
												num.style.display = 'inline-block';
												setNumStyle(result, num, index);
											}
										);

										nums.push(num);

										return h(
											'div',

											[num, result.question],
											(question) => {
												question.onmouseover = () => {
													mouseoverIndex = index;
													// 重新渲染结果列表
													resultContainer.replaceChildren(createResult(result));
												};

												question.onmouseleave = () => {
													mouseoverIndex = -1;
													// 重新显示指定序号的结果
													resultContainer.replaceChildren(createResult(results[this.cfg.currentResultIndex]));
												};

												question.onclick = () => {
													for (const n of nums) {
														n.classList.remove('active');
													}
													for (const q of questions) {
														q.classList.remove('active');
													}
													nums[index].classList.add('active');
													question.classList.add('active');
													// 更新显示序号
													this.cfg.currentResultIndex = index;
													// 重新渲染结果列表
													resultContainer.replaceChildren(createResult(result));
													// 触发页面题目元素同步器
													if (this.cfg.questionPositionSyncHandlerType) {
														state.workResult.questionPositionSyncHandler[this.cfg.questionPositionSyncHandlerType]?.(
															index
														);
													}
												};
											}
										);
									});

									list.replaceChildren(...questions);
									// 初始显示指定序号的结果
									if (mouseoverIndex === -1) {
										resultContainer.replaceChildren(createResult(results[this.cfg.currentResultIndex]));
									} else {
										resultContainer.replaceChildren(createResult(results[mouseoverIndex]));
									}

									container.replaceChildren(
										h('div', [list, h('div', {}, [resultContainer])], (div) => {
											div.style.display = 'flex';
										})
									);
								}
							} else {
								container.replaceChildren(
									h('div', { className: 'alert-info-wrapper' }, [
										h('div', '暂无任何搜索结果~', (div) => {
											div.style.marginTop = '12px';
											div.className = 'result-info no-answer';
										})
									])
								);
							}

							/** 恢复高度 */
							list.scrollTo({
								top: scrollPercent * list.scrollHeight,
								behavior: 'auto'
							});

							const tip = h('div', [
								h('div', { className: 'search-infos-num' }, '1'),
								' 表示等待处理中',
								h('br'),
								h('div', { className: 'search-infos-num requested' }, '1'),
								' 表示已完成搜索 ',
								h('br'),
								h('div', { className: 'search-infos-num finish' }, '1'),
								' 表示已搜索已答题 '
							]);

							/** 添加信息 */
							container.prepend(
								h('hr'),
								h(
									'div',
									[
										$ui.space(
											[
												h('span', `已搜题: ${this.cfg.requestedCount}/${this.cfg.totalQuestionCount}`),
												h('span', `已答题: ${this.cfg.resolvedCount}/${this.cfg.totalQuestionCount}`),
												h('a', '提示', (btn) => {
													btn.style.cursor = 'pointer';
													btn.onclick = () => {
														$modal.confirm({ content: tip, footer: undefined });
													};
												}),
												$ui.tooltip(
													h('a', '清空结果', (btn) => {
														btn.title = '仅用于不会自动清空搜索结果的场景，例如超星非整卷预览模式';
														btn.style.cursor = 'pointer';
														btn.onclick = () => {
															this.methods.clearResults();
															const { panel, header } = CXProject.scripts.work;
															if (panel && header) {
																CXProject.scripts.work.onrender?.({ panel, header });
																CommonProject.scripts.workResults.onrender?.({ panel, header });
															}
														};
													})
												)
											],
											{ separator: '|' }
										)
									],
									(div) => {
										div.style.textAlign = 'center';
										div.style.fontSize = '12px';
									}
								)
							);
						}, 100);

						/** 渲染结果列表 */
						const createResult = (result: SimplifyWorkResult | undefined) => {
							if (result) {
								let info: HTMLElement | null = null;

								if (result.requested === false && result.resolved === false) {
									info = h('div', { className: 'result-info unresolved' }, '等待搜索中... 🔍');
								} else if (result.error) {
									info = h('div', { className: 'result-info error' }, '❌ ' + result.error);
								} else if (result.searchInfos.length === 0) {
									info = h('div', { className: 'result-info no-answer' }, '❌ 题库没搜索到答案');
								} else {
									info = result.finish
										? null
										: result.resolved === false
										? h('div', { className: 'result-info unresolved' }, '等待顺序答题中... ⏱️')
										: h('div', { className: 'result-info error' }, '❌ 此题未完成, 可能是没有匹配的选项。');
								}

								return h('div', [
									h('div', { className: 'alert-info-wrapper' }, [info ?? h('div')]),
									h(SearchInfosElement, {
										infos: result.searchInfos,
										question: result.question,
										type: result.type
									})
								]);
							} else {
								return h('div', 'undefined');
							}
						};

						render();
						this.onConfigChange('type', render);
						this.onConfigChange('requestedCount', render);
						this.onConfigChange('resolvedCount', render);
						$store.addChangeListener(TAB_WORK_RESULTS_KEY, render);

						return root;
					}
				};
			},
			onrender({ panel }) {
				panel.body.replaceChildren(this.methods.createWorkResultsPanel());
			}
		}),
		onlineSearch: new Script({
			name: '🔎 在线搜题',
			matches: [['所有页面', /.*/]],
			namespace: 'common.online-search',
			configs: {
				notes: {
					defaultValue: '查题前请在 “通用-全局设置” 中设置题库配置，才能进行在线搜题。'
				},

				selectSearch: {
					label: '划词搜索',
					defaultValue: true,
					attrs: {
						type: 'checkbox',
						title:
							'使用鼠标滑动选择页面中的题目（包含图片）自动填入搜索框。仅当搜索框为空，或内容是上一次自动填入且未被修改时才会填入，清空搜索框后可重新自动填入。'
					}
				},
				searchValue: {
					sync: true,
					label: '搜索题目',
					tag: 'textarea',
					attrs: {
						placeholder: '输入题目，请尽量保证题目完整，不要漏字',
						style: {
							minWidth: '300px',
							minHeight: '64px'
						}
					},
					defaultValue: ''
				}
			},
			oncomplete() {
				document.addEventListener(
					'selectionchange',
					debounce(() => {
						if (!this.cfg.selectSearch) {
							return;
						}

						// 选中内容（图片会以链接形式保留，用于 AI 识别图片题）
						const val = getSelectionTextWithImages();
						if (!val) {
							return;
						}

						// 只在搜索框为空，或者里面的内容是上一次自动填入且用户没有修改过时才自动填入，
						// 避免覆盖用户正在编辑或已经搜索的内容；清空搜索框后即可重新自动填入。
						const autoFilledKey = 'common.online-search.auto-filled-value';
						const current = String(this.cfg.searchValue || '');
						const lastAutoFilled = String($store.get(autoFilledKey, '') || '');
						if (current.trim() === '' || current === lastAutoFilled) {
							this.cfg.searchValue = val;
							$store.set(autoFilledKey, val);
						}
					}, 500)
				);
			},
			onrender({ panel }) {
				panel.body.replaceChildren(createManualSearchEntry());
			}
		}),
		/** 渲染脚本，窗口渲染主要脚本 */
		render: RenderScript,
		hack: new Script({
			name: '页面复制粘贴限制解除',
			matches: [['所有页面', /.*/]],
			hideInPanel: true,
			onactive() {
				enableCopy([document, document.body]);
			},
			oncomplete() {
				enableCopy([document, document.body]);
				insertCopyableStyle();
				setTimeout(() => {
					enableCopy([document, document.body]);
					insertCopyableStyle();
				}, 3000);
			}
		}),
		disableDialog: new Script({
			name: '禁止弹窗',
			matches: [['所有页面', /.*/]],
			hideInPanel: true,
			priority: 1,
			onstart() {
				function disableDialog(msg: string) {
					$modal.alert({
						profile: '弹窗来自：' + location.origin,
						content: msg
					});
				}

				try {
					$gm.unsafeWindow.alert = disableDialog;
					window.alert = disableDialog;
				} catch (e) {
					console.error(e);
				}
			}
		}),
		apps: new Script({
			name: '📱 拓展应用',
			matches: [['', /.*/]],
			namespace: 'common.apps',
			configs: {
				notes: {
					defaultValue: '这里是一些其他的应用或者拓展功能。'
				},
				/**
				 * 题库缓存
				 */
				localQuestionCaches: {
					defaultValue: [] as QuestionCache[],
					extra: {
						appConfigSync: false
					}
				}
			},
			methods() {
				return {
					/**
					 * 添加题库缓存
					 */
					addQuestionCache: async (...questionCacheItems: QuestionCache[]) => {
						const questionCaches: QuestionCache[] = this.cfg.localQuestionCaches;
						const currentScope = getQuestionCacheScope();

						for (const raw of [...questionCacheItems].reverse()) {
							const item: QuestionCache = {
								...raw,
								title: String(raw.title || '').trim(),
								scope: raw.scope ?? currentScope,
								source: getQuestionCacheSource(raw),
								time: raw.time || Date.now()
							};
							item.ai = item.source === 'ai';
							if (!item.title || !item.answer) {
								continue;
							}
							const rank = QUESTION_CACHE_SOURCE_RANK[item.source as QuestionCacheSource];

							const itemKey = normalizeCacheTitle(item.title);
							// 同一课程范围内的同题缓存
							const isPeer = (c: QuestionCache) =>
								normalizeCacheTitle(c.title) === itemKey && (c.scope || '') === (item.scope || '');
							// 没有课程信息的旧缓存，标准答案同样可以覆盖它
							const isLegacy = (c: QuestionCache) =>
								normalizeCacheTitle(c.title) === itemKey && !c.scope && Boolean(item.scope);

							if (item.source === 'standard') {
								// 标准答案：直接覆盖同题的所有旧答案（包括旧的错误答案、AI 答案）
								for (let index = questionCaches.length - 1; index >= 0; index--) {
									if (isPeer(questionCaches[index]) || isLegacy(questionCaches[index])) {
										questionCaches.splice(index, 1);
									}
								}
								questionCaches.unshift(item);
								continue;
							}

							const peers = questionCaches.filter(isPeer);
							// 已有可信度更高的答案时，不再写入
							if (peers.some((c) => QUESTION_CACHE_SOURCE_RANK[getQuestionCacheSource(c)] > rank)) {
								continue;
							}
							// 可信度更高的新答案，替换掉较低的旧答案（例如在线题库答案替换 AI 答案）
							for (let index = questionCaches.length - 1; index >= 0; index--) {
								const cache = questionCaches[index];
								if (isPeer(cache) && QUESTION_CACHE_SOURCE_RANK[getQuestionCacheSource(cache)] < rank) {
									questionCaches.splice(index, 1);
								}
							}
							// 去重
							if (!questionCaches.some((c) => isPeer(c) && c.answer === item.answer)) {
								questionCaches.unshift(item);
							}
						}

						this.cfg.localQuestionCaches = questionCaches;
					},
					addQuestionCacheFromWorkResult(swr: SimplifyWorkResult[]) {
						const scope = getQuestionCacheScope();
						CommonProject.scripts.apps.methods.addQuestionCache(
							...swr
								.map((r) =>
									r.searchInfos
										.map((i) =>
											i.results
												// 不相关的题库结果（题干相似度过低、占位答案）不写入缓存，避免污染
												.filter(
													(res) =>
														res[1] &&
														isCredibleAnswer(r.question, { question: res[0], answer: res[1], extra_data: res[2] })
												)
												.map((res) => {
													const extra = (res[2] || {}) as {
														ai?: boolean;
														source?: QuestionCacheSource;
														option?: string;
														answerText?: string;
													};
													return {
														title: r.question,
														answer: res[1],
														from: i.name.replace(/【题库缓存】/g, ''),
														homepage: i.homepage || '',
														scope,
														source: extra.ai ? 'ai' : extra.source || 'bank',
														option: extra.option,
														content: extra.answerText
													} as QuestionCache;
												})
										)
										.flat()
								)
								.flat()
						);
					},
					/**
					 * 将题库缓存作为题库并进行题目搜索
					 * @param title 题目
					 * @param whenSearchEmpty 当搜索结果为空，或者题库缓存功能被关闭时执行的函数
					 */
					searchAnswerInCaches: async (
						title: string,
						whenSearchEmpty: () => SearchInformation[] | Promise<SearchInformation[]>,
						/** 当前题目的选项文字，用于校验缓存答案是否能匹配到选项（可选） */
						optionTexts: string[] = []
					): Promise<SearchInformation[]> => {
						if (CommonProject.scripts.settings.cfg.enableQuestionCaches === false) {
							return await whenSearchEmpty();
						}

						let results: SearchInformation[] = [];
						const scope = getQuestionCacheScope();
						const titleKey = normalizeCacheTitle(title);
						const allowCrossCourse = Boolean(CommonProject.scripts.settings.cfg.cacheCrossCourse);

						let caches = (this.cfg.localQuestionCaches as QuestionCache[])
							// 题干相同，并且不属于其他课程（未识别课程的旧缓存对所有课程通用）
							.filter(
								(cache) =>
									normalizeCacheTitle(cache.title) === titleKey &&
									(allowCrossCourse || !scope || !cache.scope || cache.scope === scope)
							);

						// 填空题答案里只有“第一空：”这样的标签（没有内容）的缓存是无效数据：清除；
						// 带有标签的有效答案去掉标签，避免把“第一空：”填进输入框
						const junkCaches = caches.filter((c) => isBlankAnswerJunk(c.answer));
						if (junkCaches.length) {
							const isJunk = (c: QuestionCache) =>
								normalizeCacheTitle(c.title) === titleKey && isBlankAnswerJunk(c.answer);
							this.cfg.localQuestionCaches = (this.cfg.localQuestionCaches as QuestionCache[]).filter(
								(c) => !isJunk(c)
							);
							caches = caches.filter((c) => !isBlankAnswerJunk(c.answer));
						}
						caches = caches.map((c) =>
							/第\s*[一二三四五六七八九十\d]+\s*空/.test(c.answer) ? { ...c, answer: cleanBlankAnswer(c.answer) } : c
						);

						// 只使用可信度最高的一类答案：标准答案 > 在线题库 = AI
						const bestRank = Math.max(0, ...caches.map((c) => QUESTION_CACHE_SOURCE_RANK[getQuestionCacheSource(c)]));
						caches = caches.filter((c) => QUESTION_CACHE_SOURCE_RANK[getQuestionCacheSource(c)] === bestRank);

						// 同一类答案中，优先使用本课程的缓存
						const sameScopeCaches = caches.filter((c) => scope && c.scope === scope);
						if (sameScopeCaches.length) {
							caches = sameScopeCaches;
						}

						// 缓存答案与当前选项都对不上（例如过去被模糊搜索污染的缓存）：忽略并清除这些缓存，重新搜索
						if (
							caches.length &&
							!isAnswerUsableForOptions(
								caches.map((c) => c.answer),
								optionTexts
							)
						) {
							const stale = caches.filter((c) => getQuestionCacheSource(c) !== 'standard');
							if (stale.length) {
								const isStale = (c: QuestionCache) =>
									normalizeCacheTitle(c.title) === titleKey &&
									stale.some((x) => x.answer === c.answer && x.from === c.from && (x.scope || '') === (c.scope || ''));
								this.cfg.localQuestionCaches = (this.cfg.localQuestionCaches as QuestionCache[]).filter(
									(c) => !isStale(c)
								);
							}
							caches = [];
						}

						for (const cache of caches) {
							const source = getQuestionCacheSource(cache);
							results.push({
								name: cache.from,
								homepage: cache.homepage,
								results: [
									{
										answer: cache.answer,
										question: cache.title,
										extra_data: {
											ai: source === 'ai',
											cache: true,
											source,
											...(cache.option ? { option: cache.option } : {}),
											...(cache.content ? { answerText: cache.content } : {})
										}
									}
								]
							});
						}
						if (results.length === 0) {
							results = await whenSearchEmpty();
						}
						return results;
					},
					/**
					 * 查看更新日志
					 */
					async showChangelog() {
						const changelog = h('div', {
							className: 'markdown card',
							innerHTML: '加载中...',
							style: { maxWidth: '600px' }
						});
						$modal.simple({
							width: 600,
							content: h('div', [
								h('div', { className: 'notes card' }, [
									$ui.notes(['此页面实时更新，遇到问题可以查看最新版本是否修复。'])
								]),
								changelog
							])
						});
						const md = await request(PROJECT_CHANGELOG + '?t=' + Date.now(), {
							type: 'GM_xmlhttpRequest',
							responseType: 'text',
							method: 'get'
						});
						changelog.innerHTML = markdown(md);
					}
				};
			},
			onrender({ panel }) {
				const btnStyle: Partial<CSSStyleDeclaration> = {
					padding: '6px 12px',
					margin: '4px',
					marginBottom: '8px',
					boxShadow: '0px 0px 4px #bebebe',
					borderRadius: '8px',
					cursor: 'pointer'
				};

				const cachesBtn = h('div', { innerText: '💾 题库缓存', style: btnStyle }, (btn) => {
					btn.onclick = () => {
						const countEl = h('span', ['当前缓存数量：' + this.cfg.localQuestionCaches.length]);
						/** 重新渲染缓存列表（在下方定义） */
						let render: () => void = () => {};
						const updateCount = () => render();
						const exportQuestionCaches = () => {
							const caches = this.cfg.localQuestionCaches;
							const blob = new Blob(
								[
									JSON.stringify(
										{
											name: `${PROJECT_NAME}题库缓存`,
											version: 1,
											exportedAt: new Date().toISOString(),
											count: caches.length,
											caches
										},
										null,
										2
									)
								],
								{ type: 'application/json' }
							);
							const url = URL.createObjectURL(blob);
							const a = h('a', {
								href: url,
								download: `nanchengpai-question-cache-${new Date()
									.toISOString()
									.slice(0, 10)}${QUESTION_CACHE_EXPORT_EXTENSION}`
							});
							a.click();
							URL.revokeObjectURL(url);
						};
						const importQuestionCaches = () => {
							const input = h('input', { type: 'file', accept: '.json,.txt' });
							input.onchange = async () => {
								const file = input.files?.[0];
								if (!file) {
									return;
								}

								try {
									const json = JSON.parse(await file.text());
									const items = normalizeQuestionCacheItems(json);
									if (items.length === 0) {
										$message.warn({ content: '未在文件中识别到可导入的题库缓存。', duration: 5 });
										return;
									}

									await CommonProject.scripts.apps.methods.addQuestionCache(...items);
									updateCount();
									$message.success({
										content: `已导入 ${items.length} 条题库缓存（同一题已有更可信的答案时会自动跳过）。`,
										duration: 8
									});
								} catch (error) {
									$message.error({ content: '题库缓存导入失败：文件不是有效 JSON。', duration: 8 });
									console.error(error);
								}
							};
							input.click();
						};

						const PAGE_SIZE = 100;
						const SOURCE_LABELS: Record<QuestionCacheSource, { text: string; color: string; title: string }> = {
							standard: { text: '标准答案', color: '#2e9e4f', title: '提交后从页面读取的标准答案，可信度最高' },
							bank: { text: '题库', color: '#7a7a7a', title: '在线题库返回的答案' },
							ai: { text: 'AI', color: '#2f6fed', title: 'AI 生成的答案；取得标准答案后会被自动覆盖' }
						};
						let keyword = '';
						let sourceFilter: '' | QuestionCacheSource = '';
						let limit = PAGE_SIZE;

						/** 同步清理章节重做用的标签页缓存，避免删除后又被恢复 */
						const removeFromRetakeTab = async (predicate: (cache: QuestionCache) => boolean) => {
							try {
								const tabCaches = ((await $store.getTab(CX_CHAPTER_RETAKE_CACHE_TAB_KEY)) || []) as QuestionCache[];
								await $store.setTab(
									CX_CHAPTER_RETAKE_CACHE_TAB_KEY,
									Array.isArray(tabCaches) ? tabCaches.filter((cache) => !predicate(cache)) : []
								);
							} catch {}
						};

						const createCacheItem = (c: QuestionCache) => {
							const source = getQuestionCacheSource(c);
							const label = SOURCE_LABELS[source];
							const meta: string[] = [];
							if (c.scope) {
								meta.push('课程 ' + c.scope.split(':').pop());
							}
							if (c.time) {
								meta.push(new Date(c.time).toLocaleString());
							}
							meta.push('来自 ' + (c.from || '未知题库'));

							return h(
								'div',
								{
									className: 'question-cache',
									style: {
										margin: '8px',
										border: '1px solid lightgray',
										borderRadius: '4px',
										padding: '8px'
									}
								},
								[
									h('div', { className: 'title' }, [
										h(
											'span',
											{
												title: label.title,
												style: {
													color: '#fff',
													background: label.color,
													borderRadius: '4px',
													padding: '0 6px',
													marginRight: '6px',
													fontSize: '12px'
												}
											},
											label.text
										),
										h('span', { title: `主页：${c.homepage || '未知主页'}`, style: { fontWeight: 'bold' } }, c.title)
									]),
									h(
										'div',
										{ className: 'answer', style: { marginTop: '6px', wordBreak: 'break-all' } },
										(c.option && c.option !== c.answer ? c.option + '. ' : '') + c.answer
									),
									// 答案是图片链接（选项是图片）时显示缩略图，方便查看
									...(extractImageUrls(c.answer).length
										? [
												h(
													'div',
													{ style: { marginTop: '4px' } },
													extractImageUrls(c.answer).map((url) =>
														h('img', { src: url, title: url }, (img) => {
															img.style.maxHeight = '64px';
															img.style.maxWidth = '120px';
															img.style.marginRight = '6px';
															img.style.border = '1px solid #ddd';
															img.style.borderRadius = '4px';
															img.onerror = () => img.remove();
														})
													)
												)
										  ]
										: []),
									...(c.content && c.content !== c.answer
										? [h('div', { style: { marginTop: '4px', color: '#666' } }, '内容：' + c.content)]
										: []),
									h(
										'div',
										{ style: { marginTop: '6px', fontSize: '12px', color: '#999', wordBreak: 'break-all' } },
										meta.join(' · ')
									),
									h('div', { style: { textAlign: 'right', marginTop: '6px' } }, [
										$ui.button('删除', {}, (deleteBtn) => {
											deleteBtn.onclick = async () => {
												const same = (cache: QuestionCache) =>
													cache.title === c.title &&
													cache.answer === c.answer &&
													cache.from === c.from &&
													(cache.scope || '') === (c.scope || '');
												this.cfg.localQuestionCaches = this.cfg.localQuestionCaches.filter(
													(cache: QuestionCache) => !same(cache)
												);
												await removeFromRetakeTab(same);
												render();
											};
										})
									])
								]
							);
						};

						const listEl = h('div');
						render = () => {
							const all: QuestionCache[] = this.cfg.localQuestionCaches;
							const matched = all.filter(
								(c) =>
									(!sourceFilter || getQuestionCacheSource(c) === sourceFilter) &&
									(!keyword || c.title.includes(keyword) || c.answer.includes(keyword))
							);

							countEl.innerText =
								matched.length === all.length
									? `当前缓存数量：${all.length}`
									: `当前缓存数量：${all.length}，匹配 ${matched.length} 条`;

							listEl.innerHTML = '';
							if (matched.length === 0) {
								listEl.append(
									h('div', { style: { textAlign: 'center' } }, all.length === 0 ? '暂无题库缓存' : '没有匹配的缓存')
								);
								return;
							}

							for (const c of matched.slice(0, limit)) {
								listEl.append(createCacheItem(c));
							}
							if (matched.length > limit) {
								listEl.append(
									h('div', { style: { textAlign: 'center', margin: '8px' } }, [
										$ui.button(`显示更多（还有 ${matched.length - limit} 条）`, {}, (moreBtn) => {
											moreBtn.onclick = () => {
												limit += PAGE_SIZE;
												render();
											};
										})
									])
								);
							}
						};

						const searchInput = h('input', {
							type: 'search',
							placeholder: '搜索题目或答案',
							style: { width: '240px', padding: '4px 8px' }
						});
						searchInput.oninput = () => {
							keyword = searchInput.value.trim();
							limit = PAGE_SIZE;
							render();
						};
						const sourceSelect = h('select', { style: { padding: '4px 8px' } }, [
							h('option', { value: '' }, '全部来源'),
							h('option', { value: 'standard' }, '标准答案'),
							h('option', { value: 'bank' }, '在线题库'),
							h('option', { value: 'ai' }, 'AI 答案')
						]);
						sourceSelect.onchange = () => {
							sourceFilter = sourceSelect.value as '' | QuestionCacheSource;
							limit = PAGE_SIZE;
							render();
						};

						render();

						$modal.simple({
							width: 800,
							content: h('div', [
								h('div', { className: 'notes card' }, [
									$ui.notes([
										'题库缓存会长期保存在脚本存储中，重复使用时可直接命中缓存，不需要再次请求题库。',
										'答案可信度：标准答案（提交后读取）> 在线题库 = AI；同一题只会使用可信度最高的一类答案，取得标准答案后会自动覆盖旧的错误答案。',
										'缓存会记录所属课程，不同课程中题干相同的题目互不干扰（可在全局设置中开启“跨课程使用缓存”）。',
										'不限制缓存条数；除非手动删除/清空、导入覆盖脚本数据、卸载脚本或清理浏览器/油猴存储，否则不会自动清除，建议定期导出备份。'
									])
								]),
								h('div', { className: 'card' }, [
									$ui.space(
										[
											countEl,
											$ui.button('导出题库缓存', {}, (btn) => {
												btn.onclick = exportQuestionCaches;
											}),
											$ui.button('导入题库缓存', {}, (btn) => {
												btn.onclick = importQuestionCaches;
											}),
											$ui.button('清除 AI 答案', {}, (btn) => {
												btn.onclick = async () => {
													this.cfg.localQuestionCaches = this.cfg.localQuestionCaches.filter(
														(cache: QuestionCache) => getQuestionCacheSource(cache) !== 'ai'
													);
													await removeFromRetakeTab((cache) => getQuestionCacheSource(cache) === 'ai');
													render();
													$message.success({ content: '已清除全部 AI 答案缓存。', duration: 5 });
												};
											}),
											$ui.button('清空题库缓存', {}, (btn) => {
												btn.onclick = () => {
													$modal.confirm({
														content: '确定要清空全部题库缓存吗？此操作无法撤销，建议先导出备份。',
														onConfirm: async () => {
															this.cfg.localQuestionCaches = [];
															try {
																await $store.setTab(CX_CHAPTER_RETAKE_CACHE_TAB_KEY, []);
															} catch {}
															render();
														}
													});
												};
											})
										],
										{ separator: '|' }
									)
								]),
								h('div', { className: 'card' }, [$ui.space([searchInput, sourceSelect])]),

								listEl
							])
						});
					};
				});

				const exportSetting = $ui.tooltip(
					h(
						'div',
						{
							innerText: '📤 导出全部设置',
							style: btnStyle,
							title: `导出全部页面的设置，包括全局设置，题库配置，学习设置等等。（文件后缀名为：${PROJECT_SETTING_EXTENSION}）`
						},
						(btn) => {
							btn.onclick = () => {
								const setting = Object.create({});
								for (const key of $store.list()) {
									const val = $store.get(key);
									if (val) {
										Reflect.set(setting, key, val);
									}
								}
								const blob = new Blob([JSON.stringify(setting, null, 2)], { type: 'text/plain' });
								const url = URL.createObjectURL(blob);
								const a = h('a', {
									href: url,
									download: `nanchengpai-setting-export${PROJECT_SETTING_EXTENSION}`
								});
								a.click();
								URL.revokeObjectURL(url);
							};
						}
					)
				);

				const importSetting = $ui.tooltip(
					h(
						'div',
						{
							innerText: '📥 导入全部设置',
							style: btnStyle,
							title: `导入并且覆盖当前的全部设置。（文件后缀名优先为：${PROJECT_SETTING_EXTENSION}，同时兼容旧版 .ocssetting）`
						},
						(btn) => {
							btn.onclick = () => {
								const input = h('input', { type: 'file', accept: PROJECT_SETTING_IMPORT_ACCEPT });
								input.onchange = async () => {
									const file = input.files?.[0];
									if (file) {
										const setting = await file.text();
										const obj = JSON.parse(setting);
										for (const key of Object.keys(obj)) {
											$store.set(key, obj[key]);
										}
										$message.success({ content: '设置导入成功，页面即将刷新。', duration: 3 });
										setTimeout(() => {
											location.reload();
										}, 3000);
									}
								};
								input.click();
							};
						}
					)
				);

				[cachesBtn, exportSetting, importSetting].forEach((btn) => {
					btn.onmouseover = () => {
						btn.style.boxShadow = '0px 0px 4px #0099ff9c';
					};
					btn.onmouseout = () => {
						btn.style.boxShadow = '0px 0px 4px #bebebe';
					};
				});

				const sep = (text: string) => h('div', { className: 'separator', style: { padding: '4px 0px' } }, text);

				panel.body.replaceChildren(
					h('div', [sep('题库拓展'), cachesBtn, sep('其他功能'), exportSetting, importSetting])
				);
			}
		})
	}
});

function insertCopyableStyle() {
	const style = document.createElement('style');
	style.innerHTML = `
		html * {
		  -webkit-user-select: text !important;
		  -khtml-user-select: text !important;
		  -moz-user-select: text !important;
		  -ms-user-select: text !important;
		  user-select: text !important;
		}`;

	document.head.append(style);
}

function createAnswererWrapperList(aw: AnswererWrapper[]) {
	return aw.map((item) =>
		h(
			'details',
			[
				h('summary', [
					$ui.space([
						(() => {
							let isDisabled = CommonProject.scripts.settings.cfg.disabledAnswererWrapperNames.includes(item.name);

							const checkbox = h('input', { type: 'checkbox', checked: !isDisabled, className: 'base-style-switch' });

							checkbox.onclick = () => {
								isDisabled = !isDisabled;
								if (isDisabled) {
									CommonProject.scripts.settings.cfg.disabledAnswererWrapperNames = [
										...CommonProject.scripts.settings.cfg.disabledAnswererWrapperNames,
										item.name
									];
									$message.warn({
										content: '题库：' + item.name + ' 已被停用，如需开启请在：通用-全局设置-题库配置中开启。',
										duration: 30
									});
								} else {
									CommonProject.scripts.settings.cfg.disabledAnswererWrapperNames =
										CommonProject.scripts.settings.cfg.disabledAnswererWrapperNames.filter(
											(name) => name !== item.name
										);
									$message.success({
										content: '题库：' + item.name + ' 已启用。',
										duration: 3
									});
								}
							};

							checkbox.title = '点击停用或者启用题库，停用题库后将无法在自动答题中查询题目';

							return $ui.tooltip(checkbox);
						})(),
						h('span', item.name)
					])
				]),
				h('ul', [
					h('li', ['名字\t', item.name]),
					h('li', { innerHTML: `官网\t<a target="_blank" href=${item.homepage}>${item.homepage || '无'}</a>` }),
					h('li', ['接口\t', item.url]),
					h('li', ['请求方法\t', item.method]),
					h('li', ['请求类型\t', item.type]),
					h('li', ['请求头\t', JSON.stringify(item.headers, null, 4) || '无']),
					h('li', ['请求体\t', JSON.stringify(item.data, null, 4) || '无'])
				])
			],
			(details) => {
				details.style.paddingLeft = '12px';
			}
		)
	);
}

const createGuide = () => {
	const showProjectDetails = (project: Project) => {
		$modal.simple({
			title: project.name,
			width: 800,
			content: h('div', [
				h('div', [
					'运行域名：',
					...(project.domains || []).map((d) =>
						h(
							'a',
							{ href: d.startsWith('http') ? d : 'https://' + d, target: '_blank', style: { margin: '0px 4px' } },
							d
						)
					)
				]),
				h('div', '脚本列表：'),
				h(
					'ul',
					Object.keys(project.scripts)
						.sort((a, b) => (project.scripts[b].hideInPanel ? -1 : 1))
						.map((key) => {
							const script = project.scripts[key];
							return h(
								'li',
								[
									h('b', script.name),
									$ui.notes([
										h('span', ['操作面板：', script.hideInPanel ? '隐藏' : '显示']),

										[
											'运行页面：',
											h(
												'ul',
												script.matches
													.map((m) => (Array.isArray(m) ? m : (['无描述', m] as [string, string | RegExp])))
													.map((i) =>
														h('li', [
															i[0],
															'：',
															i[1] instanceof RegExp ? i[1].toString().replace(/\\/g, '').slice(1, -1) : h('span', i[1])
														])
													)
											)
										]
									])
								],
								(li) => {
									li.style.marginBottom = '12px';
								}
							);
						}),
					(ul) => {
						ul.style.padding = '12px 24px';
						ul.style.border = '1px solid #e1e1e1';
						ul.style.borderRadius = '4px';
						ul.style.maxHeight = '400px';
						ul.style.overflow = 'auto';
						ul.style.paddingLeft = '42px';
					}
				)
			])
		});
	};

	const gotoHome = h('button', { className: 'base-style-button-secondary' }, '🏡项目主页');
	gotoHome.onclick = () => window.open(PROJECT_REPO, '_blank');

	const contactUs = h('button', { className: 'base-style-button-secondary' }, '🗨️问题反馈');
	contactUs.onclick = () => window.open(PROJECT_ISSUES, '_blank');

	const changeLog = h('button', { className: 'base-style-button-secondary' }, '📄更新日志');
	changeLog.onclick = () => CommonProject.scripts.apps.methods.showChangelog();

	const cardStyle: Partial<CSSStyleDeclaration> = {
		border: '1px solid #eee',
		borderRadius: '4px',
		padding: '8px',
		paddingTop: '4px'
	};

	return h('div', { className: 'user-guide' }, [
		h('div', { className: 'notes card', style: { ...cardStyle, marginBottom: '12px' } }, [
			`${PROJECT_NAME} 基于 OCSJS 二次开发，如需查看说明或反馈问题，请使用下方快捷入口。`
		]),
		h('div', { style: cardStyle }, [
			h('div', { style: { marginBottom: '4px', fontWeight: 'bold' } }, [
				'✨兼容的网课平台：',
				h('span', { className: 'secondary', style: { fontWeight: 'normal' } }, '（未适配的平台将无法运行，请等待适配）')
			]),

			h('div', [
				...[CXProject, ZHSProject, ZJYProject, IcveMoocProject, ICourseProject].map((project) => {
					const btn = h('button', { className: 'base-style-button-secondary', style: { margin: '4px' } }, [
						project.name
					]);
					btn.onclick = () => {
						showProjectDetails(project);
					};
					return btn;
				})
			])
		]),
		h('div', { style: { ...cardStyle, marginTop: '12px' } }, [
			h('div', { style: { marginBottom: '8px', fontWeight: 'bold' } }, '🌐快捷访问：'),
			gotoHome,
			contactUs,
			changeLog
		])
	]);
};
