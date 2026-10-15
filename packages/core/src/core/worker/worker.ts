import { $, CommonEventEmitter } from 'easy-us';
import { domSearchAll } from '../utils/dom';
import {
	CustomWorkOptions,
	RawElements,
	ResolverResult,
	SimplifyWorkResult,
	WorkContext,
	WorkerEvents,
	WorkOptions,
	WorkResult,
	WorkUploadType
} from './interface';
import { createDefaultQuestionResolver } from './question.resolver';
import { defaultWorkTypeResolver } from './utils';
import { AnswerWrapperHandlerConfig } from '../answer-wrapper';

/**
 * 自动答题器， 传入一些指定的配置， 就可以进行自动答题。
 *
 * @param work      工作器, 传入一个方法可自定义工作器，或者使用默认的工作器，详情： {@link WorkOptions.work}
 * @param answerer  查题器, : 默认是 {@link defaultAnswerWrapperHandler}
 *
 * 调度模型（搜题和答题互不阻塞）：
 *  - 搜题：最多 `thread` 道题同时搜索，每道题的搜索都有独立的时限（搜题超时 + AI 额外等待），
 *    超时后这道题按“搜不到答案”处理，不会占着线程，也不会拖住后面的题目；
 *  - 答题：谁先搜完谁先作答（同时搜完的按题号顺序），答题动作串行执行，避免同时操作页面。
 */
export class OCSWorker<E extends RawElements = RawElements> extends CommonEventEmitter<WorkerEvents> {
	opts: WorkOptions<E>;
	isRunning = false;
	isClose = false;
	isStop = false;
	totalQuestionCount = 0;

	constructor(opts: WorkOptions<E>) {
		super();
		this.opts = opts;
	}

	/** 启动答题器  */
	async doWork(options?: { enable_debug?: boolean }) {
		this.emit('start');
		this.isRunning = true;

		/** 唤醒答题线程（有题目搜完 / 关闭 / 继续时调用） */
		let wakeResolver: (() => void) | undefined;
		const wake = () => {
			const fn = wakeResolver;
			wakeResolver = undefined;
			fn?.();
		};

		this.once('close', () => {
			this.isClose = true;
			wake();
		});

		this.on('stop', () => {
			this.isStop = true;
		});

		this.on('continuate', () => {
			this.isStop = false;
			wake();
		});

		/** 寻找题目父节点 */
		const questionRoots: HTMLElement[] | null =
			typeof this.opts.root === 'string' ? Array.from(document.querySelectorAll(this.opts.root)) : this.opts.root;

		this.totalQuestionCount += questionRoots.length;

		if (options?.enable_debug) {
			console.debug('开始答题', this);
			console.debug('题目数量: ', questionRoots.length);
			console.debug('父节点列表: ', questionRoots);
		}

		/** 答题结果 */
		const results: WorkResult<E>[] = [];

		if (questionRoots.length === 0) {
			throw new Error('未找到任何题目，答题结束。');
		}

		/** 搜索元素 */
		for (const questionRoot of questionRoots) {
			// 初始化上下文
			const ctx: WorkContext<E> = {
				searchInfos: [],
				root: questionRoot,
				elements: domSearchAll<E>(this.opts.elements, questionRoot),
				type: undefined,
				answerSeparators: this.opts.answerSeparators,
				answerMatchMode: this.opts.answerMatchMode || 'similar'
			};

			/** 执行元素搜索钩子 */
			await this.opts.onElementSearched?.(ctx.elements, questionRoot);
			/** 排除掉 null 的元素 */
			ctx.elements.title = ctx.elements.title?.filter(Boolean) as HTMLElement[];
			ctx.elements.options = ctx.elements.options?.filter(Boolean) as HTMLElement[];

			/** 获取题目类型 */
			if (typeof this.opts.work === 'object') {
				ctx.type =
					this.opts.work.type === undefined
						? // 使用默认解析器
						  defaultWorkTypeResolver(ctx)
						: // 自定义解析器
						typeof this.opts.work.type === 'string'
						? this.opts.work.type
						: this.opts.work.type(ctx);
			}

			results.push({
				requested: false,
				resolved: false,
				ctx: ctx
			});
		}

		if (options?.enable_debug) {
			console.debug('上下文已初始化: ', results);
		}

		/** 调用外部回调，回调里的异常只记录，不能中断搜题 / 答题流程 */
		const notifyResultsUpdate = async (result: WorkResult<E>, index: number) => {
			try {
				await this.opts.onResultsUpdate?.(result, index, results);
			} catch (err) {
				console.error('onResultsUpdate 回调出错', err);
			}
		};

		/** 搜题已完成、等待作答的题目序号 */
		const resolveQueue: number[] = [];

		/** 单道题的搜索时限（毫秒）：题库超时 + 缓冲 + AI 额外等待，每次搜题时读取最新配置 */
		const getSearchLimitMs = () =>
			((AnswerWrapperHandlerConfig.timeout_seconds || 60) + 10 + (AnswerWrapperHandlerConfig.extra_wait_seconds || 0)) *
			1000;

		/** 搜索一道题 */
		const searchOne = async (index: number) => {
			const result = results[index];
			const ctx = result.ctx || ({} as WorkContext<E>);

			/** 检查是否暂停中 */
			if (this.isStop) {
				await waitForContinuate(
					() => this.isStop,
					() => this.isClose
				);
			}
			/** 强行关闭 */
			if (this.isClose === true) {
				return;
			}

			/** 查找答案 */
			ctx.searchInfos = [];

			if (options?.enable_debug) {
				console.groupEnd();
				console.group(
					'开始搜题: ',
					ctx.elements.title
						?.map((t) => t?.innerText)
						.filter(Boolean)
						.join(', ')
						.slice(0, 20)
				);
				console.log('ctx', result.ctx);
			}

			let error: string | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const limitMs = getSearchLimitMs();
				const timeout = new Promise<never>((resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error(`搜题超过 ${Math.round(limitMs / 1000)} 秒没有返回结果，已放弃这道题`)),
						limitMs
					);
				});
				const infos = (await Promise.race([Promise.resolve(this.opts.answerer(ctx.elements, ctx)), timeout])) || [];

				// 答案为 undefined 的情况， 需要赋值给一个空字符串，因为可能传回的题目中带有其他提示信息，或者题目里包含答案。
				infos.forEach((info) => {
					info.results = info.results.map((ans) => {
						ans.answer = ans.answer ? ans.answer.trim() : '';
						return ans;
					});
				});
				ctx.searchInfos = infos;
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			} finally {
				if (timer) {
					clearTimeout(timer);
				}
			}

			result.ctx = ctx;
			result.requested = true;
			result.error = error;

			if (options?.enable_debug) {
				console.log('搜题结果: ', ctx.searchInfos);
			}

			resolveQueue.push(index);
			wake();
			/** 回调 */
			await notifyResultsUpdate(result, index);
		};

		/** 搜题线程：从题目列表里依次领取题目搜索，最多 thread 个同时进行 */
		const searchThreadCount = Math.max(1, Math.floor(this.opts.thread || 1));
		let nextIndex = 0;
		const searchThread = async () => {
			while (this.isClose === false) {
				const index = nextIndex++;
				if (index >= results.length) {
					return;
				}
				try {
					await searchOne(index);
				} catch (err) {
					// 单题搜索出错不能让整个线程退出
					console.error(err);
				}
			}
		};

		/** 答题线程：搜完一题答一题，答题动作串行执行 */
		const resolverThread = async () => {
			let resolvedCount = 0;

			while (resolvedCount < results.length) {
				/** 强行关闭 */
				if (this.isClose === true) {
					this.isRunning = false;
					return;
				}

				if (resolveQueue.length === 0) {
					// 没有搜完的题目：等待唤醒（保留一个兜底定时器，避免遗漏唤醒）
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, 1000);
						wakeResolver = () => {
							clearTimeout(timer);
							resolve();
						};
					});
					continue;
				}

				/** 检查是否暂停中 */
				if (this.isStop) {
					await waitForContinuate(
						() => this.isStop,
						() => this.isClose
					);
					continue;
				}

				// 题号小的优先
				resolveQueue.sort((a, b) => a - b);
				const index = resolveQueue.shift() as number;
				const result = results[index];

				let error: string | undefined;
				let res: ResolverResult | undefined;

				try {
					if (result.ctx && result.ctx.searchInfos.length !== 0) {
						/** 开始处理 */
						if (typeof this.opts.work === 'object') {
							if (result.ctx.elements.options) {
								/** 使用默认处理器 */

								if (result.ctx.type) {
									const resolver = createDefaultQuestionResolver(result.ctx)[result.ctx.type];
									const handler = this.opts.work.handler;
									res = await resolver(result.ctx.searchInfos, result.ctx.elements.options as HTMLElement[], handler);
								} else {
									error = '题目类型解析失败, 请自行提供解析器, 或者忽略此题。';
								}
							} else {
								error = 'elements.options 为空 ! 使用默认处理器, 必须提供题目选项的选择器。';
							}
						} else {
							/** 使用自定义处理器 */
							const work = this.opts.work;
							res = await work(result.ctx);
						}
					} else {
						error = result.error ? `搜题失败：${result.error}` : '搜索不到答案, 请重新运行, 或者忽略此题。';
					}
				} catch (err) {
					error = (err as any)?.message || err;
				}

				result.error = error;

				/** 修改答题结果 */
				result.result = res || { finish: false };
				/** 设置答题完成 */
				result.resolved = true;
				resolvedCount++;

				if (options?.enable_debug) {
					console.log(
						'答题完成: ',
						result.ctx?.elements.title
							?.map((t) => t?.innerText)
							.join(', ')
							.slice(0, 20),
						result
					);
				}

				/** 回调 */
				await notifyResultsUpdate(result, index);
			}
		};

		await Promise.all([
			resolverThread(),
			...Array.from({ length: Math.min(searchThreadCount, results.length) }, () => searchThread())
		]);

		this.isRunning = false;
		return results;
	}

	/** 答题结果处理器 */
	uploadHandler(options: {
		// doWork 的返回值结果
		results: WorkResult<E>[];
		// 提交类型
		type: WorkUploadType;
		/**
		 * 是否上传处理器
		 *
		 * @param  uploadable  是否可以上传
		 * @param finishedRate 完成率
		 */
		callback: (finishedRate: number, uploadable: boolean) => void | Promise<void>;
	}) {
		const { results, type, callback } = options;
		if (type !== 'nomove') {
			let finished = 0;
			for (const result of results) {
				if (result.result?.finish) {
					finished++;
				}
			}
			const rate = results.length === 0 ? 0 : (finished / results.length) * 100;
			if (type === 'force') {
				return callback(rate, true);
			} else {
				return callback(rate, type === 'save' ? false : rate >= parseFloat(type.toString()));
			}
		}
	}
}

export class CustomOCSWorker extends CommonEventEmitter<WorkerEvents> {
	opts: CustomWorkOptions;
	isRunning = false;
	isClose = false;
	isStop = false;

	constructor(opts: CustomWorkOptions) {
		super();
		this.opts = opts;
	}

	/** 启动答题器  */
	async doWork(options?: { enable_debug?: boolean }) {
		this.emit('start');
		this.isRunning = true;

		this.once('close', () => {
			this.isClose = true;
		});

		this.on('stop', () => {
			this.isStop = true;
		});

		this.on('continuate', () => {
			this.isStop = false;
		});

		const questions = await this.opts.questions?.();

		if (options?.enable_debug) {
			console.debug('开始答题', this);
			console.debug('题目数量: ', questions.length);
		}
		const results: SimplifyWorkResult[] = [];

		for (let index = 0; index < questions.length; index++) {
			/** 强行关闭 */
			if (this.isClose === true) {
				this.isRunning = false;
				return;
			}
			/** 检查是否暂停中 */
			if (this.isStop) {
				await waitForContinuate(
					() => this.isStop,
					() => this.isClose
				);
			}

			const question = questions[index];
			results[index] = {
				question: question.text,
				requested: false,
				resolved: false,
				searchInfos: [],
				type: question.type,
				finish: false,
				error: ''
			};

			try {
				const infos = await this.opts.answerer(question.text);
				results[index].searchInfos = infos.map((i) => ({
					name: i.name,
					homepage: i.homepage,
					results: i.results.map((r) => [r.question, r.answer, r.extra_data || {}]),
					error: i.error
				}));
				results[index].requested = true;
				this.opts.onResultsUpdate?.(results[index], index, results);

				try {
					const resolved = await this.opts.resolver(infos);
					results[index].finish = resolved.finish;
					results[index].error = resolved.error;
					results[index].resolved = true;
				} catch (err) {
					results[index].finish = false;
					results[index].error = err instanceof Error ? err.message : String(err);
					results[index].resolved = true;
				}
				this.opts.onResultsUpdate?.(results[index], index, results);
			} catch (err) {
				results[index].requested = true;
				results[index].resolved = false;
				// 搜题过程出错时这道题并没有完成，不能计入完成率
				results[index].finish = false;
				results[index].error = err instanceof Error ? err.message : String(err);
				this.opts.onResultsUpdate?.(results[index], index, results);
			}

			await $.sleep(this.opts.period);
		}
	}
}

/** 暂停时等待继续；被关闭时也会返回，避免暂停中关闭导致永远卡住 */
async function waitForContinuate(isStopping: () => boolean, isClosed: () => boolean = () => false) {
	if (isStopping()) {
		await new Promise<void>((resolve) => {
			const interval = setInterval(() => {
				if (isStopping() === false || isClosed()) {
					clearInterval(interval);
					resolve();
				}
			}, 200);
		});
	}
}
