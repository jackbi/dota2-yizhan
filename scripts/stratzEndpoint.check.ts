import assert from 'node:assert/strict';
import { STRATZ_GRAPHQL_URL, resolveStratzEndpoint } from '../src/lib/stratzEndpoint.ts';

/**
 * `src/lib/stratzEndpoint.ts` 的自检。
 *
 * 这里是**选错就会线上 403** 的分支，所以把四种组合钉死：两个都配、只配一半（两个方向各一条）、
 * 只配 token、什么都不配。另外钉住「中转优先」和「UA 不能被改」这两条硬要求。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/stratzEndpoint.check.ts`）。
 */
const RELAY = 'https://relay.example.com/graphql';
const RELAY_TOKEN = 'r'.repeat(32);
const TOKEN = 'jwt-token-value';
let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

// 两个都配 → 走中转，带口令、**不带** STRATZ token（那东西根本不该在这台机器上）
{
	const endpoint = resolveStratzEndpoint({ relayUrl: RELAY, relayToken: RELAY_TOKEN, token: TOKEN });
	assert.equal(endpoint.mode, 'relay');
	assert.equal(endpoint.url, RELAY);
	assert.equal(endpoint.headers['x-relay-token'], RELAY_TOKEN);
	assert.ok(!('Authorization' in endpoint.headers), '走中转时不该再带 Authorization');
	assert.equal(endpoint.problem, undefined);
	ok('中转优先：两个都配时只带中转口令');
}

// 只配地址 → 不静默退回直连，按未配置处理并把原因说清楚
{
	const endpoint = resolveStratzEndpoint({ relayUrl: RELAY, token: TOKEN });
	assert.equal(endpoint.mode, 'none');
	assert.match(String(endpoint.problem), /RELAY_TOKEN/);
	ok('只配中转地址时按未配置处理（不偷偷退回直连）');
}

// 只配口令 → 同上，另一个方向
{
	const endpoint = resolveStratzEndpoint({ relayToken: RELAY_TOKEN });
	assert.equal(endpoint.mode, 'none');
	assert.match(String(endpoint.problem), /RELAY_URL/);
	ok('只配中转口令时按未配置处理');
}

// 只有 token → 直连官方 GraphQL，带 Authorization
{
	const endpoint = resolveStratzEndpoint({ token: TOKEN });
	assert.equal(endpoint.mode, 'token');
	assert.equal(endpoint.url, STRATZ_GRAPHQL_URL);
	assert.equal(endpoint.headers.Authorization, `Bearer ${TOKEN}`);
	ok('只配 token 时直连官方地址');
}

// 什么都不配 → 未配置，但头里的 UA 仍然固定成官方要求的那个
{
	const endpoint = resolveStratzEndpoint({});
	assert.equal(endpoint.mode, 'none');
	assert.equal(endpoint.url, STRATZ_GRAPHQL_URL);
	assert.equal(endpoint.headers['User-Agent'], 'STRATZ_API');
	assert.equal(endpoint.problem, undefined);
	ok('未配置时不带鉴权，UA 仍固定为 STRATZ_API');
}

// 空白字符串等于没配（`.env` 里留了个空值是最常见的写法）
{
	const endpoint = resolveStratzEndpoint({ relayUrl: '  ', relayToken: '', token: ` ${TOKEN} ` });
	assert.equal(endpoint.mode, 'token');
	assert.equal(endpoint.headers.Authorization, `Bearer ${TOKEN}`);
	ok('空白值按未配置处理，token 两侧空白被裁掉');
}

console.log(`stratzEndpoint 全部断言通过（${cases} 组）`);
