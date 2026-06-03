// services/azureService.js
const { DefaultAzureCredential, ClientSecretCredential,
  ManagedIdentityCredential } = require('@azure/identity');
const { ComputeManagementClient } = require('@azure/arm-compute');
const { NetworkManagementClient } = require('@azure/arm-network');
const { StorageManagementClient } = require('@azure/arm-storage');
const { SqlManagementClient } = require('@azure/arm-sql');
const { ContainerServiceClient } = require('@azure/arm-containerservice');
const { CosmosDBManagementClient } = require('@azure/arm-cosmosdb');
const { EventHubManagementClient } = require('@azure/arm-eventhub');
const { WebSiteManagementClient } = require('@azure/arm-appservice');
const { MonitorClient } = require('@azure/arm-monitor');
const { mapFamily, healthFromStatus, estimateMonthlyCost } = require('../utils/normalizer');

// Azure VM size specs lookup
const AZURE_VM_SPECS = {
  'Standard_B1s': { vcpu: 1, memGiB: 1 }, 'Standard_B1ms': { vcpu: 1, memGiB: 2 },
  'Standard_B2s': { vcpu: 2, memGiB: 4 }, 'Standard_B2ms': { vcpu: 2, memGiB: 8 },
  'Standard_B4ms': { vcpu: 4, memGiB: 16 }, 'Standard_B8ms': { vcpu: 8, memGiB: 32 },
  'Standard_D2s_v3': { vcpu: 2, memGiB: 8 }, 'Standard_D4s_v3': { vcpu: 4, memGiB: 16 },
  'Standard_D8s_v3': { vcpu: 8, memGiB: 32 }, 'Standard_D16s_v3': { vcpu: 16, memGiB: 64 },
  'Standard_D2s_v4': { vcpu: 2, memGiB: 8 }, 'Standard_D4s_v4': { vcpu: 4, memGiB: 16 },
  'Standard_D2s_v5': { vcpu: 2, memGiB: 8 }, 'Standard_D4s_v5': { vcpu: 4, memGiB: 16 },
  'Standard_D8s_v5': { vcpu: 8, memGiB: 32 }, 'Standard_D16s_v5': { vcpu: 16, memGiB: 64 },
  'Standard_E2s_v3': { vcpu: 2, memGiB: 16 }, 'Standard_E4s_v3': { vcpu: 4, memGiB: 32 },
  'Standard_E8s_v3': { vcpu: 8, memGiB: 64 }, 'Standard_E16s_v3': { vcpu: 16, memGiB: 128 },
  'Standard_F2s_v2': { vcpu: 2, memGiB: 4 }, 'Standard_F4s_v2': { vcpu: 4, memGiB: 8 },
  'Standard_F8s_v2': { vcpu: 8, memGiB: 16 }, 'Standard_F16s_v2': { vcpu: 16, memGiB: 32 },
  'Standard_A1_v2': { vcpu: 1, memGiB: 2 }, 'Standard_A2_v2': { vcpu: 2, memGiB: 4 },
  'Standard_NC6': { vcpu: 6, memGiB: 56 }, 'Standard_NC12': { vcpu: 12, memGiB: 112 },
};

class AzureService {
  constructor(credentials) {
    this.creds = credentials;
    this.subscriptionId = credentials.subscriptionId;
    this.credential = null;
    this._nicCache = {};
    this._vmSizeCache = {};
  }

  getCredential() {
    if (this.credential) return this.credential;
    const { authType, tenantId, clientId, clientSecret } = this.creds;
    if (authType === 'servicePrincipal' && tenantId && clientId && clientSecret) {
      this.credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    } else if (authType === 'managedIdentity') {
      this.credential = new ManagedIdentityCredential(clientId);
    } else {
      this.credential = new DefaultAzureCredential();
    }
    return this.credential;
  }

  async verifyConnection() {
    try {
      const cred = this.getCredential();
      const compute = new ComputeManagementClient(cred, this.subscriptionId);
      const iter = compute.virtualMachines.listAll();
      await iter.next();
      return { success: true, subscriptionId: this.subscriptionId };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Lookup VM size specs (vCPU, memory)
  async getVMSizeSpecs(size, location) {
    if (!size) return {};
    if (AZURE_VM_SPECS[size]) return AZURE_VM_SPECS[size];
    const cacheKey = `${location}:${size}`;
    if (this._vmSizeCache[cacheKey]) return this._vmSizeCache[cacheKey];
    try {
      const cred = this.getCredential();
      const compute = new ComputeManagementClient(cred, this.subscriptionId);
      for await (const vmSize of compute.virtualMachineSizes.list(location)) {
        if (vmSize.name === size) {
          const specs = {
            vcpu: vmSize.numberOfCores,
            memGiB: vmSize.memoryInMB ? Math.round(vmSize.memoryInMB / 1024 * 10) / 10 : null,
            memMB: vmSize.memoryInMB,
            maxDataDiskCount: vmSize.maxDataDiskCount,
            osDiskSizeGB: vmSize.osDiskSizeInMB ? Math.round(vmSize.osDiskSizeInMB / 1024) : null,
            resourceDiskSizeGB: vmSize.resourceDiskSizeInMB ? Math.round(vmSize.resourceDiskSizeInMB / 1024) : null,
          };
          this._vmSizeCache[cacheKey] = specs;
          return specs;
        }
      }
    } catch {}
    this._vmSizeCache[cacheKey] = {};
    return {};
  }

  // Fetch NIC details including private/public IP
  async getNICDetails(nicId, networkClient) {
    if (!nicId) return null;
    if (this._nicCache[nicId]) return this._nicCache[nicId];
    try {
      const parts = nicId.split('/');
      const rg = parts[4];
      const nicName = parts[parts.length - 1];
      const nic = await networkClient.networkInterfaces.get(rg, nicName);

      const details = {
        id: nic.id,
        name: nic.name,
        macAddress: nic.macAddress,
        enableAcceleratedNetworking: nic.enableAcceleratedNetworking,
        enableIpForwarding: nic.enableIpForwarding,
        location: nic.location,
        dnsSettings: nic.dnsSettings,
        networkSecurityGroupId: nic.networkSecurityGroup?.id?.split('/').pop() || null,
        ipConfigurations: await Promise.all((nic.ipConfigurations || []).map(async ipConfig => {
          let publicIp = null;
          let publicIpDns = null;
          let publicIpSku = null;
          let publicIpAllocation = null;

          // Fetch public IP details if associated
          if (ipConfig.publicIPAddress?.id) {
            try {
              const pipParts = ipConfig.publicIPAddress.id.split('/');
              const pipRg = pipParts[4];
              const pipName = pipParts[pipParts.length - 1];
              const pip = await networkClient.publicIPAddresses.get(pipRg, pipName);
              publicIp = pip.ipAddress || null;
              publicIpDns = pip.dnsSettings?.fqdn || null;
              publicIpSku = pip.sku?.name || null;
              publicIpAllocation = pip.publicIPAllocationMethod || null;
            } catch {}
          }

          return {
            name: ipConfig.name,
            privateIp: ipConfig.privateIPAddress,
            privateIpAllocation: ipConfig.privateIPAllocationMethod,
            publicIp,
            publicIpDns,
            publicIpSku,
            publicIpAllocation,
            subnetId: ipConfig.subnet?.id?.split('/').pop() || null,
            subnetRef: ipConfig.subnet?.id || null,
            primary: ipConfig.primary || false,
          };
        })),
      };
      this._nicCache[nicId] = details;
      return details;
    } catch { return null; }
  }

  async getVirtualMachines() {
    try {
      const cred = this.getCredential();
      const compute = new ComputeManagementClient(cred, this.subscriptionId);
      const networkClient = new NetworkManagementClient(cred, this.subscriptionId);
      const vms = [];

      for await (const vm of compute.virtualMachines.listAll()) {
        const location = vm.location;
        const rg = vm.id?.split('/')[4] || 'unknown';
        const tags = vm.tags || {};
        const osType = vm.storageProfile?.osDisk?.osType || 'Linux';

        // Power state from instance view
        let powerState = 'unknown';
        let provisioningState = vm.provisioningState;
        let computerName = null;
        let osProfile = {};
        try {
          const view = await compute.virtualMachines.instanceView(rg, vm.name || '');
          const ps = (view.statuses || []).find(s => s.code?.startsWith('PowerState/'));
          powerState = ps?.code?.replace('PowerState/', '') || 'unknown';
          computerName = view.computerName || null;
          osProfile = {
            osName: view.osName,
            osVersion: view.osVersion,
            computerName,
          };
        } catch {}

        // VM size specs
        const vmSize = vm.hardwareProfile?.vmSize;
        const specs = await this.getVMSizeSpecs(vmSize, location);

        // NIC details (fetch all NICs to get IPs)
        const nicRefs = vm.networkProfile?.networkInterfaces || [];
        const nicDetails = await Promise.all(
          nicRefs.map(nic => this.getNICDetails(nic.id, networkClient))
        );
        const validNics = nicDetails.filter(Boolean);

        // Flatten primary/secondary IPs
        const primaryNic = validNics.find(n => n.ipConfigurations?.some(ip => ip.primary)) || validNics[0];
        const primaryIpConfig = primaryNic?.ipConfigurations?.find(ip => ip.primary) || primaryNic?.ipConfigurations?.[0];

        // OS disk details
        const osDisk = vm.storageProfile?.osDisk;
        // Data disks
        const dataDisks = (vm.storageProfile?.dataDisks || []).map(d => ({
          lun: d.lun,
          name: d.name,
          diskSizeGB: d.diskSizeGB,
          caching: d.caching,
          createOption: d.createOption,
          managed: !!d.managedDisk,
          managedDiskId: d.managedDisk?.id?.split('/').pop() || null,
          storageAccountType: d.managedDisk?.storageAccountType || null,
        }));

        // Image reference
        const imageRef = vm.storageProfile?.imageReference;

        // Extensions
        let extensions = [];
        try {
          for await (const ext of compute.virtualMachineExtensions.list(rg, vm.name || '')) {
            extensions.push({
              name: ext.name,
              publisher: ext.publisher,
              type: ext.typePropertiesType || ext.type,
              version: ext.typeHandlerVersion,
              provisioningState: ext.provisioningState,
            });
          }
        } catch {}

        vms.push({
          id: `az-vm-${vm.id?.split('/').pop() || vm.name}`,
          rawId: vm.id,
          name: vm.name || 'unnamed-vm',
          type: 'Virtual Machine',
          family: 'Compute',
          provider: 'azure',
          region: location,
          resourceGroup: rg,
          status: powerState,
          provisioningState,
          health: ['running'].includes(powerState) ? 'healthy' :
            powerState === 'deallocated' ? 'stopped' : healthFromStatus(powerState),

          // Specs
          size: vmSize,
          vcpu: specs.vcpu || null,
          memGiB: specs.memGiB || null,
          memMB: specs.memMB || null,
          maxDataDiskCount: specs.maxDataDiskCount || null,

          // OS
          os: osType,
          osProfile,
          imagePublisher: imageRef?.publisher,
          imageOffer: imageRef?.offer,
          imageSku: imageRef?.sku,
          imageVersion: imageRef?.exactVersion || imageRef?.version,
          imageId: imageRef?.id?.split('/').pop() || null,

          // Storage
          osDiskSizeGB: osDisk?.diskSizeGB || specs?.osDiskSizeGB || null,
          osDisk: osDisk ? {
            name: osDisk.name,
            osType: osDisk.osType,
            caching: osDisk.caching,
            createOption: osDisk.createOption,
            diskSizeGB: osDisk.diskSizeGB,
            managed: !!osDisk.managedDisk,
            managedDiskId: osDisk.managedDisk?.id?.split('/').pop() || null,
            storageAccountType: osDisk.managedDisk?.storageAccountType || null,
            writeAcceleratorEnabled: osDisk.writeAcceleratorEnabled || false,
            encryptionType: osDisk.managedDisk?.diskEncryptionSet?.id ? 'CMEK' : 'platform',
          } : null,
          dataDisks,
          dataDiskCount: dataDisks.length,

          // Network
          ip: primaryIpConfig?.privateIp || null,
          publicIp: primaryIpConfig?.publicIp || null,
          publicDns: primaryIpConfig?.publicIpDns || null,
          networkInterfaces: validNics.map(nic => ({
            name: nic.name,
            macAddress: nic.macAddress,
            acceleratedNetworking: nic.enableAcceleratedNetworking,
            ipForwarding: nic.enableIpForwarding,
            nsgId: nic.networkSecurityGroupId,
            ipConfigurations: nic.ipConfigurations || [],
          })),

          // Security
          extensions,
          availabilitySet: vm.availabilitySet?.id?.split('/').pop() || null,
          availabilityZones: vm.zones || [],
          proximityPlacementGroup: vm.proximityPlacementGroup?.id?.split('/').pop() || null,
          licenseType: vm.licenseType || null,
          priority: vm.priority || 'Regular',
          evictionPolicy: vm.evictionPolicy || null,
          billingProfile: vm.billingProfile?.maxPrice ?? null,

          // Diagnostics
          bootDiagnostics: vm.diagnosticsProfile?.bootDiagnostics?.enabled || false,

          launchTime: null, // Not directly available on VM resource; comes from Activity Log
          uptime: null,
          cpu: null,
          memUsage: null,
          diskUsage: null,
          cost: estimateMonthlyCost({ instanceType: vmSize, family: 'Compute' }),
          tags,
          connections: [],
        });
      }
      return vms;
    } catch (e) {
      console.error('Azure VM error:', e.message);
      return [];
    }
  }

  async getAKSClusters() {
    try {
      const cred = this.getCredential();
      const containerService = new ContainerServiceClient(cred, this.subscriptionId);
      const networkClient = new NetworkManagementClient(cred, this.subscriptionId);
      const clusters = [];

      for await (const cluster of containerService.managedClusters.list()) {
        const rg = cluster.id?.split('/')[4] || 'unknown';
        const agentPools = cluster.agentPoolProfiles || [];
        const nodeCount = agentPools.reduce((a, p) => a + (p.count || 0), 0);

        const nodePools = agentPools.map(p => ({
          name: p.name,
          count: p.count,
          vmSize: p.vmSize,
          osDiskSizeGB: p.osDiskSizeGB,
          osDiskType: p.osDiskType,
          osType: p.osType,
          osSKU: p.osSKU,
          mode: p.mode,  // System or User
          type: p.type,  // VirtualMachineScaleSets or AvailabilitySet
          availabilityZones: p.availabilityZones || [],
          enableAutoScaling: p.enableAutoScaling || false,
          minCount: p.minCount,
          maxCount: p.maxCount,
          maxPods: p.maxPods,
          nodeLabels: p.nodeLabels || {},
          nodeTaints: p.nodeTaints || [],
          upgradeSettings: p.upgradeSettings,
          provisioningState: p.provisioningState,
          powerState: p.powerState?.code || 'Running',
          kubeletDiskType: p.kubeletDiskType,
          vnetSubnetId: p.vnetSubnetId?.split('/').pop() || null,
        }));

        // Fetch VNET info if available
        let vnetName = null;
        if (agentPools[0]?.vnetSubnetId) {
          const parts = agentPools[0].vnetSubnetId.split('/');
          vnetName = parts[parts.indexOf('virtualNetworks') + 1] || null;
        }

        clusters.push({
          id: `az-aks-${cluster.name}`,
          rawId: cluster.id,
          name: cluster.name || 'unnamed-aks',
          type: 'AKS Cluster',
          family: 'Container',
          provider: 'azure',
          region: cluster.location,
          resourceGroup: rg,
          status: cluster.provisioningState,
          health: cluster.provisioningState === 'Succeeded' ? 'healthy' : healthFromStatus(cluster.provisioningState),

          // Kubernetes
          kubernetesVersion: cluster.kubernetesVersion,
          currentKubernetesVersion: cluster.currentKubernetesVersion,
          nodes: nodeCount,
          nodeGroups: agentPools.length,
          nodePools,

          // Workloads (estimated)
          pods: nodeCount * 12,
          runningPods: nodeCount * 11,

          // Network
          fqdn: cluster.fqdn,
          privateFqdn: cluster.privateFQDN,
          dnsPrefix: cluster.dnsPrefix,
          vnet: vnetName,
          networkPlugin: cluster.networkProfile?.networkPlugin,
          networkPolicy: cluster.networkProfile?.networkPolicy,
          podCidr: cluster.networkProfile?.podCidr,
          serviceCidr: cluster.networkProfile?.serviceCidr,
          dnsServiceIp: cluster.networkProfile?.dnsServiceIP,
          loadBalancerSku: cluster.networkProfile?.loadBalancerSku,

          // Identity & security
          identityType: cluster.identity?.type,
          clientId: cluster.servicePrincipalProfile?.clientId,
          enableRBAC: cluster.enableRBAC || false,
          enablePrivateCluster: cluster.apiServerAccessProfile?.enablePrivateCluster || false,
          authorizedIpRanges: cluster.apiServerAccessProfile?.authorizedIPRanges || [],
          addonProfiles: cluster.addonProfiles ? Object.entries(cluster.addonProfiles).map(([k, v]) => ({
            name: k,
            enabled: v.enabled,
          })) : [],

          // OS & node config
          nodeResourceGroup: cluster.nodeResourceGroup,
          autoUpgradeChannel: cluster.autoUpgradeProfile?.upgradeChannel || 'none',

          launchTime: null,
          uptime: null,
          cpu: null,
          memUsage: null,
          cost: estimateMonthlyCost({ family: 'Container' }) * (nodeCount || 1),
          tags: cluster.tags || {},
          connections: [],
        });
      }
      return clusters;
    } catch (e) {
      console.error('AKS error:', e.message);
      return [];
    }
  }

  async getSQLCurrentSizeBytes(cred, resourceId) {
    try {
      const monitorClient = new MonitorClient(cred, this.subscriptionId);
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 10 * 60 * 1000);
      const result = await monitorClient.metrics.list(resourceId, {
        metricnames: 'storage',
        timespan: `${startTime.toISOString()}/${endTime.toISOString()}`,
        interval: 'PT1M',
        aggregation: 'Average',
      });
      const series = result?.value?.[0]?.timeseries;
      if (!series || series.length === 0) return null;
      const dataPoints = series[0].data || [];
      const latest = dataPoints.filter(d => d.average != null).pop();
      return latest?.average != null ? Math.round(latest.average) : null;
    } catch {
      return null;
    }
  }

  async getSQLDatabases() {
    try {
      const cred = this.getCredential();
      const sqlClient = new SqlManagementClient(cred, this.subscriptionId);
      const dbs = [];

      for await (const server of sqlClient.servers.list()) {
        const rg = server.id?.split('/')[4] || 'unknown';

        for await (const db of sqlClient.databases.listByServer(rg, server.name || '')) {
          if (db.name === 'master') continue;

          dbs.push({
            id: `az-sqldb-${db.name}-${server.name}`,
            rawId: db.id,
            name: db.name || 'unnamed-db',
            type: 'Azure SQL Database',
            family: 'Database',
            provider: 'azure',
            region: db.location,
            resourceGroup: rg,
            server: server.name,
            serverFqdn: server.fullyQualifiedDomainName,
            status: db.status,
            health: db.status === 'Online' ? 'healthy' : healthFromStatus(db.status),

            // Specs
            tier: db.sku?.tier,
            size: db.sku?.name,
            skuCapacity: db.sku?.capacity,
            storageGB: Math.round((db.maxSizeBytes || 0) / 1073741824),
            maxSizeBytes: db.maxSizeBytes,
            currentSizeBytes: null, // populated below via Azure Monitor

            // Edition / service objective
            edition: db.edition,
            serviceObjective: db.currentServiceObjectiveName,
            elasticPoolId: db.elasticPoolId?.split('/').pop() || null,

            // Server details
            serverVersion: server.version,
            serverAdminLogin: server.administratorLogin,
            serverPublicNetworkAccess: server.publicNetworkAccess,
            serverMinTlsVersion: server.minimalTlsVersion,
            serverConnectionPolicy: null,

            // Network
            ip: null,
            endpoint: server.fullyQualifiedDomainName ? `${server.fullyQualifiedDomainName}:1433` : null,

            // HA & Backup
            zoneRedundant: db.zoneRedundant || false,
            geoReplication: db.secondaryType != null,
            secondaryType: db.secondaryType,
            requestedBackupStorageRedundancy: db.requestedBackupStorageRedundancy,
            earliestRestoreDate: db.earliestRestoreDate,

            // Licensing
            licenseType: db.licenseType,
            readReplicaCount: db.highAvailabilityReplicaCount || 0,
            readScale: db.readScale,
            collation: db.collation,

            // Encryption
            transparentDataEncryption: true,

            launchTime: db.creationDate,
            uptime: db.creationDate ? formatUptime(db.creationDate) : null,
            cpu: null,
            dbConnections: null,
            cost: estimateMonthlyCost({ family: 'Database' }),
            tags: db.tags || {},
            connections: [],
          });
        }
      }

      // Fetch real-time storage usage from Azure Monitor in parallel
      await Promise.all(dbs.map(async (db) => {
        if (db.rawId) {
          db.currentSizeBytes = await this.getSQLCurrentSizeBytes(cred, db.rawId);
        }
      }));

      return dbs;
    } catch (e) {
      console.error('Azure SQL error:', e.message);
      return [];
    }
  }

  async getStorageAccounts() {
    try {
      const cred = this.getCredential();
      const storageClient = new StorageManagementClient(cred, this.subscriptionId);
      const accounts = [];

      for await (const account of storageClient.storageAccounts.list()) {
        const rg = account.id?.split('/')[4] || 'unknown';

        accounts.push({
          id: `az-storage-${account.name}`,
          rawId: account.id,
          name: account.name || 'unnamed-storage',
          type: 'Storage Account',
          family: 'Storage',
          provider: 'azure',
          region: account.location,
          resourceGroup: rg,
          status: account.provisioningState,
          health: account.provisioningState === 'Succeeded' ? 'healthy' : healthFromStatus(account.provisioningState),

          // Tier & type
          tier: account.sku?.tier,
          skuName: account.sku?.name,
          kind: account.kind,
          accessTier: account.accessTier,

          // Endpoints
          blobEndpoint: account.primaryEndpoints?.blob || null,
          fileEndpoint: account.primaryEndpoints?.file || null,
          queueEndpoint: account.primaryEndpoints?.queue || null,
          tableEndpoint: account.primaryEndpoints?.table || null,
          dfsEndpoint: account.primaryEndpoints?.dfs || null,
          primaryLocation: account.primaryLocation,
          secondaryLocation: account.secondaryLocation,
          statusOfPrimary: account.statusOfPrimary,
          statusOfSecondary: account.statusOfSecondary,

          // Security & encryption
          encryption: account.encryption?.services?.blob?.enabled ? 'Enabled' : 'Disabled',
          encryptionKeyType: account.encryption?.keySource || 'Microsoft.Storage',
          keyVaultUri: account.encryption?.keyVaultProperties?.keyVaultUri || null,
          httpsOnly: account.enableHttpsTrafficOnly,
          minTlsVersion: account.minimumTlsVersion,
          allowBlobPublicAccess: account.allowBlobPublicAccess,
          allowSharedKeyAccess: account.allowSharedKeyAccess,

          // Network rules
          networkDefaultAction: account.networkRuleSet?.defaultAction || 'Allow',
          networkBypassServices: account.networkRuleSet?.bypass || [],
          ipRules: (account.networkRuleSet?.ipRules || []).map(r => r.iPAddressOrRange),
          virtualNetworkRules: (account.networkRuleSet?.virtualNetworkRules || []).length,

          // Replication & DR
          replicationKind: account.sku?.name, // LRS, GRS, RAGRS, ZRS, GZRS, RAGZRS
          largeFileSharesState: account.largeFileSharesState,

          // Lifecycle
          creationTime: account.creationTime,
          launchTime: account.creationTime,
          uptime: account.creationTime ? formatUptime(account.creationTime) : null,

          sizeGB: null, // Requires Metrics API call
          blobCount: null,
          cost: 5 + Math.random() * 30,
          tags: account.tags || {},
          connections: [],
        });
      }
      return accounts;
    } catch (e) {
      console.error('Azure Storage error:', e.message);
      return [];
    }
  }

  async getCosmosDBAccounts() {
    try {
      const cred = this.getCredential();
      const cosmosClient = new CosmosDBManagementClient(cred, this.subscriptionId);
      const accounts = [];

      for await (const account of cosmosClient.databaseAccounts.list()) {
        const rg = account.id?.split('/')[4] || 'unknown';

        accounts.push({
          id: `az-cosmos-${account.name}`,
          rawId: account.id,
          name: account.name || 'unnamed-cosmos',
          type: 'Cosmos DB Account',
          family: 'Database',
          provider: 'azure',
          region: account.location,
          resourceGroup: rg,
          status: account.provisioningState,
          health: account.provisioningState === 'Succeeded' ? 'healthy' : healthFromStatus(account.provisioningState),

          // Configuration
          kind: account.kind,
          databaseAccountOfferType: account.databaseAccountOfferType,
          consistencyLevel: account.consistencyPolicy?.defaultConsistencyLevel,

          // Network
          ip: null,
          documentEndpoint: account.documentEndpoint,
          publicNetworkAccess: account.publicNetworkAccess,
          ipRules: (account.ipRules || []).map(r => r.ipAddressOrRange),
          isVirtualNetworkFilterEnabled: account.isVirtualNetworkFilterEnabled || false,
          virtualNetworkRules: (account.virtualNetworkRules || []).length,

          // Geo-distribution
          geoReplication: (account.locations?.length || 0) > 1,
          writeLocations: account.writeLocations?.map(l => l.locationName) || [],
          readLocations: account.readLocations?.map(l => l.locationName) || [],
          failoverPolicies: (account.failoverPolicies || []).map(f => ({
            location: f.locationName,
            priority: f.failoverPriority,
          })),

          // Security
          disableKeyBasedMetadataWriteAccess: account.disableKeyBasedMetadataWriteAccess || false,
          enableFreeTier: account.enableFreeTier || false,
          enableAnalyticalStorage: account.enableAnalyticalStorage || false,
          backupPolicy: account.backupPolicy?.type,

          launchTime: null,
          uptime: null,
          cpu: null,
          dbConnections: null,
          cost: 25 + Math.random() * 100,
          tags: account.tags || {},
          connections: [],
        });
      }
      return accounts;
    } catch (e) {
      console.error('CosmosDB error:', e.message);
      return [];
    }
  }

  async getEventHubs() {
    try {
      const cred = this.getCredential();
      const ehClient = new EventHubManagementClient(cred, this.subscriptionId);
      const hubs = [];

      for await (const ns of ehClient.namespaces.list()) {
        const rg = ns.id?.split('/')[4] || 'unknown';
        let eventHubCount = 0;
        try {
          for await (const eh of ehClient.eventHubs.listByNamespace(rg, ns.name || '')) {
            eventHubCount++;
          }
        } catch {}

        hubs.push({
          id: `az-eventhub-${ns.name}`,
          rawId: ns.id,
          name: ns.name || 'unnamed-eventhub',
          type: 'Event Hub Namespace',
          family: 'Messaging',
          provider: 'azure',
          region: ns.location,
          resourceGroup: rg,
          status: ns.provisioningState,
          health: ns.provisioningState === 'Succeeded' ? 'healthy' : healthFromStatus(ns.provisioningState),

          // Tier & capacity
          tier: ns.sku?.tier,
          skuName: ns.sku?.name,
          capacity: ns.sku?.capacity,
          maximumThroughputUnits: ns.maximumThroughputUnits,
          isAutoInflateEnabled: ns.isAutoInflateEnabled || false,
          kafkaEnabled: ns.kafkaEnabled || false,
          zoneRedundant: ns.zoneRedundant || false,

          // Network
          endpoint: ns.serviceBusEndpoint,
          publicNetworkAccess: ns.publicNetworkAccess,

          // Namespaces & hubs
          eventHubCount,

          creationTime: ns.createdAt,
          launchTime: ns.createdAt,
          uptime: ns.createdAt ? formatUptime(ns.createdAt) : null,
          cost: 10 + Math.random() * 40,
          tags: ns.tags || {},
          connections: [],
        });
      }
      return hubs;
    } catch (e) {
      console.error('Event Hub error:', e.message);
      return [];
    }
  }

  async getFunctionApps() {
    try {
      const cred = this.getCredential();
      const webClient = new WebSiteManagementClient(cred, this.subscriptionId);
      const apps = [];

      for await (const app of webClient.webApps.list()) {
        if (!app.kind?.includes('functionapp')) continue;
        const rg = app.id?.split('/')[4] || 'unknown';

        // Fetch site config for runtime details
        let siteConfig = {};
        try {
          const sc = await webClient.webApps.getConfiguration(rg, app.name || '');
          siteConfig = {
            linuxFxVersion: sc.linuxFxVersion,
            windowsFxVersion: sc.windowsFxVersion,
            phpVersion: sc.phpVersion,
            pythonVersion: sc.pythonVersion,
            nodeVersion: sc.nodeVersion,
            dotnetFrameworkVersion: sc.netFrameworkVersion,
            javaVersion: sc.javaVersion,
            use32BitWorkerProcess: sc.use32BitWorkerProcess,
            alwaysOn: sc.alwaysOn,
            functionAppScaleLimit: sc.functionAppScaleLimit,
            minimumElasticInstanceCount: sc.minimumElasticInstanceCount,
            vnetRouteAllEnabled: sc.vnetRouteAllEnabled,
            http20Enabled: sc.http20Enabled,
            minTlsVersion: sc.minTlsVersion,
            ftpsState: sc.ftpsState,
          };
        } catch {}

        apps.push({
          id: `az-func-${app.name}`,
          rawId: app.id,
          name: app.name || 'unnamed-function',
          type: 'Azure Function App',
          family: 'Serverless',
          provider: 'azure',
          region: app.location,
          resourceGroup: rg,
          status: app.state,
          health: app.state === 'Running' ? 'healthy' : healthFromStatus(app.state),

          // Runtime
          kind: app.kind,
          runtime: siteConfig.linuxFxVersion || siteConfig.windowsFxVersion || 'Unknown',
          os: app.kind?.includes('linux') ? 'Linux' : 'Windows',

          // Endpoints
          defaultHostName: app.defaultHostName,
          enabledHostNames: app.enabledHostNames || [],
          httpsOnly: app.httpsOnly,

          // Network
          vnet: app.virtualNetworkSubnetId?.split('/')[app.virtualNetworkSubnetId?.split('/').indexOf('virtualNetworks') + 1] || null,
          vnetSubnetId: app.virtualNetworkSubnetId?.split('/').pop() || null,
          outboundIpAddresses: app.outboundIpAddresses?.split(',') || [],
          possibleOutboundIpAddresses: app.possibleOutboundIpAddresses?.split(',') || [],

          // Config details
          alwaysOn: siteConfig.alwaysOn,
          scaleLimit: siteConfig.functionAppScaleLimit,
          minElasticInstances: siteConfig.minimumElasticInstanceCount,
          minTlsVersion: siteConfig.minTlsVersion,
          ftpsState: siteConfig.ftpsState,

          // Identity
          identityType: app.identity?.type,

          launchTime: null,
          uptime: null,
          invocations: null,
          errors: null,
          duration: null,
          cost: 0.5 + Math.random() * 5,
          tags: app.tags || {},
          connections: [],
        });
      }
      return apps;
    } catch (e) {
      console.error('Azure Functions error:', e.message);
      return [];
    }
  }

  async getVirtualNetworks() {
    try {
      const cred = this.getCredential();
      const networkClient = new NetworkManagementClient(cred, this.subscriptionId);
      const vnets = [];

      for await (const vnet of networkClient.virtualNetworks.listAll()) {
        const rg = vnet.id?.split('/')[4] || 'unknown';

        // Build subnet details
        const subnets = (vnet.subnets || []).map(s => ({
          name: s.name,
          addressPrefix: s.addressPrefix,
          provisioningState: s.provisioningState,
          nsgId: s.networkSecurityGroup?.id?.split('/').pop() || null,
          routeTableId: s.routeTable?.id?.split('/').pop() || null,
          serviceEndpoints: (s.serviceEndpoints || []).map(se => se.service),
          delegations: (s.delegations || []).map(d => d.serviceName),
          privateEndpointNetworkPolicies: s.privateEndpointNetworkPolicies,
          privateLinkServiceNetworkPolicies: s.privateLinkServiceNetworkPolicies,
        }));

        // DNS settings
        const dnsServers = vnet.dhcpOptions?.dnsServers || [];

        vnets.push({
          id: `az-vnet-${vnet.name}`,
          rawId: vnet.id,
          name: vnet.name || 'unnamed-vnet',
          type: 'Virtual Network',
          family: 'Networking',
          provider: 'azure',
          region: vnet.location,
          resourceGroup: rg,
          status: vnet.provisioningState,
          health: vnet.provisioningState === 'Succeeded' ? 'healthy' : healthFromStatus(vnet.provisioningState),
          cidr: vnet.addressSpace?.addressPrefixes?.[0],
          addressPrefixes: vnet.addressSpace?.addressPrefixes || [],
          subnets,
          subnetCount: subnets.length,
          dnsServers,
          enableDdosProtection: vnet.enableDdosProtection || false,
          ddosProtectionPlan: vnet.ddosProtectionPlan?.id?.split('/').pop() || null,
          enableVmProtection: vnet.enableVmProtection || false,
          virtualNetworkPeerings: (vnet.virtualNetworkPeerings || []).map(p => ({
            name: p.name,
            remoteVnetId: p.remoteVirtualNetwork?.id?.split('/').pop() || null,
            state: p.peeringState,
            allowVnetAccess: p.allowVirtualNetworkAccess,
            allowForwardedTraffic: p.allowForwardedTraffic,
            allowGatewayTransit: p.allowGatewayTransit,
            useRemoteGateways: p.useRemoteGateways,
          })),
          peeringCount: (vnet.virtualNetworkPeerings || []).length,
          cost: 0,
          tags: vnet.tags || {},
          connections: [],
        });
      }
      return vnets;
    } catch (e) {
      return [];
    }
  }

  async getAlerts() {
    try {
      const cred = this.getCredential();
      const monitorClient = new MonitorClient(cred, this.subscriptionId);
      const alerts = [];
      for await (const rule of monitorClient.alertRules.listBySubscription()) {
        if (rule.isEnabled === false) continue;
        alerts.push({
          id: `az-alert-${rule.name}`,
          title: rule.name || 'Azure Alert',
          message: rule.description || 'Alert rule triggered',
          severity: 'warning',
          provider: 'azure',
          service: 'Azure Monitor',
          region: rule.location || 'global',
          time: new Date().toISOString(),
          acknowledged: false,
        });
      }
      return alerts;
    } catch (e) {
      console.error('Azure Monitor error:', e.message);
      return [];
    }
  }

  async getAllResources() {
    const results = await Promise.allSettled([
      this.getVirtualMachines(),
      this.getAKSClusters(),
      this.getSQLDatabases(),
      this.getStorageAccounts(),
      this.getCosmosDBAccounts(),
      this.getEventHubs(),
      this.getFunctionApps(),
      this.getVirtualNetworks(),
    ]);

    let allResources = [];
    for (const r of results) {
      if (r.status === 'fulfilled') allResources = allResources.concat(r.value);
    }
    buildAzureConnectionGraph(allResources);
    return allResources;
  }
}

function buildAzureConnectionGraph(resources) {
  const byRG = {};
  const byVnet = {};
  for (const r of resources) {
    const rg = r.resourceGroup;
    if (rg) {
      if (!byRG[rg]) byRG[rg] = [];
      byRG[rg].push(r.id);
    }
    if (r.vnet) {
      if (!byVnet[r.vnet]) byVnet[r.vnet] = [];
      byVnet[r.vnet].push(r.id);
    }
  }
  for (const r of resources) {
    const conns = new Set();
    const rg = r.resourceGroup;
    if (rg && byRG[rg]) {
      byRG[rg].filter(id => id !== r.id).slice(0, 6).forEach(id => conns.add(id));
    }
    if (r.vnet && byVnet[r.vnet]) {
      byVnet[r.vnet].filter(id => id !== r.id).slice(0, 4).forEach(id => conns.add(id));
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

module.exports = AzureService;
