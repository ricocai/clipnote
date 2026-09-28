import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  utf8ByteLength,
  truncateToUtf8Bytes,
  isSafeRelativePath,
  normalizeLineEndings,
  toHex,
} from '../../common/src/main/ets/core/bytes';

test('utf8ByteLength 按 UTF-8 计字节而非字符数', () => {
  assert.equal(utf8ByteLength('abc'), 3);
  assert.equal(utf8ByteLength('中'), 3);
  assert.equal(utf8ByteLength('中文笔记'), 12);
  assert.equal(utf8ByteLength('é'), 2);
  assert.equal(utf8ByteLength('🙂'), 4);
});

test('utf8ByteLength 正确合并代理对（不把 emoji 算成 6 字节）', () => {
  const family = '👨‍👩‍👧';
  assert.equal(utf8ByteLength(family), 18);
});

test('truncateToUtf8Bytes 不超限时不改动原文', () => {
  const r = truncateToUtf8Bytes('中文abc', 100);
  assert.equal(r.truncated, false);
  assert.equal(r.text, '中文abc');
  assert.equal(r.byteLength, 9);
});

test('truncateToUtf8Bytes 落在码点边界，不切坏多字节字符', () => {
  // '中'=3B, 'a'=1B, '文'=3B → 上限 5 只应保留 '中a'
  const r = truncateToUtf8Bytes('中a文文', 5);
  assert.equal(r.text, '中a');
  assert.equal(r.truncated, true);
  assert.equal(r.byteLength, 4);
  assert.ok(utf8ByteLength(r.text) <= 5);
});

test('truncateToUtf8Bytes 不产出孤立代理项（不会切坏 emoji）', () => {
  const text = 'aaa🙂bbb';
  for (let max = 1; max <= 12; max++) {
    const r = truncateToUtf8Bytes(text, max);
    // 若产生孤立代理项，utf8ByteLength 会退回 3 字节/半对；这里直接检查是否可安全 JSON 序列化
    const roundTrip = JSON.parse(JSON.stringify(r.text));
    assert.equal(roundTrip, r.text, `max=${max}`);
    assert.ok(utf8ByteLength(r.text) <= max, `max=${max}`);
  }
});

test('normalizeLineEndings 只统一行尾，不动其它空白与表格边界', () => {
  assert.equal(normalizeLineEndings('a\r\nb\rc'), 'a\nb\nc');
  const table = '| a  b |  c |\r\n|---|---|\r\n| 1 |  2 |';
  const out = normalizeLineEndings(table);
  assert.ok(out.includes('| a  b |  c |'), '单元格内空白必须原样保留');
  assert.ok(!out.includes('\r'));
});

test('isSafeRelativePath 接受合法内容寻址路径', () => {
  assert.equal(isSafeRelativePath('blobs/ab/cd/abcdef'), true);
  assert.equal(isSafeRelativePath('notes/a.md'), true);
  assert.equal(isSafeRelativePath('a'), true);
});

test('isSafeRelativePath 拒绝越界与协议路径', () => {
  const bad = [
    '../etc/passwd',
    'a/../../b',
    '/etc/passwd',
    '\\windows\\system32',
    'file:///etc/passwd',
    'http://evil.com/x',
    'a//b',
    './a',
    'a/%2e%2e/b',
    'a/%2E%2E/b',
    'a/%252e%252e/b',
    'a/%25252e%25252e/b',
    'a\u0000b',
    'C:/Windows',
    '',
  ];
  for (const p of bad) {
    assert.equal(isSafeRelativePath(p), false, `应拒绝: ${p}`);
  }
});

test('toHex 输出小写定宽十六进制', () => {
  assert.equal(toHex(new Uint8Array([0, 15, 255])), '000fff');
});
