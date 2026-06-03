import React, { useState, useMemo } from 'react';
import { PROVIDER_META, fmt, STATUS_COLORS } from '../utils/theme';
import ServiceLogo from './ServiceLogo';

const COLUMNS = [
  { key: 'name',    label: 'Service Name',   sortable: true  },
  { key: 'type',    label: 'Type',           sortable: true  },
  { key: 'region',  label: 'Region/Zone',    sortable: true  },
  { key: 'status',  label: 'Status',         sortable: true  },
  { key: 'cpu',     label: 'CPU',            sortable: true  },
  { key: 'memory',  label: 'Memory',         sortable: false },
  { key: 'spec',    label: 'Specification',  sortable: false },
  { key: 'cost',    label: 'Cost/mo',        sortable: true  },
  { key: 'uptime',  label: 'Uptime',         sortable: false },
  { key: 'health',  label: 'Health',         sortable: true  },
];

function getUsageColor(val) {
  if (val >= 85) return '#ef4444';
  if (val >= 70) return '#eab308';
  return '#22c55e';
}

function ServiceRow({ s, provider, onClick }) {
  const meta = PROVIDER_META[provider];
  const cost = s.cost || s.costMonth || 0;

  // Build spec string
  let spec = '';
  if (s.instanceType || s.size || s.machineType) spec = s.instanceType || s.size || s.machineType;
  else if (s.vcpu) spec = `${s.vcpu} vCPU`;
  else if (s.tier) spec = s.tier;
  else if (s.plan) spec = s.plan;
  else if (s.storageClass) spec = s.storageClass;
  else if (s.engine) spec = s.engine;

  // Memory display
  let memDisplay = '';
  if (s.memUsage !== undefined && s.memory) memDisplay = `${s.memUsage}%`;
  else if (s.memory) memDisplay = s.memory;

  const zone = s.az || s.zone || '';

  return (
    <tr onClick={() => onClick(s)}>
      <td>
        <div className="svc-name-cell">
          <ServiceLogo type={s.type} family={s.family} size={32} />
          <div>
            <div className="svc-name" title={s.name}>{s.name.length > 28 ? s.name.substring(0, 28) + '…' : s.name}</div>
            <div className="svc-type">{s.family}</div>
          </div>
        </div>
      </td>
      <td style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{s.type}</td>
      <td>
        <span className="region-badge">{s.region}{zone ? ` · ${zone}` : ''}</span>
      </td>
      <td>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span className={`badge badge-${(s.health === 'healthy' || ['running','available','active','RUNNING','RUNNABLE'].includes(s.status)) ? 'active' : ['stopped','terminated','deallocated','shutting-down'].includes((s.status||'').toLowerCase()) ? 'critical' : s.health === 'warning' ? 'warning' : 'critical'}`}>
            {['running','RUNNING'].includes(s.status) ? '▶ Running'
              : ['stopped','STOPPED'].includes(s.status) ? '⏹ Stopped'
              : ['terminated','shutting-down'].includes(s.status) ? '✕ Terminated'
              : ['deallocated'].includes((s.status||'').toLowerCase()) ? '⏹ Deallocated'
              : ['available','RUNNABLE','Online','Succeeded'].includes(s.status) ? '● Active'
              : s.status || 'Unknown'}
          </span>
          {(s.isPrivate || s.networkAccess === 'private') && (
            <span style={{ fontSize: 10, color: '#9ca3af', background: 'rgba(156,163,175,0.12)', borderRadius: 4, padding: '1px 5px', display: 'inline-block' }}>private</span>
          )}
        </div>
      </td>
      <td>
        {s.cpu !== undefined ? (
          <div className="usage-bar-cell">
            <div className="usage-bar-bg">
              <div className="usage-bar-fill" style={{ width: `${s.cpu}%`, background: getUsageColor(s.cpu) }} />
            </div>
            <span className="usage-val" style={{ color: getUsageColor(s.cpu) }}>{s.cpu}%</span>
          </div>
        ) : <span style={{ color: 'var(--text3)', fontSize: 11 }}>N/A</span>}
      </td>
      <td>
        {s.memUsage !== undefined ? (
          <div className="usage-bar-cell">
            <div className="usage-bar-bg">
              <div className="usage-bar-fill" style={{ width: `${s.memUsage}%`, background: getUsageColor(s.memUsage) }} />
            </div>
            <span className="usage-val" style={{ color: getUsageColor(s.memUsage) }}>{s.memUsage}%</span>
          </div>
        ) : memDisplay ? <span style={{ fontSize: 12, color: 'var(--text2)' }}>{memDisplay}</span>
          : <span style={{ color: 'var(--text3)', fontSize: 11 }}>N/A</span>}
      </td>
      <td style={{ fontSize: 11, color: 'var(--text2)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={spec}>{spec || '—'}</td>
      <td className="cost-cell" style={{ color: meta.color }}>{fmt.usd2(cost)}</td>
      <td style={{ fontSize: 11, color: 'var(--text3)' }}>{s.uptime || '—'}</td>
      <td>
        <span className={`badge badge-${s.health}`}>
          {s.health === 'healthy' ? '✓ Healthy' : s.health === 'warning' ? '⚠ Warning' : s.health === 'critical' ? '✗ Critical' : s.health || '—'}
        </span>
      </td>
    </tr>
  );
}

export default function ServiceDetailTable({ services, provider, onRowClick, showStatusFilter = false }) {
  const meta = PROVIDER_META[provider];
  const [sortKey, setSortKey] = useState('cost');
  const [sortDir, setSortDir] = useState('desc');
  const [regionFilter, setRegionFilter] = useState('all');
  const [familyFilter, setFamilyFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const regions = useMemo(() => ['all', ...new Set(services.map(s => s.region))], [services]);
  const families = useMemo(() => ['all', ...new Set(services.map(s => s.family))], [services]);

  function handleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  const filtered = useMemo(() => {
    let list = [...services];
    if (regionFilter !== 'all') list = list.filter(s => s.region === regionFilter);
    if (familyFilter !== 'all') list = list.filter(s => s.family === familyFilter);
    if (showStatusFilter) {
      if (statusFilter === 'private') list = list.filter(s => s.isPrivate || s.networkAccess === 'private');
      else if (statusFilter === 'stopped') list = list.filter(s => ['stopped','terminated','deallocated','shutting-down','stopping'].includes((s.status||'').toLowerCase()));
    }
    list.sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey];
      if (sortKey === 'cost') { va = a.cost || a.costMonth || 0; vb = b.cost || b.costMonth || 0; }
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb||'') : (vb||'').localeCompare(va);
      return sortDir === 'asc' ? (va||0) - (vb||0) : (vb||0) - (va||0);
    });
    return list;
  }, [services, sortKey, sortDir, regionFilter, familyFilter, statusFilter, showStatusFilter]);

  const totalCost = filtered.reduce((a, s) => a + (s.cost || s.costMonth || 0), 0);
  const warnCount = filtered.filter(s => s.health === 'warning').length;

  return (
    <div>
      {/* Toolbar */}
      <div className="table-toolbar">
        <div className="table-toolbar-left">
          <div className="region-bar" style={{ marginBottom: 0 }}>
            <span className="region-bar-label">📍</span>
            {regions.map(r => (
              <button key={r} className={`region-btn ${regionFilter === r ? 'active' : ''}`}
                style={regionFilter === r ? { borderColor: meta.color, color: meta.color, background: `${meta.color}12` } : {}}
                onClick={() => setRegionFilter(r)}>
                {r === 'all' ? 'All Regions' : r}
              </button>
            ))}
          </div>
        </div>
        <div className="table-toolbar-right" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div className="region-bar" style={{ marginBottom: 0 }}>
            {families.map(f => (
              <button key={f} className={`region-btn ${familyFilter === f ? 'active' : ''}`}
                style={familyFilter === f ? { borderColor: meta.color, color: meta.color, background: `${meta.color}12` } : {}}
                onClick={() => setFamilyFilter(f)}>
                {f === 'all' ? 'All Types' : f}
              </button>
            ))}
          </div>
          {showStatusFilter && (
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              style={{
                background: 'var(--bg2)', color: 'var(--text1)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
                outline: 'none', height: 28,
              }}>
              <option value="all">All Status</option>
              <option value="private">🔒 Private Only</option>
              <option value="stopped">⏹ Stopped / Terminated</option>
            </select>
          )}
        </div>
      </div>

      {/* Summary row */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span className="summary-pill">{filtered.length} resources</span>
        <span className="summary-pill" style={{ color: meta.color }}>Total: {fmt.usd2(totalCost)}/mo</span>
        {warnCount > 0 && <span className="summary-pill" style={{ color: '#eab308' }}>⚠ {warnCount} warning{warnCount > 1 ? 's' : ''}</span>}
      </div>

      <div className="service-table-wrap">
        <table className="service-table">
          <thead>
            <tr>
              {COLUMNS.map(col => (
                <th key={col.key} onClick={() => col.sortable && handleSort(col.key)} style={{ cursor: col.sortable ? 'pointer' : 'default' }}>
                  {col.label}
                  {col.sortable && <span className={`sort-arrow ${sortKey === col.key ? 'active' : ''}`}>
                    {sortKey === col.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'}
                  </span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(s => (
              <ServiceRow key={s.id} s={s} provider={provider} onClick={onRowClick} />
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text3)', fontSize: 13 }}>
          No services match the current filters.
        </div>
      )}
    </div>
  );
}
