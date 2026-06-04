// src/utils/api.js
const BASE = '/api';

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Connections
  connect: (provider, creds) => request('POST', `/connect/${provider}`, creds),
  disconnect: (provider) => request('DELETE', `/connect/${provider}`),
  getConnections: () => request('GET', '/connections'),

  // Resources
  getResources: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return request('GET', `/resources${qs ? `?${qs}` : ''}`);
  },
  getProviderResources: (provider) => request('GET', `/resources/${provider}`),
  refreshResources: (provider) => request('POST', '/resources/refresh', provider ? { provider } : {}),

  // Stats
  getStats: () => request('GET', '/stats'),

  // Alerts
  getAlerts: () => request('GET', '/alerts'),
  acknowledgeAlert: (id) => request('POST', `/alerts/${id}/acknowledge`),
  acknowledgeAll: () => request('POST', '/alerts/acknowledge-all'),

  // Daily Reports
  getReportSchedule: (email) => request('GET', `/reports/schedule?email=${encodeURIComponent(email)}`),
  saveReportSchedule: (email, time) => request('POST', '/reports/schedule', { email, time }),
  deleteReportSchedule: (email) => request('DELETE', '/reports/schedule', { email }),
  sendReportNow: (email) => request('POST', '/reports/send-now', { email }),

  // S3 on-demand details (objects + policy)
  getS3Details: (bucket) => request('GET', `/aws/s3-details/${encodeURIComponent(bucket)}`),

  // Topology
  getTopology: () => request('GET', '/topology'),

  // Metrics
  getResourceMetrics: (id) => request('GET', `/metrics/resource/${encodeURIComponent(id)}`),
};
