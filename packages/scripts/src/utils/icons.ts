/* eslint-disable max-len */
/**
 * 内置的线性图标（24x24，描边风格）。
 * 窗口运行在 Shadow DOM 里，无法使用外部图标字体，所以全部用内联 SVG。
 */
const PATHS: Record<string, string> = {
	play: '<polygon points="7 4 19 12 7 20 7 4"/>',
	pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
	skip: '<polygon points="5 5 15 12 5 19 5 5"/><line x1="19" y1="5" x2="19" y2="19"/>',
	check: '<polyline points="5 12.5 10 17.5 19 7"/>',
	x: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
	minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
	expand:
		'<polyline points="15 4 20 4 20 9"/><line x1="20" y1="4" x2="13" y2="11"/><polyline points="9 20 4 20 4 15"/><line x1="4" y1="20" x2="11" y2="13"/>',
	headphones:
		'<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1"/><rect x="17" y="14" width="4" height="6" rx="1"/>',
	file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>',
	pencil: '<path d="M4 20l1-4L16 5a2.1 2.1 0 0 1 3 3L8 19z"/><line x1="14" y1="7" x2="17" y2="10"/>',
	notebook:
		'<rect x="6" y="3" width="13" height="18" rx="2"/><line x1="10" y1="8" x2="15" y2="8"/><line x1="10" y1="12" x2="15" y2="12"/><line x1="3" y1="7" x2="6" y2="7"/><line x1="3" y1="12" x2="6" y2="12"/><line x1="3" y1="17" x2="6" y2="17"/>',
	clipboard:
		'<rect x="6" y="5" width="12" height="16" rx="2"/><rect x="9" y="3" width="6" height="4" rx="1"/><polyline points="9 14 11 16 15 12"/>',
	sparkles:
		'<path d="M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8z"/><path d="M19 15l.7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7z"/>',
	shield:
		'<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12" y2="16.5"/>',
	alert: '<path d="M12 4l9 16H3z"/><line x1="12" y1="10" x2="12" y2="14"/><line x1="12" y1="17" x2="12" y2="17.5"/>',
	flask:
		'<path d="M9 3h6"/><path d="M10 3v6L5 19a1.5 1.5 0 0 0 1.3 2h11.4A1.5 1.5 0 0 0 19 19l-5-10V3"/><line x1="8" y1="14" x2="16" y2="14"/>',
	loader:
		'<line x1="12" y1="4" x2="12" y2="7"/><line x1="12" y1="17" x2="12" y2="20"/><line x1="4" y1="12" x2="7" y2="12"/><line x1="17" y1="12" x2="20" y2="12"/><line x1="6.3" y1="6.3" x2="8.4" y2="8.4"/><line x1="15.6" y1="15.6" x2="17.7" y2="17.7"/><line x1="6.3" y1="17.7" x2="8.4" y2="15.6"/><line x1="15.6" y1="8.4" x2="17.7" y2="6.3"/>',
	school:
		'<path d="M3 9l9-5 9 5-9 5z"/><path d="M7 11.5V16c0 1.5 2.2 3 5 3s5-1.5 5-3v-4.5"/><line x1="21" y1="9" x2="21" y2="15"/>',
	dashboard:
		'<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="5" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="11" width="7" height="9" rx="1"/>',
	sliders:
		'<line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="15" cy="17" r="2"/>',
	search: '<circle cx="10.5" cy="10.5" r="6"/><line x1="15" y1="15" x2="20" y2="20"/>',
	terminal: '<polyline points="5 8 9 12 5 16"/><line x1="12" y1="17" x2="19" y2="17"/>',
	download:
		'<line x1="12" y1="4" x2="12" y2="15"/><polyline points="7 11 12 16 17 11"/><line x1="5" y1="20" x2="19" y2="20"/>',
	package:
		'<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><polyline points="3 8 12 13 21 8"/><line x1="12" y1="13" x2="12" y2="21"/>',
	book: '<path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><line x1="8" y1="8" x2="14" y2="8"/>',
	bug: '<rect x="8" y="9" width="8" height="10" rx="4"/><line x1="12" y1="9" x2="12" y2="19"/><line x1="4" y1="12" x2="8" y2="12"/><line x1="16" y1="12" x2="20" y2="12"/><path d="M9 9a3 3 0 0 1 6 0"/>',
	help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7"/><line x1="12" y1="17" x2="12" y2="17.5"/>',
	clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
	moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
	globe:
		'<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
	refresh:
		'<path d="M20 11a8 8 0 0 0-14-4L4 9"/><polyline points="4 4 4 9 9 9"/><path d="M4 13a8 8 0 0 0 14 4l2-2"/><polyline points="20 20 20 15 15 15"/>',
	link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
	apps: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
	chevron: '<polyline points="9 6 15 12 9 18"/>',
	database:
		'<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
	upload:
		'<line x1="12" y1="20" x2="12" y2="9"/><polyline points="7 13 12 8 17 13"/><line x1="5" y1="4" x2="19" y2="4"/>'
};

export type IconName = keyof typeof PATHS | string;

/** 返回一个内联 SVG 字符串，颜色跟随当前文字颜色 */
export function icon(name: IconName, size = 16) {
	const path = PATHS[name] || PATHS.help;
	return (
		`<svg class="ncp-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
		`stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
	);
}
