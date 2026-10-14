/**
 * 选择题答案与选项的配对工具：
 * - 视频内题目、手动搜题的“推荐选择”共用
 */

export type ChoiceType = 'single' | 'multiple' | 'judgement';

const CORRECT_WORDS = ['对', '正确', '√', 'true', 't', '是', 'yes', '对的', '正确的'];
const WRONG_WORDS = ['错', '错误', '×', 'x', 'false', 'f', '否', 'no', '错的', '错误的'];

/** 去掉标点、空白、HTML 标签并转小写，用于文字比较 */
export function normalizeText(text: string) {
	let value = String(text || '');
	try {
		// 统一 Unicode 写法：微符号 µ（U+00B5）与希腊字母 μ（U+03BC）看起来一样，必须当作同一个字符
		value = value.normalize('NFKC');
	} catch {
		// 不支持 normalize 的环境保持原样
	}
	return value
		.replace(/<[^>]+>/g, '')
		.replace(/[\s。．.、,，;；:：!！?？"'“”（）()【】[\]]/g, '')
		.toLowerCase();
}

/** 两段文字的相似度（Dice 系数，0 ~ 1） */
export function textSimilarity(a: string, b: string) {
	const x = normalizeText(a);
	const y = normalizeText(b);
	if (!x || !y) {
		return 0;
	}
	if (x === y) {
		return 1;
	}
	if (x.length < 2 || y.length < 2) {
		return 0;
	}

	const bigrams = new Map<string, number>();
	for (let i = 0; i < x.length - 1; i++) {
		const gram = x.slice(i, i + 2);
		bigrams.set(gram, (bigrams.get(gram) || 0) + 1);
	}

	let intersection = 0;
	for (let i = 0; i < y.length - 1; i++) {
		const gram = y.slice(i, i + 2);
		const count = bigrams.get(gram) || 0;
		if (count > 0) {
			bigrams.set(gram, count - 1);
			intersection++;
		}
	}

	return (2 * intersection) / (x.length + y.length - 2);
}

/** 推断选择题类型：优先使用文字提示，其次根据选项和答案判断 */
export function inferChoiceType(questionText: string, optionTexts: string[], answers: string[] = []): ChoiceType {
	if (/多选题|多项选择|不定项/.test(questionText)) {
		return 'multiple';
	}
	if (/判断题|正误题|对错题/.test(questionText)) {
		return 'judgement';
	}
	const options = optionTexts.map(normalizeText);
	if (
		options.length === 2 &&
		options.every((option) => CORRECT_WORDS.includes(option) || WRONG_WORDS.includes(option))
	) {
		return 'judgement';
	}
	if (/单选题|单项选择/.test(questionText)) {
		return 'single';
	}
	const multipleAnswer = answers.some(
		(answer) =>
			String(answer)
				.split(/#|===|---|\||;|；|\n/)
				.filter(Boolean).length > 1
	);
	return multipleAnswer ? 'multiple' : 'single';
}

/**
 * 从一段文本中拆出题干和选项，例如：
 * `判断题】 xxx。 A 对 B 错`、`xxx\nA. 电压源\nB. 电流源`
 * 没有识别到至少两个按字母顺序排列的选项时，返回空的选项列表。
 */
export function parseQuestionWithOptions(text: string): { stem: string; options: string[] } {
	const source = String(text || '').trim();
	const markerRegex = /(^|[\s（(])([A-H])(?:[.、:：．]\s*|\s+)(?=\S)/g;
	const markers: { letter: string; start: number; end: number }[] = [];

	for (const match of source.matchAll(markerRegex)) {
		const start = (match.index || 0) + match[1].length;
		markers.push({ letter: match[2], start, end: (match.index || 0) + match[0].length });
	}

	// 找到最后一组以 A 开头、字母连续递增的选项
	let best: typeof markers = [];
	for (let i = 0; i < markers.length; i++) {
		if (markers[i].letter !== 'A') {
			continue;
		}
		const run = [markers[i]];
		for (let j = i + 1; j < markers.length; j++) {
			if (markers[j].letter.charCodeAt(0) === run[run.length - 1].letter.charCodeAt(0) + 1) {
				run.push(markers[j]);
			}
		}
		if (run.length >= 2) {
			best = run;
		}
	}

	if (best.length < 2) {
		return { stem: source, options: [] };
	}

	const options = best.map((marker, index) => {
		const next = best[index + 1];
		return source.slice(marker.end, next ? next.start : undefined).trim();
	});

	return { stem: source.slice(0, best[0].start).trim(), options };
}

/** 将答案与选项配对，返回命中的选项下标（单选/判断最多一个） */
export function matchAnswerToOptions(answers: string[], optionTexts: string[], type: ChoiceType) {
	const parts = answers
		.flatMap((answer) => String(answer || '').split(/#|===|---|\||;|；|\n/))
		.map(normalizeText)
		.filter(Boolean);
	const options = optionTexts.map(normalizeText);
	const picked: number[] = [];

	if (type === 'judgement') {
		const isCorrect = parts.some((part) => CORRECT_WORDS.includes(part));
		const isWrong = parts.some((part) => WRONG_WORDS.includes(part));
		if (isCorrect !== isWrong) {
			const words = isCorrect ? CORRECT_WORDS : WRONG_WORDS;
			const index = options.findIndex((option) => words.includes(option));
			if (index !== -1) {
				return [index];
			}
		}
	}

	// 文字匹配：完全一致优先，其次互相包含
	const exact = options.map((option, index) => (option && parts.includes(option) ? index : -1)).filter((i) => i !== -1);
	if (exact.length) {
		picked.push(...exact);
	} else {
		options.forEach((option, index) => {
			if (!option) {
				return;
			}
			const matched = parts.some(
				(part) => (option.length >= 2 && part.includes(option)) || (part.length >= 2 && option.includes(part))
			);
			if (matched) {
				picked.push(index);
			}
		});
	}

	// 纯字母答案：A / ABD
	if (picked.length === 0) {
		for (const part of parts) {
			if (/^[a-h]{1,8}$/.test(part)) {
				for (const letter of part) {
					const index = letter.charCodeAt(0) - 97;
					if (options[index] !== undefined && !picked.includes(index)) {
						picked.push(index);
					}
				}
			}
		}
	}

	return type === 'multiple' ? picked : picked.slice(0, 1);
}

/** 去掉题干前面的题型标记和序号，例如 `1【单选题】`、`判断题】` */
export function cleanQuestionStem(stem: string) {
	return String(stem || '')
		.replace(/^\s*\d+\s*[.、．]\s*/, '')
		.replace(/^\s*\d*\s*[【[(（]?\s*(?:单选题|多选题|判断题|填空题|简答题|选择题|问答题|名词解释)\s*[】\])）]\s*/, '')
		.trim();
}

/**
 * 结果附带的选项字母（如 B、AC）是否都落在当前选项范围内。
 * AI 答题和题库缓存会记录所选选项的字母：文字匹配不上时，答题器会退回到按字母选择，这样的答案同样可用。
 */
export function hasValidOptionLetter(option: unknown, optionCount: number) {
	const letters = String(option || '')
		.toUpperCase()
		.replace(/[^A-H]/g, '');
	return (
		optionCount >= 2 &&
		letters.length > 0 &&
		Array.from(letters).every((letter) => letter.charCodeAt(0) - 65 < optionCount)
	);
}

/**
 * 答案能否填进这道题的选项：选择题的选项都是文字时，答案必须能匹配到其中一个选项。
 * 无法验证（没有选项、填空题、选项是图片/链接）时视为可用。
 */
export function isAnswerUsableForOptions(answers: string[], optionTexts: string[]) {
	const options = optionTexts.map((text) =>
		String(text || '')
			.replace(/^\s*[A-H]\s*[.、:：．]\s*/, '')
			.trim()
	);
	if (options.length < 2 || options.some((option) => !option || /https?:\/\//.test(option))) {
		return true;
	}

	const type = inferChoiceType('', options, answers);
	if (matchAnswerToOptions(answers, options, type).length > 0) {
		return true;
	}

	// 与答题器的相似度匹配保持一致：任意答案片段与选项的相似度 >= 0.6 即认为可用
	const parts = answers.flatMap((answer) => String(answer || '').split(/#|===|---|\||;|；|\n/)).filter(Boolean);
	return parts.some((part) => options.some((option) => textSimilarity(part, option) >= 0.6));
}

/** 把带“第N空：”标签的填空题答案拆成每个空的内容（保持位置，没有内容的空为空字符串）；没有标签时返回 undefined */
export function splitBlankAnswers(text: string) {
	const raw = String(text || '');
	const labelPattern = /第\s*[一二三四五六七八九十\d]+\s*空\s*[:：]?/g;
	const matches = Array.from(raw.matchAll(labelPattern));
	if (matches.length === 0) {
		return undefined;
	}

	return matches.map((match, index) => {
		const start = (match.index || 0) + match[0].length;
		const end = index + 1 < matches.length ? matches[index + 1].index : raw.length;
		return raw.slice(start, end).trim();
	});
}

/**
 * 填空题答案去掉“第一空：”“第2空:”这样的标签，多个空用 # 连接。
 * 某个空的内容里本身含有答案分隔符（# ; ； | --- ===）时，改用 JSON 数组字符串保存
 * （答题器的 splitAnswer 会把 JSON 数组按元素拆分），避免内容被分隔符拆开，导致答案数量与空数对不上。
 */
export function cleanBlankAnswer(text: string) {
	const parts = splitBlankAnswers(text);
	if (!parts) {
		return String(text || '').trim();
	}

	if (parts.some((part) => /#|===|---|\||;|；/.test(part))) {
		return JSON.stringify(parts);
	}

	return parts.join('#');
}

/** 填空题答案是否不可用：带有“第N空”标签但整体为空，或某个空没有内容（例如答案是公式图片，只提取到了标签） */
export function isBlankAnswerJunk(text: string) {
	const parts = splitBlankAnswers(text);
	if (!parts) {
		return false;
	}
	return parts.length === 0 || parts.some((part) => !part.trim());
}
