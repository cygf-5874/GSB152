# cookiejar —— HTTP cookie jar（RFC 6265 子集）

`src/cookiejar.mjs` 实现一个 cookie jar：接收 `Set-Cookie`、按请求 URL 算出该发回的
`Cookie` 头。它只用 `node:` 内置模块，没有任何第三方依赖。

```js
import { CookieJar } from './src/cookiejar.mjs';

const jar = new CookieJar({ clock: () => Date.now() });
jar.setCookies('https://www.example.com/a/b', ['sid=1; Domain=example.com; Path=/a']);
jar.getCookies('https://www.example.com/a/c');   // => "sid=1"
```

## 本次重构的目标

现在每次 `getCookies` / `getVisibleCookies` 都把整张表从头扫一遍：数据量一大，
一次请求的代价随整罐 cookie 数量线性增长。要在**不改变任何语义**的前提下，
把查询代价降下来（按 domain 后缀建索引），让规模判据达标。语义细节见下面「对外契约」。

## 对外契约（9 条）

1. **语义不回归**：`setCookies(url, list)` / `getCookies(url, options)` / `getVisibleCookies(url, options)`
   的行为必须与「全表扫描版」逐条一致，含域匹配、路径匹配、`Secure` / `HttpOnly` / `SameSite`、
   `Max-Age` / `Expires` 过期、同名覆盖。
2. **可注入的扫描计数**：判定用 `ScanCounter`（见 `src/counter.mjs`），由构造参数注入。
   在 `getCookies` / `getVisibleCookies` 里**每检查一个已存 cookie 条目**就记一次：
   `entries += 1`、`bytes += name.length + value.length + domain.length + path.length`。
   `setCookies` 不计入。计数器语义与容器迭代顺序无关。
3. **规模判据**：`n = 20000` 个 cookie、`m = 5000` 次查询的工作负载下（构造方式见
   `check/`），`counter.entries < 5000000` 且 `counter.bytes < 200000000`。
   朴素的全表扫描版约为 `n × m`，会明显超出。
4. **注入时钟**：过期判定只使用构造时注入的 `clock()`（返回 epoch 毫秒），**不得读 `Date.now()`**。
5. **确定性**：结果与内部 `Map` 的迭代顺序无关；同一输入多次调用结果相同。
6. **等价**：索引化之后，任意输入下的结果与全表扫描版逐条等价（顺序也一致）。
7. **边界**：`Domain` 等于**公共后缀**（`co.uk`、`com` 这类，取自 `src/publicsuffix.mjs`）时
   拒绝该 cookie；请求主机是 **IP 地址**时，带 `Domain` 属性的 cookie 一律拒绝。
8. **删除**：`Max-Age=0`（或 `Max-Age` 为负、`Expires` 已过期）表示删除同名同域同路径的现有 cookie。
9. **幂等**：重复 `setCookies` 同一个 cookie 只保留一个条目，值以最后一次为准。

## 语义细则

- **域匹配**：`Domain` 缺省时为 host-only，只有请求主机**等于**该域才匹配；带 `Domain` 时
  前缀点全部忽略、转小写，请求主机等于该域、或以 `.<域>` 结尾才匹配。
- **路径匹配**：`cookiePath === requestPath`，或 `requestPath` 以 `cookiePath` 开头且
  `cookiePath` 以 `/` 结尾、或下一个字符是 `/`。
- **默认路径**：请求路径没有 `/` 或首字符不是 `/` → `/`；否则取到最后一个 `/`（不含）为止，
  若只有开头的 `/` 则取 `/`。
- **发送顺序**（RFC 6265 §5.4）：路径长者在前；路径长度相同按**创建时间**升序。
- **`Secure`**：仅当请求协议为 `https:` 时发送。
- **`HttpOnly`**：`getCookies` 会带上；`getVisibleCookies` 把它排除。
- **`SameSite`**：`Strict` 在 `options.crossSite === true` 时不发送；`Lax` 始终发送；
  `None` 必须同时带 `Secure`，否则该 cookie 被忽略。`crossSite` 缺省为 `false`。
- **`Max-Age` 优先于 `Expires`**；两者都缺省时是会话 cookie（不过期）。
- 没有任何 cookie 匹配时，`getCookies` 返回空串，`getVisibleCookies` 返回 `[]`。

## 怎么跑

```bash
node --test                      # 既有用例（数据量小，当前全绿）
bash scripts/check.sh            # 固定验收程序；加 -list / --only <组> 可过滤场景
```

`check/` 是固定验收程序，**不要修改**。

## 目录

```
src/cookiejar.mjs       CookieJar 主体（解析、存储、查询）
src/counter.mjs         ScanCounter（可注入扫描计数器）
src/publicsuffix.mjs    公共后缀子集
tests/cookiejar.test.mjs 既有用例（小数据量，当前全绿）
check/check.mjs         固定验收程序（equivalence 3 + cost 2 + expiry 2 + domain 2）
scripts/check.sh        自检入口
```

## 环境

Node.js 22（ESM）。`package.json` 里没有 `dependencies`，也不应该有；只用 `node:` 内置模块。