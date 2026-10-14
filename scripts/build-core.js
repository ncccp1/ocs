// @ts-check

const { series } = require('gulp');
const del = require('del');
const util = require('util');
const { version } = require('../package.json');
const execOut = util.promisify(require('./utils').execOut);
const { createUserScript } = require('../packages/utils');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
const { pathToFileURL } = require('url');

dotenv.config();

const distPath = process.env.BUILD_PATH || '../dist';
console.log('BUILD_PATH: ', distPath);
const distResolvedPath = path.resolve(__dirname, distPath);

function cleanOutput() {
	return del([distPath, '../lib'], { force: true });
}

async function buildPackages() {
	// @ts-ignore
	await execOut('tsc', { cwd: '../packages/core' });
	// @ts-ignore
	await execOut('vite build', { cwd: '../packages/core' });
	// @ts-ignore
	await execOut('tsc', { cwd: '../packages/scripts' });
	// @ts-ignore
	await execOut('vite build', { cwd: '../packages/scripts' });
}

/** 发布文件所在目录，脚本管理器的自动更新、脚本内的更新提示都读取这里 */
const RELEASE_BASE_URL = 'https://raw.githubusercontent.com/ncccp1/ocs/main/release/';
const releasePath = path.resolve(__dirname, '../release');

/**
 * 设置脚本管理器自动更新地址
 * updateURL 指向只含元数据的 .meta.js（体积小，用于检查版本），downloadURL 指向完整脚本
 * @param {import('../packages/utils').CreateOptions} opts
 * @param {string} name
 */
function setUpdateUrls(opts, name) {
	opts.metadata.updateURL = RELEASE_BASE_URL + name + '.meta.js';
	opts.metadata.downloadURL = RELEASE_BASE_URL + name + '.user.js';
}

/** 把构建出的脚本复制到 release 目录，并生成对应的 .meta.js（仅元数据头） */
async function publishRelease() {
	fs.mkdirSync(releasePath, { recursive: true });
	for (const name of ['nanchengpai', 'nanchengpai.common']) {
		const src = path.join(distResolvedPath, name + '.user.js');
		const code = fs.readFileSync(src, 'utf-8');
		const match = code.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/);
		if (!match) {
			throw new Error('未找到脚本元数据头：' + src);
		}
		fs.copyFileSync(src, path.join(releasePath, name + '.user.js'));
		fs.writeFileSync(path.join(releasePath, name + '.meta.js'), `${match[0]}\n`, 'utf-8');
		console.log('release: ', path.join(releasePath, name + '.user.js'));
	}
}

async function createUserJs() {
	/** 模拟浏览器环境 */
	require('browser-env')();

	// @ts-ignore
	globalThis.unsafeWindow = {};

	/** @type {import('../packages/scripts/src/index')} */
	// @ts-ignore
	const ocs = require(path.join(distPath, 'index.js'));

	/** @return {import('../packages/utils').CreateOptions} */
	const createOptions = () => {
		const { CXProject, ZHSProject, ZJYProject, IcveMoocProject, ICourseProject } = ocs;
		const projectList = [CXProject, ZHSProject, ZJYProject, IcveMoocProject, ICourseProject]
			.map((s) => `【${s.name}】`)
			.join(' ');

		const matchMetadata = Array.from(
			new Set(
				ocs
					.definedProjects()
					.map((p) => (p.domains || []).map((d) => `*://*.${d}/*`))
					.flat()
			)
		);

		return {
			parseRequire: true,
			parseResource: true,
			resourceBuilder: (key, value) => `const ${key} = \`${value}\`;`,
			metaDataFormatter: {
				header: '==UserScript==',
				footer: '==/UserScript==',
				prefix: '// ',
				symbol: '@',
				gap: '\t'.repeat(4)
			},
			metadata: {
				name: '南城派网课助手',
				version: version,
				description: ['南城派网课助手，基于 OCSJS 二次开发，支持 ', projectList, '等网课的学习、作业、考试。'].join(
					' '
				),
				author: 'ncccp1',
				license: 'MIT',
				namespace: 'https://github.com/ncccp1/ocs',
				homepage: 'https://github.com/ncccp1/ocs',
				source: 'https://github.com/ncccp1/ocs',
				connect: [
					'raw.githubusercontent.com',
					'github.com',
					'm.metst.cn',
					'm.metost.com',
					'v.metst.cn',
					'api.deepseek.com',
					'cn.bing.com',
					'bing.com',
					'duckduckgo.com',
					'cdn.ocsjs.com',
					'chaoxing.com',
					'zhihuishu.com',
					'icourse163.org',
					'127.net',
					'icve.com.cn',
					'localhost',
					'127.0.0.1'
				],
				match: matchMetadata,
				grant: [
					'GM_info',
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
				],
				require: [path.join(__dirname, distPath, 'index.js')],
				resource: [`STYLE ${path.join(__dirname, '../packages/scripts/assets/css/style.css')}`],
				'run-at': 'document-start',
				antifeature: 'payment'
			},
			entry: path.join(__dirname, '../packages/scripts/entry.js'),
			dist: path.join(__dirname, distPath, 'nanchengpai.user.js')
		};
	};

	const officialOpts = createOptions();
	setUpdateUrls(officialOpts, 'nanchengpai');
	console.log('CreateUserScript: ', officialOpts.metadata.name, officialOpts.dist);
	await createUserScript(officialOpts);

	/** 创建调试脚本 */
	const devOpts = createOptions();
	devOpts.parseRequire = false;
	devOpts.parseResource = false;
	devOpts.metadata.name = devOpts.metadata.name + '(dev)';
	devOpts.metadata.require = [pathToFileURL(path.join(distResolvedPath, 'index.js')).href];
	devOpts.metadata.resource = [
		`STYLE ${pathToFileURL(path.join(__dirname, '../packages/scripts/assets/css/style.css')).href}`
	];
	devOpts.entry = path.join(__dirname, '../packages/scripts/entry.dev.js');
	devOpts.dist = path.join(distResolvedPath, 'nanchengpai.dev.user.js');
	/** 导出样式文件 */
	fs.copyFileSync(
		path.join(__dirname, '../packages/scripts/assets/css/style.css'),
		path.join(distResolvedPath, 'style.css')
	);
	console.log('createUserScript: ', devOpts.metadata.name, devOpts.dist);
	await createUserScript(devOpts);

	/** 创建全Connect域名通用脚本 */
	const commonOpts = createOptions();
	commonOpts.metadata.name = commonOpts.metadata.name + ' - 全域名通用版';
	const connect = Array.isArray(commonOpts.metadata.connect) ? commonOpts.metadata.connect : [];
	connect.push('*');
	commonOpts.metadata.connect = connect;
	setUpdateUrls(commonOpts, 'nanchengpai.common');
	commonOpts.entry = path.join(__dirname, '../packages/scripts/entry.common.js');
	commonOpts.dist = path.join(distResolvedPath, 'nanchengpai.common.user.js');

	console.log('createUserScript: ', commonOpts.metadata.name, commonOpts.dist);
	await createUserScript(commonOpts);
}

exports.default = series(cleanOutput, buildPackages, createUserJs, publishRelease);
