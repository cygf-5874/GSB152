cookiejar 是 Node.js 22 的 Cookie jar 库，仅使用 `node:` 内置模块。README 有 9 条对外契约，`src/counter.mjs` 是固定的扫描计数入口。

任务：在不改变 domain、path、expiry、SameSite 等语义的前提下重构存储与查询，使结果不变且固定扫描预算达标。

验收：
- node --test 退出码 0；
- bash scripts/check.sh 退出码 0，9 个场景全过（equivalence 3 + cost 2 + expiry 2 + domain 2）。

约束：
1. 不改 `check/`、`counter.mjs`、`publicsuffix.mjs` 的字段与语义；公开签名不变。
2. 时间只来自注入 clock；输出顺序和结果不得依赖 Map 迭代顺序。
3. 不得通过缓存特定 URL、跳过安全检查或减少匹配范围来满足预算。
