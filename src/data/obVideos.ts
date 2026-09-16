import type { BiliVideo } from './types';

/**
 * B站 视频清单。
 *
 * 每一条都用 B站 自己的 `api.bilibili.com/x/web-interface/view?bvid=` 核对过，
 * 标题、时长、播放量、投稿人全部来自接口返回值（核对方式见 docs/data-sources.md 的「视频」一节），
 * 不靠搜索结果里的转述。老视频大多是粉丝搬运，所以卡片上会把**投稿人**如实写出来——
 * 搬运者不是原作者。
 *
 * 收录标准：优先「OB 人物志」这类成系列的人物回顾，其次是与某个具体梗直接对应的原始对局，
 * 再次是本人频道发的切片。没有可靠对应视频的成员就不凑数。
 */
export const OB_MEMBER_VIDEOS: Record<string, BiliVideo[]> = {
	yyf: [
		{
			bv: 'BV1ZJ411z7eh',
			title: 'OB人物志——YYF姜岑传',
			uploader: 'qingpingle1986',
			uploaderUid: '130125536',
			pubdate: '2019-12-04',
			duration: 847,
			views: 104631,
			cover: 'https://i0.hdslb.com/bfs/archive/d33430584e71a2f1c29890b280c5790543a65492.jpg',
			why: 'OB 人物志系列里的一篇，从 DOTA1 时期讲到他退役',
		},
		{
			bv: 'BV1N5411A72d',
			title: 'DOTA(蓝猫)YYF经典蓝猫，七进七出，手持万元无限买活，冰蛙为此增加买活CD！',
			uploader: '爱思刀塔人',
			uploaderUid: '2311507',
			pubdate: '2021-04-04',
			duration: 661,
			views: 21481,
			cover: 'https://i1.hdslb.com/bfs/archive/be5d2a85bc90b2583f3b091e8059ad05eb58626e.jpg',
			why: '「蓝猫七进七出」的原始素材，社区常说这一战打出了买活 CD',
		},
		{
			bv: 'BV14b411L7z4',
			title: '【DOTA2】说文解字 第一章 第一节 沉江',
			uploader: 'RiseVideo',
			uploaderUid: '123707266',
			pubdate: '2019-04-14',
			duration: 334,
			views: 158130,
			cover: 'https://i0.hdslb.com/bfs/archive/83c46403c76e44fdba545a4ce5acf929e6d29ee5.jpg',
			why: '「沉江」这个梗的来龙去脉',
		},
	],
	zhou: [
		{
			bv: 'BV1cW411H7m6',
			title: '【dota2经典-多分镜版The play】Patience from zhou（配肾的周）多分镜版',
			uploader: 'Zero_Requiem',
			uploaderUid: '39275925',
			pubdate: '2018-01-31',
			duration: 58,
			views: 9741,
			cover: 'https://i1.hdslb.com/bfs/archive/62619d85137f396d315406598e046500ab441c01.jpg',
			why: 'TI2 上那句「Patience from Zhou」的多分镜复盘',
		},
		{
			bv: 'BV1qu411H7cd',
			title: '再看亿遍之【CN军团的首冠IG：TI2 3：1卫冕冠军NAVI】，偶数年玄学的开端，CN军团的领头羊，ZHOU，430，YYF，CHUAN，FAITH…很牛',
			uploader: '洋柿子Tomat0',
			uploaderUid: '508203117',
			pubdate: '2023-08-02',
			duration: 1368,
			views: 43271,
			cover: 'https://i1.hdslb.com/bfs/archive/d3797d1fa7369d582a4546480bcd40731c24cacf.jpg',
			why: 'TI2 决赛 iG 3:1 NAVI，CN 军团的首个 TI 冠军',
		},
	],
	820: [
		{
			bv: 'BV1qJ411x7yZ',
			title: 'OB人物志——820传',
			uploader: 'qingpingle1986',
			uploaderUid: '130125536',
			pubdate: '2019-12-21',
			duration: 641,
			views: 33231,
			cover: 'https://i1.hdslb.com/bfs/archive/e8063ce1d8af84939f80f624b86e5e418cf04b5b.jpg',
			why: 'OB 人物志系列里的一篇',
		},
		{
			bv: 'BV1wM4y167b2',
			title: 'DOTA剑血封喉：倚天既出，谁与争锋！820职业生涯回顾',
			uploader: 'DOTA-YaphetS',
			uploaderUid: '3493135418133022',
			pubdate: '2023-03-25',
			duration: 1445,
			views: 20833,
			cover: 'https://i2.hdslb.com/bfs/archive/ad7788f3601e8fe8a81580ca17675efe59ddb335.jpg',
			why: '从 EHOME 十冠到退役的职业生涯回顾',
		},
	],
	longdd: [
		{
			bv: 'BV1vJ411y7Pt',
			title: 'OB人物志——Longdd传',
			uploader: 'qingpingle1986',
			uploaderUid: '130125536',
			pubdate: '2019-12-11',
			duration: 1638,
			views: 45164,
			cover: 'https://i2.hdslb.com/bfs/archive/27bb9bdeae64e8bb1cefd0da75fc320be9649df5.jpg',
			why: 'OB 人物志系列里的一篇',
		},
		{
			bv: 'BV13b411j71A',
			title: '《致竞》走近LongDD听龙神讲述辛酸往事，我哭了，你们呢？',
			uploader: '大电竞',
			uploaderUid: '95508834',
			pubdate: '2019-04-15',
			duration: 555,
			views: 55781,
			cover: 'https://i0.hdslb.com/bfs/archive/a6f49d0f5f768ba8df6984d5c6c717db51adbc56.jpg',
			why: '本人出镜，讲早年的经历',
		},
	],
	zippo: [
		{
			bv: 'BV1uJ411d7iS',
			title: 'OB人物志——周雄宝哥传',
			uploader: 'qingpingle1986',
			uploaderUid: '130125536',
			pubdate: '2019-11-22',
			duration: 2249,
			views: 31714,
			cover: 'https://i2.hdslb.com/bfs/archive/75429b799c5d134c532cd6bb86418ae3a30b9825.jpg',
			why: 'OB 人物志系列里的一篇，也是该系列时长最长的一集',
		},
		{
			bv: 'BV1Kj411K75b',
			title: '反贼们的聚会，OB唯一歌王——宝哥周雄唱歌合集',
			uploader: '背着梦的幸存者已报废',
			uploaderUid: '256060106',
			pubdate: '2023-02-06',
			duration: 786,
			views: 26395,
			cover: 'https://i0.hdslb.com/bfs/archive/abea5c5b4b9fe0c26160556d04af7de05e379b43.jpg',
			why: '「OB 唯一歌王」的唱歌合集',
		},
	],
	dd: [
		{
			bv: 'BV1CE411e7aR',
			title: 'OB人物志——谢彬DD传',
			uploader: 'qingpingle1986',
			uploaderUid: '130125536',
			pubdate: '2019-11-13',
			duration: 1083,
			views: 126430,
			cover: 'https://i2.hdslb.com/bfs/archive/5fe1f44534a870fb2038f33c73980e0c6a8bf505.jpg',
			why: 'OB 人物志系列里的一篇',
		},
		{
			bv: 'BV17mFTzeE8K',
			title: '【刀塔年菜时刻】2025年谢彬DD年度高能时刻',
			uploader: '好动彗星',
			uploaderUid: '1300882',
			pubdate: '2026-02-02',
			duration: 1727,
			views: 85107,
			cover: 'https://i0.hdslb.com/bfs/archive/9b788c8c02406ee2aa203c25e8fd3d335704538c.jpg',
			why: '2025 年直播高能时刻的年度剪辑',
		},
	],
	zsmj: [
		{
			bv: 'BV1Jb4y1f7pN',
			title: '［DOTA经典战役］ZSMJ最强7分钟刷出圣者遗物，让你一个3800是中国战队的实力！',
			uploader: '爱思刀塔人',
			uploaderUid: '2311507',
			pubdate: '2021-05-14',
			duration: 969,
			views: 237313,
			cover: 'https://i1.hdslb.com/bfs/archive/6df0e79bd71ab3b0df67d472e0072b6990499ca2.jpg',
			why: '「7 分钟 3800」那一局的来龙去脉',
		},
		{
			bv: 'BV11J411u7BL',
			title: '820回忆录之爹妈大战(ZSMJ圣剑MED)_超清',
			uploader: '七律SAMA',
			uploaderUid: '659578',
			pubdate: '2019-09-21',
			duration: 4046,
			views: 14266,
			cover: 'https://i1.hdslb.com/bfs/archive/95e7da2c2e05a8f7101306a4ae2e34af2198eaa1.jpg',
			why: '爹妈大战里的圣剑美杜莎',
		},
	],
	hao: [
		{
			bv: 'BV17s411D78m',
			title: '给我幽鬼，不赢砍手！----《砍手豪的由来》xfy vs rox.kis第三场',
			uploader: '九天之上我让你',
			uploaderUid: '7986180',
			pubdate: '2015-04-23',
			duration: 3307,
			views: 74886,
			cover: 'https://i2.hdslb.com/bfs/archive/f4708e75c71bedde9b5eb5acae2f3478bd3b6b64.jpg',
			why: '「给我幽鬼，不赢砍手」的出处：xfy vs rox.kis 第三场',
		},
		{
			bv: 'BV16g411G7dh',
			title: '不懂幽鬼陈智豪！光速变脸，阿豪把直播玩穿了！',
			uploader: 'sakira_hao',
			uploaderUid: '383826285',
			pubdate: '2021-06-11',
			duration: 387,
			views: 14155,
			cover: 'https://i2.hdslb.com/bfs/archive/220880fbddb43688ecb3f0b4eb9229511f64d0cd.jpg',
			why: '本人在自己频道发的直播切片',
		},
	],
	mu: [
		{
			bv: 'BV1jW411n7hU',
			title: '【DOTA2】大mu金仙 - mu神回忆录',
			uploader: '淡若浅紫',
			uploaderUid: '15134124',
			pubdate: '2018-02-09',
			duration: 1844,
			views: 237143,
			cover: 'https://i0.hdslb.com/bfs/archive/e7d7b5eaaddc70b1e91a3b5c3d2bd6f2ced250db.jpg',
			why: '「大 Mu 金仙」这个称呼的由来与生涯回顾',
		},
		{
			bv: 'BV1Jr4y1N7yC',
			title: '【Mu】《修仙歌》——法力无边，东尼大Mu',
			uploader: '小辛不会弹solo',
			uploaderUid: '1475759',
			pubdate: '2021-02-10',
			duration: 255,
			views: 228683,
			cover: 'https://i2.hdslb.com/bfs/archive/8bf4a4731b4b4cb9b76b2130a6406715d952b75d.jpg',
			why: '「法力无边，东尼大 Mu」的鬼畜曲',
		},
	],
	sansheng: [
		{
			bv: 'BV1nJ411S7Eg',
			title: 'OB人物志——我的兄弟兆辉传',
			uploader: 'qingpingle1986',
			uploaderUid: '130125536',
			pubdate: '2019-11-17',
			duration: 992,
			views: 85475,
			cover: 'https://i0.hdslb.com/bfs/archive/9bff3b29a75de5946e85f68ebc0f910fe4130f05.jpg',
			why: 'OB 人物志系列里的一篇，副标题「我的兄弟兆辉」就是他的外号',
		},
		{
			bv: 'BV1ze4y1N7Yb',
			title: '反贼们的聚会，唐门第6大仇人——灭门者王兆辉，狗哥1穿8',
			uploader: '背着梦的幸存者已报废',
			uploaderUid: '256060106',
			pubdate: '2023-02-06',
			duration: 776,
			views: 21158,
			cover: 'https://i0.hdslb.com/bfs/archive/265b574c6ca5b252e24e2c328614094f9e69d588.jpg',
			why: '「狗哥 1 穿 8」的对局记录',
		},
	],
	laochen: [
		{
			bv: 'BV1ax411c79B',
			title: '【WoDotA荣誉出品】屠夫阿川：I Can Feel You',
			uploader: 'Jun2rin',
			uploaderUid: '31533',
			pubdate: '2011-01-28',
			duration: 651,
			views: 61681,
			cover: 'https://i0.hdslb.com/bfs/archive/64d94fc507bfe256e27d4dcb5dcb6b8fb23b7f93.jpg',
			why: 'DOTA1 时代屠夫阿川的代表作，2011 年投稿',
		},
		{
			bv: 'BV1os411H7nT',
			title: '【DOTA小课堂】对黑再现OB救星老陈！屠夫阿川真的操刀屠夫变成大腿了！',
			uploader: '游戏小书童',
			uploaderUid: '2858823',
			pubdate: '2018-07-06',
			duration: 758,
			views: 10242,
			cover: 'https://i1.hdslb.com/bfs/archive/12a9268133cf6fe14a0069a6f09878c214116a74.jpg',
			why: '对黑局里老陈真的操刀屠夫',
		},
	],
};

/**
 * 剑雪封喉（B站 UID 12893504）的作品。
 *
 * 他的《DotA 回忆录》《疯狂的 DotA》《天下 DotA》是 DOTA1/DOTA2 早期的口述史，
 * 也是「7 进 7 出蓝猫」这类传奇的放大器——YYF 自己在直播里说过「当年做个视频就能让
 * 一个人封神」。这里**只有 `BV1ss41167pe` 是他自己频道发的**，其余都是粉丝搬运，
 * 卡片上标的是搬运者的昵称，不是喉哥。
 */
export const JIANXUE_FENGHOU = {
	name: '剑雪封喉',
	biliName: '剑雪封喉2011',
	uid: '12893504',
	spaceUrl: 'https://space.bilibili.com/12893504',
};

export const JIANXUE_VIDEOS: BiliVideo[] = [
	{
		bv: 'BV1ss41167pe',
		title: '【天下DotA】Ti6 Wings夺冠特辑（上）：远征海外，如履薄冰——小组赛有惊无险',
		uploader: '剑雪封喉2011',
		uploaderUid: '12893504',
		pubdate: '2016-08-30',
		duration: 1742,
		views: 718895,
		cover: 'https://i1.hdslb.com/bfs/archive/7d96958ad5b16200da59c463982737898931f1e4.jpg',
		why: '喉哥自己频道里的《天下 DotA》TI6 Wings 夺冠特辑',
	},
	{
		bv: 'BV1xx411w7p8',
		title: 'DotA回忆录第7期 剑雪封喉“爹妈大战”不可复制的经典',
		uploader: '憤怒的崇凱的罪惡-',
		uploaderUid: '122204',
		pubdate: '2012-01-15',
		duration: 1730,
		views: 150790,
		cover: 'https://i0.hdslb.com/bfs/archive/ac8be51ccb8c3380934c54a05cc15fdd79b53949.jpg',
		why: '《DotA 回忆录》第 7 期，讲的就是「爹妈大战」',
	},
	{
		bv: 'BV1Ax411c7bp',
		title: '剑雪封喉-【天下DotA】(第4期)：山岭，逆袭！—记TI2败者组Ehome vs Orange',
		uploader: '喜多村みゆき',
		uploaderUid: '135301',
		pubdate: '2013-02-25',
		duration: 1748,
		views: 110653,
		cover: 'https://i1.hdslb.com/bfs/archive/82d7fe3805f6f6b13defd811aae5e86587347c60.jpg',
		why: '《天下 DotA》第 4 期：TI2 败者组 EHOME vs Orange',
	},
	{
		bv: 'BV1Px411T7Dr',
		title: '【剑雪封喉】【天下DotA】（第8期）：火！火！火！——记SL9附加赛 Rox vs IG',
		uploader: '尼禄NeRU',
		uploaderUid: '320838',
		pubdate: '2014-05-21',
		duration: 1306,
		views: 106901,
		cover: 'https://i1.hdslb.com/bfs/archive/3c41e8d6798fe710e80b311a8937da6041a8ca4a.jpg',
		why: '《天下 DotA》第 8 期：SL9 附加赛 Rox vs IG',
	},
	{
		bv: 'BV18D4y1S7oP',
		title: 'DOTA王者对决经典回顾：名师大将莫自牢，千军万马避蓝猫！',
		uploader: 'ZeroDOTA',
		uploaderUid: '889274',
		pubdate: '2020-07-12',
		duration: 918,
		views: 21387,
		cover: 'https://i2.hdslb.com/bfs/archive/a5edbe480134eccddbfd5cada73e48e4d07c64e5.jpg',
		why: '「名师大将莫自牢，千军万马避蓝猫」的出处考',
	},
	{
		bv: 'BV18x411A7Dq',
		title: '【剑雪封喉系列】回忆录10+天下18+番外2；不能不记得DotA，不能不认识喉哥。',
		uploader: 'pianr_',
		uploaderUid: '4520202',
		pubdate: '2015-02-10',
		duration: 43253,
		views: 430589,
		cover: 'https://i2.hdslb.com/bfs/archive/b2366ab12c5b07d2087f911250ed2cfd17732f39.jpg',
		why: '粉丝搬运的合集：回忆录 10 期 + 天下 18 期 + 番外 2 期',
	},
	{
		bv: 'BV1GY411V7M5',
		title: '【剑雪封喉高清早期系列】DotA回忆录11+疯狂的DotA13+天下DotA20',
		uploader: '沈小轮',
		uploaderUid: '5705431',
		pubdate: '2022-02-14',
		duration: 49379,
		views: 63643,
		cover: 'https://i2.hdslb.com/bfs/archive/17a1123ba90f085929ec352b46fb0efefbd7edd9.jpg',
		why: '粉丝搬运的高清早期合集',
	},
];

/** B站 视频页地址。 */
export function biliUrl(bv: string): string {
	return `https://www.bilibili.com/video/${bv}`;
}

/** 秒数转 12:34 / 1:02:03。 */
export function videoDuration(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** 播放量按国内习惯写：9.7 万 / 43.1 万 / 1.2 亿。 */
export function videoViews(views: number): string {
	if (views >= 100_000_000) return `${(views / 100_000_000).toFixed(1)} 亿`;
	if (views >= 10_000) return `${(views / 10_000).toFixed(1)} 万`;
	return String(views);
}
