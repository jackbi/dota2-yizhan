import assert from 'node:assert/strict';
import { decodeEntities, sanitizeArticleHtml, summarizeArticle, toArticleContent } from '../src/lib/articleHtml.ts';

/**
 * `src/lib/articleHtml.ts` 正文清洗的自检。
 *
 * 这一层是**唯一**挡在第三方正文与 `set:html` 之间的东西，而正文来自 Reddit / 虎扑这类
 * 用户内容——清洗漏一个写法，就是本站域名下的存储型 XSS。原先那版是黑名单，实测漏掉：
 *
 * - `<img src=x onerror=alert(1)>`（无引号）；
 * - `<img src='x' onerror='alert(1)'>`（单引号）；
 * - `onerror = alert(1)`（等号两边有空格）；
 * - `<svg/onload=alert(1)>`（自闭合斜杠）；
 * - `<a href="javascript:alert(1)">`（还显式放行 `javascript:`）；
 * - `<a href="&#106;avascript:alert(1)">`（实体还原成 `j`）。
 *
 * 所以下面第一组用例盯的就是这些，且**断言的是"输出里没有可执行的痕迹"，不是"输出等于某个字符串"**——
 * 换写法（大小写、引号、实体、空格）都得挡住，而不是把那几种字符串从产物里删掉。
 *
 * 最后一组模拟真实链路：Reddit 的 `selftext_html` 是**已经把用户尖括号转义好**的 HTML
 * （用户写 `<img …>`，上游给的是 `&lt;img …&gt;`）。曾经这里被 `decodeEntities` 反解回真标签，
 * 于是 `parseListing` 再交给清洗时已经是可利用的 HTML。现在解析侧不再反解，但清洗侧必须自己站得住，
 * 所以这组直接断言「即使拿反解过的输入进来，输出里也不能有活的 onerror」。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/articleHtml.check.ts`）。
 */

let cases = 0;

/** 带执行能力的标签，一个都不该出现在输出里。 */
const DANGEROUS_TAGS = /\b(?:script|style|iframe|svg|object|embed|form|math|link|meta|base)\b/i;

/**
 * 输出里不许出现可执行的东西：可执行标签、标签上的事件属性、标签上的危险协议。
 *
 * **只检查真正的标签**，不检查文字——被转义之后 `&lt;img src=x onerror=…` 是页面上的
 * 可见文字（用户原文就该看见），不是可执行的标记。分不清这两者的话，这条断言会把
 * 「已经安全地变成文字」误判成漏洞。
 */
function assertNoExecution(output: string, what: string): void {
	for (const match of output.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g)) {
		const tag = match[1].toLowerCase();
		const attrs = match[2];
		assert.ok(!DANGEROUS_TAGS.test(tag), `${what}：输出里不该留下 <${tag}> → ${output}`);
		assert.ok(!/\bon[a-z]+\s*=/i.test(attrs), `${what}：<${tag}> 上不该留下事件属性 → ${output}`);
		assert.ok(!/(?:javascript|vbscript|data)\s*:/i.test(attrs), `${what}：<${tag}> 上不该留下危险协议 → ${output}`);
	}
}

// 1. 黑名单漏掉的那几种写法 + 同族的变体，一律不许留活口。
{
	const payloads = [
		'<img src=x onerror=alert(1)>',
		"<img src='x' onerror='alert(1)'>",
		'<img src="x" onerror = alert(1)>',
		'<img src="x" OnError="alert(1)">',
		'<img src="x" ONERROR=alert(1) />',
		'<svg/onload=alert(1)>',
		'<svg onload=alert(1)>',
		'<a href="javascript:alert(1)">x</a>',
		'<a href="JaVaScRiPt:alert(1)">x</a>',
		'<a href="&#106;avascript:alert(1)">x</a>',
		'<a href="java\tscript:alert(1)">x</a>',
		'<a href=" vbscript:msgbox(1)">x</a>',
		'<a href="data:text/html,<script>alert(1)</script>">x</a>',
		'<iframe srcdoc="<script>alert(1)</script>"></iframe>',
		'<object data="x"></object>',
		'<form action="/x"><input name="a"></form>',
		'<p onclick="alert(1)">文字</p>',
		'<div onmouseover=alert(1)>文字</div>',
		// 半截标签：少一个 `>`，后面的正文与页面标记都不该被它吃掉。
		'<img src=x onerror=alert(1)',
		'<p>正文</p><img src=x onerror=alert(1)',
	];
	for (const payload of payloads) {
		const output = sanitizeArticleHtml(payload);
		assertNoExecution(output, payload);
	}
	cases += 1;
}

// 2. 危险标签的**内容**要一起删掉，不能只删标签留下裸代码难看。
{
	const output = sanitizeArticleHtml('<p>前</p><script>alert("x")</script><style>body{color:red}</style><!-- 注释 --><p>后</p>');
	assert.equal(output, '<p>前</p><p>后</p>', 'script / style / 注释连内容一起删');
	cases += 1;
}

// 3. 正常正文照旧：格式标签留下，属性里的 style / class / id 丢掉，图片补懒加载。
{
	const output = sanitizeArticleHtml(
		'<p style="color:red" id="a" class="b">文字<strong>加粗</strong></p><div><img src="/images/x.jpg" alt="图" width="10"></div>',
	);
	assert.equal(
		output,
		'<p>文字<strong>加粗</strong></p><div><img src="https://www.dota2.com.cn/images/x.jpg" alt="图" width="10" loading="lazy"></div>',
		'站内相对地址补成官方站绝对地址，其余照旧',
	);
	cases += 1;
}

// 4. 相对地址按调用方给的站点补——虎扑正文必须补成 bbs.hupu.com，不能沿用官方站的。
{
	const output = sanitizeArticleHtml('<img src="/x.jpg"><a href="/1.html">链</a>', { baseOrigin: 'https://bbs.hupu.com' });
	assert.ok(output.includes('src="https://bbs.hupu.com/x.jpg"'), `虎扑的相对地址要补虎扑域名 → ${output}`);
	assert.ok(output.includes('href="https://bbs.hupu.com/1.html"'), `虎扑的相对地址要补虎扑域名 → ${output}`);
	cases += 1;
}

// 5. 属性值里的引号与实体：不能靠引号逃出去，也不能被双重转义成乱码。
{
	assert.equal(
		sanitizeArticleHtml('<img alt=\'说 "引号" 的图\'>'),
		'<img alt="说 &quot;引号&quot; 的图" loading="lazy">',
		'alt 里的双引号要转义',
	);
	assert.equal(sanitizeArticleHtml('<a href="/x.php?a=1&amp;b=2">x</a>'), '<a href="https://www.dota2.com.cn/x.php?a=1&amp;b=2">x</a>', 'URL 里的 & 重新转义回 &amp;');
	assert.equal(sanitizeArticleHtml('<img alt="A &amp; B">'), '<img alt="A &amp; B" loading="lazy">', 'alt 里的实体不该被双重转义');
	cases += 1;
}

// 6. 配平：被丢掉的标签不留孤零零的闭合标签，写坏的标签也别把后面的正文吞掉。
{
	assert.equal(sanitizeArticleHtml('</div><p>正文</p></span>'), '<p>正文</p>', '没有对应开标签的闭合标签要丢掉');
	assert.equal(sanitizeArticleHtml('<p>前<div>中</p>后'), '<p>前<div>中</div></p>后', '嵌套写坏时补上缺失的闭合');
	assert.equal(sanitizeArticleHtml('<p>没有闭合'), '<p>没有闭合</p>', '尾部缺闭合要补齐');
	cases += 1;
}

// 7. 文字里已经转义好的尖括号保持转义：它应当是可见的文字，而不是标签。
{
	const output = sanitizeArticleHtml('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
	assert.equal(output, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>', '已转义的尖括号原样保留');
	assertNoExecution(output, '已转义尖括号');
	cases += 1;
}

// 8. 真实链路：Reddit 上游已经把用户尖括号转义好了（用户写 `<img …>`，上游给 `&lt;img …&gt;`）。
//    两件事分别盯：正常路径下它必须是**可见的文字**；解析侧哪天再犯「反解实体」的错，
//    清洗侧也得自己站得住——上一版就是两层一起塌才出的洞。
{
	const fromReddit = '&lt;img src=x onerror=alert(document.domain)&gt;';
	const normal = sanitizeArticleHtml(fromReddit);
	assert.equal(normal, fromReddit, '上游已转义的用户尖括号应当原样保留成可见文字');
	assert.ok(!/<img\b/i.test(normal), `没被反解时不该长出真标签 → ${normal}`);

	const decoded = sanitizeArticleHtml(decodeEntities(fromReddit));
	assertNoExecution(decoded, 'Reddit 正文（反解实体后）');
	cases += 1;
}

// 9. `summarizeArticle` 吃的是清洗结果，别把它的输入格式改坏。
{
	const cleaned = sanitizeArticleHtml('<p>这一句是第一段正文，长度够当摘要用了。</p><p>第二段</p>');
	assert.equal(summarizeArticle(cleaned), '这一句是第一段正文，长度够当摘要用了。', '摘要仍能从清洗结果里取到首段');
	cases += 1;
}

// 10. 官方新闻：抽正文靠 `<div class="content">`，清洗会把 class 丢掉——所以**必须先抽后洗**。
//     顺序反过来就是 62 份空正文（实测），这条用例专门盯它。
{
	const page =
		'<html><body><div class="nav">导航</div>' +
		'<div class="article content" id="x"><p>正文第一段</p><img src="/a.jpg"></div>' +
		'<div class="footer">页脚</div></body></html>';
	const output = toArticleContent(page);
	assert.equal(output, '<p>正文第一段</p><img src="https://www.dota2.com.cn/a.jpg" loading="lazy">', '抽正文要先于清洗，且只留内容容器里的东西');
	assert.equal(toArticleContent('<html><body><p>没有内容容器</p></body></html>'), '', '找不到容器就返回空串，不能把整页当正文');
	cases += 1;
}

console.log(`articleHtml 全部断言通过（${cases} 组用例）`);
