import React, { useState, useCallback } from 'react';

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

const SEV_COLOR = { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#22c55e' };
const SEV_BG    = { critical: 'rgba(239,68,68,0.1)', high: 'rgba(249,115,22,0.1)', medium: 'rgba(234,179,8,0.08)', low: 'rgba(34,197,94,0.08)' };
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function buildSecurityContext(aws, gcp, azure) {
  const lines = [];

  // ── AWS ──────────────────────────────────────────────────────────────────
  lines.push('=== AWS ===');
  const ec2        = aws.filter(s => s.type === 'EC2 Instance');
  const publicEC2  = ec2.filter(s => s.publicIp);
  const rds        = aws.filter(s => s.family === 'Database' && s.provider === 'aws');
  const publicRDS  = rds.filter(s => s.publiclyAccessible);
  const s3         = aws.filter(s => s.type === 'S3 Bucket');
  const publicS3   = s3.filter(s => !s.blockPublicAccess);
  const sgs        = aws.filter(s => s.type === 'Security Group');
  const openSGs    = sgs.filter(sg =>
    sg.inboundRules?.some(r => r.sources?.some(src => src.value === '0.0.0.0/0' || src.value === '::/0'))
  );

  lines.push(`EC2: ${ec2.length} instances, ${publicEC2.length} with public IP`);
  publicEC2.slice(0, 6).forEach(s => {
    const sgIds = (s.securityGroups || []).map(sg => sg.id || sg).join(', ');
    lines.push(`  - ${s.name} | ${s.instanceType || '?'} | ${s.region} | publicIP=${s.publicIp} | OS=${s.os || '?'} | SGs=[${sgIds}]`);
  });

  lines.push(`RDS: ${rds.length} instances, ${publicRDS.length} publicly accessible`);
  rds.slice(0, 5).forEach(s => lines.push(`  - ${s.name} | ${s.engine} ${s.engineVersion || ''} | publiclyAccessible=${s.publiclyAccessible} | storageEncrypted=${s.storageEncrypted} | multiAZ=${s.multiAZ}`));

  lines.push(`S3: ${s3.length} buckets, ${publicS3.length} without public-access-block`);
  s3.slice(0, 5).forEach(s => lines.push(`  - ${s.name} | blockPublicAccess=${s.blockPublicAccess} | encryption=${s.encryption || 'none'} | versioning=${s.versioning}`));

  lines.push(`Security Groups: ${sgs.length} total, ${openSGs.length} with 0.0.0.0/0 inbound`);
  openSGs.slice(0, 6).forEach(sg => {
    (sg.inboundRules || [])
      .filter(r => r.sources?.some(src => src.value === '0.0.0.0/0' || src.value === '::/0'))
      .forEach(rule => lines.push(`  - SG ${sg.name}/${sg.rawId}: ${rule.protocol} ${rule.fromPort}${rule.fromPort !== rule.toPort ? `-${rule.toPort}` : ''} open to 0.0.0.0/0`));
  });

  const lambda = aws.filter(s => s.family === 'Serverless');
  if (lambda.length) lines.push(`Lambda: ${lambda.length} functions`);

  // ── GCP ──────────────────────────────────────────────────────────────────
  lines.push('\n=== GCP ===');
  const gcpVMs      = gcp.filter(s => s.family === 'Compute');
  const publicGCP   = gcpVMs.filter(s => s.publicIp);
  const gcpSQL      = gcp.filter(s => s.family === 'Database');
  const gcpBuckets  = gcp.filter(s => s.family === 'Storage');

  lines.push(`Compute VMs: ${gcpVMs.length}, ${publicGCP.length} with public IP`);
  publicGCP.slice(0, 5).forEach(s => lines.push(`  - ${s.name} | ${s.machineType || '?'} | ${s.zone} | publicIP=${s.publicIp} | OS=${s.os || '?'}`));

  lines.push(`Cloud SQL: ${gcpSQL.length} instances`);
  gcpSQL.slice(0, 5).forEach(s => lines.push(`  - ${s.name} | ${s.engine} | requireSsl=${s.requireSsl} | privateNetwork=${s.privateNetwork || 'none'} | multiAZ=${s.multiAZ}`));

  lines.push(`GCS Buckets: ${gcpBuckets.length}`);

  const gke = gcp.filter(s => s.family === 'Container');
  if (gke.length) lines.push(`GKE Clusters: ${gke.length}`);

  // ── AZURE ────────────────────────────────────────────────────────────────
  lines.push('\n=== AZURE ===');
  const azVMs     = azure.filter(s => s.family === 'Compute');
  const publicAZ  = azVMs.filter(s => s.publicIp);
  const azSQL     = azure.filter(s => s.type === 'Azure SQL Database');
  const azStore   = azure.filter(s => s.type === 'Storage Account');
  const publicSt  = azStore.filter(s => s.allowBlobPublicAccess);
  const cosmos    = azure.filter(s => s.type === 'Cosmos DB Account');

  lines.push(`Virtual Machines: ${azVMs.length}, ${publicAZ.length} with public IP`);
  publicAZ.slice(0, 5).forEach(s => lines.push(`  - ${s.name} | ${s.size || '?'} | ${s.region} | publicIP=${s.publicIp} | OS=${s.os || '?'} | bootDiagnostics=${s.bootDiagnostics}`));

  lines.push(`Azure SQL: ${azSQL.length} databases`);
  azSQL.slice(0, 5).forEach(s => lines.push(`  - ${s.name} | server=${s.server} | publicNetworkAccess=${s.serverPublicNetworkAccess} | zoneRedundant=${s.zoneRedundant} | geoReplication=${s.geoReplication}`));

  lines.push(`Storage Accounts: ${azStore.length}, ${publicSt.length} with public blob access`);
  azStore.slice(0, 4).forEach(s => lines.push(`  - ${s.name} | httpsOnly=${s.httpsOnly} | publicBlobAccess=${s.allowBlobPublicAccess} | encryption=${s.encryption} | minTLS=${s.minTlsVersion}`));

  if (cosmos.length) lines.push(`Cosmos DB: ${cosmos.length} accounts`);
  const aks = azure.filter(s => s.type === 'AKS Cluster');
  if (aks.length) lines.push(`AKS Clusters: ${aks.length}`);

  return lines.join('\n');
}

function InfoBlock({ icon, title, text, color }) {
  return (
    <div style={{ padding: '10px 14px', borderRadius: 6, background: color ? `${color}08` : 'var(--bg)', border: `0.5px solid ${color ? `${color}30` : 'var(--border)'}` }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: color || 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
        {icon} {title}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{text}</div>
    </div>
  );
}

export default function AISuggestions({ awsServices, gcpServices, azureServices }) {
  const [loading, setLoading]     = useState(false);
  const [result, setResult]       = useState(null);
  const [error, setError]         = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [sevFilter, setSevFilter] = useState('all');

  const total = awsServices.length + gcpServices.length + azureServices.length;

  const analyse = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    setExpandedId(null);

    try {
      const context = buildSecurityContext(awsServices, gcpServices, azureServices);

      const prompt = `You are a senior cloud security architect. Analyse this multi-cloud infrastructure and identify every security vulnerability, misconfiguration, and risk.

INFRASTRUCTURE:
${context}

For each finding include:
- Exact attack vector (how a real hacker would exploit it step by step)
- Specific fix commands or console steps
- Which resource names are affected

Respond ONLY with a valid JSON object (no markdown, no backticks):
{
  "summary": "2-3 sentence executive summary of overall security posture",
  "overallRiskScore": 7,
  "vulnerabilities": [
    {
      "id": "v1",
      "title": "Short title",
      "severity": "critical",
      "provider": "aws",
      "service": "EC2 / S3 / RDS / etc",
      "affectedResources": ["instance-name-or-id"],
      "description": "What is wrong and why it is dangerous",
      "howItCanBeHacked": "Exact step-by-step attack: port scan → exploit → pivot → data exfil",
      "howToFix": "Exact fix: CLI command or console steps",
      "estimatedFixTime": "15 minutes"
    }
  ],
  "quickWins": ["3-5 immediate actions that take under 5 minutes each"],
  "criticalCount": 0,
  "highCount": 0,
  "mediumCount": 0,
  "lowCount": 0
}`;

      const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || `Gemini API error ${res.status}`);
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Empty response from Gemini');

      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed  = JSON.parse(cleaned);

      // Sort by severity
      if (parsed.vulnerabilities) {
        parsed.vulnerabilities.sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
        // Auto-fill counts
        ['critical','high','medium','low'].forEach(s => {
          parsed[`${s}Count`] = parsed.vulnerabilities.filter(v => v.severity === s).length;
        });
      }

      setResult(parsed);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [awsServices, gcpServices, azureServices]);

  const vulns = (result?.vulnerabilities || []).filter(v => sevFilter === 'all' || v.severity === sevFilter);

  return (
    <div style={{ paddingBottom: 40 }}>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="section-card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="section-title" style={{ marginBottom: 4 }}>AI Security Suggestions</div>
            <div style={{ fontSize: 13, color: 'var(--text3)' }}>
              Powered by Google Gemini · {total} resources across AWS, GCP &amp; Azure
            </div>
          </div>
          <button
            onClick={analyse}
            disabled={loading || total === 0}
            style={{
              padding: '10px 28px', borderRadius: 8, border: 'none',
              background: loading || total === 0 ? 'var(--border)' : 'linear-gradient(135deg,#4f46e5,#7c3aed)',
              color: loading || total === 0 ? 'var(--text3)' : '#fff',
              fontWeight: 700, fontSize: 14, cursor: loading || total === 0 ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 8,
            }}
          >
            {loading
              ? <><span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span> Analysing…</>
              : result ? 'Re-Analyse' : 'Analyse Security'
            }
          </button>
        </div>
      </div>

      {/* ── Error ────────────────────────────────────────────────────────── */}
      {error && (
        <div style={{ padding: '14px 18px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 10, marginBottom: 16, color: '#ef4444', fontSize: 13 }}>
          ⚠️ {error}
        </div>
      )}

      {/* ── Loading ──────────────────────────────────────────────────────── */}
      {loading && (
        <div className="section-card" style={{ textAlign: 'center', padding: '56px 24px' }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text3)', marginBottom: 16, letterSpacing: 1 }}>AI</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>Scanning your infrastructure…</div>
          <div style={{ fontSize: 13, color: 'var(--text3)' }}>Gemini is analysing {total} services for vulnerabilities, misconfigurations and attack vectors</div>
        </div>
      )}

      {/* ── Results ──────────────────────────────────────────────────────── */}
      {result && !loading && (
        <>
          {/* Summary row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: 16, marginBottom: 16, alignItems: 'start' }}>

            {/* Summary + quick wins */}
            <div className="section-card" style={{ margin: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Executive Summary</div>
              <div style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.8 }}>{result.summary}</div>
              {result.quickWins?.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#22c55e', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Quick Wins</div>
                  {result.quickWins.map((w, i) => (
                    <div key={i} style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 7, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <span style={{ color: '#22c55e', flexShrink: 0, marginTop: 1 }}>+</span>
                      <span style={{ lineHeight: 1.5 }}>{w}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Risk score card */}
            <div className="section-card" style={{ margin: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 1 }}>Risk Score</div>
              <div style={{
                width: 90, height: 90, borderRadius: '50%',
                border: `4px solid ${result.overallRiskScore >= 8 ? '#ef4444' : result.overallRiskScore >= 5 ? '#eab308' : '#22c55e'}`,
                background: result.overallRiskScore >= 8 ? 'rgba(239,68,68,0.1)' : result.overallRiskScore >= 5 ? 'rgba(234,179,8,0.1)' : 'rgba(34,197,94,0.1)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              }}>
                <span style={{ fontSize: 30, fontWeight: 800, lineHeight: 1, color: result.overallRiskScore >= 8 ? '#ef4444' : result.overallRiskScore >= 5 ? '#eab308' : '#22c55e' }}>
                  {result.overallRiskScore}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text3)' }}>/10</span>
              </div>
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 5 }}>
                {[
                  { label: 'Critical', key: 'criticalCount', color: '#ef4444' },
                  { label: 'High',     key: 'highCount',     color: '#f97316' },
                  { label: 'Medium',   key: 'mediumCount',   color: '#eab308' },
                  { label: 'Low',      key: 'lowCount',      color: '#22c55e' },
                ].map(({ label, key, color }) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, alignItems: 'center' }}>
                    <span style={{ color: 'var(--text3)' }}>{label}</span>
                    <span style={{ fontWeight: 700, color, fontSize: 14 }}>{result[key] ?? 0}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Vulnerability list */}
          <div className="section-card" style={{ margin: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div className="section-title" style={{ margin: 0 }}>
                Vulnerabilities &amp; Fixes ({vulns.length})
              </div>
              {/* Severity filter */}
              <div style={{ display: 'flex', gap: 6 }}>
                {['all','critical','high','medium','low'].map(s => (
                  <button
                    key={s}
                    onClick={() => setSevFilter(s)}
                    style={{
                      padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                      border: `1px solid ${s === 'all' ? 'var(--border)' : SEV_COLOR[s] + '60'}`,
                      background: sevFilter === s ? (s === 'all' ? 'var(--border)' : SEV_BG[s]) : 'transparent',
                      color: s === 'all' ? 'var(--text2)' : SEV_COLOR[s] || 'var(--text2)',
                      cursor: 'pointer',
                    }}
                  >
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                    {s !== 'all' && result[`${s}Count`] > 0 && (
                      <span style={{ marginLeft: 4 }}>{result[`${s}Count`]}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {vulns.length === 0 && (
                <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
                  No {sevFilter !== 'all' ? sevFilter : ''} vulnerabilities found.
                </div>
              )}
              {vulns.map(v => (
                <div
                  key={v.id}
                  style={{
                    border: `1px solid ${SEV_COLOR[v.severity] || '#64748b'}35`,
                    borderLeft: `4px solid ${SEV_COLOR[v.severity] || '#64748b'}`,
                    borderRadius: 8, overflow: 'hidden',
                  }}
                >
                  {/* Row header */}
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', cursor: 'pointer', background: expandedId === v.id ? 'var(--bg)' : '' }}
                    onClick={() => setExpandedId(expandedId === v.id ? null : v.id)}
                  >
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '2px 9px', borderRadius: 20, whiteSpace: 'nowrap',
                      background: SEV_BG[v.severity], color: SEV_COLOR[v.severity], textTransform: 'uppercase', letterSpacing: 0.5,
                    }}>
                      {v.severity}
                    </span>
                    <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', flex: 1 }}>{v.title}</span>
                    <span style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                      {v.provider?.toUpperCase()} · {v.service}
                    </span>
                    {v.estimatedFixTime && (
                      <span style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}>⏱ {v.estimatedFixTime}</span>
                    )}
                    <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 4 }}>
                      {expandedId === v.id ? '▲' : '▼'}
                    </span>
                  </div>

                  {/* Expanded detail */}
                  {expandedId === v.id && (
                    <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {v.affectedResources?.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
                          <span style={{ fontSize: 11, color: 'var(--text3)', alignSelf: 'center' }}>Affected:</span>
                          {v.affectedResources.map((r, i) => (
                            <span key={i} style={{ fontSize: 11, padding: '2px 8px', background: 'var(--border)', borderRadius: 4, fontFamily: 'monospace', color: 'var(--text2)' }}>
                              {r}
                            </span>
                          ))}
                        </div>
                      )}
                      <InfoBlock icon="" title="What is wrong" text={v.description} />
                      <InfoBlock icon="" title="How it can be hacked / exploited" text={v.howItCanBeHacked} color="#ef4444" />
                      <InfoBlock icon="" title="How to fix it" text={v.howToFix} color="#22c55e" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── Empty state ───────────────────────────────────────────────────── */}
      {!result && !loading && !error && (
        <div className="section-card" style={{ textAlign: 'center', padding: '64px 24px' }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text3)', marginBottom: 16, letterSpacing: 1 }}>AI</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>AI Security Analysis</div>
          <div style={{ fontSize: 14, color: 'var(--text3)', maxWidth: 480, margin: '0 auto 28px', lineHeight: 1.7 }}>
            Gemini will scan every service in your AWS, GCP, and Azure accounts — identifying security holes, misconfigurations, exact attack vectors, and step-by-step fixes.
          </div>
          <button
            onClick={analyse}
            disabled={total === 0}
            style={{
              padding: '12px 36px', borderRadius: 10, border: 'none',
              background: total === 0 ? 'var(--border)' : 'linear-gradient(135deg,#4f46e5,#7c3aed)',
              color: total === 0 ? 'var(--text3)' : '#fff',
              fontWeight: 700, fontSize: 15, cursor: total === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            Analyse Security Now
          </button>
          {total === 0 && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 12 }}>Connect a cloud account first</div>}
        </div>
      )}
    </div>
  );
}

