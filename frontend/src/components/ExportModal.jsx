import React, { useState } from 'react';
import { generatePDF, generateCSV, generateJSON } from '../utils/exportReport';
import ProviderLogo from './ProviderLogo';

const PROVIDERS = [
  { key: 'all',   label: 'All Clouds',  emoji: '🌐', desc: 'Combined report for AWS + GCP + Azure' },
  { key: 'aws',   label: 'AWS Only',    emoji: '🟠', desc: 'Amazon Web Services report'            },
  { key: 'gcp',   label: 'GCP Only',    emoji: '🔵', desc: 'Google Cloud Platform report'          },
  { key: 'azure', label: 'Azure Only',  emoji: '🔷', desc: 'Microsoft Azure report'                },
];

const FORMATS = [
  {
    key: 'pdf', label: 'PDF Report', icon: '📄',
    desc: 'Professional multi-page PDF with CloudNexus branding, summary metrics, service tables and alerts',
    badge: 'Recommended',
  },
  {
    key: 'csv', label: 'CSV Spreadsheet', icon: '📊',
    desc: 'Flat table export compatible with Excel, Google Sheets and BI tools',
    badge: null,
  },
  {
    key: 'json', label: 'JSON Data', icon: '🗂️',
    desc: 'Structured JSON with full metadata, summary and service details for programmatic use',
    badge: null,
  },
];

const PROVIDER_COLORS = { all: '#3b82f6', aws: '#FF9900', gcp: '#4285F4', azure: '#008AD7' };

export default function ExportModal({ open, onClose, awsServices, gcpServices, azureServices, alerts }) {
  const [selectedProvider, setSelectedProvider] = useState('all');
  const [selectedFormat,   setSelectedFormat]   = useState('pdf');
  const [loading, setLoading] = useState(false);
  const [done,    setDone]    = useState(false);

  if (!open) return null;

  function getServices(key) {
    if (key === 'all')   return [...awsServices, ...gcpServices, ...azureServices].map(s => ({ ...s, provider: s.provider || key }));
    if (key === 'aws')   return awsServices.map(s => ({ ...s, provider: 'aws'   }));
    if (key === 'gcp')   return gcpServices.map(s => ({ ...s, provider: 'gcp'   }));
    if (key === 'azure') return azureServices.map(s => ({ ...s, provider: 'azure'}));
    return [];
  }

  async function handleDownload() {
    setLoading(true);
    setDone(false);
    const services = getServices(selectedProvider);
    // Short delay so spinner renders before heavy PDF work blocks the thread
    await new Promise(r => setTimeout(r, 80));
    try {
      if (selectedFormat === 'pdf')  generatePDF(services, alerts, selectedProvider);
      if (selectedFormat === 'csv')  generateCSV(services, selectedProvider);
      if (selectedFormat === 'json') generateJSON(services, alerts, selectedProvider);
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } finally {
      setLoading(false);
    }
  }

  const pColor = PROVIDER_COLORS[selectedProvider];
  const serviceCount = getServices(selectedProvider).length;

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(4px)', zIndex: 1000,
      }} />

      {/* Modal */}
      <div style={{
        position: 'fixed', top: '50%', left: '50%',
        transform: 'translate(-50%,-50%)',
        width: 640, maxHeight: '90vh', overflowY: 'auto',
        background: 'var(--card)', borderRadius: 16,
        border: '1px solid var(--border)',
        boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
        zIndex: 1001,
      }}>

        {/* Header */}
        <div style={{
          background: 'linear-gradient(135deg, #0a1628 0%, #0f2044 100%)',
          borderRadius: '16px 16px 0 0',
          padding: '24px 28px 20px',
          borderBottom: '1px solid rgba(59,130,246,0.2)',
          position: 'relative',
        }}>
          {/* Logo row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <div style={{
              width: 38, height: 38, borderRadius: 10,
              background: 'linear-gradient(135deg, #1d4ed8, #3b82f6)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 20, boxShadow: '0 0 16px rgba(59,130,246,0.4)',
            }}>☁️</div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 800, color: 'white', letterSpacing: '-0.3px' }}>
                Cloud<span style={{ color: '#60a5fa' }}>Nexus</span>
              </div>
              <div style={{ fontSize: 10, color: '#64748b', fontWeight: 500 }}>MULTI-CLOUD MONITORING</div>
            </div>
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'white', marginTop: 10 }}>Export Infrastructure Report</div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 3 }}>
            Download a comprehensive report of your cloud infrastructure
          </div>

          {/* Close button */}
          <button onClick={onClose} style={{
            position: 'absolute', top: 16, right: 16,
            background: 'rgba(255,255,255,0.08)', border: 'none', color: '#94a3b8',
            width: 30, height: 30, borderRadius: 8, cursor: 'pointer',
            fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ padding: '24px 28px' }}>

          {/* Step 1 — Provider */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', letterSpacing: '0.06em', marginBottom: 10 }}>
              STEP 1 — SELECT CLOUD PROVIDER
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {PROVIDERS.map(p => {
                const active = selectedProvider === p.key;
                const svcCount = getServices(p.key).length;
                return (
                  <div key={p.key} onClick={() => setSelectedProvider(p.key)} style={{
                    padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
                    border: `1.5px solid ${active ? PROVIDER_COLORS[p.key] : 'var(--border)'}`,
                    background: active ? `${PROVIDER_COLORS[p.key]}12` : 'var(--bg)',
                    transition: 'all 0.15s',
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                  }}>
                    {['aws','gcp','azure'].includes(p.key)
                      ? <ProviderLogo provider={p.key} size={20} />
                      : <span style={{ fontSize: 20, lineHeight: 1 }}>{p.emoji}</span>}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: active ? PROVIDER_COLORS[p.key] : 'var(--text)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        {p.label}
                        <span style={{
                          fontSize: 10, background: active ? PROVIDER_COLORS[p.key] : 'var(--border)',
                          color: active ? 'white' : 'var(--text3)',
                          borderRadius: 8, padding: '1px 6px', fontWeight: 700,
                        }}>{svcCount}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{p.desc}</div>
                    </div>
                    {active && (
                      <div style={{
                        width: 18, height: 18, borderRadius: '50%',
                        background: PROVIDER_COLORS[p.key], flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, color: 'white', fontWeight: 700,
                      }}>✓</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Step 2 — Format */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', letterSpacing: '0.06em', marginBottom: 10 }}>
              STEP 2 — SELECT FORMAT
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {FORMATS.map(f => {
                const active = selectedFormat === f.key;
                return (
                  <div key={f.key} onClick={() => setSelectedFormat(f.key)} style={{
                    padding: '12px 16px', borderRadius: 10, cursor: 'pointer',
                    border: `1.5px solid ${active ? pColor : 'var(--border)'}`,
                    background: active ? `${pColor}0d` : 'var(--bg)',
                    transition: 'all 0.15s',
                    display: 'flex', alignItems: 'center', gap: 14,
                  }}>
                    <span style={{ fontSize: 22, lineHeight: 1 }}>{f.icon}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 600, fontSize: 13, color: active ? pColor : 'var(--text)' }}>{f.label}</span>
                        {f.badge && (
                          <span style={{
                            fontSize: 9, background: '#22c55e', color: 'white',
                            borderRadius: 4, padding: '1px 6px', fontWeight: 700, letterSpacing: '0.04em',
                          }}>{f.badge}</span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{f.desc}</div>
                    </div>
                    <div style={{
                      width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                      border: `2px solid ${active ? pColor : 'var(--border)'}`,
                      background: active ? pColor : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 10, color: 'white',
                    }}>{active ? '✓' : ''}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Preview summary bar */}
          <div style={{
            background: `${pColor}0d`,
            border: `1px solid ${pColor}30`,
            borderRadius: 10, padding: '12px 16px', marginBottom: 20,
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <span style={{ fontSize: 22 }}>
              {FORMATS.find(f => f.key === selectedFormat)?.icon}
            </span>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                Report preview
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                {['aws','gcp','azure'].includes(selectedProvider)
                  ? <ProviderLogo provider={selectedProvider} size={13} style={{ display:'inline-block', verticalAlign:'middle', marginRight:3 }} />
                  : PROVIDERS.find(p => p.key === selectedProvider)?.emoji}{' '}
                <strong style={{ color: pColor }}>{serviceCount} services</strong> ·{' '}
                {FORMATS.find(f => f.key === selectedFormat)?.label} format ·{' '}
                {selectedFormat === 'pdf' ? 'Multi-page landscape A4 PDF' :
                 selectedFormat === 'csv' ? 'Single CSV file with all service fields' :
                 'Structured JSON with metadata + full service array'}
              </div>
            </div>
          </div>

          {/* Download button */}
          <button onClick={handleDownload} disabled={loading || serviceCount === 0} style={{
            width: '100%', padding: '14px 0', borderRadius: 10,
            background: done
              ? 'linear-gradient(135deg, #16a34a, #22c55e)'
              : loading
                ? 'linear-gradient(135deg, #374151, #4b5563)'
                : `linear-gradient(135deg, ${pColor}cc, ${pColor})`,
            border: 'none', color: 'white', fontWeight: 700, fontSize: 15,
            cursor: loading || serviceCount === 0 ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            transition: 'all 0.2s',
            boxShadow: loading || done ? 'none' : `0 4px 20px ${pColor}50`,
            letterSpacing: '0.01em',
          }}>
            {loading ? (
              <>
                <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite', fontSize: 16 }}>⏳</span>
                Generating report…
              </>
            ) : done ? (
              <> ✅ Report downloaded!</>
            ) : (
              <>
                ⬇ Download {FORMATS.find(f => f.key === selectedFormat)?.label}
              </>
            )}
          </button>

          {serviceCount === 0 && (
            <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>
              No services available for the selected provider
            </div>
          )}
        </div>
      </div>
    </>
  );
}
