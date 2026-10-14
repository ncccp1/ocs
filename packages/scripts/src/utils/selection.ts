/**
 * 划词选择相关工具
 */

const BLOCK_TAGS = new Set([
	'DIV',
	'P',
	'LI',
	'UL',
	'OL',
	'TR',
	'TABLE',
	'SECTION',
	'ARTICLE',
	'BLOCKQUOTE',
	'PRE',
	'DT',
	'DD',
	'H1',
	'H2',
	'H3',
	'H4',
	'H5',
	'H6'
]);

function nodeToText(node: Node, out: string[], baseURI: string) {
	if (node.nodeType === Node.TEXT_NODE) {
		out.push(node.textContent || '');
		return;
	}

	if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
		return;
	}

	let isBlock = false;
	if (node.nodeType === Node.ELEMENT_NODE) {
		const el = node as Element;
		const tag = el.tagName;

		if (tag === 'SCRIPT' || tag === 'STYLE') {
			return;
		}
		if (tag === 'BR') {
			out.push('\n');
			return;
		}
		if (tag === 'IMG') {
			const src = el.getAttribute('src') || el.getAttribute('data-src') || '';
			if (src && !src.startsWith('data:')) {
				try {
					out.push(` ${new URL(src, baseURI).href} `);
				} catch {
					out.push(` ${src} `);
				}
			}
			return;
		}
		isBlock = BLOCK_TAGS.has(tag);
	}

	if (isBlock) {
		out.push('\n');
	}
	node.childNodes.forEach((child) => nodeToText(child, out, baseURI));
	if (isBlock) {
		out.push('\n');
	}
}

/**
 * 获取当前选中的内容，并且把选区中的图片按出现顺序以链接形式保留在文本中，
 * 这样题目中的图片可以交给 AI 识别（普通的 `selection.toString()` 会丢掉图片）。
 */
export function getSelectionTextWithImages(doc: Document = document) {
	const selection = doc.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
		return '';
	}

	const out: string[] = [];
	for (let index = 0; index < selection.rangeCount; index++) {
		nodeToText(selection.getRangeAt(index).cloneContents(), out, doc.baseURI);
	}

	let text = out
		.join('')
		.replace(new RegExp(String.fromCharCode(160), 'g'), ' ')
		.replace(/[ \t]+/g, ' ')
		.replace(/ ?\n ?/g, '\n')
		.replace(/\n{2,}/g, '\n')
		.trim();

	// 部分页面会把图片链接以不可见文字追加在 <img> 后面（见 optimizationElementWithImage），这里去掉重复的链接
	text = text.replace(/(https?:\/\/\S+)(?:\s+\1)+/g, '$1');

	return text || selection.toString().trim();
}
