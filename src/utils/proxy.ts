/**
 * Shared proxy helpers.
 *
 * Extracted from `src/server/app.ts` (proxy checker) so the Account Hub
 * warehouse can enforce the "missing/faulty proxy is the only hard block"
 * rule (Data Warehouse spec §5) against exactly the same normalisation the
 * dashboard proxy checker already uses. Single source of truth — do not
 * re-implement proxy parsing anywhere else.
 */

import net from 'node:net';
import type { AdsPowerProfileInfo, AdsPowerProxyConfig } from '../types/index.js';

/**
 * Chuẩn hóa chuỗi proxy về dạng "host:port" (lowercase) để so sánh nhất quán.
 * Hỗ trợ các format:
 *   - host:port
 *   - host:port:user:pass
 *   - socks5://host:port
 *   - http://host:port
 *   - socks5://user:pass@host:port
 */
export function normalizeProxyHost(raw: string): string {
  let s = raw.trim().toLowerCase();
  // Strip protocol prefix
  s = s.replace(/^(socks5|socks4|https?):\/\//, '');
  // Strip user:pass@ prefix (e.g. user:pass@host:port)
  const atIdx = s.indexOf('@');
  if (atIdx !== -1) {
    s = s.substring(atIdx + 1);
  }
  // Take only host:port (first two segments separated by ':')
  const parts = s.split(':');
  if (parts.length >= 2) {
    return `${parts[0]}:${parts[1]}`;
  }
  return s;
}

/** Proxy readiness of an AdsPower profile (spec §5 hard block). */
export type ProxyState = 'OK' | 'MISSING' | 'INVALID' | 'UNREACHABLE';

export interface ProxyEndpoint {
  host: string;
  port: number;
  type: string;
  /** Lowercased `host:port`, comparable with `normalizeProxyHost` output. */
  normalized: string;
}

export interface ProxyClassification {
  state: Exclude<ProxyState, 'UNREACHABLE'>;
  endpoint: ProxyEndpoint | null;
  detail: string;
}

/** AdsPower marks a profile as proxy-less with this `proxy_soft` value. */
export const NO_PROXY_SOFT = 'no_proxy';

/**
 * Read the proxy block of a profile regardless of which field name the API used.
 * `/api/v1/user/list` returns `user_proxy_config`; older callers read `proxy_config`.
 */
export function readProxyConfig(profile: Partial<AdsPowerProfileInfo>): AdsPowerProxyConfig {
  return profile.user_proxy_config ?? profile.proxy_config ?? {};
}

/**
 * Classify a proxy config without touching the network.
 *
 * MISSING — no proxy configured at all (`no_proxy`, or host/port absent).
 * INVALID — a proxy is declared but unusable (non-numeric/out-of-range port).
 * OK      — a syntactically usable endpoint; reachability is a separate probe.
 */
export function classifyProxyConfig(cfg: AdsPowerProxyConfig | null | undefined): ProxyClassification {
  const c = cfg ?? {};
  const soft = String(c.proxy_soft ?? '').trim().toLowerCase();
  const host = String(c.proxy_host ?? '').trim();
  const rawPort = String(c.proxy_port ?? '').trim();

  if (soft === NO_PROXY_SOFT || (!host && !rawPort)) {
    return { state: 'MISSING', endpoint: null, detail: 'Profile has no proxy configured' };
  }
  if (!host) {
    return { state: 'INVALID', endpoint: null, detail: 'Proxy port set without a host' };
  }
  if (!rawPort) {
    return { state: 'INVALID', endpoint: null, detail: 'Proxy host set without a port' };
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { state: 'INVALID', endpoint: null, detail: `Proxy port "${rawPort}" is not a valid TCP port` };
  }

  const type = String(c.proxy_type ?? '').trim().toLowerCase() || 'unknown';
  return {
    state: 'OK',
    endpoint: { host, port, type, normalized: `${host.toLowerCase()}:${port}` },
    detail: `${type}://${host}:${port}`,
  };
}

/**
 * TCP-connect probe: the concrete meaning of a "faulty" proxy (spec §5).
 * Resolves true when the endpoint accepts a connection within `timeoutMs`.
 * Never throws — a probe failure is a result, not an exception.
 */
export function probeProxyEndpoint(endpoint: ProxyEndpoint, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(endpoint.port, endpoint.host);
  });
}
