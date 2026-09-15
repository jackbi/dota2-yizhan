import assert from 'node:assert/strict';
import {
	ROOM_MAX_MEMBERS,
	addTeam,
	autoFormTeams,
	clearRolls,
	createRoom,
	freeMembers,
	formTeamsByRoll,
	moveMember,
	neededTeamCount,
	randomizeTeams,
	removeMember,
	removeTeam,
	renameTeam,
	sanitizeName,
	setRoll,
	setTeamSize,
	shuffle,
	teamOf,
	upsertMember,
	rollValue,
	randomCode,
	normalizeCode,
	isValidCode,
	appendChat,
	type Member,
	type RoomState,
} from '../src/lib/partyLogic.ts';

let joined = 0;
const mk = (id: string, name = id): Member => ({ id, name, avatar: '', joinedAt: (joined += 1) });

const room = (count: number, teamSize = 5): RoomState => {
	let state = createRoom({ code: 'ABCDE', name: '开黑', host: mk('p0', '房主'), teamSize });
	for (let i = 1; i < count; i += 1) state = upsertMember(state, mk(`p${i}`)).state;
	return state;
};

/** 不变量：每个人最多出现在一个队里，且队伍人数不超过上限。 */
function checkInvariants(state: RoomState, label: string) {
	const seen = new Set<string>();
	for (const team of state.teams) {
		for (const id of team.members) {
			assert.ok(!seen.has(id), `${label}: ${id} 同时在多个队里`);
			seen.add(id);
			assert.ok(state.members.some((m) => m.id === id), `${label}: 队里的 ${id} 不在名册`);
		}
		assert.ok(team.members.length <= state.teamSize, `${label}: ${team.id} 超员 ${team.members.length}/${state.teamSize}`);
	}
	assert.equal(seen.size + freeMembers(state).length, state.members.length, `${label}: 人员对不上`);
}

// --- 自动建队：人数与每队上限 ---
let s = room(10, 5);
assert.equal(s.teams.length, 2);
assert.deepEqual(s.teams.map((t) => t.members.length), [5, 5]);
checkInvariants(s, '10 人 5 上限');

s = room(11, 5);
assert.equal(s.teams.length, 3);
checkInvariants(s, '11 人 5 上限');
assert.equal(neededTeamCount(11, 5), 3);

// --- 上限调小：超员的人回空闲池，队数补够 ---
s = setTeamSize(room(10, 5), 3);
assert.equal(s.teams.length, 4);
checkInvariants(s, '上限 5→3');
assert.equal(freeMembers(s).length, 0);

// --- 上限调大：只补不删，房主手动加的队不能被顺手删掉 ---
s = addTeam(room(6, 3)); // 6 人本该 2 队，房主手动加到 3 队
assert.equal(s.teams.length, 3);
s = setTeamSize(s, 5);
assert.equal(s.teams.length, 3, '改上限不该删掉房主手动加的队');
checkInvariants(s, '手动加队后改上限');

// --- 自动分队：按人数重算，多出来的队拆掉，人回空闲池或重排 ---
s = autoFormTeams(addTeam(room(6, 3)));
assert.equal(s.teams.length, 2, '自动分队应按人数收敛到 2 队');
checkInvariants(s, '自动分队');

// --- 满了就不搬 ---
s = room(10, 5);
const full = s.teams[0].id;
const outsider = s.teams[1].members[0];
assert.equal(moveMember(s, outsider, full).rev, s.rev, '目标队满时不应产生新状态');
assert.equal(teamOf(moveMember(s, outsider, full), outsider)?.id, s.teams[1].id);

// --- 放回空闲池 / 再自动入队 ---
s = moveMember(s, outsider, null);
assert.equal(teamOf(s, outsider), undefined);
assert.equal(freeMembers(s).length, 1);
checkInvariants(s, '移出队伍');

// --- 删队：人回空闲池，最后一个队不能删 ---
s = room(10, 5);
const victim = s.teams[0];
s = removeTeam(s, victim.id);
assert.equal(s.teams.length, 1);
assert.equal(freeMembers(s).length, 5, '被删队里的人应回到空闲池');
checkInvariants(s, '删队');
assert.equal(removeTeam(s, s.teams[0].id).rev, s.rev, '最后一个队不应被删掉');

// --- 改队名 ---
s = renameTeam(room(5), 't1', '  带妹组  ');
assert.equal(s.teams[0].name, '带妹组');
assert.equal(renameTeam(s, 't1', '   ').rev, s.rev, '空名字不应生效');

// --- 随机分队：人全放完，不超员 ---
s = randomizeTeams(room(9, 5), () => 0.42);
checkInvariants(s, '随机分队');
assert.equal(freeMembers(s).length, 0);

// --- roll：1–100、按点数排序、重开一轮清空 ---
s = room(4, 5);
s = setRoll(s, 'p0', 87);
s = setRoll(s, 'p1', 12);
s = setRoll(s, 'p2', 150); // 越界应夹到 100
assert.equal(s.rolls.p2.value, 100);
s = clearRolls(s);
assert.deepEqual(s.rolls, {});
assert.equal(s.rollRound, 2);
for (let i = 0; i < 200; i += 1) {
	const v = rollValue();
	assert.ok(v >= 1 && v <= 100, `roll 越界: ${v}`);
}

// --- 按 roll 蛇形分队：点数最高的在 t1，第二在 t2，第三在 t2，第四在 t1 ---
s = room(4, 2);
assert.equal(s.teams.length, 2);
s = setRoll(setRoll(setRoll(setRoll(s, 'p0', 90), 'p1', 80), 'p2', 70), 'p3', 60);
s = formTeamsByRoll(s);
assert.deepEqual(s.teams[0].members, ['p0', 'p3']);
assert.deepEqual(s.teams[1].members, ['p1', 'p2']);
checkInvariants(s, '蛇形分队');

// --- 人走了：名册、队伍、roll 记录一起清掉 ---
s = removeMember(room(3, 5), 'p1');
assert.equal(s.members.length, 2);
assert.equal(freeMembers(s).length, 0);
assert.equal(s.rolls.p1, undefined);

// --- 房间满员 ---
s = room(ROOM_MAX_MEMBERS, 5);
const rejected = upsertMember(s, mk('overflow'));
assert.equal(rejected.full, true);
assert.equal(rejected.state.members.length, ROOM_MAX_MEMBERS);
s = room(3, 5);
const again = upsertMember(s, { ...s.members[0], name: '改名了' });
assert.equal(again.added, false);
assert.equal(again.state.members.length, 3);
assert.equal(again.state.members.find((m) => m.id === 'p0')?.name, '改名了');

// --- 随机源与房间码 ---
assert.equal(shuffle([1, 2, 3, 4], () => 0).length, 4);
assert.equal(isValidCode(randomCode()), true);
assert.equal(isValidCode('ABC'), false);
assert.equal(normalizeCode(' ab-cd1e '), 'ABCDE');
assert.equal(normalizeCode('ab0cd'), 'ABCD', '0 不在字母表里');

// --- 昵称清洗 ---
assert.equal(sanitizeName('  阿\u200b铨  '), '阿铨');
assert.equal(sanitizeName('a\nb'), 'ab', '控制字符直接删掉，而不是变成空格');
assert.equal(sanitizeName('x'.repeat(40)).length, 16);
assert.equal(sanitizeName('\u202eabc'), 'abc');
assert.equal(sanitizeName('   '), '');

// --- 聊天裁剪 ---
let chat: ReturnType<typeof appendChat> = [];
for (let i = 0; i < 100; i += 1) chat = appendChat(chat, { id: String(i), kind: 'say', peerId: '', name: '', text: String(i), at: i });
assert.equal(chat.length, 80);
assert.equal(chat[0].text, '20');

console.log('partyLogic 全部断言通过');
