const nodemailer = require('nodemailer');
const cron = require('node-cron');

const SMTP_USER = process.env.SMTP_USER || 'support@core5.co.in';
const SMTP_PASS = process.env.SMTP_PASS || 'Core5support@8800';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_FROM = process.env.SMTP_FROM || `"CloudNexus Monitor" <${SMTP_USER}>`;

const SEVERITY_COLOR = { critical: '#dc2626', warning: '#d97706', info: '#2563eb' };
const HEALTH_COLOR   = { healthy: '#16a34a', warning: '#d97706', critical: '#dc2626', unknown: '#6b7280' };
const PROVIDER_COLOR = { aws: '#FF9900', gcp: '#4285F4', azure: '#008AD7' };
const PROVIDER_LABEL = { aws: 'Amazon Web Services', gcp: 'Google Cloud Platform', azure: 'Microsoft Azure' };

// Inline SVG logos embedded as base64 (email-safe: rendered as <img> in HTML email)
const PROVIDER_LOGO_B64 = {
  aws:   'data:image/svg+xml;base64,' + Buffer.from(require('fs').readFileSync(
    require('path').join(__dirname, '../../frontend/public/logos/aws.svg'))).toString('base64'),
  gcp:   'data:image/svg+xml;base64,' + Buffer.from(require('fs').readFileSync(
    require('path').join(__dirname, '../../frontend/public/logos/gcp.svg'))).toString('base64'),
  azure: 'data:image/svg+xml;base64,' + Buffer.from(require('fs').readFileSync(
    require('path').join(__dirname, '../../frontend/public/logos/azure.svg'))).toString('base64'),
};

function providerLogoHtml(key, size = 24) {
  const src = PROVIDER_LOGO_B64[key];
  const color = PROVIDER_COLOR[key] || '#64748b';
  const short = key === 'aws' ? 'AWS' : key === 'gcp' ? 'GCP' : 'Azure';
  if (src) {
    return `<img src="${src}" alt="${short}" width="${size}" height="${size}" style="vertical-align:middle;object-fit:contain;" />`;
  }
  // Fallback: colored badge if file not found
  return `<span style="display:inline-block;background:${color};color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;vertical-align:middle;">${short}</span>`;
}

class ReportService {
  constructor() {
    this.schedules = new Map(); // email -> { time, cronJob }
    this.cacheRef  = null;

    this.transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { type: 'LOGIN', user: SMTP_USER, pass: SMTP_PASS },
      tls: { rejectUnauthorized: false },
      debug: true,
      logger: true,
    });
  }

  setCache(getter) { this.cacheRef = getter; }

  schedule(email, time) {
    if (this.schedules.has(email)) {
      this.schedules.get(email).cronJob.stop();
    }
    const [hour, minute] = time.split(':');
    const job = cron.schedule(`${minute} ${hour} * * *`, () => {
      this.sendReport(email).catch(e => console.error(`[ReportService] send error: ${e.message}`));
    });
    this.schedules.set(email, { time, cronJob: job });
  }

  unschedule(email) {
    if (!this.schedules.has(email)) return false;
    this.schedules.get(email).cronJob.stop();
    this.schedules.delete(email);
    return true;
  }

  getSchedule(email) {
    if (!this.schedules.has(email)) return null;
    return { email, time: this.schedules.get(email).time };
  }

  getAllSchedules() {
    return Array.from(this.schedules.entries()).map(([email, { time }]) => ({ email, time }));
  }

  async sendReport(email) {
    const cache = this.cacheRef ? this.cacheRef() : {};
    const alerts    = cache.alerts    || [];
    const awsRes    = cache.aws?.resources   || [];
    const gcpRes    = cache.gcp?.resources   || [];
    const azureRes  = cache.azure?.resources || [];
    const all       = [...awsRes, ...gcpRes, ...azureRes];

    const securityGroups   = awsRes.filter(r => r.type === 'Security Group');
    const routeTables      = awsRes.filter(r => r.type === 'Route Table');
    const internetGateways = awsRes
      .filter(r => r.type === 'VPC' && r.internetGateway)
      .map(r => ({ ...r.internetGateway, vpcId: r.rawId, vpcName: r.name, region: r.region }));

    const html = this._buildTemplate(alerts, all, { aws: awsRes, gcp: gcpRes, azure: azureRes }, { securityGroups, internetGateways, routeTables });
    const dateStr = new Date().toLocaleDateString('en-IN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    await this.transporter.sendMail({
      from: SMTP_FROM,
      to: email,
      subject: `CloudNexus Daily Infrastructure Report — ${dateStr}`,
      html,
    });
  }

  _buildTemplate(alerts, allResources, providers, { securityGroups = [], internetGateways = [], routeTables = [] } = {}) {
    const now      = new Date();
    const dateStr  = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr  = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    const reportId = 'CNX-' + now.getTime().toString(36).toUpperCase().slice(-8);

    const active   = alerts.filter(a => !a.acknowledged);
    const critical = active.filter(a => a.severity === 'critical');
    const warnings = active.filter(a => a.severity === 'warning');
    const infos    = active.filter(a => a.severity === 'info');

    const healthy  = allResources.filter(r => r.health === 'healthy').length;
    const warn     = allResources.filter(r => r.health === 'warning').length;
    const crit     = allResources.filter(r => r.health === 'critical').length;
    const total    = allResources.length;

    const overallStatus  = critical.length > 0 ? 'CRITICAL' : warnings.length > 0 ? 'WARNING' : 'HEALTHY';
    const statusColor    = critical.length > 0 ? '#ef4444' : warnings.length > 0 ? '#f59e0b' : '#10b981';
    const statusBg       = critical.length > 0 ? 'rgba(239,68,68,0.12)' : warnings.length > 0 ? 'rgba(245,158,11,0.12)' : 'rgba(16,185,129,0.12)';
    const statusBorder   = critical.length > 0 ? 'rgba(239,68,68,0.35)' : warnings.length > 0 ? 'rgba(245,158,11,0.35)' : 'rgba(16,185,129,0.35)';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CloudNexus Daily Infrastructure Report</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#0a1628;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a1628;">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;">

      <!-- HEADER -->
      <tr>
        <td style="background:#0c1e35;padding:48px 52px 44px;border-radius:12px 12px 0 0;">

          <!-- Branding -->
          <div style="font-size:26px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;line-height:1;margin-bottom:8px;">
            Cloud<span style="color:#3b82f6;">Nexus</span>
          </div>
          <div style="font-size:10px;color:#3d6080;font-weight:600;letter-spacing:4px;text-transform:uppercase;margin-bottom:32px;">
            Multi-Cloud Intelligence Platform
          </div>

          <!-- Rule -->
          <div style="height:1px;background:rgba(255,255,255,0.06);margin-bottom:32px;"></div>

          <!-- Title -->
          <div style="font-size:40px;font-weight:800;color:#ffffff;line-height:1.1;letter-spacing:-1.5px;margin-bottom:14px;">
            Daily Infrastructure<br>Status Report
          </div>
          <div style="font-size:14px;color:#3d6080;line-height:1.6;margin-bottom:40px;">
            Comprehensive multi-cloud infrastructure overview, alert summary, and service health digest
          </div>

          <!-- Metadata row -->
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding-right:24px;border-right:1px solid rgba(255,255,255,0.06);">
                <div style="font-size:10px;font-weight:600;color:#3d6080;text-transform:uppercase;letter-spacing:2.5px;margin-bottom:7px;">Report Date</div>
                <div style="font-size:14px;font-weight:700;color:#ffffff;">${dateStr}</div>
              </td>
              <td style="padding-left:24px;padding-right:24px;border-right:1px solid rgba(255,255,255,0.06);">
                <div style="font-size:10px;font-weight:600;color:#3d6080;text-transform:uppercase;letter-spacing:2.5px;margin-bottom:7px;">Report ID</div>
                <div style="font-size:14px;font-weight:700;color:#ffffff;">${reportId}</div>
              </td>
              <td style="padding-left:24px;padding-right:24px;border-right:1px solid rgba(255,255,255,0.06);">
                <div style="font-size:10px;font-weight:600;color:#3d6080;text-transform:uppercase;letter-spacing:2.5px;margin-bottom:7px;">Coverage</div>
                <div style="font-size:14px;font-weight:700;color:#ffffff;">All Providers</div>
              </td>
              <td style="padding-left:24px;">
                <div style="font-size:10px;font-weight:600;color:#3d6080;text-transform:uppercase;letter-spacing:2.5px;margin-bottom:7px;">Generated</div>
                <div style="font-size:14px;font-weight:700;color:#ffffff;">${timeStr} IST</div>
              </td>
            </tr>
          </table>

          <!-- Provider badges with logos -->
          <table cellpadding="0" cellspacing="0" style="margin-top:32px;">
            <tr>
              <td style="padding-right:10px;">
                <span style="display:inline-block;background:rgba(255,153,0,0.13);border:1.5px solid #FF9900;color:#FF9900;border-radius:100px;padding:6px 18px 6px 8px;font-size:12px;font-weight:600;letter-spacing:0.3px;">
                  <span style="display:inline-block;background:#ffffff;border-radius:50%;width:20px;height:20px;vertical-align:middle;text-align:center;margin-right:6px;line-height:20px;">${providerLogoHtml('aws', 14)}</span>Amazon AWS</span>
              </td>
              <td style="padding-right:10px;">
                <span style="display:inline-block;background:rgba(66,133,244,0.13);border:1.5px solid rgba(66,133,244,0.55);color:#6aacff;border-radius:100px;padding:6px 18px 6px 8px;font-size:12px;font-weight:600;letter-spacing:0.3px;">
                  <span style="display:inline-block;background:#ffffff;border-radius:50%;width:20px;height:20px;vertical-align:middle;text-align:center;margin-right:6px;line-height:20px;">${providerLogoHtml('gcp', 14)}</span>Google Cloud</span>
              </td>
              <td>
                <span style="display:inline-block;background:rgba(0,120,212,0.13);border:1.5px solid rgba(0,120,212,0.55);color:#6aacff;border-radius:100px;padding:6px 18px 6px 8px;font-size:12px;font-weight:600;letter-spacing:0.3px;">
                  <span style="display:inline-block;background:#ffffff;border-radius:50%;width:20px;height:20px;vertical-align:middle;text-align:center;margin-right:6px;line-height:20px;">${providerLogoHtml('azure', 14)}</span>Microsoft Azure</span>
              </td>
            </tr>
          </table>

          <!-- Status banner -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:32px;">
            <tr>
              <td style="background:${statusBg};border:1px solid ${statusBorder};border-radius:8px;padding:14px 20px;">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td>
                      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor};vertical-align:middle;margin-right:8px;"></span>
                      <span style="font-size:13px;font-weight:700;color:${statusColor};vertical-align:middle;">Infrastructure Status: ${overallStatus}</span>
                    </td>
                    <td align="right">
                      <span style="font-size:12px;color:#3d6080;">${total} resources monitored</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- SUMMARY STATS -->
      <tr>
        <td style="background:#ffffff;padding:32px 44px 24px;">
          <div style="font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:2.5px;margin-bottom:20px;">Today's Summary</div>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              ${this._statCard('Active Alerts',    active.length,    '#ef4444')}
              ${this._statCard('Critical',         critical.length,  '#dc2626')}
              ${this._statCard('Warnings',         warnings.length,  '#f59e0b')}
              ${this._statCard('Info Alerts',      infos.length,     '#3b82f6')}
            </tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;">
            <tr>
              ${this._statCard('Total Resources',  total,            '#6366f1')}
              ${this._statCard('Healthy',          healthy,          '#10b981')}
              ${this._statCard('Degraded',         warn,             '#f59e0b')}
              ${this._statCard('Critical Svcs',    crit,             '#dc2626')}
            </tr>
          </table>
        </td>
      </tr>

      <!-- DIVIDER -->
      <tr><td style="background:#ffffff;padding:0 44px;"><div style="height:1px;background:#f1f5f9;"></div></td></tr>

      <!-- PROVIDER HEALTH -->
      <tr>
        <td style="background:#ffffff;padding:28px 44px;">
          <div style="font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:2.5px;margin-bottom:20px;">Provider Health</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
            ${this._providerRow('aws',   providers.aws   || [])}
            ${this._providerRow('gcp',   providers.gcp   || [])}
            ${this._providerRow('azure', providers.azure || [])}
          </table>
        </td>
      </tr>

      <!-- DIVIDER -->
      <tr><td style="background:#ffffff;padding:0 44px;"><div style="height:1px;background:#f1f5f9;"></div></td></tr>

      <!-- ACTIVE ALERTS -->
      <tr>
        <td style="background:#ffffff;padding:28px 44px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
            <tr>
              <td>
                <div style="font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:2.5px;">Active Alerts</div>
              </td>
              <td align="right">
                ${active.length > 0
                  ? `<span style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:600;">${active.length} unresolved</span>`
                  : `<span style="background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:600;">All clear</span>`}
              </td>
            </tr>
          </table>
          ${active.length === 0
            ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:28px;text-align:center;">
                <div style="font-size:15px;font-weight:600;color:#16a34a;margin-bottom:4px;">No Active Alerts</div>
                <div style="font-size:12px;color:#86efac;">Your infrastructure is running smoothly.</div>
               </div>`
            : `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                <tr style="background:#f8fafc;">
                  <td style="padding:10px 14px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e2e8f0;">Severity</td>
                  <td style="padding:10px 14px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e2e8f0;">Alert</td>
                  <td style="padding:10px 14px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e2e8f0;">Provider</td>
                  <td style="padding:10px 14px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e2e8f0;">Service</td>
                  <td style="padding:10px 14px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e2e8f0;">Time</td>
                </tr>
                ${active.slice(0, 30).map((a, i) => this._alertRow(a, i)).join('')}
                ${active.length > 30 ? `<tr><td colspan="5" style="padding:12px 14px;text-align:center;font-size:12px;color:#94a3b8;background:#f8fafc;border-top:1px solid #e2e8f0;">+${active.length - 30} more alerts</td></tr>` : ''}
               </table>`
          }
        </td>
      </tr>

      ${allResources.length > 0 ? `
      <!-- DIVIDER -->
      <tr><td style="background:#ffffff;padding:0 44px;"><div style="height:1px;background:#f1f5f9;"></div></td></tr>

      <!-- SERVICE HEALTH -->
      <tr>
        <td style="background:#ffffff;padding:28px 44px 36px;">
          <div style="font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:2.5px;margin-bottom:20px;">Service Health Breakdown</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
            <tr style="background:#f8fafc;">
              <td style="padding:10px 14px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e2e8f0;">Service</td>
              <td style="padding:10px 14px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e2e8f0;">Provider</td>
              <td style="padding:10px 14px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e2e8f0;">Type</td>
              <td style="padding:10px 14px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e2e8f0;">Region</td>
              <td style="padding:10px 14px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e2e8f0;">Health</td>
              <td style="padding:10px 14px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e2e8f0;">CPU</td>
            </tr>
            ${allResources.slice(0, 25).map((r, i) => this._resourceRow(r, i)).join('')}
            ${allResources.length > 25 ? `<tr><td colspan="6" style="padding:12px 14px;text-align:center;font-size:12px;color:#94a3b8;background:#f8fafc;border-top:1px solid #e2e8f0;">+${allResources.length - 25} more services</td></tr>` : ''}
          </table>
        </td>
      </tr>
      ` : ''}

      ${securityGroups.length > 0 ? `
      <!-- DIVIDER -->
      <tr><td style="background:#ffffff;padding:0 44px;"><div style="height:1px;background:#f1f5f9;"></div></td></tr>

      <!-- SECURITY GROUPS -->
      <tr>
        <td style="background:#ffffff;padding:28px 44px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
            <tr>
              <td><div style="font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:2.5px;">Security Groups</div></td>
              <td align="right"><span style="background:#eff6ff;color:#3b82f6;border:1px solid #bfdbfe;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:600;">${securityGroups.length} groups</span></td>
            </tr>
          </table>
          ${securityGroups.slice(0, 20).map((sg, i) => this._sgSection(sg, i)).join('')}
          ${securityGroups.length > 20 ? `<div style="padding:10px 0;text-align:center;font-size:12px;color:#94a3b8;">+${securityGroups.length - 20} more security groups</div>` : ''}
        </td>
      </tr>
      ` : ''}

      ${internetGateways.length > 0 ? `
      <!-- DIVIDER -->
      <tr><td style="background:#ffffff;padding:0 44px;"><div style="height:1px;background:#f1f5f9;"></div></td></tr>

      <!-- INTERNET GATEWAYS -->
      <tr>
        <td style="background:#ffffff;padding:28px 44px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
            <tr>
              <td><div style="font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:2.5px;">Internet Gateways</div></td>
              <td align="right"><span style="background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:600;">${internetGateways.length} gateways</span></td>
            </tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
            <tr style="background:#f8fafc;">
              <td style="padding:10px 14px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e2e8f0;">Gateway ID</td>
              <td style="padding:10px 14px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e2e8f0;">VPC</td>
              <td style="padding:10px 14px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e2e8f0;">State</td>
              <td style="padding:10px 14px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e2e8f0;">Region</td>
            </tr>
            ${internetGateways.map((igw, i) => this._igwRow(igw, i)).join('')}
          </table>
        </td>
      </tr>
      ` : ''}

      ${routeTables.length > 0 ? `
      <!-- DIVIDER -->
      <tr><td style="background:#ffffff;padding:0 44px;"><div style="height:1px;background:#f1f5f9;"></div></td></tr>

      <!-- ROUTE TABLES -->
      <tr>
        <td style="background:#ffffff;padding:28px 44px 36px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
            <tr>
              <td><div style="font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:2.5px;">Route Tables</div></td>
              <td align="right"><span style="background:#faf5ff;color:#7c3aed;border:1px solid #ddd6fe;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:600;">${routeTables.length} tables</span></td>
            </tr>
          </table>
          ${routeTables.slice(0, 15).map((rt, i) => this._rtSection(rt, i)).join('')}
          ${routeTables.length > 15 ? `<div style="padding:10px 0;text-align:center;font-size:12px;color:#94a3b8;">+${routeTables.length - 15} more route tables</div>` : ''}
        </td>
      </tr>
      ` : ''}

      <!-- FOOTER -->
      <tr>
        <td style="background:#0c1e35;border-radius:0 0 12px 12px;padding:28px 52px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <div style="font-size:18px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;margin-bottom:4px;">
                  Cloud<span style="color:#3b82f6;">Nexus</span>
                </div>
                <div style="font-size:11px;color:#2a4a65;margin-top:2px;">Automated Infrastructure Intelligence</div>
              </td>
              <td align="right" valign="middle">
                <div style="font-size:11px;color:#2a4a65;line-height:1.8;">
                  <div>Generated: ${timeStr} IST</div>
                  <div>© ${now.getFullYear()} CloudNexus Monitor</div>
                </div>
              </td>
            </tr>
          </table>
          <div style="height:1px;background:rgba(255,255,255,0.05);margin:20px 0 16px;"></div>
          <div style="font-size:11px;color:#2a4a65;line-height:1.8;">
            You are receiving this report because daily CloudNexus reports are enabled for this address.
            To update your schedule or unsubscribe, open the <strong style="color:#3b82f6;">CloudNexus Dashboard</strong> and go to Alerts &rarr; Daily Reports.
          </div>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
  }

  _statCard(label, value, color) {
    return `
    <td width="25%" style="padding:0 5px;">
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-top:3px solid ${color};border-radius:8px;padding:18px 14px;text-align:center;">
        <div style="font-size:30px;font-weight:800;color:${color};line-height:1;margin-bottom:7px;">${value}</div>
        <div style="font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:1px;">${label}</div>
      </div>
    </td>`;
  }

  _providerRow(key, resources) {
    const total   = resources.length;
    const healthy = resources.filter(r => r.health === 'healthy').length;
    const warn    = resources.filter(r => r.health === 'warning').length;
    const crit    = resources.filter(r => r.health === 'critical').length;
    const color   = PROVIDER_COLOR[key] || '#64748b';
    const label   = PROVIDER_LABEL[key] || key.toUpperCase();
    const pct     = total > 0 ? Math.round((healthy / total) * 100) : 0;

    return `
    <tr>
      <td style="padding:12px 14px;border-bottom:1px solid #f1f5f9;vertical-align:middle;">
        <table cellpadding="0" cellspacing="0"><tr>
          <td style="padding-right:10px;vertical-align:middle;">
            <div style="width:36px;height:36px;background:${color}18;border-radius:8px;display:flex;align-items:center;justify-content:center;padding:6px;box-sizing:border-box;">
              ${providerLogoHtml(key, 24)}
            </div>
          </td>
          <td style="vertical-align:middle;">
            <div style="font-size:13px;font-weight:600;color:#1e293b;">${label}</div>
            <div style="font-size:11px;color:#64748b;margin-top:1px;">${total} resources</div>
          </td>
        </tr></table>
      </td>
      <td style="padding:12px 14px;border-bottom:1px solid #f1f5f9;">
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding-right:12px;">
              <span style="background:#f0fdf4;color:#16a34a;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:600;">✓ ${healthy} healthy</span>
            </td>
            <td style="padding-right:12px;">
              <span style="background:#fffbeb;color:#d97706;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:600;">⚠ ${warn} warning</span>
            </td>
            <td>
              <span style="background:#fef2f2;color:#dc2626;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:600;">✗ ${crit} critical</span>
            </td>
          </tr>
        </table>
      </td>
      <td style="padding:12px 14px;border-bottom:1px solid #f1f5f9;text-align:right;vertical-align:middle;">
        <div style="font-size:13px;font-weight:700;color:${pct >= 80 ? '#16a34a' : pct >= 50 ? '#d97706' : '#dc2626'};">${pct}% healthy</div>
      </td>
    </tr>`;
  }

  _alertRow(alert, index) {
    const bg       = index % 2 === 0 ? '#ffffff' : '#f8fafc';
    const sevColor = SEVERITY_COLOR[alert.severity] || '#64748b';
    const sevBg    = alert.severity === 'critical' ? '#fef2f2' : alert.severity === 'warning' ? '#fffbeb' : '#eff6ff';
    const sevIcon  = alert.severity === 'critical' ? '🔴' : alert.severity === 'warning' ? '🟡' : '🔵';
    const provColor = PROVIDER_COLOR[alert.provider] || '#64748b';
    const prov     = (alert.provider || '').toUpperCase();
    const timeLabel = alert.time ? new Date(alert.time).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:true }) : '—';

    return `
    <tr style="background:${bg};">
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;vertical-align:middle;">
        <span style="background:${sevBg};color:${sevColor};padding:3px 8px;border-radius:6px;font-size:11px;font-weight:600;white-space:nowrap;">
          ${sevIcon} ${(alert.severity || '').toUpperCase()}
        </span>
      </td>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;vertical-align:middle;">
        <div style="font-size:12px;font-weight:600;color:#1e293b;">${this._escape(alert.title || '')}</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px;">${this._escape((alert.message || '').substring(0, 80))}${(alert.message || '').length > 80 ? '...' : ''}</div>
      </td>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;vertical-align:middle;">
        <span style="background:${provColor}15;color:${provColor};padding:3px 8px;border-radius:6px;font-size:11px;font-weight:600;">${prov}</span>
      </td>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;vertical-align:middle;">
        <div style="font-size:11px;color:#475569;">${this._escape(alert.service || alert.region || '—')}</div>
      </td>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;vertical-align:middle;white-space:nowrap;">
        <div style="font-size:11px;color:#64748b;">${timeLabel}</div>
      </td>
    </tr>`;
  }

  _resourceRow(r, index) {
    const bg        = index % 2 === 0 ? '#ffffff' : '#f8fafc';
    const health    = r.health || 'unknown';
    const hColor    = HEALTH_COLOR[health] || '#6b7280';
    const hBg       = health === 'healthy' ? '#f0fdf4' : health === 'warning' ? '#fffbeb' : health === 'critical' ? '#fef2f2' : '#f8fafc';
    const hIcon     = health === 'healthy' ? '✓' : health === 'warning' ? '⚠' : health === 'critical' ? '✗' : '?';
    const provColor = PROVIDER_COLOR[r.provider] || '#64748b';
    const cpu       = r.cpu != null ? `${Math.round(r.cpu)}%` : '—';

    return `
    <tr style="background:${bg};">
      <td style="padding:9px 14px;border-bottom:1px solid #f1f5f9;vertical-align:middle;">
        <div style="font-size:12px;font-weight:600;color:#1e293b;">${this._escape(r.name || r.id || '—')}</div>
      </td>
      <td style="padding:9px 14px;border-bottom:1px solid #f1f5f9;vertical-align:middle;">
        <span style="background:${provColor}15;color:${provColor};padding:2px 7px;border-radius:5px;font-size:11px;font-weight:600;">${(r.provider || '').toUpperCase()}</span>
      </td>
      <td style="padding:9px 14px;border-bottom:1px solid #f1f5f9;vertical-align:middle;">
        <div style="font-size:11px;color:#475569;">${this._escape(r.type || r.family || '—')}</div>
      </td>
      <td style="padding:9px 14px;border-bottom:1px solid #f1f5f9;vertical-align:middle;">
        <div style="font-size:11px;color:#475569;">${this._escape(r.region || '—')}</div>
      </td>
      <td style="padding:9px 14px;border-bottom:1px solid #f1f5f9;vertical-align:middle;">
        <span style="background:${hBg};color:${hColor};padding:2px 7px;border-radius:5px;font-size:11px;font-weight:600;">${hIcon} ${health}</span>
      </td>
      <td style="padding:9px 14px;border-bottom:1px solid #f1f5f9;vertical-align:middle;text-align:center;">
        <div style="font-size:11px;color:${r.cpu > 80 ? '#dc2626' : r.cpu > 60 ? '#d97706' : '#16a34a'};font-weight:600;">${cpu}</div>
      </td>
    </tr>`;
  }

  _escape(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  _portRange(rule) {
    if (rule.protocol === 'All') return '<span style="color:#94a3b8;font-style:italic;">All Traffic</span>';
    if (rule.fromPort == null) return '<span style="color:#94a3b8;font-style:italic;">All</span>';
    if (rule.fromPort === rule.toPort) return `<strong>${rule.fromPort}</strong>`;
    return `<strong>${rule.fromPort}</strong>&ndash;<strong>${rule.toPort}</strong>`;
  }

  _sourceBadges(entries) {
    if (!entries || !entries.length) return '<span style="color:#94a3b8;">—</span>';
    return entries.map(src => {
      const val = typeof src === 'string' ? src : src.value || '';
      const isSG = val.startsWith('sg-');
      if (isSG) {
        const label = (typeof src === 'object' && src.name) ? `${val} (${this._escape(src.name)})` : val;
        return `<span style="display:inline-block;background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;border-radius:4px;padding:1px 7px;font-size:10px;font-weight:600;margin:1px 2px 1px 0;">${this._escape(label)}</span>`;
      }
      const desc = (typeof src === 'object' && src.desc) ? ` <span style="color:#94a3b8;">(${this._escape(src.desc)})</span>` : '';
      return `<span style="font-size:11px;color:#475569;">${this._escape(val)}${desc}</span>`;
    }).join(' ');
  }

  _sgSection(sg, index) {
    const inRules  = sg.inboundRules  || [];
    const outRules = sg.outboundRules || [];
    const borderColor = index % 2 === 0 ? '#e2e8f0' : '#e2e8f0';

    const rulesTable = (rules, dir) => {
      const isIn = dir === 'in';
      const accentColor  = isIn ? '#2563eb' : '#059669';
      const headerBg     = isIn ? '#eff6ff'  : '#f0fdf4';
      const headerBorder = isIn ? '#bfdbfe'  : '#bbf7d0';
      const colLabel     = isIn ? 'Source'   : 'Destination';
      if (!rules.length) return `<div style="padding:8px 16px 12px;font-size:11px;color:#94a3b8;font-style:italic;">No ${isIn ? 'inbound' : 'outbound'} rules defined.</div>`;
      return `
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:1px solid #f1f5f9;">
        <tr style="background:${headerBg};">
          <td style="padding:8px 14px;font-size:10px;font-weight:700;color:${accentColor};text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid ${headerBorder};width:80px;">Protocol</td>
          <td style="padding:8px 14px;font-size:10px;font-weight:700;color:${accentColor};text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid ${headerBorder};width:110px;">Port Range</td>
          <td style="padding:8px 14px;font-size:10px;font-weight:700;color:${accentColor};text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid ${headerBorder};">${colLabel}</td>
        </tr>
        ${rules.map((rule, ri) => `
        <tr style="background:${ri % 2 === 0 ? '#ffffff' : '#fafafa'};">
          <td style="padding:8px 14px;font-size:11px;color:#334155;border-bottom:1px solid #f1f5f9;">${this._escape(String(rule.protocol))}</td>
          <td style="padding:8px 14px;font-size:11px;color:#334155;border-bottom:1px solid #f1f5f9;">${this._portRange(rule)}</td>
          <td style="padding:8px 14px;font-size:11px;border-bottom:1px solid #f1f5f9;">${this._sourceBadges(isIn ? rule.sources : rule.destinations)}</td>
        </tr>`).join('')}
      </table>`;
    };

    return `
    <div style="margin-bottom:14px;border:1px solid ${borderColor};border-radius:8px;overflow:hidden;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;">
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;">
            <div style="font-size:13px;font-weight:700;color:#0f172a;">${this._escape(sg.name)}</div>
            <div style="margin-top:3px;">
              <span style="font-size:10px;color:#64748b;font-family:monospace;">${sg.rawId}</span>
              &nbsp;&bull;&nbsp;
              <span style="font-size:10px;color:#64748b;">VPC: ${this._escape(sg.vpcId || '—')}</span>
              &nbsp;&bull;&nbsp;
              <span style="font-size:10px;color:#64748b;">${this._escape(sg.region || '')}</span>
              ${sg.description ? `&nbsp;&bull;&nbsp;<span style="font-size:10px;color:#94a3b8;">${this._escape(sg.description)}</span>` : ''}
            </div>
          </td>
          <td align="right" style="padding:12px 16px;border-bottom:1px solid #e2e8f0;white-space:nowrap;">
            <span style="background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;padding:2px 9px;border-radius:4px;font-size:10px;font-weight:700;margin-right:4px;">${inRules.length} inbound</span>
            <span style="background:#f0fdf4;color:#059669;border:1px solid #bbf7d0;padding:2px 9px;border-radius:4px;font-size:10px;font-weight:700;">${outRules.length} outbound</span>
          </td>
        </tr>
      </table>
      <div style="padding:0 0 0 0;">
        <div style="padding:8px 16px 4px;font-size:10px;font-weight:700;color:#2563eb;text-transform:uppercase;letter-spacing:1px;">Inbound Rules</div>
        ${rulesTable(inRules, 'in')}
        <div style="padding:12px 16px 4px;font-size:10px;font-weight:700;color:#059669;text-transform:uppercase;letter-spacing:1px;">Outbound Rules</div>
        ${rulesTable(outRules, 'out')}
      </div>
    </div>`;
  }

  _igwRow(igw, index) {
    const bg = index % 2 === 0 ? '#ffffff' : '#f8fafc';
    const stateColor = (igw.state || '').toLowerCase() === 'available' ? '#059669' : '#d97706';
    const stateBg    = (igw.state || '').toLowerCase() === 'available' ? '#f0fdf4'  : '#fffbeb';
    return `
    <tr style="background:${bg};">
      <td style="padding:11px 14px;border-bottom:1px solid #f1f5f9;font-size:12px;font-weight:600;color:#0f172a;font-family:monospace;">${this._escape(igw.id || '—')}</td>
      <td style="padding:11px 14px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#475569;">${this._escape(igw.vpcId || '—')}${igw.vpcName && igw.vpcName !== igw.vpcId ? ` <span style="color:#94a3b8;">(${this._escape(igw.vpcName)})</span>` : ''}</td>
      <td style="padding:11px 14px;border-bottom:1px solid #f1f5f9;">
        <span style="background:${stateBg};color:${stateColor};padding:2px 9px;border-radius:4px;font-size:11px;font-weight:600;">${this._escape(igw.state || '—')}</span>
      </td>
      <td style="padding:11px 14px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#64748b;">${this._escape(igw.region || '—')}</td>
    </tr>`;
  }

  _rtSection(rt, index) {
    const associations = rt.associations || [];
    const subnets      = associations.filter(a => a.subnetId).map(a => a.subnetId);
    const isMain       = rt.isMain || associations.some(a => a.isMain);
    const routes       = rt.routes || [];

    return `
    <div style="margin-bottom:14px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;">
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;">
            <div style="font-size:13px;font-weight:700;color:#0f172a;">
              ${this._escape(rt.name)}
              ${isMain ? `<span style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;padding:1px 7px;border-radius:4px;font-size:10px;font-weight:700;margin-left:7px;vertical-align:middle;">MAIN</span>` : ''}
            </div>
            <div style="margin-top:3px;">
              <span style="font-size:10px;color:#64748b;font-family:monospace;">${rt.rawId}</span>
              &nbsp;&bull;&nbsp;
              <span style="font-size:10px;color:#64748b;">VPC: ${this._escape(rt.vpcId || '—')}</span>
              &nbsp;&bull;&nbsp;
              <span style="font-size:10px;color:#64748b;">${this._escape(rt.region || '')}</span>
              ${subnets.length ? `&nbsp;&bull;&nbsp;<span style="font-size:10px;color:#94a3b8;">Subnets: ${subnets.map(s => this._escape(s)).join(', ')}</span>` : ''}
            </div>
          </td>
          <td align="right" style="padding:12px 16px;border-bottom:1px solid #e2e8f0;white-space:nowrap;">
            <span style="background:#faf5ff;color:#7c3aed;border:1px solid #ddd6fe;padding:2px 9px;border-radius:4px;font-size:10px;font-weight:700;">${routes.length} routes</span>
          </td>
        </tr>
      </table>
      ${routes.length > 0 ? `
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr style="background:#faf5ff;">
          <td style="padding:8px 14px;font-size:10px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #ddd6fe;width:180px;">Destination</td>
          <td style="padding:8px 14px;font-size:10px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #ddd6fe;">Target</td>
          <td style="padding:8px 14px;font-size:10px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #ddd6fe;width:80px;">Status</td>
          <td style="padding:8px 14px;font-size:10px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #ddd6fe;width:100px;">Origin</td>
        </tr>
        ${routes.map((route, ri) => {
          const t = route.target || '';
          const targetColor = t.startsWith('igw-') ? '#2563eb' : t.startsWith('nat-') ? '#7c3aed' : t === 'local' ? '#059669' : t.startsWith('tgw-') ? '#d97706' : '#475569';
          const stateBg    = route.state === 'active' ? '#f0fdf4' : '#fef2f2';
          const stateColor = route.state === 'active' ? '#059669' : '#dc2626';
          return `
          <tr style="background:${ri % 2 === 0 ? '#ffffff' : '#fafafa'};">
            <td style="padding:8px 14px;font-size:11px;font-weight:600;color:#0f172a;border-bottom:1px solid #f1f5f9;font-family:monospace;">${this._escape(route.destination)}</td>
            <td style="padding:8px 14px;font-size:11px;color:${targetColor};font-weight:600;border-bottom:1px solid #f1f5f9;font-family:monospace;">${this._escape(t)}</td>
            <td style="padding:8px 14px;border-bottom:1px solid #f1f5f9;">
              <span style="background:${stateBg};color:${stateColor};padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;">${this._escape(route.state || '—')}</span>
            </td>
            <td style="padding:8px 14px;font-size:10px;color:#94a3b8;border-bottom:1px solid #f1f5f9;">${this._escape(route.origin || '—')}</td>
          </tr>`;
        }).join('')}
      </table>` : '<div style="padding:12px 16px;font-size:11px;color:#94a3b8;font-style:italic;">No routes defined.</div>'}
    </div>`;
  }
}

module.exports = ReportService;
