// services/gcpService.js
const { google } = require('googleapis');
const { mapFamily, healthFromStatus, estimateMonthlyCost } = require('../utils/normalizer');

// GCP machine type memory/vCPU lookup fallback
const GCP_MACHINE_SPECS = {
  'n1-standard-1': { vcpu: 1, memGiB: 3.75 }, 'n1-standard-2': { vcpu: 2, memGiB: 7.5 },
  'n1-standard-4': { vcpu: 4, memGiB: 15 }, 'n1-standard-8': { vcpu: 8, memGiB: 30 },
  'n1-standard-16': { vcpu: 16, memGiB: 60 }, 'n1-standard-32': { vcpu: 32, memGiB: 120 },
  'n2-standard-2': { vcpu: 2, memGiB: 8 }, 'n2-standard-4': { vcpu: 4, memGiB: 16 },
  'n2-standard-8': { vcpu: 8, memGiB: 32 }, 'n2-standard-16': { vcpu: 16, memGiB: 64 },
  'n2-standard-32': { vcpu: 32, memGiB: 128 },
  'e2-micro': { vcpu: 2, memGiB: 1 }, 'e2-small': { vcpu: 2, memGiB: 2 }, 'e2-medium': { vcpu: 2, memGiB: 4 },
  'e2-standard-2': { vcpu: 2, memGiB: 8 }, 'e2-standard-4': { vcpu: 4, memGiB: 16 },
  'e2-standard-8': { vcpu: 8, memGiB: 32 }, 'e2-standard-16': { vcpu: 16, memGiB: 64 },
  'c2-standard-4': { vcpu: 4, memGiB: 16 }, 'c2-standard-8': { vcpu: 8, memGiB: 32 },
  'c2-standard-16': { vcpu: 16, memGiB: 64 }, 'c2-standard-30': { vcpu: 30, memGiB: 120 },
  'n1-highmem-2': { vcpu: 2, memGiB: 13 }, 'n1-highmem-4': { vcpu: 4, memGiB: 26 },
  'n1-highmem-8': { vcpu: 8, memGiB: 52 }, 'n1-highmem-16': { vcpu: 16, memGiB: 104 },
  'n1-highcpu-4': { vcpu: 4, memGiB: 3.6 }, 'n1-highcpu-8': { vcpu: 8, memGiB: 7.2 },
  'n1-highcpu-16': { vcpu: 16, memGiB: 14.4 },
};

class GCPService {
  constructor(credentials) {
    this.creds = credentials;
    this.projectId = credentials.projectId;
    this.auth = null;
    this._machineTypeCache = {};
  }

  async getAuth() {
    if (this.auth) return this.auth;
    if (this.creds.authType === 'serviceAccount') {
      let keyData;
      try {
        keyData = typeof this.creds.serviceAccountKey === 'string'
          ? JSON.parse(this.creds.serviceAccountKey)
          : this.creds.serviceAccountKey;
      } catch {
        throw new Error('Invalid service account JSON');
      }
      this.auth = new google.auth.GoogleAuth({
        credentials: keyData,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
    } else if (this.creds.authType === 'oauth') {
      const oauth2 = new google.auth.OAuth2();
      oauth2.setCredentials({ access_token: this.creds.accessToken });
      this.auth = oauth2;
    } else {
      this.auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
    }
    return this.auth;
  }

  async verifyConnection() {
    try {
      const auth = await this.getAuth();
      const cloudresourcemanager = google.cloudresourcemanager({ version: 'v1', auth });
      const res = await cloudresourcemanager.projects.get({ projectId: this.projectId });
      return { success: true, projectName: res.data.name, projectNumber: res.data.projectNumber };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Fetch machine type specs (vCPU, memory) with cache
  async getMachineTypeSpecs(machineType, zone) {
    if (!machineType) return {};
    if (GCP_MACHINE_SPECS[machineType]) return GCP_MACHINE_SPECS[machineType];

    const cacheKey = `${zone}:${machineType}`;
    if (this._machineTypeCache[cacheKey]) return this._machineTypeCache[cacheKey];

    try {
      const auth = await this.getAuth();
      const compute = google.compute({ version: 'v1', auth });
      const res = await compute.machineTypes.get({
        project: this.projectId,
        zone,
        machineType,
      });
      const mt = res.data;
      const specs = {
        vcpu: mt.guestCpus || null,
        memGiB: mt.memoryMb ? Math.round(mt.memoryMb / 1024 * 10) / 10 : null,
        memMB: mt.memoryMb || null,
        description: mt.description || null,
        isSharedCpu: mt.isSharedCpu || false,
      };
      this._machineTypeCache[cacheKey] = specs;
      return specs;
    } catch {
      this._machineTypeCache[cacheKey] = {};
      return {};
    }
  }

  // Detect OS from disk license URL
  detectOS(licenses) {
    if (!licenses || !licenses.length) return 'Linux';
    const license = licenses[0].toLowerCase();
    if (license.includes('windows')) return 'Windows Server';
    if (license.includes('debian')) return 'Debian';
    if (license.includes('ubuntu')) return 'Ubuntu';
    if (license.includes('centos')) return 'CentOS';
    if (license.includes('rhel') || license.includes('red-hat')) return 'RHEL';
    if (license.includes('suse') || license.includes('sles')) return 'SUSE Linux';
    if (license.includes('cos') || license.includes('container-vm')) return 'Container-Optimized OS';
    if (license.includes('coreos')) return 'CoreOS';
    return 'Linux';
  }

  async getComputeInstances() {
    try {
      const auth = await this.getAuth();
      const compute = google.compute({ version: 'v1', auth });
      const res = await compute.instances.aggregatedList({
        project: this.projectId,
        maxResults: 100,
      });
      const instances = [];
      const items = res.data.items || {};

      for (const [zone, data] of Object.entries(items)) {
        for (const vm of data.instances || []) {
          const zoneName = zone.replace('zones/', '');
          const region = zoneName.split('-').slice(0, -1).join('-');
          const machineType = vm.machineType?.split('/').pop();

          // Fetch machine type specs
          const specs = await this.getMachineTypeSpecs(machineType, zoneName);

          // All network interfaces
          const networkInterfaces = (vm.networkInterfaces || []).map(nic => ({
            name: nic.name,
            network: nic.network?.split('/').pop(),
            subnetwork: nic.subnetwork?.split('/').pop(),
            privateIp: nic.networkIP,
            publicIp: nic.accessConfigs?.[0]?.natIP || null,
            publicDns: nic.accessConfigs?.[0]?.natIP ? `${nic.accessConfigs[0].natIP}` : null,
            aliasIpRanges: nic.aliasIpRanges || [],
            stackType: nic.stackType,
          }));

          // All attached disks
          const disks = (vm.disks || []).map(d => ({
            deviceName: d.deviceName,
            type: d.type, // PERSISTENT or SCRATCH
            mode: d.mode, // READ_WRITE or READ_ONLY
            source: d.source?.split('/').pop(),
            boot: d.boot || false,
            autoDelete: d.autoDelete,
            diskSizeGB: d.diskSizeGb,
            interface: d.interface,
            licenses: d.licenses?.map(l => l.split('/').pop()) || [],
          }));

          const bootDisk = vm.disks?.find(d => d.boot);
          const bootDiskLicenses = bootDisk?.licenses || [];
          const os = this.detectOS(bootDiskLicenses.map(l => l.split('/').pop()));

          // Service account(s)
          const serviceAccounts = (vm.serviceAccounts || []).map(sa => ({
            email: sa.email,
            scopes: sa.scopes || [],
          }));

          // Tags (network tags)
          const networkTags = vm.tags?.items || [];

          instances.push({
            id: `gcp-compute-${vm.id}`,
            rawId: String(vm.id),
            name: vm.name,
            type: 'Compute Engine VM',
            family: 'Compute',
            provider: 'gcp',
            region,
            zone: zoneName,
            status: vm.status,
            health: vm.status === 'RUNNING' ? 'healthy' : healthFromStatus(vm.status),

            // Specs
            machineType,
            vcpu: specs.vcpu || null,
            memGiB: specs.memGiB || null,
            memMB: specs.memMB || null,
            isSharedCpu: specs.isSharedCpu || false,

            // Network
            ip: vm.networkInterfaces?.[0]?.networkIP,
            publicIp: vm.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP || null,
            network: vm.networkInterfaces?.[0]?.network?.split('/').pop(),
            subnetwork: vm.networkInterfaces?.[0]?.subnetwork?.split('/').pop(),
            networkInterfaces,
            networkTags,

            // OS & Storage
            os,
            diskSizeGb: bootDisk?.diskSizeGb || null,
            bootDiskSizeGB: bootDisk?.diskSizeGb || null,
            bootDiskType: bootDisk?.type || null,
            disks,

            // Identity & Security
            serviceAccounts,
            shieldedInstanceConfig: vm.shieldedInstanceConfig || null,
            shieldedInstanceIntegrityPolicy: vm.shieldedInstanceIntegrityPolicy || null,
            confidentialInstanceConfig: vm.confidentialInstanceConfig || null,

            // Scheduling
            scheduling: vm.scheduling ? {
              onHostMaintenance: vm.scheduling.onHostMaintenance,
              automaticRestart: vm.scheduling.automaticRestart,
              preemptible: vm.scheduling.preemptible,
              provisioningModel: vm.scheduling.provisioningModel,
            } : null,
            preemptible: vm.scheduling?.preemptible || false,

            // Metadata
            launchTime: vm.creationTimestamp,
            uptime: vm.creationTimestamp ? formatUptime(vm.creationTimestamp) : null,
            lastStartTimestamp: vm.lastStartTimestamp,
            lastStopTimestamp: vm.lastStopTimestamp,
            deletionProtection: vm.deletionProtection || false,
            description: vm.description,
            fingerprint: vm.labelFingerprint,

            // Metrics (live from Cloud Monitoring not available via REST without extra API calls)
            cpu: null,
            memUsage: null,
            diskUsage: null,

            cost: estimateMonthlyCost({ machineType, family: 'Compute' }),
            tags: Object.fromEntries(Object.entries(vm.labels || {})),
            connections: [],
          });
        }
      }
      return instances;
    } catch (e) {
      console.error('GCP Compute error:', e.message);
      return [];
    }
  }

  async getGKEClusters() {
    try {
      const auth = await this.getAuth();
      const container = google.container({ version: 'v1', auth });
      const res = await container.projects.locations.clusters.list({
        parent: `projects/${this.projectId}/locations/-`,
      });
      return (res.data.clusters || []).map(c => {
        const nodePools = (c.nodePools || []).map(np => ({
          name: np.name,
          status: np.status,
          machineType: np.config?.machineType,
          diskSizeGB: np.config?.diskSizeGb,
          diskType: np.config?.diskType,
          imageType: np.config?.imageType,
          oauthScopes: np.config?.oauthScopes || [],
          serviceAccount: np.config?.serviceAccount,
          preemptible: np.config?.preemptible || false,
          spot: np.config?.spot || false,
          desiredNodeCount: np.initialNodeCount,
          autoscaling: np.autoscaling ? {
            enabled: np.autoscaling.enabled,
            minNodeCount: np.autoscaling.minNodeCount,
            maxNodeCount: np.autoscaling.maxNodeCount,
          } : null,
          management: np.management ? {
            autoUpgrade: np.management.autoUpgrade,
            autoRepair: np.management.autoRepair,
          } : null,
          version: np.version,
          locations: np.locations || [],
        }));

        return {
          id: `gcp-gke-${c.name}`,
          rawId: c.name,
          name: c.name,
          type: 'GKE Cluster',
          family: 'Container',
          provider: 'gcp',
          region: c.location,
          zone: c.zone || c.location,
          status: c.status,
          health: c.status === 'RUNNING' ? 'healthy' : healthFromStatus(c.status),
          kubernetesVersion: c.currentMasterVersion,
          nodeVersion: c.currentNodeVersion,
          nodes: c.currentNodeCount,
          nodePools,
          nodePoolCount: nodePools.length,
          pods: (c.currentNodeCount || 0) * 10,
          runningPods: (c.currentNodeCount || 0) * 9,
          endpoint: c.endpoint,
          masterIpv4CidrBlock: c.privateClusterConfig?.masterIpv4CidrBlock,
          isPrivate: c.privateClusterConfig?.enablePrivateNodes || false,
          network: c.network,
          subnetwork: c.subnetwork,
          servicesIpv4Cidr: c.servicesIpv4Cidr,
          clusterIpv4Cidr: c.clusterIpv4Cidr,
          loggingService: c.loggingService,
          monitoringService: c.monitoringService,
          networkPolicy: c.networkPolicy?.enabled || false,
          addonsConfig: c.addonsConfig ? {
            httpLoadBalancing: c.addonsConfig.httpLoadBalancing?.disabled !== true,
            horizontalPodAutoscaling: c.addonsConfig.horizontalPodAutoscaling?.disabled !== true,
            networkPolicyConfig: c.addonsConfig.networkPolicyConfig?.disabled !== true,
          } : null,
          autopilot: c.autopilot?.enabled || false,
          releaseChannel: c.releaseChannel?.channel || null,
          workloadIdentity: c.workloadIdentityConfig?.workloadPool || null,
          createdAt: c.createTime,
          launchTime: c.createTime,
          uptime: c.createTime ? formatUptime(c.createTime) : null,
          cpu: null,
          memUsage: null,
          cost: estimateMonthlyCost({ family: 'Container' }) * (c.currentNodeCount || 1),
          tags: c.resourceLabels || {},
          connections: [],
        };
      });
    } catch (e) {
      console.error('GKE error:', e.message);
      return [];
    }
  }

  async getCloudSQLDiskUsedGB(instanceName) {
    try {
      const auth = await this.getAuth();
      const monitoring = google.monitoring({ version: 'v3', auth });
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 10 * 60 * 1000);
      const res = await monitoring.projects.timeSeries.list({
        name: `projects/${this.projectId}`,
        filter: `metric.type="cloudsql.googleapis.com/database/disk/bytes_used" AND resource.labels.database_id="${this.projectId}:${instanceName}"`,
        'interval.startTime': startTime.toISOString(),
        'interval.endTime': endTime.toISOString(),
        view: 'FULL',
      });
      const series = res.data.timeSeries;
      if (!series || series.length === 0) return null;
      const points = series[0].points;
      if (!points || points.length === 0) return null;
      const latestBytes = Number(points[0].value?.int64Value || points[0].value?.doubleValue || 0);
      return latestBytes > 0 ? Math.round((latestBytes / (1024 * 1024 * 1024)) * 100) / 100 : null;
    } catch {
      return null;
    }
  }

  async getCloudSQLInstances() {
    try {
      const auth = await this.getAuth();
      const sqladmin = google.sqladmin({ version: 'v1', auth });
      const res = await sqladmin.instances.list({ project: this.projectId });
      const items = res.data.items || [];

      const instances = await Promise.all(items.map(async (db) => {
        const ipAddresses = db.ipAddresses || [];
        const usedStorageGB = await this.getCloudSQLDiskUsedGB(db.name);
        return {
          id: `gcp-sql-${db.name}`,
          rawId: db.name,
          name: db.name,
          type: 'Cloud SQL Instance',
          family: 'Database',
          provider: 'gcp',
          region: db.region,
          zone: db.gceZone,
          secondaryZone: db.failoverReplica?.name ? db.gceZone : null,
          status: db.state,
          health: db.state === 'RUNNABLE' ? 'healthy' : healthFromStatus(db.state),

          // Engine
          engine: db.databaseVersion,
          databaseVersion: db.databaseVersion,
          backendType: db.backendType,

          // Specs
          tier: db.settings?.tier,
          vcpu: null,
          memGiB: null,
          dataDiskSizeGb: db.settings?.dataDiskSizeGb,
          dataDiskType: db.settings?.dataDiskType,
          storageAutoResize: db.settings?.storageAutoResize,
          storageAutoResizeLimit: db.settings?.storageAutoResizeLimitGb,
          usedStorageGB,

          // Network
          ip: ipAddresses.find(a => a.type === 'PRIVATE')?.ipAddress || null,
          publicIp: ipAddresses.find(a => a.type === 'PRIMARY')?.ipAddress || null,
          outgoingIp: ipAddresses.find(a => a.type === 'OUTGOING')?.ipAddress || null,
          ipAddresses: ipAddresses.map(a => ({ type: a.type, ip: a.ipAddress })),
          connectionName: db.connectionName,
          requireSsl: db.settings?.ipConfiguration?.requireSsl || false,
          privateNetwork: db.settings?.ipConfiguration?.privateNetwork?.split('/').pop() || null,

          // HA & Backup
          multiAZ: db.settings?.availabilityType === 'REGIONAL',
          availabilityType: db.settings?.availabilityType,
          backupEnabled: db.settings?.backupConfiguration?.enabled,
          pointInTimeRecovery: db.settings?.backupConfiguration?.pointInTimeRecoveryEnabled || false,
          backupLocation: db.settings?.backupConfiguration?.location,
          transactionLogRetentionDays: db.settings?.backupConfiguration?.transactionLogRetentionDays,
          maintenanceWindow: db.settings?.maintenanceWindow ? {
            day: db.settings.maintenanceWindow.day,
            hour: db.settings.maintenanceWindow.hour,
          } : null,

          // Flags & config
          databaseFlags: (db.settings?.databaseFlags || []).map(f => ({ name: f.name, value: f.value })),
          activationPolicy: db.settings?.activationPolicy,

          // Replicas
          replicaNames: db.replicaNames || [],
          masterInstanceName: db.masterInstanceName || null,
          isReplica: !!db.masterInstanceName,
          replicaConfiguration: db.replicaConfiguration ? {
            failoverTarget: db.replicaConfiguration.failoverTarget,
          } : null,

          launchTime: db.createTime,
          uptime: db.createTime ? formatUptime(db.createTime) : null,
          cpu: null,
          maxConnections: null,
          cost: estimateMonthlyCost({ family: 'Database' }),
          tags: db.settings?.userLabels || {},
          connections: [],
        };
      }));
      return instances;
    } catch (e) {
      console.error('Cloud SQL error:', e.message);
      return [];
    }
  }

  async getCloudStorageBuckets() {
    try {
      const auth = await this.getAuth();
      const storage = google.storage({ version: 'v1', auth });
      const res = await storage.buckets.list({
        project: this.projectId,
        projection: 'full',
      });
      return (res.data.items || []).map(b => ({
        id: `gcp-gcs-${b.name}`,
        rawId: b.name,
        name: b.name,
        type: 'Cloud Storage Bucket',
        family: 'Storage',
        provider: 'gcp',
        region: b.location?.toLowerCase(),
        locationType: b.locationType, // region, dual-region, multi-region
        status: 'Active',
        health: 'healthy',
        storageClass: b.storageClass,
        defaultStorageClass: b.defaultObjectAcl?.[0]?.role || null,
        sizeGB: 0,
        objects: 0,
        versioning: b.versioning?.enabled || false,
        uniformBucketLevelAccess: b.iamConfiguration?.uniformBucketLevelAccess?.enabled || false,
        publicAccessPrevention: b.iamConfiguration?.publicAccessPrevention || 'inherited',
        encryption: b.encryption?.defaultKmsKeyName ? 'CMEK' : 'Google-managed',
        kmsKey: b.encryption?.defaultKmsKeyName?.split('/').pop() || null,
        retentionPolicy: b.retentionPolicy ? {
          retentionPeriodSec: b.retentionPolicy.retentionPeriod,
          isLocked: b.retentionPolicy.isLocked,
          effectiveTime: b.retentionPolicy.effectiveTime,
        } : null,
        lifecycleRules: (b.lifecycle?.rule || []).length,
        cors: (b.cors || []).length > 0,
        logging: !!b.logging?.logBucket,
        website: !!b.website,
        createdAt: b.timeCreated,
        launchTime: b.timeCreated,
        cost: 2 + Math.random() * 20,
        tags: b.labels || {},
        connections: [],
      }));
    } catch (e) {
      console.error('GCS error:', e.message);
      return [];
    }
  }

  async getCloudFunctions() {
    try {
      const auth = await this.getAuth();
      const cloudfunctions = google.cloudfunctions({ version: 'v1', auth });
      const res = await cloudfunctions.projects.locations.functions.list({
        parent: `projects/${this.projectId}/locations/-`,
      });
      return (res.data.functions || []).map(fn => {
        const locationParts = fn.name.split('/');
        const region = locationParts[3];
        return {
          id: `gcp-function-${fn.name.split('/').pop()}`,
          rawId: fn.name,
          name: fn.name.split('/').pop(),
          type: 'Cloud Function',
          family: 'Serverless',
          provider: 'gcp',
          region,
          status: fn.status,
          health: fn.status === 'ACTIVE' ? 'healthy' : healthFromStatus(fn.status),

          // Runtime
          runtime: fn.runtime,
          entryPoint: fn.entryPoint,
          memorySizeMB: fn.availableMemoryMb || 256,
          memorySize: `${fn.availableMemoryMb || 256} MB`,
          timeout: fn.timeout?.replace('s', '') || '60',
          maxInstances: fn.maxInstances || null,
          minInstances: fn.minInstances || null,

          // Trigger
          httpsTrigger: fn.httpsTrigger ? { url: fn.httpsTrigger.url, securityLevel: fn.httpsTrigger.securityLevel } : null,
          eventTrigger: fn.eventTrigger ? {
            eventType: fn.eventTrigger.eventType,
            resource: fn.eventTrigger.resource,
          } : null,

          // Network
          vpc: fn.vpcConnector?.split('/').pop() || null,
          vpcConnectorEgressSettings: fn.vpcConnectorEgressSettings,
          ingressSettings: fn.ingressSettings,

          // Security
          serviceAccountEmail: fn.serviceAccountEmail,
          secretEnvVars: (fn.secretEnvironmentVariables || []).map(s => s.key),
          envVarKeys: Object.keys(fn.environmentVariables || {}),

          // Source
          sourceRepository: fn.sourceRepository?.url || null,

          launchTime: fn.updateTime,
          uptime: fn.updateTime ? formatUptime(fn.updateTime) : null,
          invocations: null,
          errors: null,
          duration: null,
          cost: 0.3 + Math.random() * 2,
          tags: fn.labels || {},
          connections: [],
        };
      });
    } catch (e) {
      console.error('Cloud Functions error:', e.message);
      return [];
    }
  }

  async getPubSubTopics() {
    try {
      const auth = await this.getAuth();
      const pubsub = google.pubsub({ version: 'v1', auth });
      const res = await pubsub.projects.topics.list({
        project: `projects/${this.projectId}`,
      });
      const topics = (res.data.topics || []).slice(0, 20);
      const results = [];
      for (const t of topics) {
        const name = t.name.split('/').pop();
        let subscriptionCount = 0;
        try {
          const subs = await pubsub.projects.topics.subscriptions.list({ topic: t.name });
          subscriptionCount = subs.data.subscriptions?.length || 0;
        } catch {}
        results.push({
          id: `gcp-pubsub-${name}`,
          rawId: t.name,
          name,
          type: 'Pub/Sub Topic',
          family: 'Messaging',
          provider: 'gcp',
          region: 'global',
          status: 'Active',
          health: 'healthy',
          kmsKeyName: t.kmsKeyName?.split('/').pop() || null,
          messageRetentionDuration: t.messageRetentionDuration || null,
          schemaSettings: t.schemaSettings ? {
            schema: t.schemaSettings.schema?.split('/').pop(),
            encoding: t.schemaSettings.encoding,
          } : null,
          subscriptionCount,
          messages: null,
          cost: 0.5 + Math.random() * 3,
          tags: t.labels || {},
          connections: [],
        });
      }
      return results;
    } catch (e) {
      console.error('Pub/Sub error:', e.message);
      return [];
    }
  }

  async getBigQueryDatasets() {
    try {
      const auth = await this.getAuth();
      const bigquery = google.bigquery({ version: 'v2', auth });
      const res = await bigquery.datasets.list({ projectId: this.projectId });
      const datasets = [];
      for (const ds of (res.data.datasets || []).slice(0, 15)) {
        const dsId = ds.datasetReference.datasetId;
        const detail = await bigquery.datasets.get({
          projectId: this.projectId,
          datasetId: dsId,
        }).catch(() => ({ data: {} }));

        // Count tables
        let tableCount = 0;
        try {
          const tables = await bigquery.tables.list({ projectId: this.projectId, datasetId: dsId });
          tableCount = tables.data.totalItems || (tables.data.tables || []).length;
        } catch {}

        datasets.push({
          id: `gcp-bigquery-${dsId}`,
          rawId: dsId,
          name: dsId,
          type: 'BigQuery Dataset',
          family: 'Analytics',
          provider: 'gcp',
          region: (ds.location || 'us').toLowerCase(),
          status: 'Active',
          health: 'healthy',
          location: ds.location,
          description: detail.data.description,
          tableCount,
          defaultTableExpirationMs: detail.data.defaultTableExpirationMs || null,
          defaultPartitionExpirationMs: detail.data.defaultPartitionExpirationMs || null,
          access: (detail.data.access || []).length,
          encryptionConfig: detail.data.defaultEncryptionConfiguration?.kmsKeyName ? 'CMEK' : 'Google-managed',
          createdAt: detail.data.creationTime ? new Date(parseInt(detail.data.creationTime)).toISOString() : null,
          lastModified: detail.data.lastModifiedTime ? new Date(parseInt(detail.data.lastModifiedTime)).toISOString() : null,
          cost: 5 + Math.random() * 50,
          tags: ds.friendlyName ? { name: ds.friendlyName } : {},
          connections: [],
        });
      }
      return datasets;
    } catch (e) {
      console.error('BigQuery error:', e.message);
      return [];
    }
  }

  async getVPCNetworks() {
    try {
      const auth = await this.getAuth();
      const compute = google.compute({ version: 'v1', auth });
      const [networksRes, firewallsRes, routersRes] = await Promise.all([
        compute.networks.list({ project: this.projectId }),
        compute.firewalls.list({ project: this.projectId }).catch(() => ({ data: { items: [] } })),
        compute.routers.aggregatedList({ project: this.projectId }).catch(() => ({ data: { items: {} } })),
      ]);

      const firewallsByNetwork = {};
      for (const fw of (firewallsRes.data.items || [])) {
        const net = fw.network?.split('/').pop();
        if (!firewallsByNetwork[net]) firewallsByNetwork[net] = [];
        firewallsByNetwork[net].push({
          name: fw.name,
          direction: fw.direction,
          priority: fw.priority,
          disabled: fw.disabled || false,
          targetTags: fw.targetTags || [],
          sourceRanges: fw.sourceRanges || [],
          allowed: (fw.allowed || []).map(a => ({ protocol: a.IPProtocol, ports: a.ports || [] })),
          denied: (fw.denied || []).map(d => ({ protocol: d.IPProtocol, ports: d.ports || [] })),
        });
      }

      return (networksRes.data.items || []).map(n => ({
        id: `gcp-vpc-${n.name}`,
        rawId: n.name,
        name: n.name,
        type: 'VPC Network',
        family: 'Networking',
        provider: 'gcp',
        region: 'global',
        status: 'Active',
        health: 'healthy',
        autoCreateSubnets: n.autoCreateSubnetworks,
        routingMode: n.routingConfig?.routingMode || 'REGIONAL',
        mtu: n.mtu || 1460,
        subnetworks: (n.subnetworks || []).map(s => s.split('/').pop()),
        subnetworkCount: (n.subnetworks || []).length,
        firewalls: firewallsByNetwork[n.name] || [],
        firewallCount: (firewallsByNetwork[n.name] || []).length,
        gatewayIpv4: n.gatewayIPv4,
        ipv4Range: n.IPv4Range || null,
        cost: 0,
        tags: {},
        connections: [],
      }));
    } catch (e) {
      return [];
    }
  }

  async getAlerts() {
    try {
      const auth = await this.getAuth();
      const monitoring = google.monitoring({ version: 'v3', auth });
      const res = await monitoring.projects.alertPolicies.list({
        name: `projects/${this.projectId}`,
      });
      const alerts = [];
      for (const policy of (res.data.alertPolicies || [])) {
        if (!policy.enabled?.value) continue;
        if (policy.conditions?.length) {
          alerts.push({
            id: `gcp-alert-${policy.name?.split('/').pop()}`,
            title: policy.displayName || 'GCP Alert Policy',
            message: policy.conditions?.[0]?.displayName || 'Condition triggered',
            severity: 'warning',
            provider: 'gcp',
            service: policy.conditions?.[0]?.conditionThreshold?.filter?.[0]?.value || 'Unknown',
            region: 'global',
            time: new Date().toISOString(),
            acknowledged: false,
          });
        }
      }
      return alerts;
    } catch (e) {
      console.error('GCP Monitoring error:', e.message);
      return [];
    }
  }

  async getAllResources() {
    const results = await Promise.allSettled([
      this.getComputeInstances(),
      this.getGKEClusters(),
      this.getCloudSQLInstances(),
      this.getCloudStorageBuckets(),
      this.getCloudFunctions(),
      this.getPubSubTopics(),
      this.getBigQueryDatasets(),
      this.getVPCNetworks(),
    ]);

    let allResources = [];
    for (const r of results) {
      if (r.status === 'fulfilled') allResources = allResources.concat(r.value);
    }
    buildGCPConnectionGraph(allResources);
    return allResources;
  }
}

function buildGCPConnectionGraph(resources) {
  const byNetwork = {};
  for (const r of resources) {
    if (r.network) {
      if (!byNetwork[r.network]) byNetwork[r.network] = [];
      byNetwork[r.network].push(r.id);
    }
  }
  for (const r of resources) {
    const conns = new Set();
    if (r.network && byNetwork[r.network]) {
      byNetwork[r.network].filter(id => id !== r.id).slice(0, 6).forEach(id => conns.add(id));
    }
    if (r.family === 'Serverless') {
      resources.filter(x => ['Database', 'Storage'].includes(x.family)).slice(0, 3).forEach(x => conns.add(x.id));
    }
    r.connections = Array.from(conns).slice(0, 8);
  }
}

function formatUptime(since) {
  const ms = Date.now() - new Date(since).getTime();
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  if (d > 0) return `${d}d ${h}h`;
  return `${h}h`;
}

module.exports = GCPService;
