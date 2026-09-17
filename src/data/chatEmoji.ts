/**
 * 聊天室的表情表。
 *
 * 只用系统字体就能显示的那批（`U+1F600` 这一代 + 少量符号），不引 emoji 字体、不引第三方
 * 选择器库——开黑房间是「边打边聊」，多一个几十 KB 的依赖换不来什么。分组是给**选择器**用的，
 * 每组一行，点一下把字符插到输入框光标处。
 *
 * `label` 是给读屏与 `title` 用的：光一个 😂 对读屏软件毫无意义，而按钮上又不能塞说明文字。
 * 自检见 `scripts/partyEmoji.check.ts`（字符不重复、label 都填了）。
 */

export interface ChatEmoji {
	/** 插进输入框的字符。 */
	char: string;
	/** 中文说明，用作 `title` 与 `aria-label`。 */
	label: string;
}

export interface ChatEmojiGroup {
	title: string;
	items: ChatEmoji[];
}

export const CHAT_EMOJI: ChatEmojiGroup[] = [
	{
		title: '常用',
		items: [
			{ char: '😀', label: '开心' },
			{ char: '😄', label: '大笑' },
			{ char: '😂', label: '笑哭' },
			{ char: '🤣', label: '爆笑' },
			{ char: '😊', label: '微笑' },
			{ char: '😍', label: '喜欢' },
			{ char: '🤔', label: '思考' },
			{ char: '😅', label: '流汗笑' },
			{ char: '😭', label: '大哭' },
			{ char: '😡', label: '生气' },
			{ char: '😱', label: '震惊' },
			{ char: '😴', label: '困了' },
			{ char: '🤯', label: '头炸' },
			{ char: '🥳', label: '庆祝' },
			{ char: '😎', label: '帅气' },
			{ char: '🤡', label: '小丑' },
		],
	},
	{
		title: '手势',
		items: [
			{ char: '👍', label: '赞' },
			{ char: '👎', label: '踩' },
			{ char: '👏', label: '鼓掌' },
			{ char: '🙌', label: '举手' },
			{ char: '🤝', label: '握手' },
			{ char: '✌️', label: '胜利' },
			{ char: '🤙', label: 'call' },
			{ char: '👊', label: '碰拳' },
			{ char: '🫡', label: '敬礼' },
			{ char: '🙏', label: '拜托' },
			{ char: '💪', label: '加油' },
			{ char: '🖖', label: '瓦肯礼' },
		],
	},
	{
		title: '刀塔',
		items: [
			{ char: '⚔️', label: '开战' },
			{ char: '🗡️', label: '短刀' },
			{ char: '🛡️', label: '护盾' },
			{ char: '🏹', label: '弓箭' },
			{ char: '🪄', label: '魔杖' },
			{ char: '🧙', label: '法师' },
			{ char: '🐉', label: '龙' },
			{ char: '👑', label: '王冠' },
			{ char: '💎', label: '宝石' },
			{ char: '🧪', label: '药水' },
			{ char: '🪓', label: '斧头' },
			{ char: '🔮', label: '水晶球' },
			{ char: '🐔', label: '信使' },
			{ char: '👻', label: '幽鬼' },
			{ char: '🧟', label: '僵尸' },
			{ char: '🍗', label: '鸡腿' },
		],
	},
	{
		title: '其它',
		items: [
			{ char: '🔥', label: '火' },
			{ char: '💯', label: '满分' },
			{ char: '🎉', label: '撒花' },
			{ char: '✅', label: '对' },
			{ char: '❌', label: '错' },
			{ char: '⚡', label: '闪电' },
			{ char: '💀', label: '骷髅' },
			{ char: '⏰', label: '时间' },
			{ char: '🍺', label: '啤酒' },
			{ char: '🎮', label: '手柄' },
			{ char: '🏆', label: '奖杯' },
			{ char: '🚀', label: '起飞' },
			{ char: '🐢', label: '慢' },
			{ char: '🍀', label: '好运' },
			{ char: '📢', label: '喇叭' },
			{ char: '🎯', label: '正中' },
		],
	},
];
