export function quarkShareInput(value, accessCode = '') {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'pan.quark.cn') return null;
  const match = /^\/s\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
  if (!match || url.username || url.password || url.port) return null;
  const code = String(accessCode || url.searchParams.get('pwd') || '').trim();
  if (code && !/^[A-Za-z0-9]{1,16}$/.test(code)) return null;
  const share = `https://pan.quark.cn/s/${match[1]}`;
  return code ? `${share} 提取码：${code}` : share;
}
