import test from 'node:test';
import assert from 'node:assert/strict';
import { baiduShareInput, baiduTransferResult } from './baidu.js';

test('百度分享只允许官方域名并规范化提取码', () => {
  assert.deepEqual(baiduShareInput('http://pan.baidu.com/s/1Ab_c?pwd=abcd'), {
    url: 'https://pan.baidu.com/s/1Ab_c', code: 'abcd',
  });
  assert.equal(baiduShareInput('https://pan.baidu.com.evil.test/s/1Ab_c'), null);
  assert.equal(baiduShareInput('https://pan.baidu.com/s/1Ab_c', 'bad code'), null);
});

test('已提交的百度任务不会误判为转存成功', () => {
  assert.deepEqual(baiduTransferResult({ status: 'submitted', task_id: '123', saved_path: '/apps/bdpan/AI漫剧/' }), {
    kind: 'submitted', taskId: '123', folder: '/apps/bdpan/AI漫剧/',
  });
  assert.deepEqual(baiduTransferResult({ files: [{ name: '第1集.mp4', saved_path: '我的应用数据/bdpan/AI漫剧/第1集.mp4' }] }), {
    kind: 'saved', files: [{ name: '第1集.mp4', path: '我的应用数据/bdpan/AI漫剧/第1集.mp4', returnUrl: '' }],
  });
});
