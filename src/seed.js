import { canonicalJson } from './lib/util.js';

const NAMES = [
  '北风物流', '恒星软件', '青禾零售', '远山制造', '潮汐媒体', '白鹭医疗',
  '晨光能源', '深蓝金融', '橙子教育', '云杉咨询', '琥珀餐饮', '极光游戏',
  '磐石建筑', '溪流出版', '长风航空', '灯塔保险', '麦田农业', '弦月音乐',
  '岩羊体育', '苏打饮料', '银河电信', '松果家居', '飞鱼旅行', '珊瑚珠宝',
];

const REGIONS = ['emea', 'apac', 'amer'];
const STATUSES = ['active', 'active', 'active', 'paused', 'archived'];
const CATEGORIES = ['subscription', 'subscription', 'services', 'hardware'];

/**
 * Deterministic pseudo-random generator so two empty-directory runs produce
 * identical seeds and therefore identical digests. Useful when comparing
 * proofs across machines.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildSeedRecords({ count = 24, seed = 20261117 } = {}) {
  const rand = mulberry32(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const records = [];
  for (let i = 0; i < count; i += 1) {
    const name = `${NAMES[i % NAMES.length]}${i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : ''}`;
    records.push({
      name,
      region: pick(REGIONS),
      status: pick(STATUSES),
      category: pick(CATEGORIES),
      amountCents: Math.round((5_000 + rand() * 995_000) / 100) * 100,
      notes: canonicalJson({ seeded: true, index: i }),
    });
  }
  return records;
}

export const SEED_SPECS = [
  {
    name: '按区域汇总活跃收入',
    description: '各区域收入合计与记录数，只统计活跃与暂停的记录',
    config: {
      groupBy: ['region'],
      filters: [{ field: 'status', values: ['active', 'paused'] }],
      measures: [{ id: 'count' }, { id: 'sum_amount' }],
    },
  },
  {
    name: '区域 × 品类 平均客单价',
    description: '双维度交叉的平均金额，用于查看品类结构性差异',
    config: {
      groupBy: ['region', 'category'],
      filters: [],
      measures: [{ id: 'count' }, { id: 'avg_amount' }],
    },
  },
  {
    name: '订阅类金额区间',
    description: '只看订阅品类，观察金额的最小值与最大值',
    config: {
      groupBy: ['status'],
      filters: [{ field: 'category', values: ['subscription'] }],
      measures: [{ id: 'count' }, { id: 'min_amount' }, { id: 'max_amount' }],
    },
  },
];
