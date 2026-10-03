/**
 * Registry provider — điểm truy cập DUY NHẤT để lấy backend profile.
 *
 * `getProvider()` không tham số => AdsPower (giữ nguyên hành vi cũ 100%).
 */

import { adsPowerProvider } from './adspower-provider.js';
import { taothaoProvider } from './taothao-provider.js';
import { BrowserProfileProvider, BrowserProviderId, DEFAULT_BROWSER_PROVIDER } from './types.js';

const PROVIDERS: Record<BrowserProviderId, BrowserProfileProvider> = {
  adspower: adsPowerProvider,
  taothao: taothaoProvider,
};

export function getProvider(id: BrowserProviderId = DEFAULT_BROWSER_PROVIDER): BrowserProfileProvider {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new Error(`Browser provider không hợp lệ: "${id}". Chỉ hỗ trợ: adspower, taothao.`);
  }
  return provider;
}

export function listProviders(): Array<{ id: BrowserProviderId; label: string; providesCredentials: boolean }> {
  return Object.values(PROVIDERS).map(p => ({
    id: p.id,
    label: p.label,
    providesCredentials: p.providesCredentials,
  }));
}

export * from './types.js';
export { adsPowerProvider, AdsPowerProvider } from './adspower-provider.js';
export { taothaoProvider, TaothaoProvider } from './taothao-provider.js';
