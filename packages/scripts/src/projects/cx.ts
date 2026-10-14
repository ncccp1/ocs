/** global Ext videojs getTeacherAjax jobs */

import {
	OCSWorker,
	$,
	StringUtils,
	request,
	createDefaultQuestionResolver,
	splitAnswer,
	domSearch,
	domSearchAll,
	SearchInformation
} from '@ocsjs/core';
import { $modal, h, $store, MessageElement, Project, Script, $el, $gm, $$el, $ui, cors, $message } from 'easy-us';

import { CommonProject, getQuestionCacheScope } from './common';
import { isAiAnswererAvailable, searchAnswerInWrappers } from '../utils/answerer';
import { cleanBlankAnswer, isBlankAnswerJunk, matchAnswerToOptions } from '../utils/option-match';
import { workNotes, volume, playbackRate, dropdownStyle } from '../utils/configs';
import {
	answerWrapperEmptyWarning,
	attachWorkFloatingBar,
	commonWork,
	optimizationElementWithImage,
	removeRedundantWords,
	simplifyWorkResult
} from '../utils/work';
import { $debug, isDebugEnabled, skipInDryRun } from '../utils/debug';
import { registerSnapshotCollector } from '../utils/snapshot';
import {
	beginBusy,
	finishTask,
	isUserPaused,
	registerMediaControl,
	resetTaskSteps,
	setTaskState,
	trackMediaProgress,
	updateTaskFromResults,
	upsertTaskStep
} from '../utils/task-state';
import md5 from 'md5';
// @ts-ignore
import Typr from 'typr.js';
import { $console } from './background';
import { CommonWorkOptions, playMedia } from '../utils';
import { waitForMedia } from '../utils/study';

try {
	/**
	 *
	 *  将繁体字映射载入内存。
	 *  为什么不存 localStorage 和 GM_setValue
	 *  localStorage: 存在被检测风险，谁都能访问
	 *  GM_setValue: 文件太大影响I/O速度
	 */
	// @ts-ignore
	top.typrMapping = top.typrMapping || undefined;

	// @ts-ignore 任务点
	top.jobs = top.jobs || [];

	// @ts-ignore 当前视频
	top.currentMedia = top.currentMedia || undefined;

	// 加 try 是因为跨域面板无法操作
} catch {}

const state = {
	study: {
		videojs: Object.create({}),
		hacked: false,
		answererWrapperUnsetMessage: undefined as MessageElement | undefined,
		playbackRateWarningListenerId: 0
	}
};

type VideoQuizStrategy = 'search' | 'random' | 'ignore';
type ChapterWorkOptions = CommonWorkOptions & { chapterAutoRetakeDepth?: number };
type WorkOrExamOptions = CommonWorkOptions & { preview_mode: boolean; cxAutoRetakeDepth?: number };
type LocalQuestionCacheItem = {
	title: string;
	answer: string;
	from: string;
	homepage: string;
	ai?: boolean;
	scope?: string;
	source?: 'standard' | 'bank' | 'ai';
	time?: number;
	option?: string;
	content?: string;
};

const CX_CHAPTER_RETAKE_CACHE_TAB_KEY = 'cx_chapter_auto_retake_caches';
const CX_WORK_RETAKE_STATE_TAB_KEY = 'cx_work_auto_retake_state';

type Attachment = {
	/** 只有当 module 为 音视频（并且已经播放完成）时才会有这个属性 */
	isPassed: boolean | undefined;
	/** 是否为任务点（音视频播放完成后此属性不存在） */
	job: boolean | undefined;
	/** 这里注意，如果当前章节测试不是任务点，则没有 jobid 或者未空字符串 */
	jobid?: string;
	property: {
		mid: string;
		/** 任务点id，固定存在 */
		_jobid: string;
		module: 'insertbook' | 'insertdoc' | 'insertflash' | 'work' | 'insertaudio' | 'insertvideo';
		name?: string;
		author?: string;
		bookname?: string;
		publisher?: string;
		title?: string;
	};
};

type Job = {
	mid: string;
	attachment: Attachment;
	func: { (): Promise<void> } | undefined;
};
export const CXProject = Project.create({
	name: '超星学习通',
	domains: [
		'chaoxing.com',
		'edu.cn',
		'org.cn',
		// 学银在线
		'xueyinonline.com',
		/** 其他域名 */
		'hnsyu.net',
		'qutjxjy.cn',
		'ynny.cn',
		'hnvist.cn',
		'fjlecb.cn',
		'gdhkmooc.com',
		'cugbonline.cn',
		'zjelib.cn',
		'cqrspx.cn',
		'neauce.com',
		'zhihui-yun.com',
		'cqie.cn',
		'ccqmxx.com',
		'jxgmxy.com',
		// 超星学习通PPT，2025下半年更新的PTT图书新域名
		'sslibrary.com'
	],
	scripts: {
		/**
		 * 创建超星独立脚本防止污染其他脚本环境
		 */
		env: new Script({
			name: '环境准备脚本',
			matches: [['所有页面', /.*/]],
			hideInPanel: true,
			onstart() {
				/**
				 * 于 4.9.20 后更新，出现顶层套壳页面跨域 :
				 * top : zjelib.cn <body>
				 * iframe : mooc1.xxx.zjelib.cn/.../mycourse/studentstudy/...  <iframe src=....>
				 * 导致top指向zjelib跨域无法访问，所以这里尝试寻找真正的top窗口对象，只有域名中包含 /mycourse/studentstudy 才是可操作的 top
				 */
				let top = window.top;
				try {
					let _self = $gm.unsafeWindow;
					let _try_count = 10;
					while (_self.parent !== undefined && _try_count > 0) {
						if (_self.location.href.includes('/mycourse/studentstudy')) {
							top = _self;
							console.log('[nanchengpai] top change to :' + top.location.href);
							break;
						} else {
							_try_count--;
							// @ts-ignore
							_self = _self.parent;
						}
					}
				} catch (e) {
					console.warn('[nanchengpai] fail of find top');
					console.warn(e);
					top = window.top;
				}
			}
		}),
		guide: new Script({
			name: '💡 使用提示',
			matches: [
				['首页', 'https://www.chaoxing.com'],
				['旧版个人首页', 'chaoxing.com/space/index'],
				['新版个人首页', 'chaoxing.com/base'],
				['学习页面', 'chaoxing.com/mycourse'],
				['新版学习页面', 'chaoxing.com/mooc2-ans/mycourse']
			],
			namespace: 'cx.guide',
			configs: {
				notes: {
					defaultValue: `请手动进入视频、作业、考试页面，脚本会自动运行。`
				}
			},
			oncomplete() {
				if (['mycourse/studentstudy'].some((path) => location.href.includes(path))) {
					$message.success('已进入学习页面，请等待自动运行...');
					return;
				}
				$message.info('请手动进入视频、作业、考试页面，脚本会自动运行。');
			}
		}),
		study: new Script({
			name: '🖥️ 课程学习',
			namespace: 'cx.new.study',
			matches: [
				['任务点页面', '/knowledge/cards'],
				['阅读任务点', '/readsvr/book/mooc']
				// 旧版浏览器好像不能识别二级 iframe ， 所以不能使用 'work/doHomeWorkNew' 以及其他二级 iframe 来触发路由
			],
			configs: {
				notes: {
					defaultValue: $ui.notes([
						['任务点不是顺序执行，如果某一个任务没有动', '请查看是否有其他任务正在学习，耐心等待即可。'],
						'闯关模式请注意题库如果没完成，需要自己完成才能解锁章节。',
						'请勿凌晨刷课，部分学校课程可能会清空进度。',
						['⚠️目前超星倍速风控严重，如果高倍速', '完成后被清空还原，请调到1-2倍速学习！']
					]).outerHTML
				},
				playbackRate: playbackRate,
				volume: volume,
				videoQuizStrategy: {
					label: '视频内题目',
					tag: 'select',
					options: [
						[
							'search',
							'题库/AI 答题',
							'先搜题库（含缓存），搜不到时调用 AI；仍无法作答时随机选择。与视频内容强相关的题目 AI 会给出最可能的答案。'
						],
						['random', '随机答题'],
						['ignore', '忽略']
					],
					attrs: {
						title:
							'视频有时在学习过程中会弹出题目，这个好像并不计算在分数内，所以可以忽略，视频可以正常观看，这里提供几个方法处理题目'
					},
					defaultValue: 'search' as VideoQuizStrategy
				},
				mode: {
					label: '跳转模式',
					tag: 'select',
					options: [
						['next', '完成后跳转下一节', '完成小节后，自动点击下一节按钮'],
						['job', '完成后跳转未完成任务点', '如果未找到任务点，则会直接结束脚本运行，目前处于试验阶段。'],
						['manually', '完成后暂停，等待手动跳转', '适用于自己手动运行']
					],
					defaultValue: 'next' as 'next' | 'job' | 'manually'
				},
				restudy: {
					label: '复习模式',
					attrs: { title: '已经完成的视频继续学习，并从当前的章节往下开始学习', type: 'checkbox' },
					defaultValue: false
				},
				forceLearn: {
					label: '强制学习',
					attrs: {
						title:
							'视频一般分为：非任务点、任务点、和已完成任务点，当遇到“非任务点”时需要开启此选项才会进行学习。同时也会对非任务点的章节测验自动答题。',
						type: 'checkbox'
					},
					defaultValue: false
				},
				backToFirstWhenFinish: {
					label: '完成全部后重新学习',
					attrs: {
						type: 'checkbox',
						title: '当章节已经学习完成至最后一章时，跳转到第一个章节重新开始学习。'
					},
					defaultValue: false
				},
				showTextareaWhenEdit: {
					label: '编辑时显示自定义编辑框',
					attrs: {
						type: 'checkbox',
						title:
							'超星默认禁止在编辑框中复制粘贴，开启此选项可以在文本框编辑时生成一个自定义编辑框进行编辑，脚本会将内容同步到编辑框中。'
					},
					defaultValue: true
				},
				notifyWhenHasFaceRecognition: {
					label: '出现人脸识别时通知我',
					attrs: {
						type: 'checkbox'
					},
					defaultValue: true
				},
				enables: {
					...dropdownStyle,
					label: '高级设置',
					attrs: { type: 'checkbox' },
					defaultValue: false
				},
				/**
				 *
				 * 开启的任务点
				 *
				 * media : 音视频
				 * ppt : 文档和书籍翻阅
				 * test : 章节测试
				 * read : 阅读
				 * live : 直播课
				 *
				 */
				enableMedia: {
					elementClassName: 'config-details',
					showIf: 'cx.new.study.enables',
					label: '视频/音频自动播放',
					attrs: { type: 'checkbox', title: '开启：音频和视频的自动播放' },
					defaultValue: true
				},
				enablePPT: {
					elementClassName: 'config-details',
					showIf: 'cx.new.study.enables',
					label: 'PPT/书籍自动完成',
					attrs: { type: 'checkbox', title: '开启：PPT/书籍自动翻阅' },
					defaultValue: true
				},
				enableChapterTest: {
					elementClassName: 'config-details',
					showIf: 'cx.new.study.enables',
					label: '章节测试自动答题',
					attrs: { type: 'checkbox', title: '开启：章节测试自动答题' },
					defaultValue: true
				},
				enableHyperlink: {
					elementClassName: 'config-details',
					showIf: 'cx.new.study.enables',
					label: '链接任务自动完成',
					attrs: { type: 'checkbox', title: '开启：链接任务自动完成' },
					defaultValue: true
				}
			},
			onrender({ panel }) {
				if (!CommonProject.scripts.settings.cfg.answererWrappers?.length) {
					answerWrapperEmptyWarning(10);
				}

				// 高倍速警告
				this.offConfigChange(state.study.playbackRateWarningListenerId);
				state.study.playbackRateWarningListenerId =
					this.onConfigChange('playbackRate', (playbackRate) => {
						if (playbackRate > 2) {
							$modal.alert({
								title: '⚠️高倍速警告',
								content: $ui.notes([
									'⚠️高倍速可能导致学习记录清空/回退',
									'⚠️超星后台可以看到学习时长，请谨慎设置',
									'⚠️如已清空/回退，请降低倍速至1-2倍'
								]),
								maskCloseable: false,
								confirmButtonText: '我已知晓风险'
							});
						}
					}) || 0;
			},
			async oncomplete() {
				/** iframe 跨域问题， 必须在 iframe 中执行 ， 所以脱离学习脚本运行。 */
				if (/\/readsvr\/book\/mooc/.test(location.href)) {
					$console.log('正在完成书籍/PPT...');
					setTimeout(() => {
						// @ts-ignore
						// eslint-disable-next-line no-undef
						readweb.goto(epage);
					}, 5000);

					return;
				}

				// 主要处理
				if (/\/knowledge\/cards/.test(location.href)) {
					const updateMediaState = () => {
						// @ts-ignore
						if (top.currentMedia) {
							// @ts-ignore 倍速设置
							top.currentMedia.playbackRate = parseFloat(this.cfg.playbackRate.toString());
							// @ts-ignore 音量设置
							top.currentMedia.volume = this.cfg.volume;
						}
					};

					this.onConfigChange('playbackRate', updateMediaState);
					this.onConfigChange('volume', updateMediaState);

					await study({
						...this.cfg,
						playbackRate: parseFloat(this.cfg.playbackRate.toString()),
						workOptions: CommonProject.scripts.settings.methods.getWorkOptions()
					});
				}
			}
		}),
		work: new Script({
			name: '✍️ 作业考试脚本',
			matches: [
				['作业页面', '/mooc2/work/dowork'],
				['考试整卷预览页面', '/mooc2/exam/preview']
			],
			namespace: 'cx.new.work',
			configs: { notes: workNotes },
			async oncomplete() {
				const isExam = /\/exam\/preview/.test(location.href);
				commonWork(this, {
					workerProvider: (opts) => workOrExam(isExam ? 'exam' : 'work', { ...opts, preview_mode: true }),
					enable_control_panel: true
				});
			}
		}),
		workAnswerCache: new Script({
			name: '作业答案缓存监听脚本',
			matches: [
				['作业/详情页面', /\/mooc2\/work\//],
				['考试/详情页面', /\/mooc2\/exam\//],
				['旧版作业/详情页面', /\/work\//],
				['旧版考试/详情页面', /\/exam\//]
			],
			namespace: 'cx.work-answer-cache',
			hideInPanel: true,
			oncomplete() {
				startCxWorkOrExamAnswerCacheObserver();
			}
		}),
		autoRead: new Script({
			name: '🖥️ 自动阅读',
			matches: [
				['阅读页面', '/ztnodedetailcontroller/visitnodedetail'],
				['课程目录', /chaoxing.com\/course\/\d+\.html/],
				['课程目录', /chaoxing.com\/mooc-ans\/course\/\d+\.html/]
			],
			namespace: 'cx.new.auto-read',
			configs: {
				notes: {
					defaultValue: $ui.notes(['阅读任务次日才会统计阅读时长']).outerHTML
				},
				restartAfterFinish: {
					label: '无限阅读',
					attrs: { type: 'checkbox', title: '阅读完成最后一章后从头第一章继续阅读' },
					defaultValue: false
				}
			},
			oncomplete() {
				// 自动进入章节功能，如果不是阅读页面则自动进入
				if (location.href.includes('/ztnodedetailcontroller/visitnodedetail') === false) {
					startAtFirst();
					return;
				}

				let top = 0;
				const interval = setInterval(() => {
					top += (document.documentElement.scrollHeight - window.innerHeight) / 60;
					window.scrollTo({
						behavior: 'smooth',
						top: top
					});
				}, 1000);

				setTimeout(() => {
					clearInterval(interval);
					// 下一页
					const next = $el('.nodeItem.r i');
					if (next) {
						next.click();
					} else {
						if (this.cfg.restartAfterFinish) {
							setTimeout(() => startAtFirst(), 3000);
							$message.info({ content: '即将重新从头开始阅读', duration: 10 });
							$console.log('即将重新从头开始阅读');
						} else {
							$message.success({ content: '阅读任务已完成', duration: 0 });
							$console.log('未检测到下一页');
						}
					}
				}, (60 + 3) * 1000);

				// 点击第一个章节
				function startAtFirst() {
					const texts = $$el('.course_section .chapterText');
					if (texts.length) {
						texts[0].click();
					}
				}
			}
		}),
		/**
		 * 有时候进入课程会默认在，任务页面，会出现任务为空，部分用户会以为没有章节任务，所以添加此脚本
		 */
		pageRedirect: new Script({
			name: '章节页面自动切换脚本',
			matches: [['课程任务页面', 'pageHeader=0']],
			hideInPanel: true,
			async oncomplete() {
				if (top === window) {
					const a = document.querySelector<HTMLElement>('a[title="章节"]');
					if (a) {
						await $.sleep(1000);
						// 跳转到最新版本的超星
						a.click();
						$message.info({
							content: '已经为您自动切换到章节列表页面，手动进入任意章节即可开始自动学习！'
						});
					}
				}
			}
		}),
		versionRedirect: new Script({
			name: '版本切换脚本',
			matches: [
				['', 'mooc2=0'],
				['', 'mycourse/studentcourse'],
				['', 'work/getAllWork'],
				['', 'work/doHomeWorkNew'],
				['', 'exam/test\\?'],
				['', 'mooc-ans/mycourse/studentstudy']
			],
			hideInPanel: true,
			async oncomplete() {
				if (top === window) {
					$message.warn({
						content:
							'南城派网课助手不支持旧版超星，即将切换到超星新版。如有其他第三方插件请关闭，可能有兼容问题导致频繁切换。',
						duration: 0
					});
					// 跳转到最新版本的超星
					await $.sleep(2000);

					// 检测是否有人脸识别
					await waitForFaceRecognition();

					const experience = document.querySelector('.experience') as HTMLElement;
					if (experience) {
						experience.click();
					} else {
						const newUrl = new URL(window.location.href);
						if (window.location.href.includes('mooc-ans/mycourse/studentstudy')) {
							newUrl.pathname = '/mycourse/studentstudy';
						}
						const params = newUrl.searchParams;
						let changed = false;
						if (params.get('mooc2') !== '1') {
							params.set('mooc2', '1');
							changed = true;
						}

						// 兼容考试切换
						if (params.get('newMooc') !== 'true') {
							params.set('newMooc', 'true');
							changed = true;
						}
						if (changed) window.location.replace(newUrl);
					}
				}
			}
		}),
		examRedirect: new Script({
			name: '考试整卷预览脚本',
			matches: [
				['新版考试页面', 'exam-ans/exam/test/reVersionTestStartNew'],
				// 2023/9月 新增
				['新版考试页面2', 'mooc-ans/exam/test/reVersionTestStartNew']
			],
			hideInPanel: true,
			oncomplete() {
				if ($gm.unsafeWindow.document.querySelector('.mark_info')?.textContent?.includes('不允许整卷预览')) {
					$message.warn({
						content: $ui.notes([
							'由于当前考试禁止整卷预览，各题为独立新页面，只能一个个答题',
							'在考完前禁止手动切换题目，否则会导致重复答题！',
							'完成后或者开考前请手动删除搜索结果！',
							'想加快速度请更改通用-全局设置-高级设置-搜题间隔，设置为 1-3 秒即可。'
						]),
						duration: 0
					});
					const isExam = /\/exam\/test/.test(location.href);
					const workOptions = CommonProject.scripts.settings.methods.getWorkOptions();
					commonWork(CXProject.scripts.work, {
						// 因为超星是每个题目一个页面，这里加快开始速度，避免等待，默认5秒，这里加快为默认3秒间隔
						start_delay_seconds: workOptions.period,
						enable_control_panel: true,
						workerProvider: (opts) => workOrExam(isExam ? 'exam' : 'work', { ...opts, preview_mode: false, thread: 1 })
					});
					return;
				}
				$message.info({ content: '即将跳转到整卷预览页面进行考试。' });
				setTimeout(() => $gm.unsafeWindow.topreview(), 3000);
			}
		}),
		rateHack: new Script({
			name: '屏蔽倍速限制',
			hideInPanel: true,
			matches: [['', '/ananas/modules/video/']],
			onstart() {
				rateHack();
			}
		}),
		copyHack: new Script({
			name: '屏蔽复制粘贴限制',
			hideInPanel: true,
			matches: [['所有页面', /.*/]],
			methods() {
				return {
					/** 解除输入框无法复制粘贴 */
					hackEditorPaste() {
						try {
							const instants = $gm.unsafeWindow?.UE?.instants || [];
							for (const key in instants) {
								const ue = instants[key];

								/**
								 * 新建一个文本框给用户编辑，然后同步到超星编辑器，防止http下浏览器无法读取剪贴板
								 */

								// eslint-disable-next-line no-proto
								if (ue?.textarea) {
									ue.body.addEventListener('click', async () => {
										// http 下无法读取剪贴板，通过弹窗让用户输入然后同步到编辑器
										if (CXProject.scripts.study.cfg.showTextareaWhenEdit) {
											const defaultText = h('span', { innerHTML: ue.textarea.value }).textContent;
											$modal.prompt({
												content:
													'请在此文本框进行编辑，防止超星无法复制粘贴。(如需关闭请前往设置: 课程学习-编辑时显示自定义编辑框)',
												width: 800,
												inputDefaultValue: defaultText || '',
												modalInputType: 'textarea',
												onConfirm: (val = '') => {
													ue.setContent(
														val
															.split('\n')
															.map((line) => `<p>${line}</p>`)
															.join('')
													);
												}
											});
										}
									});

									if ($gm.unsafeWindow.editorPaste) {
										ue.removeListener('beforepaste', $gm.unsafeWindow.editorPaste);
									}
									if ($gm.unsafeWindow.myEditor_paste) {
										ue.removeListener('beforepaste', $gm.unsafeWindow.myEditor_paste);
									}
								}
							}
						} catch {}
					}
				};
			},
			oncomplete() {
				const hackInterval = setInterval(() => {
					if (typeof $gm.unsafeWindow.UE !== 'undefined') {
						clearInterval(hackInterval);
						this.methods.hackEditorPaste();
						console.log('已解除输入框无法复制粘贴限制');
					}
				}, 500);
			}
		}),
		studyDispatcher: new Script({
			name: '课程学习调度器',
			matches: [['课程学习页面', '/mycourse/studentstudy']],
			namespace: 'cx.new.study-dispatcher',
			hideInPanel: true,
			async oncomplete() {
				// 开始任务切换
				const restudy = CXProject.scripts.study.cfg.restudy;

				CommonProject.scripts.render.methods.pin(CXProject.scripts.study);

				let chapters = await CXAnalyses.waitForChapterInfos();

				if (!restudy) {
					// 如果不是复习模式，则寻找需要运行的任务
					const params = new URLSearchParams(window.location.href);
					const mooc = params.get('mooc2');
					/** 切换新版 */
					if (mooc === null) {
						params.set('mooc2', '1');
						window.location.replace(decodeURIComponent(params.toString()));
						return;
					}

					// 过滤掉已完成的章节
					chapters = chapters.filter((chapter) => chapter.unFinishCount !== 0);

					if (chapters.length === 0) {
						$message.warn({ content: '页面任务点数量为空! 请刷新重试!' });
					} else {
						const params = new URLSearchParams(window.location.href);
						const courseId = params.get('courseId');
						const classId = params.get('clazzid');
						setTimeout(() => {
							//  进入需要进行的章节，并且当前章节未被选中
							if ($$el(`.posCatalog_active[id="cur${chapters[0].chapterId}"]`).length === 0) {
								$gm.unsafeWindow.getTeacherAjax(courseId, classId, chapters[0].chapterId);
								// 自动滚动
								setTimeout(() => {
									CXAnalyses.scrollToActiveChapter();
								}, 1000);
							}
						}, 1000);
					}
				} else {
					// 自动滚动
					setTimeout(() => {
						CXAnalyses.scrollToActiveChapter();
					}, 1000);
				}
			}
		}),
		cxSecretFontRecognize: new Script({
			name: '繁体字识别',
			hideInPanel: true,
			matches: [
				['题目页面', 'work/doHomeWorkNew'],
				['考试整卷预览', '/mooc2/exam/preview'],
				['作业', '/mooc2/work/dowork']
			],
			async oncomplete() {
				await mappingRecognize();
			}
		}),
		// 积分课提示
		jfkGuide: new Script({
			name: '💡 积分课使用提示',
			matches: [['积分课页面', '/plaza']],
			namespace: 'cx.jfk.guide',
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'积分课请进入课程后，开启复习模式，并且关闭自动下一章',
						'课程完成后请手动切换，如果由脚本进行自动跳转会出现乱跳转的可能。'
					]).outerHTML
				}
			},
			oncomplete(...args) {
				CommonProject.scripts.render.methods.pin(this);
			}
		})
	}
});

/**
 * 考试页面启用“错题回填重答”前的二次确认。
 * 考试通常只能提交一次，随机答案提交后没有重做机会，所以每次开始前都要明确同意。
 */
function confirmExamRetake() {
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const settle = (value: boolean) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};

		$modal.confirm({
			width: 560,
			title: '⚠️ 考试页面启用错题回填重答',
			maskCloseable: false,
			content: h('div', { style: { lineHeight: '1.7' } }, [
				h('div', '当前是考试页面，并且你开启了“考试也允许错题回填重答”。'),
				h(
					'div',
					{ style: { margin: '8px 0' } },
					'如果有题目没有搜到答案，脚本会先用随机答案补满并提交考试，再查看正确答案、重做一次。'
				),
				h('div', [h('b', '考试通常只能提交一次'), '，提交后可能没有重做机会，成绩将以这次提交为准。']),
				h('div', { style: { marginTop: '8px' } }, '选择“不允许”将只正常答题，不会用随机答案提交。')
			]),
			confirmButtonText: '允许，随机答案提交',
			cancelButtonText: '不允许（仅答题）',
			onConfirm: () => settle(true),
			onCancel: () => settle(false),
			onClose: () => {
				setTimeout(() => settle(false), 50);
			}
		});
	});
}

function workOrExam(type: 'work' | 'exam' = 'work', options: WorkOrExamOptions) {
	const { answererWrappers, period, thread, redundanceWordsText, answerSeparators, answerMatchMode, preview_mode } =
		options;
	const cxAutoRetakeDepth = options.cxAutoRetakeDepth || 0;
	let cxAutoRetakeEnabled =
		Boolean(CommonProject.scripts.settings.cfg['chapterTest-autoRetake']) && cxAutoRetakeDepth === 0;
	// 考试只能提交一次：错题回填重答必须单独开启，并且每次开始前都要再确认一次
	let examRetakeGate: Promise<void> = Promise.resolve();
	if (cxAutoRetakeEnabled && type === 'exam') {
		if (!CommonProject.scripts.settings.cfg['chapterTest-autoRetake-exam']) {
			cxAutoRetakeEnabled = false;
			$console.info('当前是考试页面：“错题回填重答”默认不对考试生效，如需使用请在 通用-全局设置 中单独开启。');
		} else {
			examRetakeGate = confirmExamRetake().then((allowed) => {
				if (!allowed) {
					cxAutoRetakeEnabled = false;
					$console.info('已选择不允许考试使用随机答案提交，本次只正常答题。');
				}
			});
		}
	}

	$message.info(`开始${type === 'work' ? '作业' : '考试'}`);
	const restoreCachesTask = restoreChapterRetakeCaches();

	if (preview_mode) {
		CommonProject.scripts.workResults.methods.init({
			questionPositionSyncHandlerType: 'cx'
		});
	}

	// 处理作业和考试题目的方法
	const workOrExamQuestionTitleTransform = (titles: (HTMLElement | undefined)[]) => {
		return transformCxWorkOrExamQuestionTitle(titles, redundanceWordsText);
	};

	/** 新建答题器 */
	const worker = new OCSWorker({
		root: '.questionLi',
		elements: {
			title: [
				/** 题目标题 */
				(root) => $el('h3', root) as HTMLElement
				// /** 连线题第一组 */
				// (root) => $el('.line_wid_half.fl', root),
				// /** 连线题第二组 */
				// (root) => $el('.line_wid_half.fr', root)
			],
			options: '.answerBg .answer_p, .textDIV, .eidtDiv',
			type: type === 'exam' ? 'input[name^="type"]' : 'input[id^="answertype"]',
			lineAnswerInput: '.line_answer input[name^=answer]',
			lineSelectBox: '.line_answer_ct .selectBox ',
			/** 阅读理解 */
			reading: '.reading_answer',
			/** 完形填空 */
			filling: '.filling_answer'
		},
		thread: thread ?? 1,
		answerSeparators: answerSeparators.split(',').map((s) => s.trim()),
		answerMatchMode: answerMatchMode,
		/** 默认搜题方法构造器 */
		answerer: (elements, ctx) => {
			if (elements.title) {
				// 处理作业和考试题目
				const title = workOrExamQuestionTitleTransform(elements.title);
				if (title) {
					const typeInput = elements.type[0] as HTMLInputElement;
					return CommonProject.scripts.apps.methods.searchAnswerInCaches(
						title,
						async () => {
							await $.sleep((period ?? 3) * 1000);
							return searchAnswerInWrappers(
								answererWrappers,
								{
									type: (typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined) || 'unknown',
									blankCount: ctx.type === 'completion' ? ctx.elements.options.length : 0,
									title,
									options:
										ctx.type === 'completion'
											? ''
											: ctx.elements.options.map((o) => optimizationElementWithImage(o, true).innerText).join('\n')
								},
								'auto'
							);
						},
						ctx.type === 'completion'
							? []
							: ctx.elements.options.map((o) => optimizationElementWithImage(o, true).innerText)
					);
				} else {
					throw new Error('题目为空，请查看题目是否为空，或者忽略此题');
				}
			} else {
				throw new Error('题目为空，请查看题目是否为空，或者忽略此题');
			}
		},

		work: async (ctx) => {
			const { elements, searchInfos } = ctx;
			const typeInput = elements.type[0] as HTMLInputElement;
			const type = getQuestionType(parseInt(typeInput.value));

			if (type && (type === 'completion' || type === 'multiple' || type === 'judgement' || type === 'single')) {
				const resolver = createDefaultQuestionResolver(ctx)[type];
				let selectedOptionsCleared = false;
				const clearSelectedOptionsOnce = async () => {
					if (selectedOptionsCleared || type !== 'multiple') {
						return;
					}

					selectedOptionsCleared = true;
					await clearCxSelectedOptions(elements.options);
				};
				return await resolver(
					searchInfos,
					elements.options.map((option) => optimizationElementWithImage(option)),
					async (type, answer, option) => {
						// 如果存在已经选择的选项
						if (type === 'judgement' || type === 'single' || type === 'multiple') {
							await clearSelectedOptionsOnce();
							if (!isCxChoiceOptionSelected(option)) {
								option.click();
								await $.sleep(500);
							}
						} else if (type === 'completion' && answer.trim()) {
							const text = option?.querySelector('textarea');
							const textareaFrame = option?.querySelector('iframe');
							if (text) {
								text.value = cxBlankAnswerToHtml(answer);
							}
							if (textareaFrame?.contentDocument) {
								textareaFrame.contentDocument.body.innerHTML = cxBlankAnswerToHtml(answer);
							}
							if (option?.parentElement?.parentElement) {
								/** 如果存在保存按钮则点击 */
								$el('[onclick*=saveQuestion]', option?.parentElement?.parentElement)?.click();
								await $.sleep(500);
							}
						}
					}
				);
			}
			// 连线题自定义处理
			else if (type && type === 'line') {
				for (const answers of searchInfos.map((info) => info.results.map((res) => res.answer))) {
					let ans = answers;
					if (ans.length === 1) {
						ans = splitAnswer(ans[0]);
					}
					if (ans.filter(Boolean).length !== 0 && elements.lineAnswerInput) {
						//  选择答案
						for (let index = 0; index < elements.lineSelectBox.length; index++) {
							const box = elements.lineSelectBox[index];
							if (ans[index]) {
								$el(`li[data=${ans[index]}] a`, box)?.click();
								await $.sleep(200);
							}
						}

						return { finish: true };
					}
				}

				return { finish: false };
			}
			// 完形填空
			else if (type && type === 'fill') {
				return readerAndFillHandle(searchInfos, elements.filling);
			}
			// 阅读理解
			else if (type && type === 'reader') {
				return readerAndFillHandle(searchInfos, elements.reading);
			}

			return { finish: false };
		},

		/** 完成答题后 */
		async onResultsUpdate(current, _, res) {
			updateTaskFromResults(res, {
				kind: type === 'exam' ? 'exam' : 'homework',
				title: document.title.trim() || (type === 'exam' ? '考试' : '作业')
			});
			// 非预览模式，直接追加，想要清楚只能手动清空
			if (!preview_mode) {
				if (current.result?.finish) {
					await CommonProject.scripts.workResults.methods.appendResults(
						simplifyWorkResult(res, workOrExamQuestionTitleTransform)
					);
					CommonProject.scripts.apps.methods.addQuestionCacheFromWorkResult(
						simplifyWorkResult([current], workOrExamQuestionTitleTransform)
					);
				}
				return;
			}

			CommonProject.scripts.workResults.methods.setResults(simplifyWorkResult(res, workOrExamQuestionTitleTransform));
			CommonProject.scripts.workResults.methods.updateWorkStateByResults(res);
			if (current.result?.finish) {
				CommonProject.scripts.apps.methods.addQuestionCacheFromWorkResult(
					simplifyWorkResult([current], workOrExamQuestionTitleTransform)
				);
			}

			if (cxAutoRetakeEnabled && current.result?.finish === false && current.resolved === true) {
				await randomAnswerCxWorkQuestion(current);
			}
		}
	});

	if (preview_mode) {
		Promise.resolve()
			.then(async () => {
				await restoreCachesTask;
				await examRetakeGate;
				return worker.doWork({ enable_debug: isDebugEnabled() });
			})
			.then(async (results) => {
				reportUnfinishedQuestions(results, '作业/考试');
				const hasUnfinishedResults = results.some((result) => result.result?.finish !== true);
				const hasUnansweredQuestions = results.some((result) => !isCxWorkResultPhysicallyAnswered(result));

				if (cxAutoRetakeEnabled && hasUnfinishedResults) {
					const handled = await autoSubmitWorkOrExamAndRetake(type, options, workOrExamQuestionTitleTransform);
					if (handled) {
						return;
					}
				}

				if (cxAutoRetakeDepth > 0) {
					if (hasUnansweredQuestions) {
						$message.warn({ content: '缓存答案重答后仍有空题，请手动检查。', duration: 0 });
						$console.warn('缓存答案重答后仍有空题，请手动检查。');
					} else {
						await submitCxWorkOrExam('缓存答案重答完成，正在自动提交。');
						$message.success({ content: '缓存答案重答已自动提交，请查看最终结果。', duration: 0 });
						worker.emit('done');
						return;
					}
				}

				const uploadHandled = await handleCxWorkOrExamUploadAfterWork(worker, results, options, hasUnansweredQuestions);
				if (!uploadHandled) {
					$message.info({ content: '作业/考试完成，请自行检查后保存或提交。', duration: 0 });
				}
				worker.emit('done');
			})
			.catch((err) => {
				console.error(err);
				$message.error('答题程序发生错误 : ' + err.message);
			});
	} else {
		const getNextBtn = () => document.querySelector('[onclick="getTheNextQuestion(1)"]') as HTMLElement;
		let next = getNextBtn();

		(async () => {
			await restoreCachesTask;
			let lastQuestionKey = '';
			let loops = 0;
			while (next && worker.isClose === false && loops++ < 500) {
				// 点击“下一题”后题目没有变化，说明按钮没有生效，继续循环只会反复答同一道题
				const questionKey = (document.querySelector('.questionLi')?.textContent || '')
					.replace(/\s+/g, '')
					.slice(0, 200);
				if (questionKey && questionKey === lastQuestionKey) {
					const msg = '点击“下一题”后题目没有变化，已停止自动答题，请手动检查。';
					$console.warn(msg);
					$message.warn({ content: msg, duration: 0 });
					$debug.warn('cx.work', '下一题按钮没有生效，停止循环', { loops });
					break;
				}
				lastQuestionKey = questionKey;

				try {
					await worker.doWork({ enable_debug: isDebugEnabled() });
				} catch (error) {
					$console.warn('答题过程出错：' + String(error));
					break;
				}
				await $.sleep(1000);
				next = getNextBtn();
				next?.click();
				await $.sleep(1000);
			}

			$message.success({ content: '作业/考试完成，请自行检查后保存或提交。', duration: 0 });
			worker.emit('done');
			// 搜索完成后才会同步答案与题目的显示，防止题目错乱
			CommonProject.scripts.workResults.cfg.questionPositionSyncHandlerType = 'cx';
		})();
	}

	return worker;
}

/**
 * 繁体字识别-字典匹配
 * @see 参考 https://bbs.tampermonkey.net.cn/thread-2303-1-1.html
 */
async function mappingRecognize(doc: Document = document) {
	let typrMapping = Object.create({});
	try {
		// @ts-ignore
		top.typrMapping = top.typrMapping || (await loadTyprMapping());
		// @ts-ignore
		typrMapping = top.typrMapping;
	} catch {
		// 超星考试可能嵌套其他平台中，所以会存在跨域，这里需要处理一下跨域情况，如果是跨域直接在当前页面加载字库
		typrMapping = await loadTyprMapping();
	}

	/** 判断是否有繁体字 */
	const fontFaceEl = Array.from(doc.head.querySelectorAll('style')).find((style) =>
		style.textContent?.includes('font-cxsecret')
	);

	const base64ToUint8Array = (base64: string) => {
		const data = window.atob(base64);
		const buffer = new Uint8Array(data.length);
		for (let i = 0; i < data.length; ++i) {
			buffer[i] = data.charCodeAt(i);
		}
		return buffer;
	};

	const fontMap = typrMapping;
	if (fontFaceEl && Object.keys(fontMap).length > 0) {
		// 解析font-cxsecret字体
		const font = fontFaceEl.textContent?.match(/base64,([\w\W]+?)'/)?.[1];

		if (font) {
			$console.log('正在识别繁体字');

			const code = Typr.parse(base64ToUint8Array(font));

			// 匹配解密字体
			const match: any = {};
			for (let i = 19968; i < 40870; i++) {
				// 中文[19968, 40869]
				const Glyph = Typr.U.codeToGlyph(code, i);
				if (!Glyph) continue;
				const path = Typr.U.glyphToPath(code, Glyph);
				const hex = md5(JSON.stringify(path)).slice(24); // 8位即可区分
				match[i.toString()] = fontMap[hex];
			}
			const fonts = CXAnalyses.getSecretFont(doc);
			// 替换加密字体
			fonts.forEach((el, index) => {
				let html = el.innerHTML;
				for (const key in match) {
					const word = String.fromCharCode(parseInt(key));
					const value = String.fromCharCode(match[key]);

					// 如果相同，则不需要替换
					if (word === value) {
						continue;
					}

					while (html.indexOf(word) !== -1) {
						html = html.replace(word, value);
					}
				}

				el.innerHTML = html;
				el.classList.remove('font-cxsecret'); // 移除字体加密
			});

			$console.log('识别繁体字完成。');
		} else {
			$console.log('未检测到繁体字。');
		}
	}
}

async function loadTyprMapping() {
	try {
		$console.log('正在加载繁体字库。');
		return await request('https://cdn.ocsjs.com/resources/font/table.json', {
			type: 'GM_xmlhttpRequest',
			method: 'get',
			responseType: 'json'
		});
	} catch (err) {
		$console.error(
			'繁体字库加载失败（不影响普通题目，仅影响字体加密题目的识别），请检查网络或刷新页面重试：',
			(err as Error)?.message || JSON.stringify(err) || String(err)
		);
	}
}

/**
 * cx分析工具
 */
const CXAnalyses = {
	/** 是否处于闯关模式或者解锁模式 */
	isInSpecialMode() {
		return Array.from(top?.document.querySelectorAll('.catalog_points_sa,.catalog_points_er') || []).length !== 0;
	},
	/** 是否为闯关模式，并且当前章节卡在最后一个待完成的任务点 */
	async isStuckInBreakingMode() {
		if (this.isInSpecialMode()) {
			const chapter = top?.document.querySelector<HTMLElement>('.posCatalog_active');
			if (chapter) {
				const id = chapter.getAttribute('id');
				if (id) {
					// 超星好像会重绘组件，导致无法绑定属性到元素中，所以这里使用页面全局变量存储
					const counter = (await $store.getTab('chapter_counter')) || Object.create({});
					let count = Reflect.get(counter, id);
					count = count ? count + 1 : 1;
					Reflect.set(counter, id, count);

					let res = false;
					if (count >= 3) {
						Reflect.set(counter, id, 1);
						res = true;
					}
					await $store.setTab('chapter_counter', counter);
					return res;
				}
			}
		}
		return false;
	},
	/**
	 * 是否处于最后一小节
	 * 当小节为0，返回 true
	 */
	isInFinalTab() {
		// 上方小节任务栏
		const tabs = Array.from<HTMLElement>(top?.document.querySelectorAll('.prev_ul li') || []);
		if (tabs.length === 0) {
			return true;
		}
		return tabs[tabs.length - 1].classList.contains('active');
	},
	/** 是否处于最后一个章节 */
	isInFinalChapter() {
		return Array.from(top?.document.querySelectorAll('.posCatalog_select') || [])
			.pop()
			?.classList.contains('posCatalog_active');
	},
	/** 是否完成全部章节 */
	isFinishedAllChapters() {
		return this.getChapterInfos().every((chapter) => chapter.unFinishCount === 0);
	},
	/** 获取所有章节信息 */
	getChapterInfos() {
		return Array.from(top?.document.querySelectorAll('[onclick^="getTeacherAjax"]') || []).map((el) => ({
			element: el as HTMLElement,
			chapterId: el.getAttribute('onclick')?.match(/\('(.*)','(.*)','(.*)'\)/)?.[3],
			// @ts-ignore
			unFinishCount: parseInt(el.parentElement.querySelector('.jobUnfinishCount')?.value || '0')
		}));
	},
	scrollToActiveChapter() {
		const activeChapter = top?.document.querySelector<HTMLElement>('.posCatalog_active');
		if (activeChapter) {
			activeChapter.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}
	},
	/**
	 * 等待并获取章节信息，直到获取到章节信息为止
	 * - 可设置超时时间（单位秒），默认10秒
	 * - 超时后返回空数组
	 */
	waitForChapterInfos(timeout = 10) {
		return new Promise<any[]>((resolve, reject) => {
			const interval = setInterval(() => {
				const res = this.getChapterInfos();
				if (res.length > 0) {
					clearInterval(interval);
					clearInterval(to);
					resolve(res);
				}
			}, 1000);

			const to = setTimeout(() => {
				clearInterval(interval);
				resolve([]);
			}, timeout * 1000);
		});
	},
	/** 检测页面是否使用字体加密 */
	getSecretFont(doc: Document = document) {
		return Array.from(doc.querySelectorAll('.font-cxsecret')).map((font) => {
			// 这里吧选项按钮和文字分离，如果不分离的话 .font-cxsecret 元素下面还包含选项按钮时，替换时会吧按钮也删除掉导致选项按钮不可用
			const after = font.querySelector('.after');
			return after === null ? font : after;
		}) as HTMLElement[];
	},
	/**
	 * 检测当前章节是否完成
	 */
	isCurrentChapterFinished() {
		const job = top?.document.querySelector('.posCatalog_active');
		if (job) {
			if (job.querySelector('.icon_Completed') !== null) {
				return true;
			}
		}
		return false;
	}
};

/**
 * 屏蔽倍速限制
 */
function rateHack() {
	state.study.hacked = false;
	let dragCount = 0;
	try {
		hack();
		window.document.addEventListener('readystatechange', hack);
		window.addEventListener('load', hack);
	} catch (e) {
		console.error(e);
	}

	function hack() {
		const videojs = $gm.unsafeWindow.videojs;
		const Ext = $gm.unsafeWindow.Ext;

		if (typeof videojs !== 'undefined' && typeof Ext !== 'undefined') {
			if (state.study.hacked) {
				return;
			}
			state.study.hacked = true;

			const _origin = videojs.getPlugin('seekBarControl');
			const plugin = videojs.extend(videojs.getPlugin('plugin'), {
				constructor: function (videoExt: any, data: any) {
					const _sendLog = data.sendLog;
					data.sendLog = (...args: any[]) => {
						if (args[1] === 'drag') {
							dragCount++;
							// 开始播放的时候偶尔会卡顿，导致一直触发 drag 事件（超星的BUG）
							// 这里如果卡顿太多，尝试暂停视频，然后等待视频自动开始。
							if (dragCount > 100) {
								dragCount = 0;
								$el('video')?.pause();
							}
						} else {
							_sendLog.apply(data, args);
						}
					};

					_origin.apply(_origin.prototype, [videoExt, data]);
				}
			});

			videojs.registerPlugin('seekBarControl', plugin);

			// 重写超星视频插件
			Ext.define('ans.VideoJs', {
				override: 'ans.VideoJs',
				constructor: function (data: any) {
					this.addEvents(['seekstart']);
					this.mixins.observable.constructor.call(this, data);
					const vjs = videojs(data.videojs, this.params2VideoOpt(data.params), function () {});
					Ext.fly(data.videojs).on('contextmenu', function (f: any) {
						f.preventDefault();
					});
					Ext.fly(data.videojs).on('keydown', function (f: any) {
						if (f.keyCode === 32 || f.keyCode === 37 || f.keyCode === 39 || f.keyCode === 107) {
							f.preventDefault();
						}
					});

					// 保存清晰度设置
					if (vjs.videoJsResolutionSwitcher) {
						vjs.on('resolutionchange', function () {
							const cr = vjs.currentResolution();
							const re = cr.sources ? cr.sources[0].res : false;
							Ext.setCookie('resolution', re);
						});
					}

					// 保存公网设置
					if (vjs.videoJsPlayLine) {
						vjs.on('playlinechange', function () {
							const cp = vjs.currentPlayline();
							Ext.setCookie('net', cp.net);
						});
					}

					// 下面连着一个倍速限制方法，这里直接不写，实现可以倍速
				}
			});
		}
	}
}

/**
 * cx 任务学习
 */
export async function study(
	opts: typeof CXProject.scripts.study.cfg & {
		workOptions: CommonWorkOptions;
	}
) {
	await $.sleep(3000);

	const searchedJobs: Job[] = [];
	resetTaskSteps();
	setTaskState({ platform: '超星学习通' });

	let searching = true;

	/** 页面中的附件总数 */
	const attachmentTotal: number = $gm.unsafeWindow.attachments?.length || 0;
	/** 搜索窗口结束后，仍有附件未检测到时的最大宽限轮数（每轮 1 秒） */
	let graceRounds = 3;

	/** 考虑到网速级慢的同学，所以10秒后如果还没有任务点才停止 */
	setTimeout(() => {
		searching = false;
	}, 10 * 1000);

	/**
	 * 递归运行任务点，一旦有新的任务点被检测到直接开始
	 * 如果所有附件都已被检测过则立即结束，避免完成后空转等待；
	 * 否则（附件未加载完，或存在无法识别的附件）最多等待搜索窗口（10秒）结束
	 */
	const runJobs = async () => {
		const job = searchJob(opts, searchedJobs);
		// 如果存在任务点
		if (job && job.func) {
			const stepId = String(job.mid);
			upsertTaskStep({ id: stepId, status: 'running' });
			try {
				await job.func();
				upsertTaskStep({ id: stepId, status: 'done' });
			} catch (e) {
				upsertTaskStep({ id: stepId, status: 'error' });
				$console.error('未知错误', e);
			}

			await $.sleep(1000);
			await runJobs();
		}
		// 检测到了附件，但它不是需要执行的任务点（已完成、功能关闭等），立即检测下一个，
		// 否则三个任务中，中间的任务不是任务点，会导致下面的任务全部不执行。
		else if (job) {
			await $.sleep(200);
			await runJobs();
		}
		// 尚有附件未被检测到，并且仍在搜索窗口内
		else if (searching && (attachmentTotal === 0 || searchedJobs.length < attachmentTotal)) {
			await $.sleep(1000);
			await runJobs();
		}
		// 搜索窗口已结束但仍有附件未检测到（长视频结束后才加载的附件），再给几秒宽限时间
		else if (searchedJobs.length < attachmentTotal && graceRounds-- > 0) {
			await $.sleep(1000);
			await runJobs();
		}
	};

	await runJobs();
	// 本页任务点都处理完了，接下来是跳转：保持“运行中”，避免窗口显示成待机
	setTaskState({
		kind: 'other',
		status: 'running',
		title: '本页任务点已处理完，正在跳转',
		progress: 1,
		busy: undefined,
		canSkip: false
	});
	$debug.log('cx.study', '任务点处理结束', {
		searched: searchedJobs.length,
		attachmentTotal,
		mode: opts.mode
	});

	// @ts-ignore
	top._preChapterId = '';

	// 下一章
	const next = async () => {
		// 一个章节可能有多个小节标签页（1、2…，例如两个章节测验）：先把后面的小节依次做完，再跳转到下一章。
		// 直接点击下一个小节标签，不依赖超星 PCount.next 内部记录的当前小节序号
		// （页面刷新或直接进入某个小节后它可能与实际不一致，会直接跳到下一章，漏掉后面的小节）。
		const sectionTabs = Array.from(top?.document.querySelectorAll<HTMLElement>('.prev_ul li') || []);
		const activeTabIndex = sectionTabs.findIndex((tab) => tab.classList.contains('active'));
		$debug.log('cx.next', '准备跳转', {
			mode: CXProject.scripts.study.cfg.mode,
			tabs: sectionTabs.map((tab) => tab.className.trim() || '-'),
			activeTabIndex,
			isInFinalTab: CXAnalyses.isInFinalTab(),
			isInFinalChapter: Boolean(CXAnalyses.isInFinalChapter())
		});
		if (sectionTabs.length > 1 && activeTabIndex !== -1 && activeTabIndex < sectionTabs.length - 1) {
			const tabMsg = `本章共 ${sectionTabs.length} 个小节，当前第 ${
				activeTabIndex + 1
			} 个已完成，即将切换到下一个小节。`;
			$console.info(tabMsg);
			$message.info({ content: tabMsg, duration: 5 });
			await $.sleep(500);
			if (skipInDryRun('切换到下一个小节', 'cx.next')) {
				return;
			}
			sectionTabs[activeTabIndex + 1].click();
			return;
		}

		if (CXAnalyses.isInFinalTab()) {
			if (await CXAnalyses.isStuckInBreakingMode()) {
				return $modal.alert({
					content: '检测到此章节重复进入, 为了避免无限重复, 请自行手动完成后手动点击下一章, 或者刷新重试。'
				});
			}
		}

		if (CXAnalyses.isInFinalChapter()) {
			let content = '';

			if (opts.backToFirstWhenFinish) {
				content = '已经抵达最后一个章节，10秒后返回第一个章节重新开始。';
				setTimeout(() => {
					top?.document.querySelector<HTMLElement>('.posCatalog_name')?.click();
				}, 10 * 1000);

				$message.info({ content, duration: 30 });
			} else {
				if (CXAnalyses.isFinishedAllChapters()) {
					content = '全部任务点已完成！';
				} else {
					content = '已经抵达最后一个章节！但仍然有任务点未完成，请手动切换至未完成的章节。';
				}

				$modal.alert({ content: content });
			}

			CommonProject.scripts.settings.methods.notificationBySetting(content, {
				duration: 0,
				extraTitle: '超星学习通学习脚本'
			});
			return;
		}

		if (CXProject.scripts.study.cfg.mode === 'job') {
			// 检测当前章节是否完成，如果已经完成则下一章
			// 如果没有需要完成的章节，则暂停运行

			if (CXAnalyses.isInFinalTab()) {
				// 找到未完成
				const elements = CXAnalyses.getChapterInfos()
					.filter((el) => el.unFinishCount > 0 || el.element.parentElement?.classList.contains('posCatalog_active'))
					.map((el) => el.element.parentElement as HTMLElement);
				if (elements.length === 0) {
					const content = '全部任务点已完成！';
					finishTask(content);
					$modal.alert({ content: content });
					CommonProject.scripts.settings.methods.notificationBySetting(content, {
						duration: 0,
						extraTitle: '超星学习通学习脚本'
					});
					return;
				}

				// 如果当前章节未完成，则跳转到下一个未完成章节
				const currentIndex = elements.findIndex((el) => el.classList.contains('posCatalog_active'));
				let nextChapter: HTMLElement | undefined;
				if (currentIndex !== -1 && currentIndex + 1 < elements.length) {
					nextChapter = elements[currentIndex + 1];
				} else {
					// 后面已经没有未完成章节，回到前面仍未完成的章节（每个章节只回退一次，避免来回无限跳转）
					const visitKey = 'cx_job_fallback_visited';
					const visited = (((await $store.getTab(visitKey)) as string[] | undefined) || []).filter(Boolean);
					const fallback = elements.find(
						(el) => !el.classList.contains('posCatalog_active') && !visited.includes(el.id || el.textContent || '')
					);
					if (fallback) {
						visited.push(fallback.id || fallback.textContent || '');
						await $store.setTab(visitKey, visited);
						nextChapter = fallback;
					}
				}

				if (nextChapter) {
					const target = nextChapter;
					CXAnalyses.scrollToActiveChapter();
					if (skipInDryRun('跳转到下一个未完成章节', 'cx.next')) {
						return;
					}
					setTimeout(() => {
						target.querySelector<HTMLElement>('.posCatalog_name')?.click();
					}, 500);
				} else {
					const content = '没有可继续自动跳转的未完成章节了，如仍有未完成章节，请手动切换。';
					$console.warn(content);
					$modal.alert({ content: content });
					CommonProject.scripts.settings.methods.notificationBySetting(content, {
						duration: 0,
						extraTitle: '超星学习通学习脚本'
					});
				}
			}
		} else if (CXProject.scripts.study.cfg.mode === 'next') {
			const curCourseId = $el<HTMLInputElement>('#curCourseId', top?.document);
			const curChapterId = $el<HTMLInputElement>('#curChapterId', top?.document);
			const curClazzId = $el<HTMLInputElement>('#curClazzId', top?.document);
			const count = $$el('#prev_tab .prev_ul li', top?.document);

			// 自动下一个小节（点击下一节）
			if (curChapterId && curCourseId && curClazzId) {
				// @ts-ignore
				top._preChapterId = curChapterId.value;
				CXAnalyses.scrollToActiveChapter();
				// 等待跳转动画完成
				await $.sleep(200);

				/**
				 * count, chapterId, courseId, clazzid, knowledgestr, checkType
				 * checkType 就是询问当前章节还有任务点未完成，是否完成，这里直接不传，默认下一章
				 */
				if (skipInDryRun('跳转到下一节', 'cx.next')) {
					return;
				}

				const before = readCxPosition();
				// @ts-ignore
				top?.PCount.next(count.length.toString(), curChapterId.value, curCourseId.value, curClazzId.value, '');

				// 超星的 PCount.next 在被拦截（例如笔记未保存）或请求失败时不会有任何提示，
				// 这里确认页面确实发生了变化，没有变化时改点击页面上的“下一节”按钮，仍然不行再提醒用户手动处理
				if (!(await waitForCxPositionChange(before, 10 * 1000))) {
					$console.warn('调用超星跳转后页面没有变化，尝试点击页面上的“下一节”按钮。');
					$debug.warn('cx.next', 'PCount.next 没有生效，尝试点击下一节按钮', before);
					const nextBtn = top?.document.querySelector<HTMLElement>('#prevNextFocusNext');
					nextBtn?.click();

					if (!(await waitForCxPositionChange(before, 8 * 1000))) {
						const content = '自动跳转没有生效（可能是页面弹窗拦截了跳转，或网络异常），请手动点击“下一节”。';
						$console.error(content);
						$message.error({ content, duration: 0 });
						CommonProject.scripts.settings.methods.notificationBySetting(content, {
							duration: 0,
							extraTitle: '超星学习通学习脚本'
						});
					}
				}
			} else {
				$console.warn('参数错误，无法跳转下一章，请尝试手动切换。');
			}
		} else {
			$console.warn('未知的跳转模式，请联系作者反馈');
		}
	};

	if (CXProject.scripts.study.cfg.mode !== 'manually') {
		const msg = '页面任务点已完成，即将跳转。';
		$message.success({ content: msg });
		$console.info(msg);
		await $.sleep(2000);
		next().catch((error) => {
			// next 不会被等待，没有这里的捕获，跳转过程中的异常会悄悄消失，表现为“卡住不动”
			$console.error('自动跳转时出错：' + String(error));
			$debug.error('cx.next', '跳转过程出错', String(error));
		});
	} else {
		const msg = '页面任务点已完成，自动跳转已关闭，请手动跳转。';
		finishTask('本页已完成，请手动跳转');
		$message.warn({ content: msg, duration: 0 });
		$console.warn(msg);
	}
}

/** 读取当前所处的章节和小节，用于判断自动跳转是否真的生效 */
function readCxPosition() {
	const tabs = Array.from(top?.document.querySelectorAll<HTMLElement>('.prev_ul li') || []);
	return {
		chapterId: top?.document.querySelector<HTMLInputElement>('#curChapterId')?.value || '',
		activeCatalog: top?.document.querySelector('.posCatalog_active')?.getAttribute('id') || '',
		activeTab: tabs.findIndex((tab) => tab.classList.contains('active')),
		cardId: top?.document.querySelector('.prev_ul li.active')?.getAttribute('cardid') || ''
	};
}

async function waitForCxPositionChange(before: ReturnType<typeof readCxPosition>, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await $.sleep(500);
		const now = readCxPosition();
		if (
			now.chapterId !== before.chapterId ||
			now.activeCatalog !== before.activeCatalog ||
			now.activeTab !== before.activeTab ||
			now.cardId !== before.cardId
		) {
			return true;
		}
	}
	return false;
}

/** 答题结束后汇总没有答出的题目并在页面上提示，避免只能到日志里才能发现 */
function reportUnfinishedQuestions(results: { result?: { finish?: boolean } }[], label: string) {
	const unfinished = results
		.map((item, index) => ({ item, number: index + 1 }))
		.filter(({ item }) => item.result?.finish !== true)
		.map(({ number }) => number);
	if (unfinished.length === 0) {
		return;
	}

	const shown = unfinished.slice(0, 20).join('、') + (unfinished.length > 20 ? ' 等' : '');
	const msg = `${label}有 ${unfinished.length} 题没有答出（第 ${shown} 题）：题库没有匹配，AI 也没有给出可用答案或请求失败。请手动检查，详情见 后台-搜题日志。`;
	$console.warn(msg);
	$message.warn({ content: msg, duration: 0 });
}

function searchIFrame(root: Document) {
	let list = Array.from(root.querySelectorAll('iframe'));
	const result: HTMLIFrameElement[] = [];
	while (list.length) {
		const frame = list.shift();

		try {
			if (frame && frame?.contentWindow?.document) {
				result.push(frame);
				const frames = frame?.contentWindow?.document.querySelectorAll('iframe');
				list = list.concat(Array.from(frames || []));
			}
		} catch (e) {
			// @ts-ignore
			console.log(e.message);
		}
	}
	return result;
}

/** 未配置题库的提示只弹一次，避免任务点搜索循环中反复提示 */
let emptyWrapperWarned = false;

/**
 * 搜索任务点
 */
function searchJob(
	opts: typeof CXProject.scripts.study.cfg & {
		workOptions: CommonWorkOptions;
	},
	searchedJobs: Job[]
): Job | undefined {
	const knowCardWin = $gm.unsafeWindow;

	const searchJobElement = (root: HTMLIFrameElement) => {
		return domSearch(
			{
				videojs: '#video,#audio',
				chapterTest: '.TiMu',
				read: '#img.imglook',
				pptWithAudio: '.swiper-container',
				hyperlink: '#hyperlink'
			},
			root.contentWindow!.document
		);
	};

	const search = (root: HTMLIFrameElement): Job | undefined => {
		const win = root.contentWindow;

		const { videojs, read, chapterTest, hyperlink, pptWithAudio } = searchJobElement(root);

		if (win && (videojs || read || chapterTest || hyperlink || pptWithAudio)) {
			// 获取任务点数据字符串
			const frame_data_str =
				win.frameElement?.getAttribute('data') ||
				// 带音频的PPT，套了两层iframe
				(win.frameElement as HTMLIFrameElement)?.contentWindow?.parent.frameElement?.getAttribute('data') ||
				'{}';
			let frame_data: any = {};
			try {
				frame_data = JSON.parse(frame_data_str);
			} catch {
				return;
			}
			const target_jobid = frame_data.jobid || frame_data._jobid;
			if (!target_jobid) {
				return;
			}

			// 获取任务点数据
			const attachment: Attachment | undefined = ((knowCardWin.attachments || []) as any[]).find((attachment) => {
				const attachment_jobid = attachment.jobid || attachment.property._jobid;
				if (!attachment_jobid) {
					return false;
				}
				return String(attachment_jobid) === String(target_jobid);
			});

			// 任务点去重
			if (attachment && searchedJobs.find((job) => job.mid === attachment.property.mid) === undefined) {
				const { name, title, bookname, author } = attachment.property;
				const jobName = name || title || (bookname ? bookname + author : undefined) || '未知任务';

				const work_type = attachment.job ? 'job' : attachment.isPassed ? 'finished' : 'not-job';

				let func: { (): Promise<any> } | undefined;
				/** 暂时无法执行（例如还没配置题库）的任务点不标记为已搜索，下次搜索时重新判断 */
				let retryLater = false;

				if (videojs) {
					if (!CXProject.scripts.study.cfg.enableMedia) {
						const msg = `音视频自动学习功能已被关闭（在上方菜单栏，超星学习通-课程学习中开启）。${jobName} 即将跳过`;
						$message.warn({ content: msg, duration: 10 });
						$console.warn(msg);
					} else {
						if (
							// 未完成
							work_type === 'job' ||
							// 重复学习
							(work_type === 'finished' && opts.restudy) ||
							// 强制学习
							(work_type === 'not-job' && opts.forceLearn)
						) {
							func = () => {
								const msg =
									`即将${
										work_type === 'finished' && opts.restudy
											? '重新'
											: work_type === 'not-job' && opts.forceLearn
											? '强制'
											: ''
									}播放 : ` + jobName;
								$message.info({ content: msg });
								$console.log(msg);
								return JobRunner.media(opts, win.document, jobName);
							};
						}
					}
				} else if (chapterTest) {
					if (!CXProject.scripts.study.cfg.enableChapterTest) {
						const msg = `章节测试自动答题功能已被关闭（在上方菜单栏，超星学习通-课程学习中开启）。${jobName} 即将跳过`;
						$message.warn({ content: msg, duration: 10 });
						$console.warn(msg);
					} else {
						const status = win.document.querySelector<HTMLElement>('.testTit_status');

						// 已完成
						if (status?.classList.contains('testTit_status_complete')) {
							const msg = `章节测试已完成 : ` + jobName;
							$message.success({ content: msg });
							$console.log(msg);

							// 已完成的章节测验页面上通常能看到正确答案，顺便缓存下来（之前这里只提示“已完成”，不会缓存）
							cacheChapterAnswersFromCurrentView(
								win,
								(titles) =>
									transformChapterTestTitle(titles, CommonProject.scripts.settings.cfg.redundanceWordsText || ''),
								'章节测验已完成'
							);
						} else {
							if (
								// 未完成
								work_type === 'job' ||
								// / 强制学习
								(work_type === 'not-job' && (CommonProject.scripts.settings.cfg['work-when-no-job'] || opts.forceLearn))
							) {
								// 每次都读取最新的全局设置，这样在页面打开后再配置题库也能生效，无需刷新页面
								const latestWorkOptions = CommonProject.scripts.settings.methods.getWorkOptions();
								if (
									(latestWorkOptions.answererWrappers === undefined ||
										latestWorkOptions.answererWrappers.length === 0) &&
									!isAiAnswererAvailable()
								) {
									retryLater = true;
									if (!emptyWrapperWarned) {
										emptyWrapperWarned = true;
										answerWrapperEmptyWarning(0);
									}
								} else {
									func = () => {
										const msg = `开始答题 : ` + jobName;
										$message.info({ content: msg });
										$console.log(msg);
										return JobRunner.chapter(root, latestWorkOptions, jobName);
									};
								}
							}
							if (
								work_type === 'not-job' &&
								!CommonProject.scripts.settings.cfg['work-when-no-job'] &&
								!opts.forceLearn
							) {
								const msg = `当前作业 ${jobName} 不是任务点，但待完成，如需自动答题，请在“课程学习”中开启“强制学习”，或前往：通用-全局设置，开启“(仅超星)强制答题”。`;
								$message.warn({ content: msg });
								$console.warn(msg);
							}
						}
					}
				} else if (read || pptWithAudio) {
					if (!CXProject.scripts.study.cfg.enablePPT) {
						const msg = `PPT/书籍阅读功能已被关闭（在上方菜单栏，超星学习通-课程学习中开启）。${jobName} 即将跳过`;
						$message.warn({ content: msg, duration: 10 });
						$console.warn(msg);
					} else {
						if (attachment.job) {
							func = () => {
								const msg = `正在学习 : ` + jobName;
								$message.info({ content: msg });
								$console.log(msg);
								setTaskState({
									kind: 'document',
									status: 'running',
									title: jobName,
									platform: '超星学习通',
									progress: null,
									canSkip: false
								});
								if (read) {
									return JobRunner.read(win);
								} else {
									return JobRunner.readPPTWithAudio(win);
								}
							};
						}
					}
				} else if (hyperlink) {
					if (!CXProject.scripts.study.cfg.enableHyperlink) {
						const msg = `链接任务点已被关闭（在上方菜单栏，超星学习通-课程学习中开启）。${jobName} 即将跳过`;
						$message.warn({ content: msg, duration: 10 });
						$console.warn(msg);
					} else {
						if (attachment.job) {
							func = () => {
								const msg = `正在完成链接阅读任务 : ` + jobName;
								$message.info({ content: msg });
								$console.log(msg);
								setTaskState({
									kind: 'document',
									status: 'running',
									title: jobName,
									platform: '超星学习通',
									progress: null,
									canSkip: false
								});
								return JobRunner.hyperlink(hyperlink);
							};
						}
					}
				}

				$debug.log('cx.job', func ? '将执行任务点' : '不执行任务点', {
					name: jobName,
					kind: videojs ? 'video' : chapterTest ? 'chapterTest' : read ? 'read' : pptWithAudio ? 'ppt' : 'hyperlink',
					work_type,
					retryLater,
					mid: attachment.property.mid
				});

				const stepKind = videojs
					? (videojs as HTMLElement).id === 'audio'
						? 'audio'
						: 'video'
					: chapterTest
					? 'quiz'
					: 'document';
				upsertTaskStep({
					id: String(attachment.property.mid),
					kind: stepKind,
					title: jobName,
					status: func ? 'pending' : work_type === 'finished' ? 'done' : 'skipped',
					note: func ? undefined : work_type === 'finished' ? '已完成' : '未执行'
				});

				const job = {
					mid: attachment.property.mid,
					attachment: attachment,
					func: func
				};

				if (!func && retryLater) {
					return;
				}

				searchedJobs.push(job);

				return job;
			}
		}
	};

	let job;

	for (const iframe of searchIFrame(knowCardWin.document)) {
		// 单个 iframe 出错（例如跨域、页面未加载完成）不应中断整个任务点搜索
		try {
			job = search(iframe);
		} catch (e) {
			job = undefined;
		}
		if (job) {
			return job;
		}
	}

	return job;
}

/**
 * 永久固定显示视频进度
 */
export function fixedVideoProgress() {
	if (state.study.videojs) {
		const { bar } = domSearch({ bar: '.vjs-control-bar' }, state.study.videojs as any);
		if (bar) {
			bar.style.opacity = '1';
		}
	}
}

/**
 * 通过题库（含缓存）和 AI 搜索视频内题目的答案，返回需要点击的选项下标，搜不到时返回空数组。
 * 与视频内容强相关的题目，AI 会标记“信息不足”，但依然会给出最可能的答案。
 */
async function searchVideoQuizAnswer(doc: Document, workOptions: CommonWorkOptions | undefined, videoName: string) {
	try {
		const labels = Array.from(doc.querySelectorAll<HTMLElement>('.ans-videoquiz-opt label'));
		if (labels.length === 0) {
			return [];
		}

		const optionTexts = labels.map((label) =>
			(label.innerText || label.textContent || '').replace(/^\s*[A-H]\s*[.、:：．]?\s*/, '').trim()
		);

		const container = doc.querySelector<HTMLElement>('.ans-videoquiz');
		let title = (doc.querySelector<HTMLElement>('.ans-videoquiz-title')?.innerText || '').trim();
		if (!title && container) {
			title = container.innerText;
			for (const label of labels) {
				title = title.replace(label.innerText || '', '');
			}
		}
		title = title
			.replace(/^\s*[[【(（]?\s*(单选题|多选题|判断题|填空题|选择题)\s*[\]】)）]?\s*/, '')
			.replace(/提交/g, '')
			.trim();
		if (!title) {
			return [];
		}

		const type: 'single' | 'multiple' | 'judgement' = doc.querySelector('.ans-videoquiz-opt input[type="checkbox"]')
			? 'multiple'
			: optionTexts.length === 2 &&
			  optionTexts.every((text) => /^(对|错|正确|错误|√|×|true|false|t|f|是|否)$/i.test(text))
			? 'judgement'
			: 'single';

		const infos = await CommonProject.scripts.apps.methods.searchAnswerInCaches(title, () =>
			searchAnswerInWrappers(
				workOptions?.answererWrappers || [],
				{
					title,
					type,
					options: optionTexts.map((text, index) => `${String.fromCharCode(65 + index)}. ${text}`).join('\n'),
					scenario: 'video-quiz',
					videoName
				},
				'auto'
			)
		);

		const results = infos.flatMap((info) => info.results).filter((result) => result.answer);
		if (results.length === 0) {
			return [];
		}

		const indexes = matchAnswerToOptions(
			results.map((result) => result.answer),
			optionTexts,
			type
		);
		if (indexes.length) {
			const insufficient = results.some((result) => (result.extra_data as { insufficient?: boolean })?.insufficient);
			const source = infos.find((info) => info.results.length)?.name || '题库';
			$console.info(
				insufficient
					? `视频内题目与视频内容强相关，信息不足，已按 AI 的猜测作答（${source}）：${title}`
					: `视频内题目已通过 ${source} 作答：${title}`
			);
		}
		return indexes;
	} catch (error) {
		$console.warn('视频内题目搜题失败：' + String(error));
		return [];
	}
}

/** 填空题答案中的图片链接（公式、示意图）还原成 <img>，直接填入编辑器 */
function cxBlankAnswerToHtml(answer: string) {
	return answer.replace(/https?:\/\/[^\s"'<>]+/gi, (url) =>
		/\.(png|jpe?g|gif|webp|bmp)(\?|#|$)/i.test(url) || /\/(star\d?|latex|image|img|ananas)/i.test(url)
			? `<img src="${url}" />`
			: url
	);
}

/** 章节测验题干的统一处理（答题、缓存标准答案时必须使用同一个规则，题干才能对得上） */
function transformChapterTestTitle(titles: (HTMLElement | undefined)[], redundanceWordsText: string) {
	const removed = removeRedundantWords(
		titles.map((t) => (t ? optimizationElementWithImage(t, true).innerText : '')).join(','),
		String(redundanceWordsText || '').split('\n')
	);

	return (
		removed
			.trim()
			/** 超星旧版作业题目冗余数据 */
			.replace(/^\d+[。、.]/, '')
			.replace(/（\d+\.\d+分）/, '')
			.replace(/\(..题, \d+?分\)/, '')
			.replace(/\(..题, \d+\.\d+分\)/, '')
			.replace(/[[(【（](..题|名词解释|完形填空|阅读理解)[\])】）]/, '')
			.trim()
	);
}

/**
 * 任务点运行器
 */
const JobRunner = {
	/**
	 * 播放视频和音频
	 */
	async media(
		setting: {
			playbackRate: number;
			volume: number;
			videoQuizStrategy: VideoQuizStrategy;
			workOptions?: CommonWorkOptions;
		},
		doc: Document,
		videoName = ''
	) {
		const { playbackRate = 1, volume = 0 } = setting;

		const media = await waitForMedia({ root: doc });

		// @ts-ignore
		const { videojs } = domSearch({ videojs: '#video,#audio' }, doc);

		if (!videojs || !media) {
			$console.error('视频检测不到，请尝试刷新或者手动切换下一章。');
			return;
		}

		state.study.videojs = videojs;
		// @ts-ignore
		top.currentMedia = media;

		// 上报任务状态：窗口的圆点、标题栏、总览页都读取这份数据
		const mediaKind = (videojs as HTMLElement).id === 'audio' ? 'audio' : 'video';
		const stopTrack = trackMediaProgress(media, {
			kind: mediaKind,
			title: videoName,
			platform: '超星学习通',
			canSkip: true
		});

		// 固定视频进度
		fixedVideoProgress();

		// 作答视频内题目
		let quizLoopStopped = false;
		if (setting.videoQuizStrategy === 'random' || setting.videoQuizStrategy === 'search') {
			const handleQuiz = async () => {
				const submitBtn = () => doc.querySelector<HTMLElement>('#videoquiz-submit');
				if (submitBtn()) {
					const labels = Array.from(doc.querySelectorAll<HTMLElement>('.ans-videoquiz-opt label'));
					let indexes: number[] = [];

					if (setting.videoQuizStrategy === 'search') {
						indexes = await searchVideoQuizAnswer(doc, setting.workOptions, videoName);
					}

					if (indexes.length === 0) {
						indexes = [Math.floor(Math.random() * labels.length)];
						if (setting.videoQuizStrategy === 'search') {
							$console.warn('视频内题目未能通过题库/AI 得到答案，已随机选择。');
						}
					}

					for (const index of indexes) {
						labels[index]?.click();
						await $.sleep(200);
					}
					submitBtn()?.click();
					await $.sleep(3000);
					// 隐藏视频内题目元素
					const container = doc.querySelector<HTMLElement>('#video .ans-videoquiz');
					const components = Array.from(doc.querySelectorAll<HTMLElement>('.x-component-default'));
					if (container) {
						container.remove();
					}
					if (components.length) {
						for (const com of components) {
							com.style.display = 'none';
						}
					}
				}
			};
			const loop = async () => {
				if (quizLoopStopped) {
					return;
				}
				try {
					await handleQuiz();
				} catch (e) {
					$console.warn('处理视频内题目时出错：' + String(e));
				}
				await $.sleep(3000);
				await loop();
			};
			loop();
		}

		/**
		 * 视频播放
		 */
		return new Promise<void>((resolve, reject) => {
			let finished = false;
			let lastTime = media.currentTime;
			let lastProgressAt = Date.now();
			let stallRecovered = false;

			/** 结束播放流程：清理所有定时器和监听，并停止视频内题目的循环 */
			const finish = (action: () => void) => {
				if (finished) {
					return;
				}
				finished = true;
				quizLoopStopped = true;
				clearInterval(reloadInterval);
				clearInterval(stallInterval);
				media.removeEventListener('pause', playFunction);
				stopTrack();
				stopControl();
				action();
			};

			// 窗口上的 暂停 / 继续 / 跳过 按钮
			const stopControl = registerMediaControl(media, () => {
				$console.info('已跳过当前视频。');
				finish(() => resolve());
			});

			// 检测视频加载失败
			const reloadInterval = setInterval(() => {
				const errorDiv = doc.querySelector<HTMLElement>('.vjs-modal-dialog-content');
				if (
					['视频文件损坏', '网络错误导致视频下载中途失败', '视频因格式不支持', '网络的问题无法加载'].some((s) =>
						errorDiv?.innerText.includes(s)
					)
				) {
					$console.error('检测到视频加载失败，即将跳过视频。');
					$message.error('检测到视频加载失败，即将跳过视频。');
					setTaskState({ status: 'error', message: '视频加载失败，已跳过' });
					$debug.warn('cx.media', '视频加载失败，跳过', { text: errorDiv?.innerText.slice(0, 80) });
					finish(() => setTimeout(resolve, 3000));
				}
			}, 3000);

			// 检测播放卡住：视频没有结束也没有暂停，但播放进度长时间不前进（网络卡死等）
			const stallInterval = setInterval(() => {
				if (media.ended || media.paused || Math.abs(media.currentTime - lastTime) > 0.1) {
					lastTime = media.currentTime;
					lastProgressAt = Date.now();
					return;
				}

				const stalledSeconds = (Date.now() - lastProgressAt) / 1000;
				if (stalledSeconds >= 180) {
					const msg = '视频长时间没有播放进度，已跳过该视频，请检查网络后手动补学。';
					$console.error(msg);
					$message.error({ content: msg, duration: 10 });
					$debug.error('cx.media', '播放进度长时间没有变化，跳过', { stalledSeconds, currentTime: media.currentTime });
					finish(() => resolve());
				} else if (stalledSeconds >= 60 && !stallRecovered) {
					stallRecovered = true;
					$console.warn(`视频播放进度已 ${Math.round(stalledSeconds)} 秒没有变化，尝试重新播放。`);
					$debug.warn('cx.media', '播放卡住，尝试恢复', { stalledSeconds, currentTime: media.currentTime });
					playMedia(() => media.play()).then(() => {
						media.playbackRate = playbackRate;
					});
				}
			}, 5000);

			const playFunction = async () => {
				// 用户通过窗口按钮暂停时，不要自动恢复播放
				if (isUserPaused()) {
					return;
				}
				// 这里先判断，再检测，否则后续添加多个 await 会导致视频启动等待时间过长，导致用户误认为脚本失效
				if (hasFaceRecognition()) await waitForFaceRecognition();
				if (hasNewFaceRecognition()) await waitForNewFaceRecognition();
				if (media.ended === false) {
					await $.sleep(1000);
					media.play();
					media.playbackRate = playbackRate;
				}
			};

			media.addEventListener('pause', playFunction);

			media.addEventListener('ended', () => {
				$console.log('视频播放完毕');
				finish(() => resolve());
			});

			$console.log('视频开始播放');
			$debug.log('cx.media', '开始播放', { name: videoName, duration: media.duration, playbackRate });
			media.volume = volume;

			// 重置视频进度
			media.currentTime = 0;

			// 使用 setTimeout 解决 The play() request was interrupted by a call to pause() 问题
			setTimeout(() => {
				playMedia(() => media.play())
					.then(() => {
						media.playbackRate = playbackRate;
					})
					.catch((error) => finish(() => reject(error)));
			}, 200);
		});
	},
	/**
	 * 阅读，PPT
	 */
	async read(win: Window & { finishJob?: Function }) {
		const finishJob = win.finishJob;
		if (finishJob) finishJob();
		await $.sleep(3000);
	},
	/**
	 * 章节测验
	 */
	async chapter(frame: HTMLIFrameElement, options: ChapterWorkOptions, jobName = '章节测验') {
		const {
			answererWrappers,
			period,
			upload,
			thread,
			stopSecondWhenFinish,
			redundanceWordsText,
			answerSeparators,
			answerMatchMode
		} = options;
		const chapterAutoRetakeDepth = options.chapterAutoRetakeDepth || 0;
		const chapterAutoRetakeEnabled =
			Boolean(CommonProject.scripts.settings.cfg['chapterTest-autoRetake']) && chapterAutoRetakeDepth === 0;

		if ((answererWrappers === undefined || answererWrappers.length === 0) && !isAiAnswererAvailable()) {
			return answerWrapperEmptyWarning(0);
		}

		$console.info('开始章节测试');
		await restoreChapterRetakeCaches();
		const visual_state = CommonProject.scripts.render.cfg.visual;

		const frameWindow = frame.contentWindow as
			| (Window & {
					noSubmit?: () => void;
					btnBlueSubmit?: () => void;
					submitCheckTimes?: () => void;
					alert?: (...args: any[]) => void;
			  })
			| null;
		const { TiMu } = domSearchAll({ TiMu: '.TiMu' }, frameWindow!.document);

		// 最大化面板
		CORSUtils.panelNormal();
		CommonProject.scripts.workResults.methods.init();
		// 固定显示答题结果面板
		CORSUtils.pinWorkPanel();

		const chapterTestTaskQuestionTitleTransform = (titles: (HTMLElement | undefined)[]) =>
			transformChapterTestTitle(titles, redundanceWordsText);

		if (frameWindow) {
			await cacheChapterAnswersFromCurrentView(frameWindow, chapterTestTaskQuestionTitleTransform, '章节测验页面加载');
		}

		/** 新建答题器 */
		const worker = new OCSWorker({
			root: TiMu,
			elements: {
				title: '.Zy_TItle .clearfix',
				/**
				 * 兼容各种选项
				 *
				 * ul li .after 单选多选
				 * ul li label:not(.after) 判断题
				 * ul li textarea 填空题
				 */
				options: 'ul li .after,ul li textarea,ul textarea,ul li label:not(.before)',
				type: 'input[id^="answertype"]',
				lineAnswerInput: '.line_answer input[name^=answer]',
				lineSelectBox: '.line_answer_ct .selectBox '
			},
			thread: thread ?? 1,
			answerSeparators: answerSeparators.split(',').map((s) => s.trim()),
			answerMatchMode: answerMatchMode,
			/** 默认搜题方法构造器 */
			answerer: (elements, ctx) => {
				const title = chapterTestTaskQuestionTitleTransform(elements.title);
				if (title) {
					const typeInput = elements.type[0] as HTMLInputElement;

					return CommonProject.scripts.apps.methods.searchAnswerInCaches(
						title,
						async () => {
							await $.sleep((period ?? 3) * 1000);
							return searchAnswerInWrappers(
								answererWrappers,
								{
									type: (typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined) || 'unknown',
									blankCount: ctx.type === 'completion' ? ctx.elements.options.length : 0,
									title,
									options:
										ctx.type === 'completion'
											? ''
											: ctx.elements.options.map((o) => optimizationElementWithImage(o, true).innerText).join('\n')
								},
								'auto'
							);
						},
						ctx.type === 'completion'
							? []
							: ctx.elements.options.map((o) => optimizationElementWithImage(o, true).innerText)
					);
				} else {
					throw new Error('题目为空，请查看题目是否为空，或者忽略此题');
				}
			},

			work: async (ctx) => {
				const { elements, searchInfos } = ctx;
				const typeInput = elements.type[0] as HTMLInputElement;
				const type = typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined;

				if (type && (type === 'completion' || type === 'multiple' || type === 'judgement' || type === 'single')) {
					const resolver = createDefaultQuestionResolver(ctx)[type];
					let selectedOptionsCleared = false;
					const clearSelectedOptionsOnce = async () => {
						if (selectedOptionsCleared || type !== 'multiple') {
							return;
						}

						selectedOptionsCleared = true;
						await clearCxSelectedOptions(elements.options);
					};

					const handler = async (type: any, answer: string, option: HTMLElement) => {
						if (type === 'judgement' || type === 'single' || type === 'multiple') {
							await clearSelectedOptionsOnce();
							if (!isCxChoiceOptionSelected(option)) {
								option?.click();
							}
						} else if (type === 'completion' && answer.trim()) {
							const text = option?.parentElement?.querySelector('textarea');
							const textareaFrame = option?.parentElement?.querySelector('iframe');
							if (text) {
								text.value = cxBlankAnswerToHtml(answer);
							}
							if (textareaFrame?.contentDocument) {
								textareaFrame.contentDocument.body.innerHTML = cxBlankAnswerToHtml(answer);
							}
							if (option?.parentElement?.parentElement) {
								/** 如果存在保存按钮则点击 */
								$el('[onclick*=saveQuestion]', option.parentElement.parentElement)?.click();
							}
						}
					};

					return await resolver(
						searchInfos,
						elements.options.map((option) => optimizationElementWithImage(option)),
						handler
					);
				}
				// 连线题自定义处理
				else if (type && type === 'line') {
					for (const answers of searchInfos.map((info) => info.results.map((res) => res.answer))) {
						let ans = answers;
						if (ans.length === 1) {
							ans = splitAnswer(ans[0]);
						}
						if (ans.filter(Boolean).length !== 0 && elements.lineAnswerInput) {
							//  选择答案
							for (let index = 0; index < elements.lineSelectBox.length; index++) {
								const box = elements.lineSelectBox[index];
								if (ans[index]) {
									$el(`li[data=${ans[index]}] a`, box)?.click();
									await $.sleep(200);
								}
							}

							return { finish: true };
						}
					}

					return { finish: false };
				}

				return { finish: false };
			},

			/** 完成答题后 */
			async onResultsUpdate(curr, _, res) {
				updateTaskFromResults(res, { kind: 'quiz', title: jobName });
				CommonProject.scripts.workResults.methods.setResults(
					simplifyWorkResult(res, chapterTestTaskQuestionTitleTransform)
				);

				if (curr.result?.finish) {
					CommonProject.scripts.apps.methods.addQuestionCacheFromWorkResult(
						simplifyWorkResult([curr], chapterTestTaskQuestionTitleTransform)
					);
				}
				CommonProject.scripts.workResults.methods.updateWorkStateByResults(res);

				// 没有完成时随机作答
				if (curr.result?.finish === false && curr.resolved === true) {
					if (isCxWorkResultPhysicallyAnswered(curr)) {
						$console.log('题库未命中，但页面已存在作答，保留原答案提交。');
						return;
					}

					const options = curr.ctx?.elements?.options || [];

					const typeInput = curr.ctx?.elements?.type[0] as HTMLInputElement | undefined;
					const type = typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined;

					const commonSetting = CommonProject.scripts.settings.cfg;

					if (
						(chapterAutoRetakeEnabled || commonSetting['randomWork-choice']) &&
						(type === 'judgement' || type === 'single' || type === 'multiple')
					) {
						$console.log('正在随机作答');

						const option = options[Math.floor(Math.random() * options.length)];
						// @ts-ignore 随机选择选项
						option?.parentElement?.querySelector('a,label')?.click();
					} else if ((chapterAutoRetakeEnabled || commonSetting['randomWork-complete']) && type === 'completion') {
						$console.log('正在随机作答');

						// 随机填写答案
						for (const option of options) {
							const textarea = option?.parentElement?.querySelector('textarea');
							const completeTexts = commonSetting['randomWork-completeTexts-textarea'].split('\n').filter(Boolean);
							const text = completeTexts[Math.floor(Math.random() * completeTexts.length)];
							const textareaFrame = option?.parentElement?.querySelector('iframe');

							if (text) {
								if (textarea) {
									textarea.value = text;
								}
								if (textareaFrame?.contentDocument) {
									textareaFrame.contentDocument.body.innerHTML = text;
								}
							} else {
								$console.error('请设置随机填空的文案');
							}

							await $.sleep(500);
						}
					}
				}
			},
			async onElementSearched(elements) {
				const typeInput = elements.type[0] as HTMLInputElement;
				const type = typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined;

				/** 判断题转换成文字，以便于答题程序判断 */
				if (type === 'judgement') {
					elements.options.forEach((option) => {
						const opt = option?.textContent?.trim() || '';
						if (opt.includes('对') || opt.includes('错')) {
							// 2023/8/5日后超星已修复判断题，将图片修改成文字，如果已经有对错的文本，则不需要再转换
						}
						// 如果是英语的对错题目，他是一个英文单词 True,False
						else if (opt === 'True') {
							option.textContent = '√';
						} else if (opt === 'False') {
							option.textContent = 'x';
						}
						// 支持香港地区的繁体字
						else if (opt === '對') {
							option.textContent = '√';
						} else if (opt === '錯') {
							option.textContent = 'x';
						} else {
							const ri = option.querySelector('.ri');
							const span = document.createElement('span');
							span.innerText = ri ? '√' : '×';
							option.appendChild(span);
						}
					});
				}
			}
		});

		// 章节测验也提供悬浮控制条（暂停/继续、手动搜题），与作业、考试保持一致
		attachWorkFloatingBar(worker);
		setTaskState({
			kind: 'quiz',
			status: 'running',
			title: jobName,
			platform: '超星学习通',
			total: TiMu.length,
			current: 0,
			progress: 0,
			questions: TiMu.map((_, index) => (index === 0 ? 'cur' : 'pending')),
			sources: { cache: 0, bank: 0, ai: 0 },
			canSkip: false
		});

		const results = await worker.doWork({ enable_debug: isDebugEnabled() });
		$debug.log('cx.chapter', '章节测验答题完成', {
			total: results.length,
			finished: results.filter((result) => result.result?.finish === true).length
		});
		reportUnfinishedQuestions(results, '章节测验');

		const autoSaveChapter = async () => {
			if (!frameWindow) {
				$console.warn('未获取到章节测试窗口，无法自动保存。');
				return;
			}

			let saved = false;
			const clickSaveButton = (root: Document | HTMLElement) => {
				const candidates = Array.from(root.querySelectorAll<HTMLElement>('a,button,input')).filter((element) => {
					const text =
						element.textContent?.trim() ||
						(element instanceof HTMLInputElement ? element.value.trim() : '') ||
						element.getAttribute('title')?.trim() ||
						'';
					const onclick = element.getAttribute('onclick') || '';
					// 只匹配章节测验自带的“暂存/保存”入口，避免误点页面上的“保存笔记”等无关按钮
					return /^(暂时保存|暂存|保存)$/.test(text) || /\bnoSubmit\s*\(/.test(onclick);
				});
				const button = candidates.find((element) => element.offsetParent !== null) || candidates[0];
				if (button) {
					button.click();
					return true;
				}
				return false;
			};

			try {
				// @ts-ignore 禁止弹窗
				frameWindow.alert = () => {};
				if (typeof frameWindow.noSubmit === 'function') {
					// @ts-ignore 站点内置暂存
					frameWindow.noSubmit();
					saved = true;
				}
			} catch (error) {
				$console.warn('调用超星暂存函数失败，准备尝试点击保存按钮。', String(error));
			}

			await $.sleep(1500);

			if (clickSaveButton(frameWindow.document)) {
				saved = true;
			}

			// 不再点击顶层页面里的按钮：顶层页面有笔记等区域，也存在名为“保存”的按钮

			if (saved) {
				$console.info('未达到自动提交条件，已执行自动保存。');
			} else {
				$console.warn('未找到可用的自动保存入口，请手动检查。');
			}
		};

		const msg = `答题完成，将等待 ${stopSecondWhenFinish} 秒后进行保存或提交。`;
		$console.info(msg);
		$message.info({ content: msg, duration: stopSecondWhenFinish });
		await $.sleep(stopSecondWhenFinish * 1000);

		const hasUnfinishedResults = results.some((result) => result.result?.finish !== true);
		const hasUnansweredQuestions = results.some((result) => !isCxWorkResultPhysicallyAnswered(result));
		const uploadType =
			(chapterAutoRetakeEnabled && hasUnfinishedResults) || (chapterAutoRetakeDepth > 0 && !hasUnansweredQuestions)
				? 'force'
				: upload;
		let chapterAutoRetakeHandled = false;

		// 处理提交
		await worker.uploadHandler({
			type: uploadType,
			results,
			async callback(finishedRate, uploadable) {
				const msg = `完成率 ${finishedRate.toFixed(2)}% :  ${
					uploadable ? '3秒后将自动提交' : '3秒后将自动保存（不提交）'
				} `;
				$console.info(msg);
				$message.success({ content: msg, duration: 3 });

				if (skipInDryRun(uploadable ? '提交章节测验' : '保存章节测验', 'cx.chapter')) {
					return;
				}

				await $.sleep(3000);

				if (uploadable) {
					frameWindow?.btnBlueSubmit?.();

					await $.sleep(3000);
					/** 确定按钮 */
					frameWindow?.submitCheckTimes?.();
					try {
						// @ts-ignore 2024/4 更新后上方函数无法关闭弹窗，需要手动关闭确定弹窗；部分页面没有 jQuery，需要判空
						top?.$?.('#workpop')?.hide();
					} catch {
						// 关闭弹窗失败不影响后续的答案缓存
					}

					// 需要重做：有题没有答出；或者题都答出了，但提交后的批阅结果里有答错的（不是满分）。
					// chapterAutoRetakeEnabled 只在第一次答题时为 true，所以最多自动重做一次。
					let needRetake = chapterAutoRetakeEnabled && Boolean(frameWindow) && hasUnfinishedResults;
					if (!needRetake && chapterAutoRetakeEnabled && frameWindow) {
						const grade = await waitForChapterGrade(frameWindow);
						if (grade.wrong > 0) {
							const gradeMsg = `提交后批阅结果中有 ${grade.wrong} 处答错（不是满分），准备查看正确答案并重做一次。`;
							$console.info(gradeMsg);
							$message.info({ content: gradeMsg, duration: 8 });
							needRetake = true;
						}
					}

					if (needRetake && frameWindow) {
						chapterAutoRetakeHandled = await autoLearnChapterAnswersAndRetake(
							frame,
							frameWindow,
							{
								...options,
								upload: upload === 'force' ? 'force' : 100,
								chapterAutoRetakeDepth: chapterAutoRetakeDepth + 1
							},
							chapterTestTaskQuestionTitleTransform
						);
					} else if (frameWindow) {
						await cacheChapterAnswersAfterSubmit(
							frameWindow,
							chapterTestTaskQuestionTitleTransform,
							'章节测验提交完成'
						);
					}
				} else {
					await autoSaveChapter();
				}
			}
		});

		if (chapterAutoRetakeHandled) {
			return;
		}

		// 还原尺寸状态
		if (visual_state === 'minimize' && CommonProject.scripts.render.cfg.visual !== 'minimize') {
			CORSUtils.panelMinimize();
		}

		worker.emit('done');
	},
	/**
	 * 带音频的PPT
	 */
	async readPPTWithAudio(win: Window & { swiperNext?: Function }) {
		// 关闭音视频声音
		win.document.querySelectorAll('audio').forEach((audio) => {
			audio.addEventListener('play', () => {
				audio.muted = true;
			});
		});

		// 阅读PPT
		const len = win.document.querySelectorAll('.swiper-container .swiper-slide').length;
		for (let index = 0; index < len; index++) {
			win.swiperNext?.();
			await $.sleep(1000);
		}
		await $.sleep(3000);
	},
	/**
	 * 链接任务点
	 */
	async hyperlink(a: HTMLElement) {
		// 修改点击事件，防止出现弹窗
		const _click = a.onclick;
		a.onclick = () => false;
		// 点击完成
		a.click();
		// 还原点击事件
		a.onclick = _click;
		await $.sleep(3000);
	}
};

/**
 * cx 题目类型 ：
 * 0 单选题
 * 1 多选题
 * 2 简答题
 * 3 判断题
 * 4 填空题
 * 5 名词解释
 * 6 论述题
 * 7 计算题
 * 8 其他题(大概率是填空题)
 * 9 分录题
 * 10 资料题
 * 11 连线题
 * 14 完形填空
 * 15 阅读理解
 */
function getQuestionType(
	val: number
): 'single' | 'multiple' | 'judgement' | 'completion' | 'line' | 'fill' | 'reader' | undefined {
	return val === 0
		? 'single'
		: val === 1
		? 'multiple'
		: val === 3
		? 'judgement'
		: [2, 4, 5, 6, 7, 8, 9, 10].some((t) => t === val)
		? 'completion'
		: val === 11
		? 'line'
		: val === 14
		? 'fill'
		: val === 15
		? 'reader'
		: undefined;
}

function transformCxWorkOrExamQuestionTitle(
	titles: (HTMLElement | undefined)[],
	redundanceWordsText = CommonProject.scripts.settings.cfg.redundanceWordsText || ''
) {
	const optimizationTitle = titles
		.map((titleElement) => {
			if (titleElement) {
				const titleCloneEl = titleElement.cloneNode(true) as HTMLElement;
				const childNodes = titleCloneEl.childNodes;
				// 删除序号
				childNodes[0]?.remove();
				// 删除题型
				childNodes[0]?.remove();
				// 显示图片链接在题目中
				return optimizationElementWithImage(titleCloneEl, true).innerText;
			}
			return '';
		})
		.join(',');

	return removeRedundantWords(
		StringUtils.of(optimizationTitle).nowrap(' ').nospace().toString().trim(),
		String(redundanceWordsText || '').split('\n')
	);
}

async function cacheCxWorkOrExamSubmittedAnswers(reason = '') {
	if (CommonProject.scripts.settings.cfg.enableQuestionCaches === false) {
		return 0;
	}

	const caches = collectWorkOrExamSubmittedAnswers(document, (titles) => transformCxWorkOrExamQuestionTitle(titles));
	if (caches.length === 0) {
		return 0;
	}

	const key = caches.map((cache) => `${cache.title}=${cache.answer}`).join('|');
	const win = window as Window & { __ncpCxWorkAnswerCacheKey?: string };
	if (win.__ncpCxWorkAnswerCacheKey === key) {
		return caches.length;
	}
	win.__ncpCxWorkAnswerCacheKey = key;

	await appendChapterRetakeCaches(caches);
	if (CommonProject.scripts.settings.cfg['chapterTest-autoRetake']) {
		await $store.setTab(CX_WORK_RETAKE_STATE_TAB_KEY, {
			phase: 'detail-cached',
			time: Date.now(),
			detailUrl: location.href
		});
	}
	const msg = `已自动缓存提交详情页正确答案 ${caches.length} 条${reason ? `（${reason}）` : ''}。`;
	$console.info(msg);
	$message.success({ content: msg, duration: 5 });
	await autoRetakeFromWorkDetailAfterCaching();

	return caches.length;
}

async function autoRetakeFromWorkDetailAfterCaching() {
	const win = window as Window & { __ncpCxDetailAutoRetaking?: boolean };
	if (win.__ncpCxDetailAutoRetaking || !CommonProject.scripts.settings.cfg['chapterTest-autoRetake']) {
		return;
	}

	const text = document.body?.innerText || '';
	if (!document.querySelector('.questionLi') || !/(正确答案|参考答案|标准答案|本题答案)/.test(text)) {
		return;
	}

	win.__ncpCxDetailAutoRetaking = true;
	$message.info({ content: '已缓存详情页答案，准备返回成绩页并点击重做。', duration: 5 });
	$console.info('已缓存详情页答案，准备返回成绩页并点击重做。');

	await $.sleep(1000);
	await returnToCxWorkScorePage();

	const reopened = await handleCxWorkScorePageAutoRetake('详情页缓存完成');
	if (!reopened) {
		$console.warn('未找到“重做”按钮，答案已缓存，请手动点击重做。');
		$message.warn({ content: '未找到重做按钮，答案已缓存，请手动点击重做。', duration: 10 });
	}
}

function startCxWorkOrExamAnswerCacheObserver() {
	const win = window as Window & { __ncpCxWorkAnswerCacheObserver?: MutationObserver };
	if (win.__ncpCxWorkAnswerCacheObserver) {
		return;
	}

	let pending = false;
	const tryCache = (reason: string) => {
		if (pending) {
			return;
		}
		pending = true;
		setTimeout(async () => {
			try {
				const cachedCount = await cacheCxWorkOrExamSubmittedAnswers(reason);
				if (cachedCount === 0) {
					await handleCxWorkScorePageAutoRetake(reason);
				}
			} finally {
				pending = false;
			}
		}, 800);
	};

	win.__ncpCxWorkAnswerCacheObserver = new MutationObserver(() => tryCache('页面变化'));
	win.__ncpCxWorkAnswerCacheObserver.observe(document.documentElement, {
		childList: true,
		subtree: true,
		characterData: true
	});

	tryCache('页面加载');
	let count = 0;
	const timer = setInterval(() => {
		count++;
		tryCache('定时检查');
		if (count >= 60) {
			clearInterval(timer);
		}
	}, 2000);
}

function getCxRandomCompletionText() {
	const configText = String(CommonProject.scripts.settings.cfg['randomWork-completeTexts-textarea'] || '');
	const texts = configText
		.split('\n')
		.map((text) => text.trim())
		.filter(Boolean);

	return texts.length ? texts[Math.floor(Math.random() * texts.length)] : '不会';
}

function clickCxOption(option: HTMLElement | undefined) {
	const target =
		option?.querySelector<HTMLElement>('a,label,input,[role="radio"],[role="checkbox"]') ||
		(option?.parentElement?.querySelector<HTMLElement>('a,label,input,[role="radio"],[role="checkbox"]') ?? option);

	target?.click();
}

function getCxChoiceOptionRoot(option: HTMLElement | undefined) {
	return (
		option?.closest<HTMLElement>('.answerBg') ||
		option?.closest<HTMLElement>('li') ||
		option?.closest<HTMLElement>('.answer_p') ||
		option?.parentElement ||
		option
	);
}

function isCxElementVisible(element: HTMLElement) {
	const style = getComputedStyle(element);
	if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
		return false;
	}

	const rect = element.getBoundingClientRect();
	return rect.width > 0 || rect.height > 0 || element.offsetWidth > 0 || element.offsetHeight > 0;
}

function hasCxSelectedMarker(root: HTMLElement | undefined) {
	if (!root) {
		return false;
	}

	const selectedClassNames = ['check_answer', 'check_answer_dx', 'oncheck'];
	const candidates = [root, ...Array.from(root.querySelectorAll<HTMLElement>('[class]'))];
	return candidates.some((element) => {
		const hasSelectedClass = selectedClassNames.some((className) => element.classList.contains(className));
		return hasSelectedClass && isCxElementVisible(element);
	});
}

function getCxChoiceOptionSelectedState(option: HTMLElement | undefined) {
	const root = getCxChoiceOptionRoot(option);
	const input = root?.querySelector<HTMLInputElement>('input[type="checkbox"],input[type="radio"]');

	if (input?.checked || input?.getAttribute('aria-checked') === 'true') {
		return { selected: true, reliable: true };
	}

	if (root?.getAttribute('aria-checked') === 'true' || option?.getAttribute('aria-checked') === 'true') {
		return { selected: true, reliable: true };
	}

	if (hasCxSelectedMarker(root)) {
		return { selected: true, reliable: true };
	}

	if (input?.getAttribute('checked') === 'checked') {
		return { selected: true, reliable: false };
	}

	return { selected: false, reliable: false };
}

function isCxChoiceOptionSelected(option: HTMLElement | undefined) {
	return getCxChoiceOptionSelectedState(option).selected;
}

async function clearCxSelectedOptions(options: HTMLElement[]) {
	const selectedItems = options
		.map((option) => ({ option, state: getCxChoiceOptionSelectedState(option) }))
		.filter((item) => item.state.selected);

	if (selectedItems.length === 0) {
		return;
	}

	if (selectedItems.length === options.length && selectedItems.some((item) => !item.state.reliable)) {
		$console.warn('检测到所有选项都像已选中，跳过本次清空，避免把正确答案反选。');
		return;
	}

	for (const { option } of selectedItems) {
		clickCxOption(option);
		await $.sleep(120);
	}
}

function isCxCompletionOptionAnswered(option: HTMLElement | undefined) {
	const root = option?.parentElement || option;
	const textarea = option?.querySelector<HTMLTextAreaElement>('textarea') || root?.querySelector('textarea');
	const input =
		option?.querySelector<HTMLInputElement>('input[type="text"],input:not([type])') ||
		root?.querySelector('input[type="text"],input:not([type])');
	const textareaFrame = option?.querySelector<HTMLIFrameElement>('iframe') || root?.querySelector('iframe');
	const frameText =
		textareaFrame?.contentDocument?.body?.innerText || textareaFrame?.contentDocument?.body?.textContent || '';

	return Boolean(textarea?.value.trim() || input?.value.trim() || frameText.trim());
}

function isCxWorkResultPhysicallyAnswered(current: any) {
	const options = (current?.ctx?.elements?.options || []).filter(Boolean) as HTMLElement[];
	const typeInput = current?.ctx?.elements?.type?.[0] as HTMLInputElement | undefined;
	const type = typeInput ? getQuestionType(parseInt(typeInput.value)) : current?.ctx?.type;

	if (options.length === 0 || !type) {
		return current?.result?.finish === true;
	}

	if (type === 'judgement' || type === 'single' || type === 'multiple') {
		return options.some((option) => isCxChoiceOptionSelected(option));
	}

	if (type === 'completion') {
		return options.every((option) => isCxCompletionOptionAnswered(option));
	}

	return current?.result?.finish === true;
}

async function randomAnswerCxWorkQuestion(current: any) {
	const options = (current.ctx?.elements?.options || []).filter(Boolean) as HTMLElement[];
	const typeInput = current.ctx?.elements?.type?.[0] as HTMLInputElement | undefined;
	const type = typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined;

	if (options.length === 0 || !type) {
		return;
	}

	if (isCxWorkResultPhysicallyAnswered(current)) {
		$console.log('题库未命中，但页面已存在作答，保留原答案提交。');
		return;
	}

	if (type === 'judgement' || type === 'single') {
		$console.log('正在随机补答未完成选择题');
		clickCxOption(options[Math.floor(Math.random() * options.length)]);
		await $.sleep(300);
	} else if (type === 'multiple') {
		$console.log('正在随机补答未完成多选题');
		const shuffled = [...options].sort(() => Math.random() - 0.5);
		const count = Math.max(1, Math.floor(Math.random() * Math.min(3, shuffled.length)) + 1);
		for (const option of shuffled.slice(0, count)) {
			clickCxOption(option);
			await $.sleep(200);
		}
	} else if (type === 'completion') {
		$console.log('正在随机补答未完成填空题');
		for (const option of options) {
			const answer = getCxRandomCompletionText();
			const textarea =
				option.querySelector<HTMLTextAreaElement>('textarea') || option.parentElement?.querySelector('textarea');
			const input = option.querySelector<HTMLInputElement>('input[type="text"]');
			const textareaFrame =
				option.querySelector<HTMLIFrameElement>('iframe') || option.parentElement?.querySelector('iframe');

			if (textarea) {
				textarea.value = answer;
			}
			if (input) {
				input.value = answer;
			}
			if (textareaFrame?.contentDocument) {
				textareaFrame.contentDocument.body.innerHTML = cxBlankAnswerToHtml(answer);
			}

			await $.sleep(300);
		}
	}
}

function clickCxButtonInAvailableDocuments(patterns: RegExp[], clickAll = false) {
	let count = 0;
	const roots: (Document | HTMLElement)[] = [document];

	try {
		if (top?.document && top.document !== document) {
			roots.push(top.document);
		}
	} catch {}

	for (const root of roots) {
		count += clickAll ? clickAllChapterButtonsByText(root, patterns) : clickChapterButtonByText(root, patterns) ? 1 : 0;
	}

	return count;
}

function getAvailableCxDocuments() {
	const roots: (Document | HTMLElement)[] = [document];

	try {
		if (top?.document && top.document !== document) {
			roots.push(top.document);
		}
	} catch {}

	return roots;
}

function findCxSubmitButton(root: Document | HTMLElement) {
	const elements = Array.from(root.querySelectorAll<HTMLElement>('a,button,input,[role="button"]'));
	const submitTextPattern = /提交|交卷|完成作业|完成考试|完成测验|确认提交/;
	const submitActionPattern = /submit|dosubmit|submitwork|worksubmit|submitexam|subpaper|finalsubmit/i;
	const savePattern = /保存|暂存|暂时保存|查看详情|查看答案|查看解析|详情|返回|取消|关闭|下一题|上一题/;
	const saveActionPattern = /(?:^|[^a-z])(save|nosubmit|tempsave|zancun)(?:[^a-z]|$)/i;

	const candidates = elements
		.map((element, index) => ({ element, index }))
		.filter(({ element }) => {
			if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) {
				if (element.disabled) {
					return false;
				}
			}

			const text = getClickableText(element);
			const onclick = element.getAttribute('onclick') || '';
			const idName = `${element.id || ''} ${element.className || ''} ${element.getAttribute('name') || ''}`;
			const actionText = `${onclick} ${idName}`;

			if (savePattern.test(text) || (saveActionPattern.test(actionText) && !submitActionPattern.test(actionText))) {
				return false;
			}

			return submitTextPattern.test(text) || submitActionPattern.test(actionText);
		})
		.sort((a, b) => {
			const aText = getClickableText(a.element);
			const bText = getClickableText(b.element);
			const aExact = /^提交$|^交卷$|^确认提交$/.test(aText) ? 0 : 1;
			const bExact = /^提交$|^交卷$|^确认提交$/.test(bText) ? 0 : 1;

			return aExact - bExact || a.index - b.index;
		});

	return candidates[0]?.element;
}

function clickCxSubmitButton() {
	for (const root of getAvailableCxDocuments()) {
		const button = findCxSubmitButton(root);
		if (button) {
			button.click();
			$console.info(`已点击提交入口：${getClickableText(button) || button.getAttribute('onclick') || button.tagName}`);
			return true;
		}
	}

	return false;
}

function findCxSaveButton(root: Document | HTMLElement) {
	const elements = Array.from(root.querySelectorAll<HTMLElement>('a,button,input,[role="button"]'));
	const submitActionPattern = /submit|dosubmit|submitwork|worksubmit|submitexam|subpaper|finalsubmit/i;
	const saveTextPattern = /保存|暂存|暂时保存/;
	const saveActionPattern = /save|nosubmit|noSubmit|tempsave|zancun/i;

	const candidates = elements
		.map((element, index) => ({ element, index }))
		.filter(({ element }) => {
			if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) {
				if (element.disabled) {
					return false;
				}
			}

			const text = getClickableText(element);
			const onclick = element.getAttribute('onclick') || '';
			const idName = `${element.id || ''} ${element.className || ''} ${element.getAttribute('name') || ''}`;
			const actionText = `${onclick} ${idName}`;

			if (submitActionPattern.test(actionText) || /提交|交卷|确认提交/.test(text)) {
				return false;
			}

			return saveTextPattern.test(text) || saveActionPattern.test(actionText);
		})
		.sort((a, b) => {
			const aText = getClickableText(a.element);
			const bText = getClickableText(b.element);
			const aExact = /^保存$|^暂存$|^暂时保存$/.test(aText) ? 0 : 1;
			const bExact = /^保存$|^暂存$|^暂时保存$/.test(bText) ? 0 : 1;

			return aExact - bExact || a.index - b.index;
		});

	return candidates[0]?.element;
}

function clickCxSaveButton() {
	for (const root of getAvailableCxDocuments()) {
		const button = findCxSaveButton(root);
		if (button) {
			button.click();
			$console.info(`已点击保存入口：${getClickableText(button) || button.getAttribute('onclick') || button.tagName}`);
			return true;
		}
	}

	return false;
}

async function submitCxWorkOrExam(message: string) {
	if (skipInDryRun('提交作业/考试', 'cx.work')) {
		return false;
	}
	$console.info(message);
	$message.info({ content: message, duration: 5 });

	const clicked = clickCxSubmitButton();

	if (!clicked) {
		$console.warn('未找到超星作业/考试提交按钮，请手动提交。');
		$message.warn({ content: '未找到提交按钮，请手动提交。', duration: 10 });
		return false;
	}

	await $.sleep(1200);

	const confirmPatterns = [/^确定$/, /^确认$/, /^是$/, /^提交$/, /确认提交/, /继续提交/, /交卷/];
	clickCxButtonInAvailableDocuments(confirmPatterns);

	await $.sleep(3000);
	return true;
}

async function saveCxWorkOrExam(message: string) {
	if (skipInDryRun('保存作业/考试', 'cx.work')) {
		return false;
	}
	$console.info(message);
	$message.info({ content: message, duration: 5 });

	const clicked = clickCxSaveButton();
	if (!clicked) {
		$console.warn('未找到超星作业/考试保存按钮，请手动保存。');
		$message.warn({ content: '未找到保存按钮，请手动保存。', duration: 10 });
		return false;
	}

	await $.sleep(1500);
	return true;
}

async function handleCxWorkOrExamUploadAfterWork(
	worker: OCSWorker<any>,
	results: any[],
	options: WorkOrExamOptions,
	hasUnansweredQuestions: boolean
) {
	if (options.upload === 'nomove') {
		const msg = '作业/考试完成，当前设置为“不保存也不提交”。';
		$console.info(msg);
		$message.info({ content: msg, duration: 0 });
		return true;
	}

	const waitSeconds = options.stopSecondWhenFinish ?? 0;
	const waitMsg = `作业/考试答题完成，将等待 ${waitSeconds} 秒后按完成率保存或提交。`;
	$console.info(waitMsg);
	$message.info({ content: waitMsg, duration: waitSeconds || 3 });
	await $.sleep(waitSeconds * 1000);

	if (worker.isClose) {
		return true;
	}

	let handled = false;
	await worker.uploadHandler({
		type: options.upload,
		results,
		async callback(finishedRate, uploadable) {
			handled = true;
			const msg = `完成率 ${finishedRate.toFixed(2)}%：${
				uploadable
					? '3秒后将自动提交'
					: hasUnansweredQuestions
					? '仍有空题，3秒后将自动保存'
					: '未达到自动提交阈值，3秒后将自动保存'
			}`;
			$console.info(msg);
			$message.success({ content: msg, duration: 3 });

			await $.sleep(3000);
			if (worker.isClose) {
				return;
			}

			if (uploadable) {
				await submitCxWorkOrExam(`完成率 ${finishedRate.toFixed(2)}% 已达到自动提交条件，正在自动提交。`);
			} else {
				await saveCxWorkOrExam('未达到自动提交条件，正在自动保存。');
			}
		}
	});

	return handled;
}

async function autoSubmitWorkOrExamAndRetake(
	type: 'work' | 'exam',
	options: WorkOrExamOptions,
	titleTransform: (titles: (HTMLElement | undefined)[], index: number) => string
) {
	try {
		const submitted = await submitCxWorkOrExam(
			'存在题库未命中或未完成题目，已保留页面已有作答并补齐空题，正在自动提交以查看正确答案。'
		);
		if (!submitted) {
			return false;
		}

		const caches = await openWorkOrExamAnswerView(titleTransform);
		if (caches.length === 0) {
			$console.warn('提交后未能提取到作业/考试正确答案，已停止自动重答。');
			$message.warn({ content: '提交后未能提取到正确答案，已停止自动重答。', duration: 10 });
			return false;
		}

		await appendChapterRetakeCaches(caches);
		$console.info(`已从提交结果缓存 ${caches.length} 条正确答案，准备重新答题。`);
		$message.success({ content: `已缓存 ${caches.length} 条正确答案，准备重新答题。`, duration: 5 });

		const reopened = await reopenWorkOrExamForRetake();
		if (!reopened) {
			$console.warn('未找到“重做/重新答题”入口，请手动重做；缓存答案已写入本地。');
			$message.warn({ content: '未找到重做入口，请手动重做；缓存答案已写入本地。', duration: 10 });
			return false;
		}

		await waitForCxQuestionRoots('.questionLi');
		workOrExam(type, {
			...options,
			preview_mode: true,
			cxAutoRetakeDepth: (options.cxAutoRetakeDepth || 0) + 1
		});

		return true;
	} catch (error) {
		$console.warn('作业/考试错题回填重答失败：' + String(error));
		$message.warn({ content: '作业/考试错题回填重答失败，请手动检查。', duration: 10 });
		return false;
	}
}

async function reopenWorkOrExamForRetake() {
	await returnToCxWorkScorePage();
	return await reopenChapterForRetake(window);
}

async function waitForCxQuestionRoots(selector: string) {
	for (let index = 0; index < 20; index++) {
		if (document.querySelector(selector)) {
			return true;
		}
		await $.sleep(500);
	}

	return false;
}

function isCxWorkScorePage(doc: Document = document) {
	const text = doc.body?.innerText || '';
	return /提交时间/.test(text) && /查看详情/.test(text) && /重做/.test(text);
}

function getCxWorkScore(doc: Document = document) {
	const text = doc.body?.innerText || '';
	const matched = text.match(/(?:^|\n|\s)(\d+(?:\.\d+)?)\s*分(?:\s|\n|$)/);
	return matched ? parseFloat(matched[1]) : undefined;
}

async function returnToCxWorkScorePage() {
	if (isCxWorkScorePage()) {
		return true;
	}

	if (history.length > 1) {
		history.back();
		for (let index = 0; index < 20; index++) {
			await $.sleep(500);
			if (isCxWorkScorePage()) {
				return true;
			}
		}
	}

	clickCxButtonInAvailableDocuments([/^返回$/, /返回成绩|返回结果|返回列表|返回作业|返回上一页/]);
	await $.sleep(1500);
	return isCxWorkScorePage();
}

async function handleCxWorkScorePageAutoRetake(reason = '') {
	if (!isCxWorkScorePage()) {
		return false;
	}

	const win = window as Window & { __ncpCxScoreHinted?: boolean; __ncpCxDetailBtnWarned?: boolean };
	const score = getCxWorkScore();

	if (!CommonProject.scripts.settings.cfg['chapterTest-autoRetake']) {
		// 未开启“错题回填重答”时不会自动查看详情/重做，这里只提示一次，避免用户以为脚本没有工作
		if (!win.__ncpCxScoreHinted && !(score !== undefined && score >= 100)) {
			win.__ncpCxScoreHinted = true;
			const msg =
				'本次作业未获得满分。开启 通用-全局设置 中的“(仅超星)错题回填重答”后，脚本会自动查看详情、缓存正确答案并重做。';
			$console.info(msg);
			$message.info({ content: msg, duration: 10 });
		}
		return false;
	}

	const state =
		((await $store.getTab(CX_WORK_RETAKE_STATE_TAB_KEY)) as
			| { phase?: string; time?: number; detailUrl?: string; url?: string }
			| undefined) || {};
	const now = Date.now();
	// 同一个标签页里先后做不同的作业时，不能被上一份作业的状态拦住，所以还要比较页面地址
	const isFresh = state.time ? now - state.time < 10 * 60 * 1000 : false;
	const isSameWork = !state.url || state.url === location.href;

	if (state.phase === 'detail-cached' && isFresh) {
		await $store.setTab(CX_WORK_RETAKE_STATE_TAB_KEY, { phase: 'retake-started', time: now, url: location.href });
		const clicked = await reopenChapterForRetake(window);
		if (clicked) {
			$console.info(`已返回成绩页并点击“重做”${reason ? `（${reason}）` : ''}。`);
			return true;
		}
		$console.warn('已缓存详情页答案，但未找到成绩页“重做”按钮。');
		return false;
	}

	if (state.phase === 'retake-started' && isFresh && isSameWork) {
		return false;
	}

	if (score !== undefined && score >= 100) {
		return false;
	}

	await $store.setTab(CX_WORK_RETAKE_STATE_TAB_KEY, { phase: 'opening-detail', time: now, url: location.href });
	const clicked = clickCxButtonInAvailableDocuments([/查看详情/]) > 0;
	if (clicked) {
		$console.info(`已在成绩页点击“查看详情”，准备提取正确答案${reason ? `（${reason}）` : ''}。`);
	} else if (!win.__ncpCxDetailBtnWarned) {
		win.__ncpCxDetailBtnWarned = true;
		$console.warn('成绩页没有找到“查看详情”按钮（可能是老师没有开放查看答案），无法自动获取正确答案。');
	}
	return clicked;
}

async function restoreChapterRetakeCaches() {
	try {
		const caches = ((await $store.getTab(CX_CHAPTER_RETAKE_CACHE_TAB_KEY)) || []) as LocalQuestionCacheItem[];
		if (Array.isArray(caches) && caches.length) {
			await CommonProject.scripts.apps.methods.addQuestionCache(...caches);
		}
	} catch (error) {
		$console.warn('读取章节测试回填缓存失败：' + String(error));
	}
}

async function appendChapterRetakeCaches(items: LocalQuestionCacheItem[]) {
	if (items.length === 0) {
		return;
	}

	await CommonProject.scripts.apps.methods.addQuestionCache(...items);

	try {
		const oldCaches = ((await $store.getTab(CX_CHAPTER_RETAKE_CACHE_TAB_KEY)) || []) as LocalQuestionCacheItem[];
		const caches = Array.isArray(oldCaches) ? [...oldCaches] : [];

		for (const item of items) {
			// 同一课程内的同一题只保留最新的标准答案
			for (let index = caches.length - 1; index >= 0; index--) {
				const cache = caches[index];
				if (cache.title === item.title && (cache.scope || '') === (item.scope || '')) {
					caches.splice(index, 1);
				}
			}

			caches.unshift(item);
		}

		await $store.setTab(CX_CHAPTER_RETAKE_CACHE_TAB_KEY, caches);
	} catch (error) {
		$console.warn('写入章节测试回填缓存失败：' + String(error));
	}
}

function getClickableText(element: HTMLElement) {
	return (
		element.textContent?.trim() ||
		(element instanceof HTMLInputElement ? element.value.trim() : '') ||
		element.getAttribute('title')?.trim() ||
		element.getAttribute('aria-label')?.trim() ||
		''
	);
}

function clickChapterButtonByText(root: Document | HTMLElement, patterns: RegExp[]) {
	const elements = Array.from(root.querySelectorAll<HTMLElement>('a,button,input,[role="button"]'));
	const target = elements.find((element) => {
		if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) {
			if (element.disabled) {
				return false;
			}
		}

		const text = getClickableText(element);
		const onclick = element.getAttribute('onclick') || '';
		return patterns.some((pattern) => pattern.test(text) || pattern.test(onclick));
	});

	if (target) {
		target.click();
		return true;
	}

	// 页面上的按钮不一定是 a/button/input（例如样式化的 div/span），退回到文字完全匹配的叶子元素
	const fallback = Array.from(root.querySelectorAll<HTMLElement>('div,span,li,p,i,label')).find((element) => {
		const text = (element.textContent || '').trim();
		return (
			text.length > 0 &&
			text.length <= 8 &&
			element.children.length === 0 &&
			element.offsetParent !== null &&
			patterns.some((pattern) => pattern.test(text))
		);
	});
	if (fallback) {
		fallback.click();
		return true;
	}

	return false;
}

function clickAllChapterButtonsByText(root: Document | HTMLElement, patterns: RegExp[]) {
	const elements = Array.from(root.querySelectorAll<HTMLElement>('a,button,input,[role="button"]'));
	let count = 0;

	for (const element of elements) {
		if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) {
			if (element.disabled) {
				continue;
			}
		}

		const text = getClickableText(element);
		const onclick = element.getAttribute('onclick') || '';
		if (patterns.some((pattern) => pattern.test(text) || pattern.test(onclick))) {
			element.click();
			count++;
		}
	}

	return count;
}

function normalizeChapterAnswerText(answer: string, type: ReturnType<typeof getQuestionType>, root?: HTMLElement) {
	let value = h('span', { innerHTML: answer }).textContent || answer;
	value = value
		.replace(/\r/g, '\n')
		.replace(/\u00a0/g, ' ')
		.replace(/^[\s：:，,;；、-]+/, '')
		.replace(/题库缓存/g, '')
		.replace(/AI\s*讲解[\s\S]*$/gi, '')
		.replace(/[✓✔✘✗√×]\s*\d+(\.\d+)?\s*分[\s\S]*$/g, '')
		.replace(/\d+(\.\d+)?\s*分[\s\S]*$/g, '')
		.replace(
			/(?:我的答案|您的答案|你的答案|学生答案|答案解析|解析|本题解析|得分|分值|批语|收起答案|展开答案|查看解析|查看详情)[\s\S]*$/g,
			''
		)
		.replace(/[。；;]+$/g, '')
		.trim();

	if (type === 'single' || type === 'multiple' || type === 'judgement') {
		const plain = value.match(/^([A-H](?:\s*[,，、#;；\s]*\s*[A-H]){0,7})(?:\s*[:：.、]|\s|$|[。；;，,、])/);
		if (plain) {
			const plainAnswer = plain[1].replace(/[,，、#;；\s]/g, '');

			if (type === 'judgement') {
				const index = plainAnswer.charCodeAt(0) - 65;
				return getJudgementAnswerFromOption(getChapterOptionItems(root || document.body)[index], index);
			}

			return plainAnswer;
		}

		const normalizedValue = clearCxAnswerText(value);
		const options = root ? getChapterOptionItems(root) : [];
		const indexes = options
			.map((option, index) => ({ optionText: clearCxAnswerText(option.innerText || option.textContent || ''), index }))
			.filter(({ optionText }) => optionText && normalizedValue.includes(optionText))
			.map(({ index }) => index);

		if (indexes.length) {
			if (type === 'judgement') {
				return getJudgementAnswerFromOption(options[indexes[0]], indexes[0]);
			}

			return indexes.map((index) => String.fromCharCode(65 + index)).join('');
		}
	}

	if (type === 'judgement') {
		if (/^(正确|对|是|√|true|t|yes|1)$/i.test(value)) {
			return '对';
		}
		if (/^(错误|错|否|×|x|false|f|no|0)$/i.test(value)) {
			return '错';
		}
	}

	// 填空题：去掉“第一空：”标签，多个空用 # 连接；有空位没有内容（例如答案是公式图片）时返回空，宁可不缓存也不缓存标签
	if (type === 'completion' || /^第\s*[一二三四五六七八九十\d]+\s*空/.test(value)) {
		return isBlankAnswerJunk(value) ? '' : cleanBlankAnswer(value);
	}

	return value;
}

function clearCxAnswerText(text: string) {
	return String(text || '')
		.replace(/<[^>]+>/g, '')
		.replace(/^[A-H]\s*[:：.、]/, '')
		.replace(/我的答案|正确答案|参考答案|标准答案|本题答案|题库缓存|AI\s*讲解/g, '')
		.replace(/[✓✔✘✗√×]/g, '')
		.replace(/\d+(\.\d+)?\s*分/g, '')
		.replace(/\s+/g, '')
		.trim();
}

function extractChapterAnswerByText(root: HTMLElement, type: ReturnType<typeof getQuestionType>) {
	// 答案可能是公式图片，把图片链接追加到文本里，否则只能提取到“第一空：”这样的标签
	optimizationElementWithImage(root);
	const text = (root.innerText || '')
		.replace(/\r/g, '\n')
		.replace(/\u00a0/g, ' ')
		.replace(/[ \t]+/g, ' ')
		.trim();
	const answerStopWords = '我的答案|您的答案|你的答案|学生答案|答案解析|解析|本题解析|得分|分值|批语|AI\\s*讲解|$';
	const answerEnd = String.raw`(?=\n\s*(?:${answerStopWords})|[✓✔✘✗√×]?\s*\d+(?:\.\d+)?\s*分|AI\s*讲解|$)`;
	const patterns = [
		new RegExp(String.raw`(?:正确答案|参考答案|标准答案|本题答案)\s*[:：]\s*([\s\S]{1,2000}?)${answerEnd}`),
		new RegExp(String.raw`(?:^|\n)\s*答案\s*[:：]\s*([\s\S]{1,2000}?)${answerEnd}`)
	];

	for (const pattern of patterns) {
		const matched = text.match(pattern);
		const answer = normalizeChapterAnswerText(matched?.[1] || '', type, root);
		if (answer) {
			return answer;
		}
	}

	return '';
}

function getChapterOptionItems(root: HTMLElement) {
	const answerBgOptions = Array.from(root.querySelectorAll<HTMLElement>('.answerBg')).filter((item) => {
		return Boolean(item.querySelector('.answer_p,label,textarea,input[type="radio"],input[type="checkbox"]'));
	});
	if (answerBgOptions.length) {
		return answerBgOptions;
	}

	const listOptions = Array.from(root.querySelectorAll<HTMLElement>('ul li')).filter((item) => {
		return Boolean(item.querySelector('.after,label,textarea,input[type="radio"],input[type="checkbox"]'));
	});
	if (listOptions.length) {
		return listOptions;
	}

	return Array.from(root.querySelectorAll<HTMLElement>('.answer_p')).filter((item) => {
		return Boolean((item.innerText || item.textContent || '').trim());
	});
}

function getJudgementAnswerFromOption(option: HTMLElement | undefined, index: number) {
	const text = option?.innerText || option?.textContent || '';
	if (/错|错误|×|false|no/i.test(text)) {
		return '错';
	}
	if (/对|正确|√|true|yes/i.test(text)) {
		return '对';
	}

	return index === 1 ? '错' : '对';
}

function isCorrectChapterOption(option: HTMLElement) {
	const classText = [option.className]
		.concat(Array.from(option.querySelectorAll<HTMLElement>('[class]')).map((element) => String(element.className)))
		.join(' ')
		.toLowerCase();

	if (/(wrong|error|incorrect|false|cuo|red|check[_-]?answer[^ ]*(?:wrong|error|false))/.test(classText)) {
		return false;
	}

	const checkAnswerRightPattern = /check[_-]?answer[^ ]*(?:right|correct)/;
	const correctStatePattern = /(?:^|\s)(?:right|correct|success|green|dui|ans-right|correctanswer|rightanswer)(?:\s|$)/;

	if (checkAnswerRightPattern.test(classText) || correctStatePattern.test(classText)) {
		return true;
	}

	const text = option.innerText || option.textContent || '';
	return /答案正确|回答正确|本题正确/.test(text) && !/我的答案|你的答案|学生答案/.test(text);
}

function extractChapterAnswerByOptionState(root: HTMLElement, type: ReturnType<typeof getQuestionType>) {
	if (type !== 'single' && type !== 'multiple' && type !== 'judgement') {
		return '';
	}

	const options = getChapterOptionItems(root);
	const indexes: number[] = [];

	options.forEach((option, index) => {
		if (isCorrectChapterOption(option)) {
			indexes.push(index);
		}
	});

	if (indexes.length === 0) {
		return '';
	}

	if (type === 'judgement') {
		return getJudgementAnswerFromOption(options[indexes[0]], indexes[0]);
	}

	return indexes.map((index) => String.fromCharCode(65 + index)).join('');
}

function extractChapterSubmittedAnswer(root: HTMLElement, type: ReturnType<typeof getQuestionType>) {
	return extractChapterAnswerByText(root, type) || extractChapterAnswerByOptionState(root, type);
}

function inferCxSubmittedQuestionType(
	root: HTMLElement,
	title: string,
	typeInput?: HTMLInputElement
): ReturnType<typeof getQuestionType> {
	const inputType = typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined;
	if (inputType) {
		return inputType;
	}

	const titleText = `${title} ${root.querySelector('h3,.Zy_TItle')?.textContent || ''}`;
	if (/多选题|多项选择|不定项/.test(titleText)) {
		return 'multiple';
	}
	if (/判断题|正误题|对错题/.test(titleText)) {
		return 'judgement';
	}
	if (/单选题|单项选择/.test(titleText)) {
		return 'single';
	}
	if (/填空题|简答题|问答题|论述题|名词解释/.test(titleText)) {
		return 'completion';
	}

	const options = getChapterOptionItems(root);
	const optionTexts = options.map((option) => clearCxAnswerText(option.innerText || option.textContent || ''));
	if (optionTexts.length === 2 && optionTexts.every((text) => /^(对|错|正确|错误|true|false|t|f|是|否)$/i.test(text))) {
		return 'judgement';
	}
	if (root.querySelector('input[type="checkbox"]')) {
		return 'multiple';
	}
	if (root.querySelector('input[type="radio"]')) {
		return optionTexts.length === 2 ? 'judgement' : 'single';
	}
	if (root.querySelector('textarea,input[type="text"],iframe')) {
		return 'completion';
	}

	return undefined;
}

/** 将选择题的字母答案（如 ABD）转换成选项文字（用 # 连接），任何一个选项没有文字时保持原样 */
/**
 * 按文本行解析选项文字，不依赖具体的 DOM 结构：
 * 识别 “A.” / “A. 内容” / “A” 这样的标签行，标签后面的内容（同一行或之后的若干行）就是该选项的文字。
 * 标签必须带分隔符（. 、 : ：）或单独成行，避免把选项内容里以字母开头的文字（如 “E，B，C”）误认为标签。
 */
function extractChapterOptionTexts(root: HTMLElement) {
	const lines = (root.innerText || '')
		.replace(/\r/g, '\n')
		.split('\n')
		.map((line) => line.replace(/\u00a0/g, ' ').trim())
		.filter(Boolean);
	// 第 2 组是分隔符（. 、 : ：），第 3 组是同一行里的选项内容
	const labelPattern = /^([A-H])(?:(\s*[.、:：．]\s*)(.*))?$/;
	const stopPattern =
		/^(?:我的答案|您的答案|你的答案|学生答案|正确答案|参考答案|标准答案|本题答案|答案解析|解析|得分|分值|AI\s*讲解)/;

	for (let start = 0; start < lines.length; start++) {
		const first = labelPattern.exec(lines[start]);
		if (!first || first[1] !== 'A') {
			continue;
		}

		const options: string[] = [];
		for (let index = start; index < lines.length; index++) {
			if (stopPattern.test(lines[index])) {
				break;
			}

			const label = labelPattern.exec(lines[index]);
			// 单独成行且没有分隔符的字母（如内容恰好就是 “E”），在上一个选项还没有内容时，当作内容而不是标签
			const looksLikeContent = Boolean(label && !label[2]) && options.length > 0 && options[options.length - 1] === '';
			if (label && label[1] === String.fromCharCode(65 + options.length) && !looksLikeContent) {
				options.push((label[3] || '').trim());
			} else if (options.length) {
				options[options.length - 1] = (options[options.length - 1] + ' ' + lines[index]).trim();
			}
		}

		if (options.length >= 2) {
			return options;
		}
	}

	return [] as string[];
}

/**
 * 将选择题的字母答案（如 ABD）转换成选项内容（用 # 连接）：
 * 优先取选项文字；选项没有文字（图片）时取图片链接；都取不到时保持字母。
 */
function convertChapterAnswerLettersToText(
	answer: string,
	type: ReturnType<typeof getQuestionType>,
	root: HTMLElement
) {
	// 只有填空题等没有选项的题型不需要转换；题型没识别出来时（详情页没有题型输入框）也要尝试转换
	if (type === 'completion') {
		return answer;
	}

	const letters = answer.replace(/[,，、#;；\s]/g, '');
	if (!/^[A-H]{1,8}$/.test(letters)) {
		return answer;
	}

	const domOptions = getChapterOptionItems(root);
	const textOptions = extractChapterOptionTexts(root);

	const texts = Array.from(letters).map((letter) => {
		const index = letter.charCodeAt(0) - 65;
		const option = domOptions[index];

		// 1. 选项元素中的文字
		const domText = option ? clearCxAnswerText(option.innerText || option.textContent || '') : '';
		if (domText) {
			return domText;
		}

		// 2. 按文本行解析出的选项文字（DOM 结构不认识时）
		const lineText = clearCxAnswerText(textOptions[index] || '');
		if (lineText) {
			return lineText;
		}

		// 3. 选项是图片（公式、电路图等）：把图片链接作为答案内容。答题页选项的文字里同样带有图片链接，
		// 所以可以按链接匹配，选项顺序被打乱也不受影响（只存字母则会失效）。
		const image = option?.querySelector<HTMLImageElement>('img');
		const src = image ? image.currentSrc || image.src : '';
		return src && !src.startsWith('data:') ? src : '';
	});

	if (texts.length && texts.every(Boolean)) {
		return texts.join('#');
	}

	const win = window as Window & { __ncpCxLetterOnlyWarned?: boolean };
	if (!win.__ncpCxLetterOnlyWarned) {
		win.__ncpCxLetterOnlyWarned = true;
		$console.warn('未能从页面提取到选项内容，标准答案只缓存了选项字母（选项顺序变化时可能失效）。', {
			letters,
			domOptions: domOptions.length,
			textOptions: textOptions.length
		});
	}

	return answer;
}

function collectSubmittedAnswers(
	doc: Document,
	{
		rootSelector,
		titleSelector,
		titleTransform,
		from
	}: {
		rootSelector: string;
		titleSelector: string;
		titleTransform: (titles: (HTMLElement | undefined)[], index: number) => string;
		from: string;
	}
) {
	const caches: LocalQuestionCacheItem[] = [];
	const roots = Array.from(doc.querySelectorAll<HTMLElement>(rootSelector));
	const scope = getQuestionCacheScope();

	roots.forEach((root, index) => {
		const titleElements = Array.from(root.querySelectorAll<HTMLElement>(titleSelector));
		const title = titleTransform(titleElements, index);
		const typeInput = root.querySelector<HTMLInputElement>('input[id^="answertype"],input[name^="type"]');
		const type = inferCxSubmittedQuestionType(root, title, typeInput || undefined);
		// 选择题把 A/B/C 转成选项文字存储：答题器优先按文字匹配，字母只是兜底，
		// 并且选项顺序被打乱时字母会失效。
		const rawAnswer = extractChapterSubmittedAnswer(root, type);
		const answer = convertChapterAnswerLettersToText(rawAnswer, type, root);
		// 标准答案同时保存所选选项的字母（提取到字母时）
		const letters = rawAnswer.replace(/[,，、#;；\s]/g, '');
		const option = /^[A-H]{1,8}$/.test(letters) ? letters : undefined;

		if (title && answer) {
			caches.push({
				title,
				answer,
				from,
				homepage: location.href,
				scope,
				source: 'standard',
				time: Date.now(),
				...(option ? { option } : {})
			});
		}
	});

	return caches.filter(
		(cache, index, arr) => arr.findIndex((item) => item.title === cache.title && item.answer === cache.answer) === index
	);
}

function collectChapterSubmittedAnswers(
	doc: Document,
	titleTransform: (titles: (HTMLElement | undefined)[], index: number) => string
) {
	return collectSubmittedAnswers(doc, {
		rootSelector: '.TiMu',
		titleSelector: '.Zy_TItle .clearfix',
		titleTransform,
		from: '超星章节测试回填'
	});
}

function collectWorkOrExamSubmittedAnswers(
	doc: Document,
	titleTransform: (titles: (HTMLElement | undefined)[], index: number) => string
) {
	return collectSubmittedAnswers(doc, {
		rootSelector: '.questionLi',
		titleSelector: 'h3',
		titleTransform,
		from: '超星作业/考试回填'
	});
}

async function waitForChapterAnswers(
	frameWindow: Window,
	titleTransform: (titles: (HTMLElement | undefined)[], index: number) => string
) {
	for (let index = 0; index < 20; index++) {
		const caches = collectChapterSubmittedAnswers(frameWindow.document, titleTransform);
		if (caches.length) {
			return caches;
		}
		await $.sleep(1000);
	}

	return [];
}

async function waitForWorkOrExamAnswers(
	titleTransform: (titles: (HTMLElement | undefined)[], index: number) => string
) {
	for (let index = 0; index < 20; index++) {
		const caches = collectWorkOrExamSubmittedAnswers(document, titleTransform);
		if (caches.length) {
			return caches;
		}
		await $.sleep(1000);
	}

	return [];
}

async function openChapterAnswerView(
	frameWindow: Window,
	titleTransform: (titles: (HTMLElement | undefined)[], index: number) => string
) {
	const patterns = [/查看答案/, /查看解析/, /显示答案/, /展开答案/, /查看本题答案/];
	clickChapterButtonByText(frameWindow.document, patterns);
	try {
		clickChapterButtonByText(document, patterns);
	} catch {}

	await $.sleep(1500);
	return waitForChapterAnswers(frameWindow, titleTransform);
}

async function openWorkOrExamAnswerView(
	titleTransform: (titles: (HTMLElement | undefined)[], index: number) => string
) {
	const patterns = [/查看详情/, /查看答案/, /查看解析/, /显示答案/, /展开答案/, /查看本题答案/, /答案解析/];
	clickCxButtonInAvailableDocuments(patterns, true);

	await $.sleep(1500);
	return waitForWorkOrExamAnswers(titleTransform);
}

async function reopenChapterForRetake(frameWindow: Window) {
	const patterns = [
		/重新答题/,
		/重新作答/,
		/重新测试/,
		/重新测验/,
		/重新开始/,
		/再做一次/,
		/再答一次/,
		/重做/,
		/re(?:do|start|try)|again/i
	];
	const clicked =
		clickChapterButtonByText(frameWindow.document, patterns) || clickChapterButtonByText(document, patterns);

	if (!clicked) {
		return false;
	}

	await $.sleep(1000);

	// 确认弹窗（“你还可以重做N次，确认重做后…”、“之前答题内容会保留，确认重做？”）可能稍后才出现，轮询等待后点击确认。
	// 确认按钮可能叫“确定”或“重做”，不能直接按文字全局查找，否则会点到弹窗后面页面上原来的“重做”按钮。
	const dialogConfirmPatterns = [/^确定$/, /^确认$/, /^是$/, /^继续$/, /^开始$/, /^重做$/, /^重新(?:答题|作答|开始)$/];
	const confirmed = await confirmCxRetakeDialog(frameWindow, dialogConfirmPatterns);

	if (confirmed) {
		$console.info('已确认“重做”弹窗。');
	} else {
		// 没有找到弹窗时，退回到原来的文字匹配
		const confirmPatterns = [/^确定$/, /^确认$/, /^是$/, /继续|开始/];
		clickChapterButtonByText(frameWindow.document, confirmPatterns);
		try {
			clickChapterButtonByText(document, confirmPatterns);
		} catch {}
	}

	await $.sleep(3000);
	return true;
}

/**
 * 轮询等待“重做”确认弹窗并点击确认：
 * 1. 超星通用提示框：#popok 是确定按钮（#popno 是取消）
 * 2. 其他形式的弹窗：在“取消”按钮附近查找确认按钮
 * 最多等待约 8 秒。
 */
async function confirmCxRetakeDialog(frameWindow: Window, confirmPatterns: RegExp[]) {
	const docs: Document[] = [];
	const addDocument = (getter: () => Document | null | undefined) => {
		try {
			const doc = getter();
			if (doc && !docs.includes(doc)) {
				docs.push(doc);
			}
		} catch {}
	};
	addDocument(() => frameWindow.document);
	addDocument(() => document);
	addDocument(() => top?.document);

	const isVisible = (element: HTMLElement) => element.offsetParent !== null || element.getClientRects().length > 0;

	for (let attempt = 0; attempt < 16; attempt++) {
		for (const doc of docs) {
			const popOk = doc.querySelector<HTMLElement>('#workpop #popok, .popDiv #popok, #popok');
			if (popOk && isVisible(popOk)) {
				popOk.click();
				return true;
			}

			if (clickCxDialogConfirmButton(doc, confirmPatterns)) {
				return true;
			}
		}

		await $.sleep(500);
	}

	return false;
}

/**
 * 在确认弹窗里点击确认按钮：找到文字为“取消”的按钮，在它附近（同一个弹窗容器内）查找确认按钮。
 */
function clickCxDialogConfirmButton(root: Document | HTMLElement, confirmPatterns: RegExp[]) {
	const isVisible = (element: HTMLElement) => element.offsetParent !== null || element.getClientRects().length > 0;
	const candidates = (container: Document | HTMLElement) =>
		Array.from(container.querySelectorAll<HTMLElement>('a,button,div,span,input,[role="button"]')).filter(
			(element) => element.children.length === 0 && isVisible(element)
		);

	const cancelButtons = candidates(root).filter((element) => getClickableText(element) === '取消');
	for (const cancel of cancelButtons) {
		let container: HTMLElement | null = cancel.parentElement;
		for (let depth = 0; depth < 4 && container; depth++, container = container.parentElement) {
			const confirmButton = candidates(container).find(
				(element) => element !== cancel && confirmPatterns.some((pattern) => pattern.test(getClickableText(element)))
			);
			if (confirmButton) {
				confirmButton.click();
				return true;
			}
		}
	}

	return false;
}

/**
 * 等待章节测验提交后的批阅结果出现，并统计答错的数量（标记 .marking_cuo）。
 * 最多等待 12 秒，没有出现批阅标记时视为没有答错（wrong 为 0），不会触发重做。
 */
async function waitForChapterGrade(frameWindow: Window) {
	for (let index = 0; index < 12; index++) {
		try {
			const doc = frameWindow.document;
			const right = doc.querySelectorAll('.marking_dui').length;
			const wrong = doc.querySelectorAll('.marking_cuo').length;
			if (right + wrong > 0) {
				return { graded: true, right, wrong };
			}
		} catch {
			// 页面跳转过程中 document 可能暂时不可访问
		}
		await $.sleep(1000);
	}

	return { graded: false, right: 0, wrong: 0 };
}

async function autoLearnChapterAnswersAndRetake(
	frame: HTMLIFrameElement,
	frameWindow: Window,
	options: ChapterWorkOptions,
	titleTransform: (titles: (HTMLElement | undefined)[], index: number) => string
) {
	try {
		$console.info('章节测试错题回填重答：正在查看正确答案并写入本地缓存。');
		$message.info({ content: '正在查看正确答案并写入本地缓存，准备自动重答。', duration: 5 });

		const caches = await openChapterAnswerView(frameWindow, titleTransform);
		if (caches.length === 0) {
			$console.warn('未能从提交后的页面提取到正确答案，已停止自动重答。');
			$message.warn({ content: '未能提取到正确答案，已停止自动重答。', duration: 10 });
			return false;
		}

		await appendChapterRetakeCaches(caches);
		$console.info(`已从提交结果缓存 ${caches.length} 条答案，准备重新答题。`);
		$message.success({ content: `已缓存 ${caches.length} 条答案，准备重新答题。`, duration: 5 });

		const reopened = await reopenChapterForRetake(frameWindow);
		if (!reopened) {
			$console.warn('未找到“重做/重新答题”入口，请手动重做；缓存答案已写入本地。');
			$message.warn({ content: '未找到重做入口，请手动重做；缓存答案已写入本地。', duration: 10 });
			return false;
		}

		await JobRunner.chapter(frame, options);
		return true;
	} catch (error) {
		$console.warn('章节测试错题回填重答失败：' + String(error));
		$message.warn({ content: '错题回填重答失败，请手动检查提交结果。', duration: 10 });
		return false;
	}
}

async function cacheChapterAnswersFromCurrentView(
	frameWindow: Window,
	titleTransform: (titles: (HTMLElement | undefined)[], index: number) => string,
	reason = ''
) {
	if (CommonProject.scripts.settings.cfg.enableQuestionCaches === false) {
		return false;
	}

	try {
		const caches = collectChapterSubmittedAnswers(frameWindow.document, titleTransform);
		if (caches.length === 0) {
			return false;
		}

		await appendChapterRetakeCaches(caches);
		const msg = `已从章节测验当前页面缓存 ${caches.length} 条正确答案${reason ? `（${reason}）` : ''}。`;
		$console.info(msg);
		return true;
	} catch (error) {
		$console.warn('读取章节测验当前页面答案失败：' + String(error));
		return false;
	}
}

async function cacheChapterAnswersAfterSubmit(
	frameWindow: Window,
	titleTransform: (titles: (HTMLElement | undefined)[], index: number) => string,
	reason = ''
) {
	if (CommonProject.scripts.settings.cfg.enableQuestionCaches === false) {
		return false;
	}

	try {
		$console.info('章节测验已提交，正在尝试查看正确答案并写入本地题库缓存。');
		const caches = await openChapterAnswerView(frameWindow, titleTransform);
		if (caches.length === 0) {
			$console.warn('章节测验提交后未能提取到正确答案，可能页面未提供查看答案入口。');
			return false;
		}

		await appendChapterRetakeCaches(caches);
		const msg = `已从章节测验结果缓存 ${caches.length} 条正确答案${reason ? `（${reason}）` : ''}。`;
		$console.info(msg);
		$message.success({ content: msg, duration: 5 });
		return true;
	} catch (error) {
		$console.warn('章节测验正确答案缓存失败：' + String(error));
		return false;
	}
}

/** 阅读理解和完形填空的共同处理器 */
async function readerAndFillHandle(searchInfos: SearchInformation[], list: HTMLElement[]) {
	for (const answers of searchInfos.map((info) => info.results.map((res) => res.answer))) {
		let ans = answers;

		if (ans.length === 1) {
			ans = splitAnswer(ans[0]);
		}

		if (ans.filter(Boolean).length !== 0 && list.length !== 0) {
			for (let index = 0; index < ans.length; index++) {
				const item = list[index];
				if (item) {
					/** 获取每个小题中的准确答案选项 并点击 */
					$el(`span.saveSingleSelect[data="${ans[index]}"]`, item)?.click();
					await $.sleep(200);
				}
			}

			return { finish: true };
		}
	}

	return { finish: false };
}

function hasFaceRecognition() {
	// 人脸元素有时候 src 属性为空字符串，所以这里需要判断 src 是否为空字符串，如是则人脸识别会出现。
	const faces = $$el<HTMLImageElement>('#fcqrimg', top?.document);
	let active = false;
	for (const face of faces) {
		const src = face.getAttribute('src');
		if (src) {
			active = true;
			break;
		}
	}
	return active;
}

function hasNewFaceRecognition() {
	const faces = $$el<HTMLImageElement>('.chapterVideoFaceMaskDiv', top?.document);
	let active = false;
	for (const face of faces) {
		if (face.style.display !== 'none') {
			active = true;
			break;
		}
	}
	return active;
}

/**
 * 等待新版人脸识别，视频开头会出现的人脸识别
 */
function waitForNewFaceRecognition() {
	let notified = false;
	let endBusy: (() => void) | undefined;

	return new Promise<void>((resolve) => {
		const interval = setInterval(() => {
			// 人脸元素有时候 src 属性为空字符串，所以这里需要判断 src 是否为空字符串，如是则人脸识别会出现。
			const active = hasNewFaceRecognition();
			if (active) {
				if (!notified) {
					notified = true;
					const msg = '检测到人脸识别，请手动进行识别后脚本才会继续运行。';
					endBusy = beginBusy('captcha', '需要完成人脸识别');
					if (CXProject.scripts.study.cfg.notifyWhenHasFaceRecognition) {
						CommonProject.scripts.settings.methods.notificationBySetting(msg, { duration: 0 });
					}
					$message.warn({ content: msg, duration: 0 });
					$console.warn(msg);
				}
			} else {
				clearInterval(interval);
				endBusy?.();
				resolve();
			}
		}, 3000);
	});
}
/**
 * 等待人脸识别
 */
function waitForFaceRecognition() {
	let notified = false;
	let endBusy: (() => void) | undefined;

	return new Promise<void>((resolve) => {
		const interval = setInterval(() => {
			// 人脸元素有时候 src 属性为空字符串，所以这里需要判断 src 是否为空字符串，如是则人脸识别会出现。
			const active = hasFaceRecognition();
			if (active) {
				if (!notified) {
					notified = true;
					const msg = '检测到人脸识别，请手动进行识别后脚本才会继续运行。';
					endBusy = beginBusy('captcha', '需要完成人脸识别');
					if (CXProject.scripts.study.cfg.notifyWhenHasFaceRecognition) {
						CommonProject.scripts.settings.methods.notificationBySetting(msg, { duration: 0 });
					}
					$message.warn({ content: msg, duration: 0 });
					$console.warn(msg);
				}
			} else {
				clearInterval(interval);
				endBusy?.();
				resolve();
			}
		}, 3000);
	});
}

/**
 * 答题程序位于其他 iframe 中，而 methods.pin 等 是依赖于 setTab 方法的，所以需要重新定义一个顶层函数来调用 pin 方法
 * 跨域调用
 */

const CORSUtils = {
	pinWorkPanel: cors.defineTopFunction(() => {
		CommonProject.scripts.render.methods.pin(CommonProject.scripts.workResults);
	}),
	panelNormal: cors.defineTopFunction(() => {
		CommonProject.scripts.render.methods.normal();
	}),
	panelMinimize: cors.defineTopFunction(() => {
		CommonProject.scripts.render.methods.minimize();
	})
};

/** 页面元素快照中附带的超星状态：任务点、小节标签、章节完成情况和学习配置 */
registerSnapshotCollector('cx', () => {
	let isTop = false;
	try {
		isTop = self === top;
	} catch {
		isTop = false;
	}

	const attachments = ((($gm.unsafeWindow as any).attachments || []) as any[]).map((a) => ({
		jobid: a?.jobid || a?.property?._jobid,
		type: a?.type,
		name: a?.property?.name || a?.property?.title,
		mid: a?.property?.mid,
		job: a?.job,
		isPassed: a?.isPassed
	}));

	const studyCfg = CXProject.scripts.study.cfg;
	return {
		isTop,
		study: {
			mode: studyCfg.mode,
			playbackRate: studyCfg.playbackRate,
			volume: studyCfg.volume,
			restudy: studyCfg.restudy,
			forceLearn: studyCfg.forceLearn,
			enableMedia: studyCfg.enableMedia,
			enableChapterTest: studyCfg.enableChapterTest,
			enablePPT: studyCfg.enablePPT,
			enableHyperlink: studyCfg.enableHyperlink,
			videoQuizStrategy: studyCfg.videoQuizStrategy
		},
		attachments,
		...(isTop
			? {
					position: readCxPosition(),
					sectionTabs: Array.from(top?.document.querySelectorAll<HTMLElement>('.prev_ul li') || []).map((li) => ({
						className: li.className,
						text: li.textContent?.trim(),
						cardid: li.getAttribute('cardid')
					})),
					chapters: CXAnalyses.getChapterInfos()
						.slice(0, 300)
						.map((chapter) => ({ chapterId: chapter.chapterId, unFinishCount: chapter.unFinishCount })),
					isInFinalTab: CXAnalyses.isInFinalTab(),
					isInFinalChapter: Boolean(CXAnalyses.isInFinalChapter())
			  }
			: {})
	};
});
