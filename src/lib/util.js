import crypto from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Deterministic JSON: object keys are sorted, undefined members are dropped.
 * Everything that is hashed or compared across processes goes through this.
 */
export function stableStringify(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return JSON.stringify(value);
  }
  if (type === 'bigint') return JSON.stringify(value.toString());
  if (type === 'undefined') return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  }
  if (type === 'object') {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return (
      '{' +
      keys
        .map((key) => JSON.stringify(key) + ':' + stableStringify(value[key]))
        .join(',') +
      '}'
    );
  }
  return 'null';
}

export function canonicalJson(value) {
  return stableStringify(value);
}

export function shortHash(hash, length = 12) {
  if (!hash) return null;
  return hash.slice(0, length);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomId(prefix = '') {
  const id = crypto.randomBytes(8).toString('hex');
  return prefix ? `${prefix}-${id}` : id;
}

export function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export class HttpError extends Error {
  constructor(statusCode, message, detail = undefined) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

export function httpError(statusCode, message, detail) {
  return new HttpError(statusCode, message, detail);
}

export async function readJsonBody(req, { limit = 2_000_000 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw httpError(413, 'request body too large');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      throw new Error('body must be a JSON object');
    }
    return parsed;
  } catch (err) {
    throw httpError(400, `invalid JSON body: ${err.message}`);
  }
}

export function sendJson(res, statusCode, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text);
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

export function parseJsonSafe(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function versionsEqual(a, b) {
  return stableStringify(a ?? {}) === stableStringify(b ?? {});
}

export function safeKeyToken(key) {
  return sha256(key).slice(0, 20);
}

export function sourceToken(kind, id) {
  return `${kind}:${id}`;
}
