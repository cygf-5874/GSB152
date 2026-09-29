// cookiejar.mjs —— HTTP cookie jar（RFC 6265 子集）。
//
// 语义见 README「对外契约」一节。当前实现把 cookie 存在一张 Map 里，
// 每次 getCookies / getVisibleCookies 都遍历整张表。
//
// 时钟由构造参数注入（`clock` 返回 epoch 毫秒），不读墙钟。

import { isIP } from 'node:net';

import { ScanCounter } from './counter.mjs';
import { isPublicSuffix } from './publicsuffix.mjs';

/** 默认时钟：固定返回 0（不读墙钟）。 */
const ZERO_CLOCK = () => 0;

const SEP = '\u0000';

function keyOf(cookie) {
  return cookie.name + SEP + cookie.domain + SEP + cookie.path;
}

function entryBytes(cookie) {
  return cookie.name.length + cookie.value.length + cookie.domain.length + cookie.path.length;
}

function domainMatch(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

function pathMatch(requestPath, cookiePath) {
  if (cookiePath === requestPath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith('/')) return true;
  return requestPath[cookiePath.length] === '/';
}

function defaultPathFor(pathname) {
  if (!pathname || pathname[0] !== '/') return '/';
  const last = pathname.lastIndexOf('/');
  if (last === 0) return '/';
  return pathname.slice(0, last);
}

/** RFC 6265 §5.4：路径长者在前，同长按创建时间升序。 */
function compareCookies(a, b) {
  if (a.path.length !== b.path.length) return b.path.length - a.path.length;
  return a.creation - b.creation;
}

/**
 * 解析一条 Set-Cookie。
 *
 * @returns {null | {
 *   name: string, value: string, domain: string, path: string, hostOnly: boolean,
 *   secure: boolean, httpOnly: boolean, sameSite: string | null, expiresAt: number | null
 * }}
 */
function parseSetCookie(raw, ctx) {
  if (typeof raw !== 'string') return null;

  const parts = raw.split(';');
  const first = parts[0];
  const eq = first.indexOf('=');
  if (eq <= 0) return null;

  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (name === '') return null;

  let domainAttr = null;
  let path = null;
  let maxAge = null;
  let expires = null;
  let secure = false;
  let httpOnly = false;
  let sameSite = null;

  for (let i = 1; i < parts.length; i += 1) {
    const segment = parts[i];
    const idx = segment.indexOf('=');
    const attr = (idx >= 0 ? segment.slice(0, idx) : segment).trim().toLowerCase();
    const val = idx >= 0 ? segment.slice(idx + 1).trim() : '';

    if (attr === 'domain') {
      if (val !== '') domainAttr = val;
    } else if (attr === 'path') {
      if (val.startsWith('/')) path = val;
    } else if (attr === 'max-age') {
      const n = Number.parseInt(val, 10);
      if (Number.isFinite(n)) maxAge = n;
    } else if (attr === 'expires') {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) expires = t;
    } else if (attr === 'secure') {
      secure = true;
    } else if (attr === 'httponly') {
      httpOnly = true;
    } else if (attr === 'samesite') {
      const s = val.toLowerCase();
      if (s === 'strict' || s === 'lax' || s === 'none') sameSite = s;
    }
  }

  let domain;
  let hostOnly;
  if (domainAttr !== null) {
    const d = domainAttr.replace(/^\./, '').toLowerCase();
    if (isIP(ctx.host) !== 0) return null; // IP 主机不做域后缀匹配
    if (!domainMatch(ctx.host, d)) return null;
    if (isPublicSuffix(d)) return null;
    domain = d;
    hostOnly = false;
  } else {
    domain = ctx.host;
    hostOnly = true;
  }

  if (sameSite === 'none' && !secure) return null;

  let expiresAt = null;
  if (maxAge !== null) {
    expiresAt = maxAge <= 0 ? ctx.now : ctx.now + maxAge * 1000;
  } else if (expires !== null) {
    expiresAt = expires;
  }

  return {
    name,
    value,
    domain,
    path: path === null ? ctx.defaultPath : path,
    hostOnly,
    secure,
    httpOnly,
    sameSite,
    expiresAt,
    creation: 0,
  };
}

export class CookieJar {
  #store;
  #counter;
  #clock;
  #seq;

  /**
   * @param {{ counter?: ScanCounter, clock?: () => number }} [options]
   */
  constructor(options = {}) {
    this.#store = new Map();
    this.#counter = options.counter ?? new ScanCounter();
    this.#clock = options.clock ?? ZERO_CLOCK;
    this.#seq = 0;
  }

  get counter() {
    return this.#counter;
  }

  /**
   * 写入一批 Set-Cookie。
   *
   * @param {string} url
   * @param {string | string[]} cookies
   * @returns {this}
   */
  setCookies(url, cookies) {
    const parsed = new URL(url);
    const ctx = {
      host: parsed.hostname.toLowerCase(),
      protocol: parsed.protocol,
      defaultPath: defaultPathFor(parsed.pathname),
      now: this.#clock(),
    };

    const list = Array.isArray(cookies) ? cookies : [cookies];
    for (const raw of list) {
      const cookie = parseSetCookie(raw, ctx);
      if (cookie === null) continue;

      const key = keyOf(cookie);
      if (cookie.expiresAt !== null && cookie.expiresAt <= ctx.now) {
        this.#store.delete(key);
        continue;
      }

      const previous = this.#store.get(key);
      if (previous !== undefined) {
        cookie.creation = previous.creation;
      } else {
        this.#seq += 1;
        cookie.creation = this.#seq;
      }
      this.#store.set(key, cookie);
    }
    return this;
  }

  /**
   * 请求视角：返回 Cookie 头（含 HttpOnly 的 cookie）。
   *
   * @param {string} url
   * @param {{ crossSite?: boolean }} [options]
   * @returns {string}
   */
  getCookies(url, options = {}) {
    return this.#collect(url, options)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  /**
   * 脚本视角：返回可见 cookie（不含 HttpOnly）。
   *
   * @param {string} url
   * @param {{ crossSite?: boolean }} [options]
   * @returns {Array<{ name: string, value: string }>}
   */
  getVisibleCookies(url, options = {}) {
    return this.#collect(url, options)
      .filter((cookie) => !cookie.httpOnly)
      .map((cookie) => ({ name: cookie.name, value: cookie.value }));
  }

  clear() {
    this.#store.clear();
  }

  #collect(url, options) {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const protocol = parsed.protocol;
    const requestPath = parsed.pathname;
    const now = this.#clock();
    const crossSite = Boolean(options.crossSite);

    const out = [];
    for (const cookie of this.#store.values()) {
      this.#counter.add(entryBytes(cookie));

      if (cookie.expiresAt !== null && cookie.expiresAt <= now) continue;

      if (cookie.hostOnly) {
        if (host !== cookie.domain) continue;
      } else if (!domainMatch(host, cookie.domain)) {
        continue;
      }

      if (!pathMatch(requestPath, cookie.path)) continue;
      if (cookie.secure && protocol !== 'https:') continue;
      if (cookie.sameSite === 'strict' && crossSite) continue;

      out.push(cookie);
    }

    out.sort(compareCookies);
    return out;
  }
}