export const DIMENSIONS = Object.freeze({
  region: {
    label: '区域',
    values: [
      { value: 'emea', label: '欧洲、中东与非洲' },
      { value: 'apac', label: '亚太' },
      { value: 'amer', label: '美洲' },
    ],
  },
  status: {
    label: '状态',
    values: [
      { value: 'active', label: '活跃' },
      { value: 'paused', label: '暂停' },
      { value: 'archived', label: '归档' },
    ],
  },
  category: {
    label: '品类',
    values: [
      { value: 'subscription', label: '订阅' },
      { value: 'services', label: '服务' },
      { value: 'hardware', label: '硬件' },
    ],
  },
});

export const GROUP_FIELDS = Object.freeze(Object.keys(DIMENSIONS));

export const MEASURES = Object.freeze({
  count: { label: '记录数', op: 'count' },
  sum_amount: { label: '金额合计', op: 'sum', field: 'amountCents' },
  avg_amount: { label: '平均金额', op: 'avg', field: 'amountCents' },
  min_amount: { label: '最小金额', op: 'min', field: 'amountCents' },
  max_amount: { label: '最大金额', op: 'max', field: 'amountCents' },
});

export const MEASURE_IDS = Object.freeze(Object.keys(MEASURES));

export function dimensionValues(field) {
  return DIMENSIONS[field]?.values ?? [];
}

export function isValidDimension(field) {
  return Object.prototype.hasOwnProperty.call(DIMENSIONS, field);
}

export function isValidValue(field, value) {
  if (!isValidDimension(field)) return false;
  return dimensionValues(field).some((item) => item.value === value);
}

export function labelFor(field, value) {
  return dimensionValues(field).find((item) => item.value === value)?.label ?? value;
}

export function dimensionCatalog() {
  return Object.entries(DIMENSIONS).map(([id, dim]) => ({
    id,
    label: dim.label,
    values: dim.values,
  }));
}

export function measureCatalog() {
  return Object.entries(MEASURES).map(([id, measure]) => ({ id, label: measure.label }));
}
