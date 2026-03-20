import { $message, $modal, h } from 'easy-us';

export const $playwright = {
	showError: () => {
		const href = 'https://github.com/ncccp1/ocs';
		const errorEl = h('div', [
			'当前页面通常需要配合兼容的桌面端 / Playwright 启动器使用，详情可查看项目说明 => ',
			h('a', { href: href, target: '_blank' }, href)
		]);
		$modal.alert({
			maskCloseable: false,
			title: '⛔ 错误',
			confirmButtonText: '查看详情',
			content: errorEl.cloneNode(true),
			onConfirm() {
				window.open(href, '_blank');
			}
		});
		$message.error({ content: errorEl.cloneNode(true), duration: 0 });
	}
};
