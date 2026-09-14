import type { ObMember } from './types';

/**
 * OB 大家庭名单 —— 只写有来源的部分。
 *
 * OB = Old Boys，国内 DOTA2 退役选手组成的娱乐团体。名单以斗鱼官方签约通稿
 * （2018-12-07「OB 战队目前共有九人」）和 2019-06-13 OB 官博「十人全家福」为准：
 * YYF、Zhou、LongDD、宝哥、Mu、Hao、820、DD、ZSMJ、SanSheng。
 * 老陈（陈彦川）不在十人名单里，但他是 OB 前身「龙宝川」三人组的成员，页面上一并收录
 * （`membership` 只作为来源标注保留，页面上不做区分展示）。
 *
 * 两条注意：
 * - `aliases` 与 `jokes` 是社区多年流传的称呼和梗，不是官方资料；页面需整体标注出处。
 *   涉及感情纠纷、赌博与私生活的内容一律不收。
 * - 房间号会随主播转平台/换房间而失效，所以每张卡片都带 `ownerMatch`：
 *   构建期用平台接口返回的房主昵称自查，对不上就在页面上明说，不假装还是本人房间。
 */
export const OB_MEMBERS: ObMember[] = [
	{
		id: 'yyf',
		name: 'YYF',
		realName: '姜岑',
		aliases: ['枫哥', '月夜枫', '胖头鱼', '石佛', '沪上皇', '姜瘤儿', '不粘锅', 'Escape Master', '僵尸王', '饭皇'],
		platform: 'douyu',
		roomId: '9999',
		ownerMatch: ['yyf', '姜岑'],
		membership: '正式成员',
		role: '三号位',
		achievement: 'TI2 冠军（iG）、2012 WCG 中国区与世界总决赛冠军，2014 年 7 月退役',
		champions: ['酒仙', '风行', '赏金猎人', '噬魂鬼'],
		tag: 'OB 核心 · 石佛',
		description:
			'世界顶尖三号位，打法凶狠又不失稳健，因此得名「石佛」。退役后转型解说与直播，是 OB 大家庭的核心人物。',
		jokes: ['《情商》《位置》《牌面》', 'FGNB', '沉江', '诛姜三角洲', 'RUA！', '12 道枫味', '继说峰喜，勿说峰厌'],
	},
	{
		id: 'zhou',
		name: 'Zhou',
		realName: '陈尧',
		aliases: ['鲷哥', 'zhou 神', '都督', '天命鲷', '农民周', '最 C', '头铁鲷', '天梯惩罚者'],
		platform: 'douyu',
		roomId: '88660',
		ownerMatch: ['zhou', '陈尧'],
		membership: '正式成员',
		role: '一号位 Carry',
		achievement: 'TI2 冠军（iG），「国服三大 C」之一，2014 年退役',
		champions: ['幽鬼', '敌法师', '水人'],
		tag: '专业读盘解说',
		description:
			'CD 战队「玩命 4 保 Zhou」的主角，iG 时期从 BP 到战术完克欧美强队拿下 TI2。退役后以深入独到的战局分析被称作专业读盘解说。',
		jokes: ['「配肾的鲷」（Patience from Zhou）', '「没有我不敢接的团」', '「凭什么和我打」', '三巴掌一个鲷', '造尧', '东南亚鬼见 Zhou'],
	},
	{
		id: '820',
		name: '820',
		realName: '邹倚天',
		aliases: ['566', '乌总', '乌鲁鲁', '八老板', '网恋教父', '乌贼', '不爱你', '日麻教父'],
		platform: 'douyu',
		roomId: '82088',
		ownerMatch: ['820', '邹倚天', '乌鲁鲁'],
		membership: '正式成员',
		role: '五号位（原主 C / 队长）',
		achievement: 'TI1 亚军（EHOME）；SMM、ESWC 巴黎、ACG、WGT、IEM 世界总决赛冠军，2011 年 9 月退役',
		champions: ['幽鬼', '猴子', '沉默术士', '影魔', '复仇之魂'],
		tag: 'EHOME 十冠王朝建立者',
		description:
			'DOTA1 复仇之魂金色 ID 冠名者。司职主 Carry 时打钱能力一流，总比对方后期多出一个大件，因此被叫做「八老板」；后转五号位并率 EHOME 建立十冠王朝。',
		jokes: ['伟乌生，优不盾（优势不要去打盾）', '说话「乌噜噜」', '不爱你'],
	},
	{
		id: 'longdd',
		name: 'LongDD',
		realName: '黄翔',
		aliases: ['龙神', '龙弟弟', '矮子龙', '爆眼龙', '面子龙', '胆小菇', '龙虾', '龙怼怼', '霍比特龙', '体操龙', '小气龙', '巨龙输醒', '子龙'],
		platform: 'huya',
		roomId: '678555',
		ownerMatch: ['longdd', '黄翔'],
		membership: '正式成员',
		role: '辅助 / Support',
		achievement: 'EHOME、DK 时期多次夺冠（DK 六连冠）；TI3 前被 LGD 换下，无 TI 冠军',
		champions: ['夜魔', '撼地神牛', '陈'],
		tag: '解说席气氛担当',
		description:
			'「周宝龙」三人组的一员（前身「龙宝川」），OB 建队时的元老。2023 年曾在 B 站开播，2026 年 1 月 1 日回归虎牙老房间。',
		jokes: ['胆小菇', 'TB 在找你（身高梗）', '黄翔技校', '反枫建', '华府双雄', '龙神淹死在河道了', '《规矩》'],
	},
	{
		id: 'zippo',
		name: 'ZippO',
		realName: '周雄',
		aliases: ['宝哥', '生日宝', '敬业宝', '多宝道人', '蛇哥', '验尸宝', '多宝鱼', '唯一 B 神', '斯内克', '钢蛇宝', '上帝之宝', '法医周雄'],
		platform: 'douyu',
		roomId: '67554',
		ownerMatch: ['zippo', '宝哥', '周雄'],
		membership: '正式成员',
		role: '辅助 / 解说',
		achievement: '效力 cD、WE、DK，DK 九冠王时期成员；TI2 第四名，2013 年退役',
		champions: ['土猫'],
		tag: '多宝道人',
		description: '「周宝龙」三人组的一员，OB 建队元老。退役后长期担任解说与主播，外号多到需要单独列一栏。',
		jokes: ['宝哥生日快乐', '下套', '验尸', 'snake（拉长尾音）'],
	},
	{
		id: 'dd',
		name: 'DD',
		realName: '谢彬',
		aliases: ['奶哥哥', '奶子 D', '二维马', '唐门门主', '彬彬神', '蟹兵', '龟龟', 'D 能儿', '3 秒 BKB'],
		platform: 'douyu',
		roomId: '110',
		ownerMatch: ['dd', '谢彬', '谢斌'],
		membership: '正式成员',
		role: '三号位',
		achievement: 'TI2 季军（LGD），2014 年退役',
		champions: ['谜团'],
		tag: '解说效果好被拉进 OB',
		description:
			'OB 初期常请刚退役或在役选手一起解说，DD 因为解说效果好被 YYF 拉入。斗鱼官方通稿与房间页均写作「谢彬」，部分自媒体写作「谢斌」。',
		jokes: ['「谢彬是谁」', '二维马', '口头禅「还打个奶子啊」'],
	},
	{
		id: 'zsmj',
		name: 'ZSMJ',
		realName: '龚建',
		aliases: ['马甲哥', '甲鱼', '方丈', '田姐', '7 分钟 3800', '左手摸鸡', '总是没鸡', '剑神', '蛛丝马迹', '宇宙第一大刷子', '杠精', '舞王', '鹰眼'],
		platform: 'douyu',
		roomId: '52876',
		ownerMatch: ['zsmj', '龚建', '龚健'],
		membership: '正式成员',
		role: '一号位 Carry',
		achievement: '2009 SMM 世界总决赛冠军（「国服三大 C」之一）',
		champions: ['美杜莎', '幻影长矛手'],
		tag: '7 分钟 3800',
		description:
			'2009 SMM 对阵马来西亚 KS：运送圣者遗物的小鸟被吃了隐身符的兽王击杀，他在 7 分钟后再次买出圣者遗物并带队赢下比赛——让世界第一次见识到中国选手的打钱能力，「7 分钟 3800」由此而来。',
		jokes: ['7 分钟 3800', '专业念经直播间', '10 分钟 6700 烟花神'],
	},
	{
		id: 'hao',
		name: 'Hao',
		realName: '陈智豪',
		aliases: ['豪娘', '上将豪', '砍手豪', '核桃 Hao', '广州拖把王', '广州家政王', '平西王', '栗山 Hao', '逐日者', '伊人 Hao'],
		platform: 'douyu',
		roomId: '8445951',
		ownerMatch: ['hao', '陈智豪'],
		membership: '正式成员',
		role: '一号位 Carry',
		achievement: 'TI4 冠军（Newbee）；TI3、TI5 殿军',
		champions: ['矮人直升机', '幽鬼', '编织者'],
		tag: '上将豪 · TI4 冠军',
		description: '2018 年 11 月与 Mu、ZSMJ 一起加入，OB 由六人扩为九人。以激进的 Carry 风格著称。',
		jokes: ['「给我幽鬼，不赢砍手」', '被地狱火单杀', '「听说你叫潮汐是吧」', '核桃免费航班', '三万敌法一秒躺'],
	},
	{
		id: 'mu',
		name: 'Mu',
		realName: '张盼',
		aliases: ['大 Mu', '大 Mu 金仙', '东尼大木', '东尼', 'CDmu', 'Mu 神', '木木', '东腻'],
		platform: 'douyu',
		roomId: '1870001',
		ownerMatch: ['mu', '张盼'],
		membership: '正式成员',
		role: '二号位 中单 / SOLO',
		achievement: 'TI4 冠军（Newbee）；2011 DOTA2 最佳新人、2013 DOTA2 超级联赛冠军，2016 年 9 月退役',
		champions: ['帕克', '卡尔', '风暴之灵', '痛苦女王'],
		tag: '大 Mu 金仙',
		description: '世界顶尖 SOLO 位，打法凶狠飘逸。2018 年 11 月与 Hao、ZSMJ 一起加入 OB，与 Hao 合称「同福双子星」。',
		jokes: ['大 Mu 金仙（状态好时如大罗金仙）', '「法力无边，东尼大 Mu」', '与 Hao 合称「双子星」'],
	},
	{
		id: 'sansheng',
		name: 'SanSheng',
		realName: '王兆辉',
		aliases: ['狗哥', '狗妹', '烟头狗', '垃圾狗', '妇女之友'],
		platform: 'douyu',
		roomId: '312407',
		ownerMatch: ['sansheng', '王兆辉', '狗哥'],
		membership: '正式成员',
		role: '五号位 Support',
		achievement: 'TI4 冠军（Newbee）',
		champions: ['眼位型辅助'],
		tag: '第 10 位成员',
		description:
			'2019 年 5 月 1 日加入，是 OB 最近一位新成员，此后再无变动，OB 由此定型为十人。加入时斗鱼官方稿称其为「现 OB 战队新成员」。',
		jokes: ['「我的兄弟罩杯」（源自「我的兄弟兆辉」）', '捡烟头梗'],
	},
	{
		id: 'laochen',
		name: '陈彦川',
		realName: '陈彦川',
		aliases: ['老陈', '川神', '屠夫阿川', '老菜', '川菜', '田伯光', '狗川', '理财大师', '陈经理', '拆黑之王'],
		platform: 'douyu',
		roomId: '74960',
		ownerMatch: ['老陈', '陈彦川'],
		membership: '编外',
		role: '主播 / DOTA1 视频作者（非职业选手）',
		achievement: '无职业与 TI 荣誉',
		champions: ['帕吉'],
		tag: 'OB 前身「龙宝川」成员',
		description:
			'OB 的前身是「周宝龙」解说三人组（Zhou、龙弟弟、宝哥），而「周宝龙」的前身正是「龙宝川」——川就是屠夫阿川、老陈。他辈分最老，是这个圈子最早的一批人之一，多年来一直和 OB 一起活动、开黑。',
		jokes: ['华府双雄（与龙神）', '做菜（操作失误）', '战地记者', '理财大师', '下饭三幻神'],
	},
];

/** 构建期需要检查开播状态的房间。 */
export const OB_ROOMS = OB_MEMBERS.map((m) => ({
	key: `${m.platform}:${m.roomId}`,
	platform: m.platform,
	roomId: m.roomId,
	ownerMatch: m.ownerMatch,
	name: m.name,
}));
