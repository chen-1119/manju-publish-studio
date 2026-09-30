import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const providers = {
  brave: { field: 'braveApiKey', env: 'BRAVE_SEARCH_API_KEY', name: 'Brave Search' },
  qiniu: { field: 'qiniuApiKey', env: 'QINIU_AI_API_KEY', name: '七牛云 AI' },
};

export class SearchConfigError extends Error {}

export class SearchConfig {
  constructor(file, environment = process.env) {
    this.file = file;
    this.environment = environment;
    this.saved = {};
    this.saving = Promise.resolve();
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      for (const { field } of Object.values(providers)) {
        if (typeof data?.[field] === 'string') this.saved[field] = data[field];
      }
    } catch { /* First run may have no local configuration. */ }
  }

  key(provider) {
    if (!Object.hasOwn(providers, provider)) throw new SearchConfigError('未知搜索 API');
    const entry = providers[provider];
    return this.environment[entry.env] || this.saved[entry.field] || '';
  }

  status() {
    const states = Object.fromEntries(Object.entries(providers).map(([provider, entry]) => [provider, {
      configured: Boolean(this.key(provider)),
      locallyConfigured: Boolean(this.saved[entry.field]),
      fromEnvironment: Boolean(this.environment[entry.env]),
    }]));
    return { configured: Object.values(states).some((state) => state.configured), providers: states };
  }

  async update(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SearchConfigError('搜索设置格式有误');
    const provider = body.provider || 'brave';
    if (!Object.hasOwn(providers, provider)) throw new SearchConfigError('未知搜索 API');
    const entry = providers[provider];
    const key = body.clear === true ? '' : String(body.apiKey ?? body[entry.field] ?? '').trim();
    if (body.clear !== true && (key.length < 12 || key.length > 300 || /\s/.test(key))) {
      throw new SearchConfigError(`请输入有效的 ${entry.name} API 密钥`);
    }
    const action = this.saving.catch(() => {}).then(async () => {
      const next = { ...this.saved, [entry.field]: key };
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(`${this.file}.tmp`, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
        await fs.rename(`${this.file}.tmp`, this.file);
      } catch { throw new SearchConfigError('设置未能保存，请检查本机配置目录是否可写'); }
      this.saved = next;
      return this.status();
    });
    this.saving = action;
    return action;
  }
}
