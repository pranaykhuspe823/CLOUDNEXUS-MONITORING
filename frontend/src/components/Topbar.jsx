import React, { useState } from 'react';
import { PROVIDER_META } from '../utils/theme';

const PROVIDER_COLORS = { aws: '#FF9900', gcp: '#4285F4', azure: '#008AD7' };

export default function Topbar({ mode, onModeChange, onRefresh, lastRefresh, connections, onOpenConnect, onExport, searchQuery, onSearchChange, filterStatus, onFilterChange, alertCount }) {
  const [spinning, setSpinning] = useState(false);

  function handleRefresh() {
    setSpinning(true);
    onRefresh();
    setTimeout(() => setSpinning(false), 800);
  }

  function timeAgo() {
    if (!lastRefresh) return 'never';
    const s = Math.floor((Date.now() - new Date(lastRefresh)) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    return `${Math.floor(s / 60)}m ago`;
  }

  const connectedCount = ['aws','gcp','azure'].filter(p => connections?.[p]?.connected).length;

  return (
    <div className="topbar">
      <div className="topbar-left">
        <span className="logo">Cloud<span>Nexus</span></span>
        <span className="live-badge"><span className="dot" />Live</span>
        <span className="muted-text">Refreshed {timeAgo()}</span>
      </div>

      <div className="topbar-right">
        {mode === 'real' && (
          <div className="conn-pills">
            {['aws','gcp','azure'].map(p => (
              <div key={p} className={`conn-pill ${connections?.[p]?.connected ? 'connected' : ''}`} onClick={onOpenConnect} title={`${p.toUpperCase()} — ${connections?.[p]?.connected ? 'Connected' : 'Click to connect'}`}>
                <span style={{ width:6, height:6, borderRadius:'50%', background: connections?.[p]?.connected ? PROVIDER_COLORS[p] : 'rgba(0,0,0,0.2)', display:'inline-block' }} />
                {p.toUpperCase()}
              </div>
            ))}
          </div>
        )}

        <div className="mode-toggle">
          <button className={`mode-btn ${mode === 'mock' ? 'active' : ''}`} onClick={() => onModeChange('mock')}>Mock</button>
          <button className={`mode-btn ${mode === 'real' ? 'active' : ''}`} onClick={() => { onModeChange('real'); onOpenConnect(); }}>
            Real {mode === 'real' && connectedCount > 0 && <span style={{fontSize:10,marginLeft:3,opacity:0.8}}>{connectedCount}/3</span>}
          </button>
        </div>

        <button className="icon-btn" onClick={onOpenConnect}>🔌 Connect</button>
        <button className="icon-btn" onClick={onExport} title="Export Report"
          style={{ background: 'linear-gradient(135deg,#1d4ed8,#3b82f6)', color:'white', border:'none', fontWeight:600 }}>
          ⬇ Report
        </button>
        <button className={`icon-btn ${spinning ? 'spin' : ''}`} onClick={handleRefresh} title="Refresh">↻</button>
      </div>
    </div>
  );
}
