import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

// ─── Colour palette ───────────────────────────────────────────────────────────
const C = {
  navy:    [8,  18,  50],
  navyMid: [14, 28,  72],
  blue:    [59, 130, 246],
  aws:     [255,153,  0],
  gcp:     [66, 133, 244],
  azure:   [0,  138, 215],
  healthy: [34, 197,  94],
  warning: [234,179,   8],
  critical:[239, 68,  68],
  white:   [255,255, 255],
  gray1:   [148,163, 184],
  gray2:   [30,  41,  59],
  gray3:   [51,  65,  85],
  rowAlt:  [241,245, 249],
  rowDark: [248,250, 252],
};

const PROVIDER_COLORS = { aws: C.aws, gcp: C.gcp, azure: C.azure, all: C.blue };
const PROVIDER_LABELS = { aws: 'Amazon Web Services', gcp: 'Google Cloud Platform', azure: 'Microsoft Azure', all: 'All Cloud Providers' };
const HEALTH_COLORS   = { healthy: C.healthy, warning: C.warning, critical: C.critical };

function healthColor(h)  { return HEALTH_COLORS[h] || C.gray1; }
function usd(v)          { return `$${(v||0).toFixed(2)}`; }
function pct(v)          { return v != null ? `${v}%` : '—'; }
function strOrDash(v)    { return v != null && v !== '' ? String(v) : '—'; }
function ts()            { return new Date().toLocaleString('en-US', { dateStyle:'long', timeStyle:'short' }); }

// ─── PDF helpers ──────────────────────────────────────────────────────────────
function addPageHeader(doc, title, providerKey, pageNum, totalPages) {
  const W = doc.internal.pageSize.getWidth();
  const pColor = PROVIDER_COLORS[providerKey] || C.blue;

  // Dark header bar
  doc.setFillColor(...C.navy);
  doc.rect(0, 0, W, 18, 'F');

  // Provider accent bar (left strip)
  doc.setFillColor(...pColor);
  doc.rect(0, 0, 4, 18, 'F');

  // Logo
  doc.setTextColor(...C.white);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('CloudNexus', 9, 11);

  // Separator dot
  doc.setTextColor(...C.gray1);
  doc.setFontSize(9);
  doc.text('·', 38, 11);

  // Page title
  doc.setTextColor(200, 215, 240);
  doc.setFont('helvetica', 'normal');
  doc.text(title, 43, 11);

  // Right: page number + date
  doc.setFontSize(8);
  doc.setTextColor(...C.gray1);
  doc.text(`Page ${pageNum} / ${totalPages}`, W - 10, 7, { align: 'right' });
  doc.text(ts(), W - 10, 13, { align: 'right' });
}

function addPageFooter(doc) {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  doc.setDrawColor(...C.gray3);
  doc.setLineWidth(0.2);
  doc.line(10, H - 8, W - 10, H - 8);
  doc.setFontSize(7.5);
  doc.setTextColor(...C.gray1);
  doc.setFont('helvetica', 'normal');
  doc.text('CloudNexus — Multi-Cloud Monitoring Platform  |  Confidential', 10, H - 4);
  doc.text('This report is auto-generated. Data reflects the most recent refresh.', W - 10, H - 4, { align: 'right' });
}

function coverPage(doc, providerKey, services, alerts) {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const pColor = PROVIDER_COLORS[providerKey] || C.blue;

  // Full dark background
  doc.setFillColor(...C.navy);
  doc.rect(0, 0, W, H, 'F');

  // Left accent bar
  doc.setFillColor(...pColor);
  doc.rect(0, 0, 6, H, 'F');

  // Blue glow stripe
  doc.setFillColor(...C.navyMid);
  doc.rect(6, 0, W * 0.55, H, 'F');

  // ── Logo area ──
  doc.setTextColor(...pColor);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(42);
  doc.text('CloudNexus', 22, 55);

  // Underline accent
  doc.setDrawColor(...pColor);
  doc.setLineWidth(1.2);
  doc.line(22, 59, 22 + doc.getTextWidth('CloudNexus') * 0.98, 59);

  // Tagline
  doc.setTextColor(...C.gray1);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(13);
  doc.text('Multi-Cloud Infrastructure Report', 22, 70);

  // Report type badge
  const label = PROVIDER_LABELS[providerKey] || 'All Providers';
  doc.setFillColor(...pColor);
  doc.roundedRect(22, 78, doc.getTextWidth(label) + 12, 10, 2, 2, 'F');
  doc.setTextColor(...C.white);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.text(label, 28, 84.5);

  // ── Metrics summary (right panel) ──
  const healthy  = services.filter(s => s.health === 'healthy').length;
  const warning  = services.filter(s => s.health === 'warning').length;
  const critical = services.filter(s => s.health === 'critical').length;
  const totalCost = services.reduce((a, s) => a + (s.cost || 0), 0);
  const regions   = [...new Set(services.map(s => s.region).filter(Boolean))].length;

  const cards = [
    { label: 'Total Services',    value: String(services.length), color: C.blue },
    { label: 'Healthy',           value: String(healthy),         color: C.healthy },
    { label: 'Warning',           value: String(warning),         color: C.warning },
    { label: 'Critical',          value: String(critical),        color: C.critical },
    { label: 'Active Alerts',     value: String(alerts.filter(a => !a.acknowledged).length), color: C.warning },
    { label: 'Active Regions',    value: String(regions),         color: C.blue },
    { label: 'MTD Estimated Cost',value: `$${Math.round(totalCost).toLocaleString()}`, color: C.aws },
  ];

  const startX = W * 0.6;
  let cy = 36;

  cards.forEach(card => {
    doc.setFillColor(20, 35, 75);
    doc.roundedRect(startX, cy, W - startX - 12, 16, 2, 2, 'F');
    doc.setDrawColor(...card.color);
    doc.setLineWidth(0.5);
    doc.roundedRect(startX, cy, W - startX - 12, 16, 2, 2, 'S');
    // Left color strip
    doc.setFillColor(...card.color);
    doc.roundedRect(startX, cy, 3, 16, 1, 1, 'F');
    // Label
    doc.setTextColor(...C.gray1);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(card.label, startX + 8, cy + 6);
    // Value
    doc.setTextColor(...card.color);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text(card.value, startX + 8, cy + 13);
    cy += 20;
  });

  // ── Generated by / date ──
  doc.setTextColor(...C.gray1);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Generated: ${ts()}`, 22, H - 20);
  doc.text(`CloudNexus — Confidential`, 22, H - 14);

  addPageFooter(doc);
}

// ─── Build service rows ───────────────────────────────────────────────────────
function serviceRows(services) {
  return services.map(s => [
    strOrDash(s.name),
    strOrDash(s.type),
    strOrDash(s.family),
    strOrDash(s.region),
    strOrDash(s.health),
    strOrDash(s.status),
    usd(s.cost),
    pct(s.cpu),
    strOrDash(s.instanceType || s.machineType || s.size || '—'),
  ]);
}

// ─── Main PDF generator ───────────────────────────────────────────────────────
export function generatePDF(services, alerts, providerKey) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();

  const pColor = PROVIDER_COLORS[providerKey] || C.blue;

  // Group by provider for "all" report
  const groups = providerKey === 'all'
    ? [
        { key: 'aws',   label: 'Amazon Web Services (AWS)',   svcs: services.filter(s => s.provider === 'aws')   },
        { key: 'gcp',   label: 'Google Cloud Platform (GCP)', svcs: services.filter(s => s.provider === 'gcp')   },
        { key: 'azure', label: 'Microsoft Azure',             svcs: services.filter(s => s.provider === 'azure') },
      ].filter(g => g.svcs.length > 0)
    : [{ key: providerKey, label: PROVIDER_LABELS[providerKey], svcs: services }];

  // Count total pages: cover + groups + alerts
  const totalPages = 1 + groups.length + (alerts.length > 0 ? 1 : 0);
  let pageNum = 1;

  // ── Cover page ──
  coverPage(doc, providerKey, services, alerts);

  // ── Per-provider / per-group service tables ──
  groups.forEach(group => {
    doc.addPage();
    pageNum++;
    addPageHeader(doc, `${group.label} — Services`, group.key, pageNum, totalPages);

    const healthy  = group.svcs.filter(s => s.health === 'healthy').length;
    const warning  = group.svcs.filter(s => s.health === 'warning').length;
    const critical = group.svcs.filter(s => s.health === 'critical').length;
    const totalCost = group.svcs.reduce((a, s) => a + (s.cost || 0), 0);
    const gc = PROVIDER_COLORS[group.key] || C.blue;

    // Summary strip
    doc.setFillColor(gc[0], gc[1], gc[2], 0.08);
    doc.setFillColor(20, 30, 60);
    doc.rect(0, 18, W, 18, 'F');

    const summaryItems = [
      { label: 'Total', value: group.svcs.length, color: C.white },
      { label: 'Healthy', value: healthy, color: C.healthy },
      { label: 'Warning', value: warning, color: C.warning },
      { label: 'Critical', value: critical, color: C.critical },
      { label: 'Est. MTD Cost', value: `$${Math.round(totalCost).toLocaleString()}`, color: C.aws },
    ];

    let sx = 12;
    summaryItems.forEach(item => {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(14);
      doc.setTextColor(...item.color);
      doc.text(String(item.value), sx, 30);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(...C.gray1);
      doc.text(item.label, sx, 34);
      sx += 46;
    });

    // Services table
    const rows = serviceRows(group.svcs);
    autoTable(doc, {
      startY: 38,
      head: [['Service Name', 'Type', 'Family', 'Region', 'Health', 'Status', 'Cost/Mo', 'CPU %', 'Instance Type']],
      body: rows,
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2.5, font: 'helvetica', textColor: [30, 41, 59] },
      headStyles: {
        fillColor: gc, textColor: [255, 255, 255],
        fontStyle: 'bold', fontSize: 8.5,
      },
      alternateRowStyles: { fillColor: C.rowAlt },
      bodyStyles: { fillColor: C.rowDark },
      columnStyles: {
        0: { fontStyle: 'bold', cellWidth: 38 },
        4: { fontStyle: 'bold' },
        6: { halign: 'right' },
        7: { halign: 'right' },
      },
      didParseCell(data) {
        if (data.section === 'body' && data.column.index === 4) {
          const v = data.cell.raw?.toLowerCase();
          if (v === 'critical') data.cell.styles.textColor = C.critical;
          else if (v === 'warning') data.cell.styles.textColor = C.warning;
          else if (v === 'healthy') data.cell.styles.textColor = C.healthy;
        }
      },
      margin: { top: 38, left: 8, right: 8 },
    });

    addPageFooter(doc);
  });

  // ── Alerts page ──
  if (alerts.length > 0) {
    doc.addPage();
    pageNum++;
    addPageHeader(doc, 'Alerts & Anomalies', providerKey, pageNum, totalPages);

    const activeAlerts = alerts.filter(a => !a.acknowledged);
    doc.setFillColor(20, 30, 60);
    doc.rect(0, 18, W, 12, 'F');
    doc.setTextColor(...C.white);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(`Total: ${alerts.length}   Active: ${activeAlerts.length}   Acknowledged: ${alerts.length - activeAlerts.length}`, 12, 26);

    const alertRows = alerts.map(a => [
      a.severity?.toUpperCase() || '—',
      strOrDash(a.service || a.resource),
      strOrDash(a.message || a.title),
      strOrDash(a.region),
      a.acknowledged ? 'Acknowledged' : 'Active',
      a.timestamp ? new Date(a.timestamp).toLocaleString() : '—',
    ]);

    autoTable(doc, {
      startY: 32,
      head: [['Severity', 'Service', 'Message', 'Region', 'Status', 'Timestamp']],
      body: alertRows,
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2.5, textColor: [30, 41, 59] },
      headStyles: { fillColor: C.critical, textColor: C.white, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: C.rowAlt },
      columnStyles: { 2: { cellWidth: 80 } },
      didParseCell(data) {
        if (data.section === 'body' && data.column.index === 0) {
          const v = data.cell.raw?.toLowerCase();
          if (v === 'critical') data.cell.styles.textColor = C.critical;
          else if (v === 'warning') data.cell.styles.textColor = C.warning;
          else if (v === 'info') data.cell.styles.textColor = C.blue;
          data.cell.styles.fontStyle = 'bold';
        }
      },
      margin: { top: 32, left: 8, right: 8 },
    });

    addPageFooter(doc);
  }

  const filename = `CloudNexus_Report_${providerKey.toUpperCase()}_${new Date().toISOString().slice(0,10)}.pdf`;
  doc.save(filename);
}

// ─── CSV generator ────────────────────────────────────────────────────────────
export function generateCSV(services, providerKey) {
  const headers = ['ID','Name','Type','Family','Provider','Region','AZ','Health','Status',
    'Cost/Month','CPU%','Memory%','Disk%','Instance Type','Memory','OS','VPC','Subnet',
    'Public IP','Private IP','Uptime'];

  const rows = services.map(s => [
    s.id, s.name, s.type, s.family, s.provider, s.region, s.az || s.zone || '',
    s.health, s.status, s.cost?.toFixed(2) || '0',
    s.cpu ?? '', s.memUsage ?? '', s.diskUsage ?? '',
    s.instanceType || s.machineType || s.size || '',
    s.memory || '', s.os || '',
    s.vpc || s.vnet || '', s.subnet || s.subnetwork || '',
    s.publicIp || '', s.ip || '',
    s.uptime || '',
  ].map(v => {
    const str = String(v ?? '');
    return str.includes(',') || str.includes('"') || str.includes('\n')
      ? `"${str.replace(/"/g, '""')}"` : str;
  }));

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `CloudNexus_Report_${providerKey.toUpperCase()}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── JSON generator ───────────────────────────────────────────────────────────
export function generateJSON(services, alerts, providerKey) {
  const healthy  = services.filter(s => s.health === 'healthy').length;
  const warning  = services.filter(s => s.health === 'warning').length;
  const critical = services.filter(s => s.health === 'critical').length;

  const payload = {
    report: {
      generator:  'CloudNexus Multi-Cloud Monitoring Platform',
      version:    '1.0',
      generatedAt: new Date().toISOString(),
      provider:   providerKey,
      providerLabel: PROVIDER_LABELS[providerKey] || providerKey,
    },
    summary: {
      totalServices: services.length,
      healthy, warning, critical,
      totalCostMTD: Math.round(services.reduce((a, s) => a + (s.cost || 0), 0) * 100) / 100,
      activeRegions: [...new Set(services.map(s => s.region).filter(Boolean))],
      activeAlerts:  alerts.filter(a => !a.acknowledged).length,
      familyBreakdown: Object.fromEntries(
        Object.entries(
          services.reduce((m, s) => { m[s.family] = (m[s.family] || 0) + 1; return m; }, {})
        ).sort((a, b) => b[1] - a[1])
      ),
    },
    services: services.map(s => ({
      id: s.id, name: s.name, type: s.type, family: s.family,
      provider: s.provider, region: s.region, az: s.az || s.zone,
      health: s.health, status: s.status,
      cost: s.cost, cpu: s.cpu, memUsage: s.memUsage, diskUsage: s.diskUsage,
      instanceType: s.instanceType || s.machineType || s.size,
      memory: s.memory, os: s.os, uptime: s.uptime,
      ip: s.ip, publicIp: s.publicIp,
      vpc: s.vpc || s.vnet, subnet: s.subnet || s.subnetwork,
      tags: s.tags || {},
    })),
    alerts: alerts.map(a => ({
      id: a.id, severity: a.severity, service: a.service || a.resource,
      message: a.message || a.title, region: a.region,
      acknowledged: a.acknowledged, timestamp: a.timestamp,
    })),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `CloudNexus_Report_${providerKey.toUpperCase()}_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
