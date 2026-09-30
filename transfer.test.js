import test from 'node:test';
import assert from 'node:assert/strict';
import { quarkShareInput } from './transfer.js';

test('accepts only a Quark share URL and passes a valid extraction code', () => {
  assert.equal(quarkShareInput('https://pan.quark.cn/s/Ab12cd'), 'https://pan.quark.cn/s/Ab12cd');
  assert.equal(quarkShareInput('https://pan.quark.cn/s/Ab12cd?pwd=1234'), 'https://pan.quark.cn/s/Ab12cd 提取码：1234');
  assert.equal(quarkShareInput('https://pan.quark.cn/s/Ab12cd', '5678'), 'https://pan.quark.cn/s/Ab12cd 提取码：5678');
  assert.equal(quarkShareInput('https://pan.quark.cn.evil.test/s/Ab12cd'), null);
  assert.equal(quarkShareInput('http://pan.quark.cn/s/Ab12cd'), null);
  assert.equal(quarkShareInput('https://pan.quark.cn/s/Ab12cd/extra'), null);
  assert.equal(quarkShareInput('https://pan.quark.cn/s/Ab12cd', 'a b'), null);
});
