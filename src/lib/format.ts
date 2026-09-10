/** 站点面向国内玩家，所有时间统一按东八区渲染。 */
const TIME_ZONE = 'Asia/Shanghai';

const PARTS = new Intl.DateTimeFormat('en-CA', {
	timeZone: TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	hour12: false,
});

interface Parts {
	year: string;
	month: string;
	day: string;
	hour: string;
	minute: string;
}

function parts(unix: number): Parts {
	const out: Record<string, string> = {};
	for (const part of PARTS.formatToParts(unix * 1000)) {
		if (part.type !== 'literal') out[part.type] = part.value;
	}
	return {
		year: out.year ?? '1970',
		month: out.month ?? '01',
		day: out.day ?? '01',
		hour: out.hour === '24' ? '00' : (out.hour ?? '00'),
		minute: out.minute ?? '00',
	};
}

/** 2026.09.10 */
export function formatDay(unix: number): string {
	const p = parts(unix);
	return `${p.year}.${p.month}.${p.day}`;
}

/** 09.10 */
export function formatMonthDay(unix: number): string {
	const p = parts(unix);
	return `${p.month}.${p.day}`;
}

/** 20:30 */
export function formatClock(unix: number): string {
	const p = parts(unix);
	return `${p.hour}:${p.minute}`;
}

/** 用于按天分组赛程 */
export function dayKey(unix: number): string {
	const p = parts(unix);
	return `${p.year}-${p.month}-${p.day}`;
}

/** 09.10（周一） */
export function formatDayWithWeekday(unix: number): string {
	const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: TIME_ZONE, weekday: 'short' }).format(unix * 1000);
	return `${formatMonthDay(unix)}（${weekday}）`;
}

/**
 * 今天 / 明天 / 昨天 / 09.12。
 * `unix` 与 `nowSec` 都是 Unix 秒（`Date.now()` 是毫秒，需先 `Math.floor(now / 1000)`）。
 */
export function formatRelativeDay(unix: number, nowSec: number): string {
	const target = dayKey(unix);
	const today = dayKey(nowSec);
	if (target === today) return '今天';
	if (target === dayKey(nowSec + 86_400)) return '明天';
	if (target === dayKey(nowSec - 86_400)) return '昨天';
	return formatMonthDay(unix);
}

/** 今天 20:30 / 昨天 20:30 / 09.12 20:30。`unix` 与 `nowSec` 均为 Unix 秒。 */
export function formatMatchTime(unix: number, nowSec: number): string {
	return `${formatRelativeDay(unix, nowSec)} ${formatClock(unix)}`;
}

/** 2026.09.06 — 2026.09.13，同一天只显示一个日期 */
export function formatRange(start: number, end: number): string {
	if (dayKey(start) === dayKey(end)) return formatDay(start);
	const a = parts(start);
	const b = parts(end);
	const left = `${a.year}.${a.month}.${a.day}`;
	const right = a.year === b.year ? `${b.month}.${b.day}` : `${b.year}.${b.month}.${b.day}`;
	return `${left} — ${right}`;
}

/** 把 ISO 时间渲染成 2026.09.10 14:30 */
export function formatIso(iso: string): string {
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return iso;
	return `${formatDay(Math.floor(time / 1000))} ${formatClock(Math.floor(time / 1000))}`;
}
