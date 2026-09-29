// GSB152 cookiejar 固定验收程序（固定件）。**别改这个文件。**
//
// 用法：
//   node check/check.mjs                   跑全部场景
//   node check/check.mjs -list             列出全部场景
//   node check/check.mjs --only cost       只跑某一组（equivalence / cost / expiry / domain，可逗号分隔）
//
// 九组共 9 个场景：
//   equivalence 3 —— 域/路径匹配、同名覆盖与幂等、发送顺序；
//   cost        2 —— n=20000 / m=5000 工作负载下 entries 与 bytes 都低于上界；
//   expiry      2 —— Max-Age 过期与删除、注入时钟 + Max-Age 优先于 Expires；
//   domain      2 —— 公共后缀拒绝、IP 主机不接受 Domain。
//
// 输出：逐场景 `PASS <组>/<名>` 或 `FAIL <组>/<名>  期望=… 实际=…`，
// 结尾 `结果：通过 x/N`；全过 exit 0，否则 exit 1。失败不早退。
//
// 判据全程确定性：注入固定时钟、固定工作负载（无随机、不看墙钟），
// 结果不依赖 Map 迭代顺序。

import { CookieJar } from '../src/cookiejar.mjs';

const BOUND_ENTRIES = 5_000_000;
const BOUND_BYTES = 200_000_000;

const WORKLOAD_DOMAINS = 200;
const WORKLOAD_PER_DOMAIN = 100;
const WORKLOAD_QUERIES = 5000;

class AssertionFailure extends Error {
  constructor(expected, actual) {
    super('assertion failed');
    this.expected = expected;
    this.actual = actual;
  }
}

function show(value) {
  let text;
  try {
    text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > 300 ? text.slice(0, 300) + '…' : text;
}

function expectSame(expected, actual) {
  if (expected !== actual) throw new AssertionFailure(show(expected), show(actual));
}

function expectTrue(ok, expected, actual) {
  if (!ok) throw new AssertionFailure(expected, show(actual));
}

function expectArray(expected, actual) {
  const a = JSON.stringify(expected);
  const b = JSON.stringify(actual);
  if (a !== b) throw new AssertionFailure(a, b);
}

// ---------------------------------------------------------------------------
// 规模工作负载（只构造一次）
// ---------------------------------------------------------------------------

let workloadCache = null;

function measureWorkload() {
  if (workloadCache !== null) return workloadCache;

  const jar = new CookieJar({ clock: () => 0 });
  for (let d = 0; d < WORKLOAD_DOMAINS; d += 1) {
    const host = `site${d}.example.com`;
    const list = [];
    for (let k = 0; k < WORKLOAD_PER_DOMAIN; k += 1) {
      list.push(`n${k}=v${k}; Domain=${host}; Path=/`);
    }
    jar.setCookies(`https://${host}/`, list);
  }

  jar.counter.reset();
  for (let q = 0; q < WORKLOAD_QUERIES; q += 1) {
    const d = q % WORKLOAD_DOMAINS;
    jar.getCookies(`https://a.site${d}.example.com/`);
  }

  workloadCache = { entries: jar.counter.entries, bytes: jar.counter.bytes };
  return workloadCache;
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

const scenarios = [
  {
    group: 'equivalence',
    name: 'domain-path',
    run() {
      const jar = new CookieJar({ clock: () => 0 });
      jar.setCookies('https://www.example.com/a/b', [
        'sid=1; Domain=example.com; Path=/a',
        'theme=dark',
        'root=yes; Path=/',
      ]);

      expectSame('sid=1; theme=dark; root=yes', jar.getCookies('https://www.example.com/a/c'));
      expectSame('', jar.getCookies('https://www.other.com/a'));
      expectSame('root=yes', jar.getCookies('https://www.example.com/b'));
    },
  },
  {
    group: 'equivalence',
    name: 'overwrite-idempotent',
    run() {
      const jar = new CookieJar({ clock: () => 0 });
      jar.setCookies('https://example.com/', ['a=1; Path=/']);
      jar.setCookies('https://example.com/', ['a=2; Path=/']);
      jar.setCookies('https://example.com/', ['a=2; Path=/']);

      expectSame('a=2', jar.getCookies('https://example.com/'));
      expectArray([{ name: 'a', value: '2' }], jar.getVisibleCookies('https://example.com/'));
    },
  },
  {
    group: 'equivalence',
    name: 'send-order',
    run() {
      const jar = new CookieJar({ clock: () => 0 });
      jar.setCookies('https://example.com/a/b/c', [
        'x=1; Path=/a',
        'y=2; Path=/a/b',
        'z=3; Path=/',
      ]);

      expectSame('y=2; x=1; z=3', jar.getCookies('https://example.com/a/b/c'));
    },
  },
  {
    group: 'cost',
    name: 'entries',
    run() {
      const { entries } = measureWorkload();
      expectTrue(
        entries < BOUND_ENTRIES,
        `条目扫描计数 < ${BOUND_ENTRIES}`,
        `${entries}（n=${WORKLOAD_DOMAINS * WORKLOAD_PER_DOMAIN}、m=${WORKLOAD_QUERIES}）`
      );
    },
  },
  {
    group: 'cost',
    name: 'bytes',
    run() {
      const { bytes } = measureWorkload();
      expectTrue(
        bytes < BOUND_BYTES,
        `字节扫描计数 < ${BOUND_BYTES}`,
        `${bytes}（n=${WORKLOAD_DOMAINS * WORKLOAD_PER_DOMAIN}、m=${WORKLOAD_QUERIES}）`
      );
    },
  },
  {
    group: 'expiry',
    name: 'max-age-delete',
    run() {
      let now = 0;
      const jar = new CookieJar({ clock: () => now });
      jar.setCookies('https://example.com/', ['a=1; Max-Age=100; Path=/']);

      expectSame('a=1', jar.getCookies('https://example.com/'));
      now = 99_999;
      expectSame('a=1', jar.getCookies('https://example.com/'));
      now = 100_000;
      expectSame('', jar.getCookies('https://example.com/'));

      now = 0;
      jar.setCookies('https://example.com/', ['b=1; Path=/']);
      expectSame('a=1; b=1', jar.getCookies('https://example.com/'));
      jar.setCookies('https://example.com/', ['b=x; Max-Age=0; Path=/']);
      expectSame('a=1', jar.getCookies('https://example.com/'));
    },
  },
  {
    group: 'expiry',
    name: 'injected-clock-precedence',
    run() {
      let now = 1_000_000_000_000;
      const jar = new CookieJar({ clock: () => now });

      // Max-Age 优先于 Expires：Expires 已过去，但 Max-Age 仍为正 → 不过期
      jar.setCookies('https://example.com/', [
        'a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=1000; Path=/',
      ]);
      expectSame('a=1', jar.getCookies('https://example.com/'));
      now += 2_000_000;
      expectSame('', jar.getCookies('https://example.com/'));

      // 只有 Expires，且已过期 → 立即不生效
      jar.setCookies('https://example.com/', ['b=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/']);
      expectSame('', jar.getCookies('https://example.com/'));
    },
  },
  {
    group: 'domain',
    name: 'public-suffix',
    run() {
      const jar = new CookieJar({ clock: () => 0 });
      jar.setCookies('https://foo.co.uk/', ['a=1; Domain=co.uk; Path=/', 'b=2; Domain=foo.co.uk; Path=/']);
      expectSame('b=2', jar.getCookies('https://foo.co.uk/'));

      jar.setCookies('https://example.com/', ['c=1; Domain=com; Path=/']);
      expectSame('', jar.getCookies('https://example.com/'));
    },
  },
  {
    group: 'domain',
    name: 'ip-no-suffix',
    run() {
      const jar = new CookieJar({ clock: () => 0 });
      jar.setCookies('https://192.168.0.1/', [
        'a=1; Domain=0.1; Path=/',
        'b=2; Domain=192.168.0.1; Path=/',
      ]);
      expectSame('', jar.getCookies('https://192.168.0.1/'));

      jar.setCookies('https://192.168.0.1/', ['c=3; Path=/']);
      expectSame('c=3', jar.getCookies('https://192.168.0.1/'));
    },
  },
];

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

let list = false;
let only = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '-list' || arg === '--list') {
    list = true;
  } else if (arg === '--only' || arg === '--group') {
    i += 1;
    if (i >= args.length) {
      process.stderr.write('--only 需要一个组名（equivalence / cost / expiry / domain）\n');
      process.exit(2);
    }
    only = new Set(args[i].split(',').map((p) => p.trim()).filter((p) => p !== ''));
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write('用法: node check/check.mjs [-list] [--only <组名>]\n');
    process.exit(0);
  } else {
    process.stderr.write(`未知参数: ${arg}\n`);
    process.exit(2);
  }
}

if (list) {
  for (const scenario of scenarios) process.stdout.write(`${scenario.group}/${scenario.name}\n`);
  process.exit(0);
}

const groups = new Set(scenarios.map((scenario) => scenario.group));
if (only !== null) {
  for (const name of only) {
    if (!groups.has(name)) {
      process.stderr.write(`未知分组 ${name}（可选：${[...groups].join(' / ')}）\n`);
      process.exit(2);
    }
  }
}

let passed = 0;
let selected = 0;
for (const scenario of scenarios) {
  if (only !== null && !only.has(scenario.group)) continue;
  selected += 1;
  const label = `${scenario.group}/${scenario.name}`;
  try {
    scenario.run();
    passed += 1;
    process.stdout.write(`PASS ${label}\n`);
  } catch (error) {
    const expected = error instanceof AssertionFailure ? error.expected : '(未抛断言)';
    const actual = error instanceof AssertionFailure ? error.actual : error.message;
    process.stdout.write(`FAIL ${label}  期望=${expected} 实际=${actual}\n`);
  }
}

if (selected === 0) {
  process.stderr.write('没有匹配的场景\n');
  process.exit(2);
}

process.stdout.write(`结果：通过 ${passed}/${selected}\n`);
process.exit(passed === selected ? 0 : 1);