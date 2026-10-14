import { findBestMatch, Rating } from 'string-similarity';

/**
 * 删除特殊字符, 并且全部转小写，只保留英文，数字，中文
 * @param str
 * @returns
 */
/** 统一 Unicode 写法：全角字符转半角，微符号 µ（U+00B5）转希腊字母 μ（U+03BC）等，看起来一样的字符才能匹配上 */
function normalizeUnicode(str: string) {
	try {
		return str.normalize('NFKC');
	} catch {
		return str;
	}
}

export function clearString(str: string, ...exclude: string[]) {
	exclude.push(...['①②③④⑤⑥⑦⑧⑨']);
	const base = normalizeUnicode(str).trim().toLocaleLowerCase();
	/**
	 * 只保留中日韩文字、所有语言的字母和数字。
	 * 以前只保留中文、英文字母和数字，导致希腊字母（λ ρ μ …）等理工科题目里常见的选项被清成空字符串，永远匹配不上。
	 */
	const cleaned = base.replace(RegExp(`[^\\u2E80-\\u9FFF\\p{L}\\p{N}${exclude.join('')}]+`, 'gu'), '');
	// 选项本身全是符号时（例如 ≥ ≤ ± →），上面会得到空字符串，此时只去掉空白，保留符号用于比较
	return cleaned || base.replace(/\s+/g, '');
}

/**
 * 答案相似度匹配 , 返回相似度对象列表 Array<{@link Rating}>
 *
 * 相似度计算算法 : https://www.npmjs.com/package/string-similarity
 *
 * @param answers 答案列表
 * @param options 选项列表
 *
 *
 * @example
 *
 * ```js
 *
 * answerSimilar( ['3'], ['1+2','3','4','错误的选项'] ) // [0, 1, 0, 0]
 *
 * answerSimilar( ['hello world','console.log("hello world")'], ['console.log("hello world")','hello world','1','错误的选项'] ) // [1, 1, 0, 0]
 *
 * ```
 *
 */
export function answerSimilar(answers: string[], options: string[]): Rating[] {
	const _answers = answers.map(removeRedundant).map((a) => clearString(a));
	const _options = options.map(removeRedundant).map((o) => clearString(o));

	const similar =
		_answers.length !== 0
			? _options.map((option) => {
					if (option.trim() === '') {
						return { rating: 0, target: '' };
					}
					return findBestMatch(option, _answers).bestMatch;
			  })
			: _options.map(() => ({ rating: 0, target: '' }));

	return similar;
}

/**
 * 	精准匹配模式，返回符合的选项字符串列表
 * @param answers	答案列表
 * @param options	选项列表
 */
export function answerExactMatch(answers: string[], options: string[]): string[] {
	const _answers = answers.map(removeRedundant);
	const _options = options.map(removeRedundant);

	const result =
		_answers.length !== 0
			? _options.filter((option) => {
					return _answers.find((answer) => answer.trim() === option.trim());
			  })
			: [];

	return result;
}

/**
 * 删除题目选项中开头的冗余字符串
 */
export function removeRedundant(str: string) {
	// 只删除开头的选项标签（A. / A、 / A： / A) / “A”后面换行或空白再跟内容）。
	// 旧实现没有锚定开头，会把内容中间的“大写字母 + 符号 + 字母”也删掉，
	// 例如答案 “DW +DQ -DA” 被改成 “DDQ -DA”，而选项只去掉了标签，两边永远对不上。
	return (
		normalizeUnicode(str || '')
			.trim()
			.replace(/^[A-Z](?:\s*[.、:：．)）]\s*|\s+)(?=[A-Za-z0-9\u2E80-\u9FFF])/, '') || ''
	);
}
