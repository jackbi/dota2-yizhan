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

/** 09.10。不是有效时间戳时返回 `--.--`（分组用的 `dayKey` 不设这道守卫，见文件末尾）。 */
export function formatMonthDay(unix: number): string {
	if (!Number.isFinite(unix) || unix <= 0) return '--.--';
	const p = parts(unix);
	return `${p.month}.${p.day}`;
}

/** 20:30。不是有效时间戳时返回 `--:--`。 */
export function formatClock(unix: number): string {
	if (!Number.isFinite(unix) || unix <= 0) return '--:--';
	const p = parts(unix);
	return `${p.hour}:${p.minute}`;
}

/** 用于按天分组赛程 */
export function dayKey(unix: number): string {
	const p = parts(unix);
	return `${p.year}-${p.month}-${p.day}`;
}

/**
 * 对局内的秒数 → `18:43`。超过一小时（加速模式之外几乎不会有）就带上小时位。
 *
 * 和经济/经验曲线的分钟轴、回放时间轴共用一份口径：负数按 0 处理，
 * 上游偶尔会给出负的时间（开局前的选人/策略时间）。
 */
export function formatElapsed(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(total / 60);
	const rest = total % 60;
	const tail = `${String(minutes % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
	return minutes >= 60 ? `${Math.floor(minutes / 60)}:${tail}` : `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * 09.10（周一）。不是有效时间戳时返回「时间待定」。
 *
 * 与 `formatMatchTime` 同一道理：上游的 `startDateTime` 缺省是 0，而 `new Date(0)` 是合法的
 * 1970-01-01——不拦的话页面上会多出一个看着像真日期的假信息（对局详情、复盘页都直连这个函数）。
 */
export function formatDayWithWeekday(unix: number): string {
	if (!Number.isFinite(unix) || unix <= 0) return '时间待定';
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

/**
 * 今天 20:30 / 昨天 20:30 / 09.12 20:30。`unix` 与 `nowSec` 均为 Unix 秒。
 *
 * `unix` 不是正数时返回「时间待定」：OpenDota 的进行中比赛会给 `activate_time: 0`，
 * 而 `new Date(0)` 是合法的 1970-01-01——不拦的话卡片上就多出一个看着像真日期的假信息。
 * 守卫放在这里、而不是每个调用点：同一批数据会流到记分板、赛程卡、比赛列表好几处，
 * 漏一处就是一处假日期（上游那次只在 `MatchRow` 上堵住了，别处照样印）。
 */
export function formatMatchTime(unix: number, nowSec: number): string {
	if (!Number.isFinite(unix) || unix <= 0) return '时间待定';
	return `${formatRelativeDay(unix, nowSec)} ${formatClock(unix)}`;
}

/**
 * 按国内习惯把大数字写短：23.1 万 / 1.2 亿。
 *
 * 浏览数与播放量这类数字动辄五六位，原样铺在卡片上又长又难读；一万以下保持原样，
 * 免得把"541"写成"0.1 万"这种反而看不出来的形式。
 */
export function formatCount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return '0';
	if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿`;
	if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
	return String(value);
}

/**
 * 2026.09.06 — 2026.09.13，同一天只显示一个日期。
 *
 * 两端都要是有效时间戳：赛事数据来自 Liquipedia / OpenDota，缺日期时是 0，印出来就是
 * 「1970.01.01 — 1970.01.01」这种看着像真的假区间。
 */
export function formatRange(start: number, end: number): string {
	if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(end) || end <= 0) return '时间待定';
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
