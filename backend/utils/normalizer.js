// utils/normalizer.js
// Normalizes resources from all clouds into a common schema

const FAMILY_MAP = {
  // AWS
  'ec2': 'Compute', 'rds': 'Database', 's3': 'Storage',
  'lambda': 'Serverless', 'eks': 'Container', 'ecs': 'Container',
  'elasticache': 'Cache', 'elb': 'Networking', 'alb': 'Networking',
  'cloudfront': 'CDN', 'sqs': 'Messaging', 'sns': 'Messaging',
  'vpc': 'Networking', 'subnet': 'Networking',
  // GCP
  'compute': 'Compute', 'sql': 'Database', 'gcs': 'Storage',
  'functions': 'Serverless', 'gke': 'Container', 'run': 'Serverless',
  'bigtable': 'Database', 'firestore': 'Database', 'bigquery': 'Analytics',
  'pubsub': 'Messaging', 'memorystore': 'Cache',
  // Azure
  'vm': 'Compute', 'sqldb': 'Database', 'blob': 'Storage',
  'functionapp': 'Serverless', 'aks': 'Container', 'cosmos': 'Database',
  'eventhub': 'Messaging', 'redis': 'Cache', 'servicebus': 'Messaging',
  'appservice': 'Compute', 'vnet': 'Networking',
};

function mapFamily(serviceType) {
  const lower = serviceType.toLowerCase();
  for (const [key, family] of Object.entries(FAMILY_MAP)) {
    if (lower.includes(key)) return family;
  }
  return 'Other';
}

function healthFromStatus(status, checks = null) {
  if (!status) return 'warning';
  const s = String(status).toLowerCase();
  if (['running', 'available', 'active', 'healthy', 'succeeded', 'ok', 'online', 'started', 'deployed'].some(x => s.includes(x))) return 'healthy';
  if (['stopped', 'terminated', 'failed', 'error', 'critical', 'unhealthy'].some(x => s.includes(x))) return 'critical';
  if (['warning', 'pending', 'starting', 'stopping', 'degraded', 'impaired'].some(x => s.includes(x))) return 'warning';
  return 'warning';
}

function estimateMonthlyCost(resource) {
  // Very rough estimates for UI purposes. Real cost comes from Cost Explorer / billing APIs
  const { type, family, instanceType, vcpu, memory, sizeGB } = resource;
  if (instanceType) {
    const map = {
      't3.micro': 8.50, 't3.small': 17, 't3.medium': 34, 't3.large': 67,
      't3.xlarge': 134, 'm5.large': 87, 'm5.xlarge': 174, 'm5.2xlarge': 348,
      'c5.large': 85, 'c5.xlarge': 170, 'r5.large': 121, 'r5.xlarge': 242,
      // GCP
      'n1-standard-1': 24, 'n1-standard-2': 48, 'n1-standard-4': 96,
      'e2-medium': 26, 'e2-standard-2': 49, 'n2-standard-2': 67,
      // Azure
      'Standard_B1s': 8, 'Standard_B2s': 38, 'Standard_D2s_v3': 70,
      'Standard_D4s_v3': 140, 'Standard_E2s_v3': 87,
    };
    const v = map[instanceType];
    if (v) return v;
  }
  const familyCosts = {
    Compute: 65, Database: 120, Storage: 25, Serverless: 15, Container: 200,
    Cache: 50, CDN: 30, Analytics: 80, Messaging: 20, Networking: 35, Other: 40,
  };
  return familyCosts[family] || 40;
}

module.exports = { mapFamily, healthFromStatus, estimateMonthlyCost };
