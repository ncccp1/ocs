// @ts-check

/**
 * 界面本地预览：不需要油猴脚本管理器。
 *
 * 用桩函数模拟油猴 API，加载构建产物 dist/index.js 和样式，在一个静态页面里显示窗口。
 * 用法：
 *   pnpm build
 *   pnpm ui:preview
 * 然后打开 http://127.0.0.1:5175/index.html ，在浏览器控制台里用 OCS.setTaskState({...}) 模拟各种任务状态，例如：
 *   OCS.setTaskState({ kind: 'quiz', status: 'running', title: '章节测验', total: 8, current: 3, progress: 0.37 })
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'ui-preview');
const port = Number(process.env.PORT || 5175);

function sync() {
	fs.copyFileSync(path.join(__dirname, '../dist/index.js'), path.join(dir, 'index.js'));
	fs.copyFileSync(path.join(__dirname, '../packages/scripts/assets/css/style.css'), path.join(dir, 'style.css'));
}

const types = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8'
};

http
	.createServer((req, res) => {
		const name = (req.url || '/').split('?')[0].replace(/^\/+/, '') || 'index.html';
		// 每次请求都重新同步，重新构建后刷新页面即可看到最新效果
		try {
			sync();
		} catch (error) {
			res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end('请先执行 pnpm build：' + error.message);
			return;
		}
		const file = path.join(dir, path.basename(name));
		if (!fs.existsSync(file)) {
			res.writeHead(404);
			res.end('not found');
			return;
		}
		res.writeHead(200, {
			'Content-Type': types[path.extname(file)] || 'application/octet-stream',
			'Cache-Control': 'no-store'
		});
		fs.createReadStream(file).pipe(res);
	})
	.listen(port, '127.0.0.1', () => {
		console.log(`界面预览已启动：http://127.0.0.1:${port}/index.html`);
	});
