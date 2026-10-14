import { createRenderScript } from 'easy-us';

export const RenderScript = createRenderScript({
	name: '🖼️ 窗口设置'
});

// 工作台布局下 13px 的字号更合适（easy-us 默认 14px）
const fontsize = (RenderScript.configs as any).fontsize;
if (fontsize) {
	fontsize.defaultValue = 13;
}
