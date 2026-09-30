export function baiduShareInput(value, accessCode = '') {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'pan.baidu.com' || url.port || url.username || url.password) return null;
  const match = /^\/s\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  const oldSurl = url.pathname === '/share/init' ? url.searchParams.get('surl') : '';
  if (!match && (!oldSurl || !/^[A-Za-z0-9_-]+$/.test(oldSurl))) return null;
  const code = String(accessCode || url.searchParams.get('pwd') || '').trim();
  if (code && !/^[A-Za-z0-9]{4}$/.test(code)) return null;
  return { url: `https://pan.baidu.com/s/${match ? match[1] : `1${oldSurl}`}`, code };
}

export function baiduTransferResult(data) {
  if (!data || typeof data !== 'object') return { kind: 'error' };
  const body = data.data && typeof data.data === 'object' ? data.data : data;
  if (body.status === 'submitted') {
    return {
      kind: 'submitted',
      taskId: String(body.task_id || body.taskid || ''),
      folder: String(body.saved_path || body.remote_path || '/apps/bdpan/AI漫剧/'),
    };
  }
  if (Array.isArray(body.files) && body.files.length > 0) {
    return {
      kind: 'saved',
      files: body.files.map((file) => ({
        name: String(file.name || file.server_filename || ''),
        path: String(file.saved_path || file.path || file.remote_path || ''),
        returnUrl: safeReturnUrl(file.return_url),
      })),
    };
  }
  return { kind: 'error' };
}

function safeReturnUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'pan.baidu.com' ? url.href : '';
  } catch { return ''; }
}
