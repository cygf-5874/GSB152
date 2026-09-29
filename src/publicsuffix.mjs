// publicsuffix.mjs —— 公共后缀表（子集）。
//
// 一个 cookie 的 Domain 属性若恰好等于公共后缀（如 `co.uk`、`com`），必须被拒绝：
// 否则任何子域都能往整个注册域写 cookie。
// 这里只收录本题用到的子集；判据是「精确匹配」而不是后缀匹配。

export const PUBLIC_SUFFIXES = new Set([
  'com',
  'net',
  'org',
  'io',
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'co.jp',
  'co.nz',
  'com.au',
]);

/**
 * @param {string} domain 已小写、无前导点的域
 * @returns {boolean}
 */
export function isPublicSuffix(domain) {
  return PUBLIC_SUFFIXES.has(domain);
}