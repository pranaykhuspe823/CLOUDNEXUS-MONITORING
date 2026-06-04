// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server: SocketServer } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const winston = require('winston');

const credentialStore = require('./utils/credentialStore');
const AWSService = require('./services/awsService');
const GCPService = require('./services/gcpService');
const AzureService = require('./services/azureService');
const AlertService = require('./services/alertService');
const ReportService = require('./services/reportService');

// ─── Logger ────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()],
});

// ─── App ────────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const ALLOWED_ORIGINS = process.env.FRONTEND_URL
  ? [process.env.FRONTEND_URL]
  : ['http://localhost:5173', 'http://localhost:3009', 'http://localhost:4173'];

const io = new SocketServer(server, {
  cors: { origin: ALLOWED_ORIGINS, credentials: true },
});

const PORT = process.env.PORT || 3001;

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(rateLimit({ windowMs: 60000, max: 200, message: 'Too many requests' }));

// ─── In-memory cache ─────────────────────────────────────────────────────────
const cache = {
  aws: { resources: [], lastFetch: null, fetching: false },
  gcp: { resources: [], lastFetch: null, fetching: false },
  azure: { resources: [], lastFetch: null, fetching: false },
  alerts: [],
  alertService: new AlertService(),
  topology: null,
};

const reportService = new ReportService();
reportService.setCache(() => cache);

// ─── Helper: build topology from resources ────────────────────────────────
function buildTopology() {
  const all = [...cache.aws.resources, ...cache.gcp.resources, ...cache.azure.resources];
  return {
    aws: cache.aws.resources.map(r => ({
      id: r.id, label: r.name, type: r.type, family: r.family,
      provider: 'aws', region: r.region, health: r.health, connections: r.connections,
    })),
    gcp: cache.gcp.resources.map(r => ({
      id: r.id, label: r.name, type: r.type, family: r.family,
      provider: 'gcp', region: r.region, health: r.health, connections: r.connections,
    })),
    azure: cache.azure.resources.map(r => ({
      id: r.id, label: r.name, type: r.type, family: r.family,
      provider: 'azure', region: r.region, health: r.health, connections: r.connections,
    })),
  };
}

// ─── Fetch resources for a provider ─────────────────────────────────────────
async function fetchProvider(provider) {
  if (!credentialStore.has(provider)) return;
  const creds = credentialStore.get(provider);
  if (!creds) return;

  cache[provider].fetching = true;
  io.emit('provider:fetching', { provider });
  logger.info(`Fetching ${provider} resources...`);

  try {
    let resources = [];
    let providerAlerts = [];

    if (provider === 'aws') {
      const svc = new AWSService(creds);
      resources = await svc.getAllResources();
      providerAlerts = await svc.getAlertsAllRegions();
    } else if (provider === 'gcp') {
      const svc = new GCPService(creds);
      resources = await svc.getAllResources();
      providerAlerts = await svc.getAlerts();
    } else if (provider === 'azure') {
      const svc = new AzureService(creds);
      resources = await svc.getAllResources();
      providerAlerts = await svc.getAlerts();
    }

    cache[provider].resources = resources;
    cache[provider].lastFetch = new Date().toISOString();
    cache[provider].fetching = false;

    // Process alerts
    const alertSvc = cache.alertService;
    alertSvc.addProviderAlerts(providerAlerts);
    alertSvc.generateFromResources(resources);
    cache.alerts = alertSvc.getAll();

    // Update topology
    cache.topology = buildTopology();

    // Emit real-time updates
    io.emit('provider:updated', {
      provider,
      resources,
      resourceCount: resources.length,
      timestamp: cache[provider].lastFetch,
    });
    io.emit('alerts:updated', cache.alerts);
    io.emit('topology:updated', cache.topology);

    logger.info(`${provider}: fetched ${resources.length} resources, ${providerAlerts.length} cloud alerts`);
  } catch (err) {
    cache[provider].fetching = false;
    logger.error(`${provider} fetch error: ${err.message}`);
    io.emit('provider:error', { provider, error: err.message });
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', providers: credentialStore.listProviders() }));

// ── Auth / Connections ─────────────────────────────────────────────────────
app.post('/api/connect/:provider', async (req, res) => {
  const { provider } = req.params;
  if (!['aws', 'gcp', 'azure'].includes(provider)) return res.status(400).json({ error: 'Unknown provider' });

  const creds = req.body;
  if (!creds) return res.status(400).json({ error: 'No credentials' });

  // Verify before storing
  try {
    let result;
    if (provider === 'aws') {
      const svc = new AWSService(creds);
      result = await svc.verifyConnection();
    } else if (provider === 'gcp') {
      const svc = new GCPService(creds);
      result = await svc.verifyConnection();
    } else {
      const svc = new AzureService(creds);
      result = await svc.verifyConnection();
    }

    if (!result.success) {
      return res.status(401).json({ success: false, error: result.error });
    }

    credentialStore.set(provider, creds);

    // Kick off background fetch
    fetchProvider(provider).catch(e => logger.error(`Background fetch error: ${e.message}`));

    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/connect/:provider', (req, res) => {
  const { provider } = req.params;
  credentialStore.delete(provider);
  cache[provider] = { resources: [], lastFetch: null, fetching: false };
  cache.alertService = new AlertService();
  cache.alerts = [];
  io.emit('provider:disconnected', { provider });
  res.json({ success: true });
});

app.get('/api/connections', (_, res) => {
  const providers = ['aws', 'gcp', 'azure'];
  const result = {};
  for (const p of providers) {
    result[p] = {
      connected: credentialStore.has(p),
      fetching: cache[p]?.fetching || false,
      resourceCount: cache[p]?.resources?.length || 0,
      lastFetch: cache[p]?.lastFetch || null,
    };
  }
  res.json(result);
});

// ── Resources ─────────────────────────────────────────────────────────────
app.get('/api/resources', (req, res) => {
  const { provider, family, region, health, search } = req.query;
  let resources = [];

  if (!provider || provider === 'aws') resources = resources.concat(cache.aws.resources);
  if (!provider || provider === 'gcp') resources = resources.concat(cache.gcp.resources);
  if (!provider || provider === 'azure') resources = resources.concat(cache.azure.resources);

  if (family) resources = resources.filter(r => r.family === family);
  if (region) resources = resources.filter(r => r.region?.includes(region));
  if (health) resources = resources.filter(r => r.health === health);
  if (search) {
    const q = search.toLowerCase();
    resources = resources.filter(r =>
      r.name?.toLowerCase().includes(q) ||
      r.type?.toLowerCase().includes(q) ||
      r.region?.toLowerCase().includes(q)
    );
  }

  res.json({ resources, total: resources.length });
});

app.get('/api/resources/:provider', (req, res) => {
  const { provider } = req.params;
  if (!['aws', 'gcp', 'azure'].includes(provider)) return res.status(400).json({ error: 'Unknown provider' });
  res.json({
    resources: cache[provider].resources,
    lastFetch: cache[provider].lastFetch,
    fetching: cache[provider].fetching,
  });
});

app.post('/api/resources/refresh', async (req, res) => {
  const { provider } = req.body;
  const providers = provider ? [provider] : credentialStore.listProviders();
  for (const p of providers) {
    fetchProvider(p).catch(e => logger.error(`Refresh error: ${e.message}`));
  }
  res.json({ success: true, refreshing: providers });
});

// ── Stats / Overview ───────────────────────────────────────────────────────
app.get('/api/stats', (_, res) => {
  const all = [...cache.aws.resources, ...cache.gcp.resources, ...cache.azure.resources];
  const totalCost = all.reduce((a, r) => a + (r.cost || 0), 0);
  const regions = new Set(all.map(r => r.region).filter(Boolean));
  const families = {};
  for (const r of all) families[r.family] = (families[r.family] || 0) + 1;

  res.json({
    totalServices: all.length,
    healthyServices: all.filter(r => r.health === 'healthy').length,
    warningServices: all.filter(r => r.health === 'warning').length,
    criticalServices: all.filter(r => r.health === 'critical').length,
    totalCostMTD: Math.round(totalCost),
    regions: regions.size,
    familyBreakdown: families,
    perProvider: {
      aws: { count: cache.aws.resources.length, cost: Math.round(cache.aws.resources.reduce((a, r) => a + (r.cost || 0), 0)), lastFetch: cache.aws.lastFetch },
      gcp: { count: cache.gcp.resources.length, cost: Math.round(cache.gcp.resources.reduce((a, r) => a + (r.cost || 0), 0)), lastFetch: cache.gcp.lastFetch },
      azure: { count: cache.azure.resources.length, cost: Math.round(cache.azure.resources.reduce((a, r) => a + (r.cost || 0), 0)), lastFetch: cache.azure.lastFetch },
    },
  });
});

// ── Alerts ─────────────────────────────────────────────────────────────────
app.get('/api/alerts', (_, res) => {
  res.json({ alerts: cache.alerts, stats: cache.alertService.getStats() });
});

app.post('/api/alerts/:id/acknowledge', (req, res) => {
  const { id } = req.params;
  const ok = cache.alertService.acknowledge(id);
  cache.alerts = cache.alertService.getAll();
  io.emit('alerts:updated', cache.alerts);
  res.json({ success: ok });
});

app.post('/api/alerts/acknowledge-all', (_, res) => {
  const all = cache.alertService.getAll();
  for (const a of all) cache.alertService.acknowledge(a.id);
  cache.alerts = cache.alertService.getAll();
  io.emit('alerts:updated', cache.alerts);
  res.json({ success: true });
});

// ── Daily Reports ──────────────────────────────────────────────────────────
app.get('/api/reports/schedule', (req, res) => {
  const { email } = req.query;
  if (email) {
    const schedule = reportService.getSchedule(email);
    return res.json({ schedule });
  }
  res.json({ schedules: reportService.getAllSchedules() });
});

app.post('/api/reports/schedule', (req, res) => {
  const { email, time } = req.body;
  if (!email || !time) return res.status(400).json({ error: 'email and time are required' });
  if (!/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: 'time must be HH:MM format' });
  reportService.schedule(email, time);
  logger.info(`Daily report scheduled for ${email} at ${time}`);
  res.json({ success: true, email, time });
});

app.delete('/api/reports/schedule', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });
  const removed = reportService.unschedule(email);
  res.json({ success: removed });
});

app.post('/api/reports/send-now', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });
  try {
    await reportService.sendReport(email);
    logger.info(`Daily report sent immediately to ${email}`);
    res.json({ success: true });
  } catch (e) {
    logger.error(`Report send error: ${e.message}`);
    let userMessage = e.message;
    if (e.responseCode === 535 || e.message.includes('535') || e.message.includes('Authentication Failed')) {
      userMessage = 'ZOHO_AUTH_FAILED';
    }
    res.status(500).json({ error: userMessage });
  }
});

// ── Network Topology ────────────────────────────────────────────────────────
app.get('/api/topology', (_, res) => {
  if (!cache.topology) cache.topology = buildTopology();
  res.json(cache.topology);
});

// ── Metrics (Prometheus-style) ─────────────────────────────────────────────
app.get('/api/metrics/resource/:id', (req, res) => {
  const { id } = req.params;
  const all = [...cache.aws.resources, ...cache.gcp.resources, ...cache.azure.resources];
  const resource = all.find(r => r.id === id);
  if (!resource) return res.status(404).json({ error: 'Resource not found' });

  // Return time-series style metrics (mocked if not real)
  const now = Date.now();
  const points = Array.from({ length: 60 }, (_, i) => ({
    timestamp: new Date(now - (59 - i) * 60000).toISOString(),
    cpu: resource.cpu ? Math.max(0, Math.min(100, resource.cpu + (Math.random() - 0.5) * 10)) : null,
    memory: resource.memUsage ? Math.max(0, Math.min(100, resource.memUsage + (Math.random() - 0.5) * 8)) : null,
    networkIn: resource.networkIn || Math.round(100 + Math.random() * 500),
    networkOut: resource.networkOut || Math.round(50 + Math.random() * 200),
  }));

  res.json({ resourceId: id, metrics: points });
});

// ── CWAgent Installation ───────────────────────────────────────────────────
function getAWSSvc() {
  const creds = credentialStore.get('aws');
  if (!creds) return null;
  return new AWSService(creds);
}

app.get('/api/aws/s3-details/:bucket', async (req, res) => {
  const svc = getAWSSvc();
  if (!svc) return res.status(400).json({ error: 'AWS not connected' });
  try {
    const details = await svc.getS3BucketDetails(req.params.bucket);
    res.json(details);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/aws/install-cwagent', async (req, res) => {
  const { instanceId, region } = req.body;
  if (!instanceId || !region) return res.status(400).json({ error: 'instanceId and region required' });
  const svc = getAWSSvc();
  if (!svc) return res.status(400).json({ error: 'AWS not connected' });
  try {
    const commandId = await svc.installCWAgent(instanceId, region);
    res.json({ commandId, phase: 'installing' });
  } catch (e) {
    logger.error(`install-cwagent error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/aws/configure-cwagent', async (req, res) => {
  const { instanceId, region, platform } = req.body;
  if (!instanceId || !region) return res.status(400).json({ error: 'instanceId and region required' });
  const svc = getAWSSvc();
  if (!svc) return res.status(400).json({ error: 'AWS not connected' });
  try {
    const commandId = await svc.configureCWAgent(instanceId, region, platform);
    res.json({ commandId, phase: 'configuring' });
  } catch (e) {
    logger.error(`configure-cwagent error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/aws/cwagent-status', async (req, res) => {
  const { commandId, instanceId, region } = req.query;
  if (!commandId || !instanceId || !region) return res.status(400).json({ error: 'commandId, instanceId and region required' });
  const svc = getAWSSvc();
  if (!svc) return res.status(400).json({ error: 'AWS not connected' });
  try {
    const result = await svc.getCWAgentCommandStatus(commandId, instanceId, region);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  logger.info(`Client connected: ${socket.id}`);

  // Send current state on connect
  socket.emit('initial:state', {
    aws: { resources: cache.aws.resources, lastFetch: cache.aws.lastFetch, fetching: cache.aws.fetching },
    gcp: { resources: cache.gcp.resources, lastFetch: cache.gcp.lastFetch, fetching: cache.gcp.fetching },
    azure: { resources: cache.azure.resources, lastFetch: cache.azure.lastFetch, fetching: cache.azure.fetching },
    alerts: cache.alerts,
    topology: cache.topology || buildTopology(),
    connections: {
      aws: { connected: credentialStore.has('aws'), resourceCount: cache.aws.resources.length },
      gcp: { connected: credentialStore.has('gcp'), resourceCount: cache.gcp.resources.length },
      azure: { connected: credentialStore.has('azure'), resourceCount: cache.azure.resources.length },
    },
  });

  socket.on('refresh', ({ provider }) => {
    if (provider && ['aws', 'gcp', 'azure'].includes(provider)) {
      fetchProvider(provider).catch(e => logger.error(e.message));
    } else {
      credentialStore.listProviders().forEach(p =>
        fetchProvider(p).catch(e => logger.error(e.message))
      );
    }
  });

  socket.on('acknowledge', ({ alertId }) => {
    cache.alertService.acknowledge(alertId);
    cache.alerts = cache.alertService.getAll();
    io.emit('alerts:updated', cache.alerts);
  });

  socket.on('disconnect', () => logger.info(`Client disconnected: ${socket.id}`));
});

// ─── Cron: auto-refresh every 5 minutes ─────────────────────────────────────
cron.schedule('*/5 * * * *', () => {
  const connected = credentialStore.listProviders();
  if (connected.length > 0) {
    logger.info(`Cron refresh: ${connected.join(', ')}`);
    connected.forEach(p => fetchProvider(p).catch(e => logger.error(e.message)));
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  logger.info(`CloudNexus backend running on http://localhost:${PORT}`);
});
