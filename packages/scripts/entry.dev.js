/* eslint-disable no-undef */
/// <reference path="./global.d.ts" />

// 环境检测
if (
	[
		'GM_getTab',
		'GM_saveTab',
		'GM_setValue',
		'GM_getValue',
		'unsafeWindow',
		'GM_listValues',
		'GM_deleteValue',
		'GM_notification',
		'GM_xmlhttpRequest',
		'GM_getResourceText',
		'GM_addValueChangeListener',
		'GM_removeValueChangeListener'
	].some((api) => typeof Reflect.get(globalThis, api) === 'undefined')
) {
	const open = confirm(
		`南城派网课助手不支持当前的脚本管理器（${GM_info.scriptHandler}）。` +
			'请前往 https://github.com/ncccp1/ocs 查看安装说明，推荐使用 “Scriptcat 脚本猫” 或 “Tampermonkey 油猴”'
	);

	if (open) {
		window.location.href = 'https://github.com/ncccp1/ocs';
	}
	return;
}

const { start, definedProjects, CommonProject, RenderScript } = OCS;

const infos = GM_info;

(function () {
	'use strict';

	const projects = definedProjects();

	// 运行脚本
	start({
		projects: projects,
		renderConfig: {
			renderScript: RenderScript,
			styles: [GM_getResourceText('STYLE')],
			defaultPanelName: CommonProject.scripts.guide.namespace,
			title: `南城派 DEV-${infos.script.version}`
		},
		updatePage: ''
	});
})();
