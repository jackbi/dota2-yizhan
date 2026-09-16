/**
 * RFC 1321 的 MD5（纯 TS，十六进制输出）。
 *
 * 为什么不用 `node:crypto`：`astro.config.mjs` 立的规矩是 SSR 侧只用 Web 标准 API，
 * 换到 Cloudflare Workers 才不用重写；而 **WebCrypto 里没有 MD5**（`crypto.subtle.digest`
 * 只认 SHA 家族），斗鱼/虎牙的签名偏偏只要 MD5。所以自己带一份，运行时无关。
 *
 * 只在解析直播直链时用（斗鱼的 `auth`、虎牙的 `wsSecret`），不在任何热路径上：
 * 一次签名几十次 MD5，输入都是短字符串。
 *
 * 自检见 `scripts/md5.check.ts`——它拿 `node:crypto` 当参照物跑一遍，
 * 包括 55/56/64 这几个分块边界。**改这个文件必须跑 `pnpm check`。**
 */
const S = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4,
	11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** K[i] = floor(abs(sin(i + 1)) * 2^32)，按规范算而不是抄一张表，免得抄错一位。 */
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

/** 输入按 UTF-8 编码后取摘要（ASCII 输入与原文一致）。 */
export function md5Hex(input: string): string {
	const msg = new TextEncoder().encode(input);
	const bitLen = msg.length * 8;
	// 补一个 1 比特（0x80）、补零、末尾 8 字节写**小端**的比特长度。
	const total = (msg.length + 8 + 64) & ~63;
	const buf = new Uint8Array(total);
	buf.set(msg);
	buf[msg.length] = 0x80;
	const view = new DataView(buf.buffer);
	view.setUint32(total - 8, bitLen >>> 0, true);
	view.setUint32(total - 4, Math.floor(bitLen / 4294967296), true);

	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;
	const m = new Uint32Array(16);

	for (let off = 0; off < total; off += 64) {
		for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);
		let a = a0;
		let b = b0;
		let c = c0;
		let d = d0;
		for (let i = 0; i < 64; i++) {
			let f: number;
			let g: number;
			if (i < 16) {
				f = (b & c) | (~b & d);
				g = i;
			} else if (i < 32) {
				f = (d & b) | (~d & c);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				f = b ^ c ^ d;
				g = (3 * i + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * i) % 16;
			}
			const tmp = d;
			d = c;
			c = b;
			const sum = (f + a + K[i] + m[g]) | 0;
			b = (b + ((sum << S[i]) | (sum >>> (32 - S[i])))) | 0;
			a = tmp;
		}
		a0 = (a0 + a) | 0;
		b0 = (b0 + b) | 0;
		c0 = (c0 + c) | 0;
		d0 = (d0 + d) | 0;
	}

	const out = new Uint8Array(16);
	const outView = new DataView(out.buffer);
	outView.setUint32(0, a0 >>> 0, true);
	outView.setUint32(4, b0 >>> 0, true);
	outView.setUint32(8, c0 >>> 0, true);
	outView.setUint32(12, d0 >>> 0, true);
	let hex = '';
	for (const byte of out) hex += byte.toString(16).padStart(2, '0');
	return hex;
}
