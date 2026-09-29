// counter.mjs —— 可注入的扫描计数器。
//
// 「扫描」指在 getCookies / getVisibleCookies 里**检查一个已存 cookie 条目**：
//   entries += 1
//   bytes   += name.length + value.length + domain.length + path.length
//
// 计数器不依赖墙钟，纯整数累加，结果与容器迭代顺序无关。

export class ScanCounter {
  constructor() {
    this.entries = 0;
    this.bytes = 0;
  }

  /** 记录检查了一个条目（`bytes` 为该条目的键面长度）。 */
  add(bytes) {
    this.entries += 1;
    this.bytes += bytes;
  }

  reset() {
    this.entries = 0;
    this.bytes = 0;
  }
}