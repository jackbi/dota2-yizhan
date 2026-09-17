import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHAT_EMOJI } from '../src/data/chatEmoji.ts';

/**
 * 聊天室表情表的自检。
 *
 * 表情表是手写的长列表，最容易出的两种错都很难在页面上发现：**同一个字符出现在两组里**
 * （看着像多了一个按钮，其实点哪个都一样）和**漏了 label**（读屏念出来是一个空白按钮）。
 * 顺带钉住三条实现约定：面板用 `style="display:none"` 初始隐藏（不能用 hidden 属性/类）、
 * 脚本里有人负责显示它、插入走 `setRangeText`（否则只能追加到末尾，补表情就废了）。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/partyEmoji.check.ts`）。
 */
const page = readFileSync(new URL('../src/pages/party.astro', import.meta.url), 'utf8');
const script = readFileSync(new URL('../src/scripts/partyRoom.ts', import.meta.url), 'utf8');

assert.ok(CHAT_EMOJI.length >= 2, `表情表至少要有两组，现在 ${CHAT_EMOJI.length} 组`);

const seen = new Map<string, string>();
let count = 0;
for (const group of CHAT_EMOJI) {
	assert.ok(group.title.trim(), '每组都要有标题');
	assert.ok(group.items.length > 0, `「${group.title}」是空组`);
	for (const item of group.items) {
		assert.ok(item.char.trim(), `「${group.title}」里有空字符`);
		assert.ok(item.label.trim(), `表情 ${item.char} 缺 label（读屏会念成一个空白按钮）`);
		// 松一点的形状检查：一个表情最多是「基字符 + 变体选择符 + ZWJ 组合」，不该是一句话。
		assert.ok([...item.char].length <= 4, `表情 ${item.char} 看着不像单个表情`);
		const owner = seen.get(item.char);
		assert.equal(owner, undefined, `${item.char} 同时出现在「${owner}」与「${group.title}」里`);
		seen.set(item.char, group.title);
		count += 1;
	}
}
console.log(`  ✓ 表情表：${CHAT_EMOJI.length} 组 / ${count} 个，无重复、label 齐全`);

// 面板：初始隐藏必须是 style（hidden 属性/类会被 Tailwind 的 !important 按住，脚本放不出来）。
const panelTag = /<div[^>]*id="chat-emoji-panel"[^>]*>/i.exec(page)?.[0];
assert.ok(panelTag, 'party.astro 里找不到表情面板');
assert.match(panelTag, /style="display:\s*none"/i, '表情面板要用 style="display:none" 初始隐藏');
assert.ok(!/\shidden(\s|=|>)/i.test(panelTag.replace(/class="[^"]*"/gi, 'class=""')), '面板不能带 hidden 属性');

// 脚本里得有人显示它，否则面板永远打不开（同 partyVisibility.check.ts 的规则 2）。
assert.match(script, /emojiPanel/, '脚本里没有引用表情面板');
assert.match(script, /setVisible\(dom\.emojiPanel/, '面板必须通过 setVisible() 显隐');
// 开关状态要自己记：面板初始只有内联 display:none，`hidden` 属性一直是 false，
// 读它会把第一次点击判成「关闭」，面板就永远打不开（踩过）。
assert.match(script, /let emojiPanelOpen/, '面板开关状态要用变量记，别读 .hidden');
assert.ok(
	!/setEmojiPanel\(dom\.emojiPanel\.hidden\)/.test(script),
	'不能用 dom.emojiPanel.hidden 判断当前状态',
);

// 插入必须走 setRangeText：只往末尾拼的话，用户没法把表情补进半句话中间。
assert.match(script, /setRangeText\(/, '插入表情要用 setRangeText()，插到光标处');
// 插完要按码点裁一次：setRangeText 会绕过 maxlength。
assert.match(script, /clampChatText\(input\.value\)/, '插入后要按码点裁一次长度');
// 点「别处」收起的判断要放过整个聊天表单：按回车是隐式提交，浏览器会在发送按钮上补一次
// click 冒泡到 document，不放过的话「发一条消息，面板自己关了」。
assert.match(
	script,
	/closest\('#chat-form'\)/,
	'点别处收起的判断必须放过 #chat-form 里的点击',
);

console.log('party 表情输入断言通过');
