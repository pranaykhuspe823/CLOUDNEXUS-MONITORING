import React, { useState } from 'react';
import { PROVIDER_META } from '../utils/theme';
import { api } from '../utils/api';
import ProviderLogo from './ProviderLogo';

const AWS_REGIONS = [
  'us-east-1','us-east-2','us-west-1','us-west-2',
  'eu-west-1','eu-west-2','eu-central-1',
  'ap-southeast-1','ap-southeast-2','ap-northeast-1','ap-south-1',
  'ca-central-1','sa-east-1',
];

const MULTI_REGIONS = AWS_REGIONS;

function AWSForm({ onConnected, onDisconnect, isConnected, isFetching }) {
  const [authType, setAuthType] = useState('keys');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [roleArn, setRoleArn] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [selectedRegions, setSelectedRegions] = useState(AWS_REGIONS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function toggleRegion(r) {
    setSelectedRegions(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r]);
  }

  async function handleConnect() {
    setError('');
    setLoading(true);
    try {
      const creds = { authType, region, regions: selectedRegions };
      if (authType === 'keys') {
        if (!accessKeyId || !secretAccessKey) { setError('Access Key ID and Secret are required'); setLoading(false); return; }
        creds.accessKeyId = accessKeyId;
        creds.secretAccessKey = secretAccessKey;
        if (sessionToken) creds.sessionToken = sessionToken;
      } else if (authType === 'role') {
        if (!roleArn) { setError('Role ARN is required'); setLoading(false); return; }
        creds.roleArn = roleArn;
      }
      const result = await api.connect('aws', creds);
      if (result.success) {
        onConnected('aws', result);
      } else {
        setError(result.error || 'Connection failed');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  if (isConnected) {
    return (
      <div>
        <div className="connected-status">
          ✓ AWS Connected — Live data streaming
          <button className="disconnect-btn" onClick={() => onDisconnect('aws')}>Disconnect</button>
        </div>
        {isFetching && <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>⏳ Fetching resources...</div>}
        <div style={{ fontSize: 13, color: 'var(--text2)' }}>
          Monitoring regions: {selectedRegions.join(', ') || region}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="warning-box">⚠️ Only read-only IAM permissions required (ReadOnlyAccess policy). Credentials are session-encrypted and never stored to disk.</div>
      <div className="auth-type-row">
        {[['keys','Access Keys','Best for dev/testing'],['role','IAM Role','Best for EC2/Lambda'],['env','Env Variables','Uses AWS_* env vars']].map(([v,l,s]) => (
          <button key={v} className={`auth-type-btn ${authType === v ? 'active' : ''}`} onClick={() => setAuthType(v)}>
            <div className="auth-type-label">{l}</div>
            <div className="auth-type-sub">{s}</div>
          </button>
        ))}
      </div>
      {authType === 'keys' && (
        <>
          <div className="form-group">
            <label className="form-label">Access Key ID *</label>
            <input className="form-input" placeholder="AKIAIOSFODNN7EXAMPLE" value={accessKeyId} onChange={e => setAccessKeyId(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Secret Access Key *</label>
            <input className="form-input" type="password" placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" value={secretAccessKey} onChange={e => setSecretAccessKey(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Session Token <span style={{ color: 'var(--text3)', fontWeight: 400 }}>(optional — for STS/MFA)</span></label>
            <input className="form-input" placeholder="Temporary session token" value={sessionToken} onChange={e => setSessionToken(e.target.value)} />
          </div>
        </>
      )}
      {authType === 'role' && (
        <div className="form-group">
          <label className="form-label">Role ARN *</label>
          <input className="form-input" placeholder="arn:aws:iam::123456789012:role/CloudNexusReadOnly" value={roleArn} onChange={e => setRoleArn(e.target.value)} />
          <div className="form-hint">The role must have trust relationship with this server's identity</div>
        </div>
      )}
      {authType === 'env' && (
        <div className="warning-box" style={{ background: 'rgba(66,133,244,0.08)', borderColor: 'rgba(66,133,244,0.3)', color: '#1a56db' }}>
          ℹ️ Will use AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION from environment variables on the backend server.
        </div>
      )}
      <div className="form-group">
        <label className="form-label">Primary Region</label>
        <select className="form-input form-select" value={region} onChange={e => setRegion(e.target.value)}>
          {AWS_REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      <div className="form-group">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <label className="form-label" style={{ marginBottom: 0 }}>Scan Regions</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setSelectedRegions(AWS_REGIONS)}
              style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, border: '0.5px solid #FF9900', background: 'rgba(255,153,0,0.1)', color: '#FF9900', cursor: 'pointer' }}>
              Select All
            </button>
            <button onClick={() => setSelectedRegions([])}
              style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, border: '0.5px solid var(--border)', background: 'var(--bg)', color: 'var(--text3)', cursor: 'pointer' }}>
              Clear
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {MULTI_REGIONS.map(r => (
            <button key={r} onClick={() => toggleRegion(r)}
              style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, border: `0.5px solid ${selectedRegions.includes(r) ? '#FF9900' : 'var(--border)'}`, background: selectedRegions.includes(r) ? 'rgba(255,153,0,0.12)' : 'var(--bg)', color: selectedRegions.includes(r) ? '#FF9900' : 'var(--text2)', cursor: 'pointer' }}>
              {r}
            </button>
          ))}
        </div>
      </div>
      {error && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 10, padding: '8px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 6 }}>✗ {error}</div>}
      <button className="connect-btn" style={{ background: '#FF9900' }} onClick={handleConnect} disabled={loading}>
        {loading ? '⏳ Verifying & Connecting...' : '🔗 Connect AWS Account'}
      </button>
      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text3)' }}>
        <strong>Required IAM Policy:</strong> ReadOnlyAccess (AWS managed) or custom with ec2:Describe*, rds:Describe*, s3:List*, lambda:List*, eks:List*, cloudwatch:GetMetricStatistics
      </div>
    </div>
  );
}

function GCPForm({ onConnected, onDisconnect, isConnected, isFetching }) {
  const [authType, setAuthType] = useState('serviceAccount');
  const [projectId, setProjectId] = useState('');
  const [serviceAccountKey, setServiceAccountKey] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target.result);
        setServiceAccountKey(ev.target.result);
        if (parsed.project_id) setProjectId(parsed.project_id);
      } catch { setError('Invalid JSON file'); }
    };
    reader.readAsText(file);
  }

  async function handleConnect() {
    setError('');
    if (!projectId) { setError('Project ID is required'); return; }
    setLoading(true);
    try {
      const creds = { authType, projectId };
      if (authType === 'serviceAccount') {
        if (!serviceAccountKey) { setError('Service Account JSON is required'); setLoading(false); return; }
        creds.serviceAccountKey = serviceAccountKey;
      } else if (authType === 'oauth') {
        if (!accessToken) { setError('Access Token is required'); setLoading(false); return; }
        creds.accessToken = accessToken;
      }
      const result = await api.connect('gcp', creds);
      if (result.success) onConnected('gcp', result);
      else setError(result.error || 'Connection failed');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  if (isConnected) {
    return (
      <div>
        <div className="connected-status">
          ✓ GCP Connected — Live data streaming
          <button className="disconnect-btn" onClick={() => onDisconnect('gcp')}>Disconnect</button>
        </div>
        {isFetching && <div style={{ fontSize: 12, color: 'var(--text3)' }}>⏳ Fetching resources...</div>}
      </div>
    );
  }

  return (
    <div>
      <div className="warning-box">⚠️ Only viewer/read roles required. Service Account key is session-encrypted and never persisted to disk.</div>
      <div className="auth-type-row">
        {[['serviceAccount','Service Account','JSON key file'],['adc','App Default Creds','gcloud auth'],['oauth','OAuth Token','Short-lived token']].map(([v,l,s]) => (
          <button key={v} className={`auth-type-btn ${authType === v ? 'active' : ''}`} onClick={() => setAuthType(v)}>
            <div className="auth-type-label">{l}</div>
            <div className="auth-type-sub">{s}</div>
          </button>
        ))}
      </div>
      <div className="form-group">
        <label className="form-label">Project ID *</label>
        <input className="form-input" placeholder="my-project-id" value={projectId} onChange={e => setProjectId(e.target.value)} />
      </div>
      {authType === 'serviceAccount' && (
        <>
          <div className="form-group">
            <label className="form-label">Service Account JSON Key *</label>
            <input type="file" accept=".json" onChange={handleFileUpload} style={{ display: 'block', marginBottom: 8, fontSize: 13, color: 'var(--text2)' }} />
            <textarea className="form-input form-textarea" placeholder='Paste service account JSON or upload file above...' value={serviceAccountKey} onChange={e => setServiceAccountKey(e.target.value)} style={{ minHeight: 80, fontFamily: 'monospace', fontSize: 11 }} />
          </div>
        </>
      )}
      {authType === 'adc' && (
        <div className="warning-box" style={{ background: 'rgba(66,133,244,0.08)', borderColor: 'rgba(66,133,244,0.3)', color: '#1a56db' }}>
          ℹ️ Will use Application Default Credentials from the backend server environment (gcloud auth application-default login).
        </div>
      )}
      {authType === 'oauth' && (
        <div className="form-group">
          <label className="form-label">OAuth Access Token *</label>
          <input className="form-input" type="password" placeholder="ya29...." value={accessToken} onChange={e => setAccessToken(e.target.value)} />
          <div className="form-hint">Get via: gcloud auth print-access-token</div>
        </div>
      )}
      {error && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 10, padding: '8px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 6 }}>✗ {error}</div>}
      <button className="connect-btn" style={{ background: '#4285F4' }} onClick={handleConnect} disabled={loading}>
        {loading ? '⏳ Verifying & Connecting...' : '🔗 Connect GCP Project'}
      </button>
      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text3)' }}>
        <strong>Required Roles:</strong> roles/viewer + roles/monitoring.viewer (or custom with compute.instances.list, container.clusters.list, cloudsql.instances.list, storage.buckets.list)
      </div>
    </div>
  );
}

function AzureForm({ onConnected, onDisconnect, isConnected, isFetching }) {
  const [authType, setAuthType] = useState('servicePrincipal');
  const [tenantId, setTenantId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [subscriptionId, setSubscriptionId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleConnect() {
    setError('');
    if (!subscriptionId) { setError('Subscription ID is required'); return; }
    if (authType === 'servicePrincipal' && (!tenantId || !clientId || !clientSecret)) {
      setError('Tenant ID, Client ID, and Client Secret are all required'); return;
    }
    setLoading(true);
    try {
      const creds = { authType, subscriptionId, tenantId, clientId, clientSecret };
      const result = await api.connect('azure', creds);
      if (result.success) onConnected('azure', result);
      else setError(result.error || 'Connection failed');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  if (isConnected) {
    return (
      <div>
        <div className="connected-status">
          ✓ Azure Connected — Live data streaming
          <button className="disconnect-btn" onClick={() => onDisconnect('azure')}>Disconnect</button>
        </div>
        {isFetching && <div style={{ fontSize: 12, color: 'var(--text3)' }}>⏳ Fetching resources...</div>}
      </div>
    );
  }

  return (
    <div>
      <div className="warning-box">⚠️ Only Reader role required at subscription scope. Credentials are session-encrypted and never stored.</div>
      <div className="auth-type-row">
        {[['servicePrincipal','Service Principal','App registration'],['managedIdentity','Managed Identity','Azure hosted'],['defaultAzure','Default Chain','Az CLI / env']].map(([v,l,s]) => (
          <button key={v} className={`auth-type-btn ${authType === v ? 'active' : ''}`} onClick={() => setAuthType(v)}>
            <div className="auth-type-label">{l}</div>
            <div className="auth-type-sub">{s}</div>
          </button>
        ))}
      </div>
      <div className="form-group">
        <label className="form-label">Subscription ID *</label>
        <input className="form-input" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={subscriptionId} onChange={e => setSubscriptionId(e.target.value)} />
        <div className="form-hint">Found in Azure Portal → Subscriptions</div>
      </div>
      {authType === 'servicePrincipal' && (
        <>
          <div className="form-group">
            <label className="form-label">Tenant (Directory) ID *</label>
            <input className="form-input" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={tenantId} onChange={e => setTenantId(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Client (Application) ID *</label>
            <input className="form-input" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={clientId} onChange={e => setClientId(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Client Secret *</label>
            <input className="form-input" type="password" placeholder="Client secret value" value={clientSecret} onChange={e => setClientSecret(e.target.value)} />
          </div>
        </>
      )}
      {authType === 'managedIdentity' && (
        <div className="form-group">
          <label className="form-label">Managed Identity Client ID <span style={{ color: 'var(--text3)', fontWeight: 400 }}>(optional)</span></label>
          <input className="form-input" placeholder="Leave blank for system-assigned" value={clientId} onChange={e => setClientId(e.target.value)} />
        </div>
      )}
      {authType === 'defaultAzure' && (
        <div className="warning-box" style={{ background: 'rgba(0,138,215,0.08)', borderColor: 'rgba(0,138,215,0.3)', color: '#1a56db' }}>
          ℹ️ Will use DefaultAzureCredential chain: environment variables → workload identity → managed identity → Azure CLI.
        </div>
      )}
      {error && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 10, padding: '8px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 6 }}>✗ {error}</div>}
      <button className="connect-btn" style={{ background: '#008AD7' }} onClick={handleConnect} disabled={loading}>
        {loading ? '⏳ Verifying & Connecting...' : '🔗 Connect Azure Subscription'}
      </button>
      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text3)' }}>
        <strong>Required Role:</strong> Reader (built-in) at Subscription scope. Grant via: az role assignment create --role Reader --assignee &lt;clientId&gt; --scope /subscriptions/&lt;id&gt;
      </div>
    </div>
  );
}

export default function CloudConnectModal({ open, onClose, onAllConnected, initialConnections, fetchingProviders }) {
  const [activeProvider, setActiveProvider] = useState('aws');

  if (!open) return null;

  function handleConnected(provider, result) {
    onAllConnected({ ...initialConnections, [provider]: { connected: true, ...result } });
  }

  async function handleDisconnect(provider) {
    try {
      await api.disconnect(provider);
      const newConns = { ...initialConnections };
      delete newConns[provider];
      onAllConnected(newConns);
    } catch (e) {
      console.error('Disconnect error:', e);
    }
  }

  const providers = ['aws', 'gcp', 'azure'];

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div className="modal-header">
          <div>
            <div className="modal-title">🔌 Connect Cloud Accounts</div>
            <div className="modal-subtitle">Connect your AWS, GCP, and Azure accounts for real-time monitoring</div>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="provider-tab-bar">
            {providers.map(p => {
              const meta = PROVIDER_META[p];
              const isConn = initialConnections?.[p]?.connected;
              return (
                <button key={p} className={`provider-tab ${activeProvider === p ? 'active' : ''}`}
                  style={activeProvider === p ? { background: meta.color, borderColor: meta.color } : {}}
                  onClick={() => setActiveProvider(p)}>
                  <ProviderLogo provider={p} size={14} style={{ display:'inline-block', verticalAlign:'middle', marginRight:4 }} /> {meta.label}
                  {isConn && <span style={{ marginLeft: 5, fontSize: 10, background: 'rgba(34,197,94,0.2)', color: '#16a34a', padding: '1px 5px', borderRadius: 10 }}>✓</span>}
                </button>
              );
            })}
          </div>

          {activeProvider === 'aws' && (
            <AWSForm
              onConnected={handleConnected}
              onDisconnect={handleDisconnect}
              isConnected={!!initialConnections?.aws?.connected}
              isFetching={fetchingProviders?.aws}
            />
          )}
          {activeProvider === 'gcp' && (
            <GCPForm
              onConnected={handleConnected}
              onDisconnect={handleDisconnect}
              isConnected={!!initialConnections?.gcp?.connected}
              isFetching={fetchingProviders?.gcp}
            />
          )}
          {activeProvider === 'azure' && (
            <AzureForm
              onConnected={handleConnected}
              onDisconnect={handleDisconnect}
              isConnected={!!initialConnections?.azure?.connected}
              isFetching={fetchingProviders?.azure}
            />
          )}

          <div style={{ marginTop: 20, padding: '14px 16px', background: 'rgba(34,197,94,0.06)', borderRadius: 8, border: '0.5px solid rgba(34,197,94,0.2)' }}>
            <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13, color: '#16a34a' }}>🛡️ Security Guarantee</div>
            <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.6 }}>
              All credentials are AES-256-GCM encrypted in memory using a session key generated at server start. They are <strong>never written to disk</strong>, never logged, and never transmitted to third parties. The backend only requests read-only APIs. Auto-refresh runs every 5 minutes via a background cron job.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
