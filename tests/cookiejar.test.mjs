// 既有用例 —— 数据量都很小，覆盖常规语义。当前全绿。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CookieJar } from '../src/cookiejar.mjs';

test('按域与路径匹配', () => {
  const jar = new CookieJar({ clock: () => 0 });
  jar.setCookies('https://www.example.com/a/b', ['sid=1; Domain=example.com; Path=/a']);

  assert.equal(jar.getCookies('https://www.example.com/a/c'), 'sid=1');
  assert.equal(jar.getCookies('https://other.example.com/a'), 'sid=1');
  assert.equal(jar.getCookies('https://www.example.com/b'), '');
});

test('同名同域同路径覆盖，不产生重复条目', () => {
  const jar = new CookieJar({ clock: () => 0 });
  jar.setCookies('https://example.com/', ['a=1; Path=/', 'a=2; Path=/']);

  assert.deepEqual(jar.getVisibleCookies('https://example.com/'), [{ name: 'a', value: '2' }]);
});

test('Secure 与 HttpOnly 的两个视角', () => {
  const jar = new CookieJar({ clock: () => 0 });
  jar.setCookies('https://example.com/', ['s=1; Secure; HttpOnly', 'o=2']);

  assert.equal(jar.getCookies('http://example.com/'), 'o=2');
  assert.deepEqual(jar.getVisibleCookies('https://example.com/'), [{ name: 'o', value: '2' }]);
});

test('过期判定走注入时钟', () => {
  let now = 0;
  const jar = new CookieJar({ clock: () => now });
  jar.setCookies('https://example.com/', ['a=1; Max-Age=10; Path=/']);

  assert.equal(jar.getCookies('https://example.com/'), 'a=1');
  now = 5_000;
  assert.equal(jar.getCookies('https://example.com/'), 'a=1');
  now = 20_000;
  assert.equal(jar.getCookies('https://example.com/'), '');
});

test('SameSite=Strict 在跨站请求里不发送', () => {
  const jar = new CookieJar({ clock: () => 0 });
  jar.setCookies('https://example.com/', ['a=1; SameSite=Strict; Path=/', 'b=2; SameSite=Lax; Path=/']);

  assert.equal(jar.getCookies('https://example.com/', { crossSite: true }), 'b=2');
  assert.equal(jar.getCookies('https://example.com/'), 'a=1; b=2');
});