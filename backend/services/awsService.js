// services/awsService.js
const { EC2Client, DescribeInstancesCommand, DescribeVpcsCommand, DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand, DescribeInternetGatewaysCommand, DescribeNatGatewaysCommand,
  DescribeNetworkInterfacesCommand, DescribeInstanceTypesCommand, DescribeImagesCommand,
  DescribeVolumesCommand, DescribeRouteTablesCommand } = require('@aws-sdk/client-ec2');
const { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand,
  DescribeDBParameterGroupsCommand, DescribeDBSubnetGroupsCommand } = require('@aws-sdk/client-rds');
const { S3Client, ListBucketsCommand, GetBucketLocationCommand, GetBucketAclCommand,
  GetBucketVersioningCommand, GetBucketEncryptionCommand, GetBucketTaggingCommand,
  GetBucketLifecycleConfigurationCommand, ListObjectsV2Command,
  GetPublicAccessBlockCommand } = require('@aws-sdk/client-s3');
const { LambdaClient, ListFunctionsCommand, GetFunctionCommand,
  GetFunctionConcurrencyCommand, ListLayersCommand } = require('@aws-sdk/client-lambda');
const { EKSClient, ListClustersCommand, DescribeClusterCommand, ListNodegroupsCommand,
  DescribeNodegroupCommand, ListAddonsCommand, DescribeAddonCommand } = require('@aws-sdk/client-eks');
const { ECSClient, ListClustersCommand: ECSListClustersCommand, DescribeClustersCommand,
  ListServicesCommand, DescribeServicesCommand } = require('@aws-sdk/client-ecs');
const { ElastiCacheClient, DescribeCacheClustersCommand } = require('@aws-sdk/client-elasticache');
const { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand, DescribeTargetHealthCommand, DescribeListenersCommand } = require('@aws-sdk/client-elastic-load-balancing-v2');
const { CloudWatchClient, GetMetricStatisticsCommand, DescribeAlarmsCommand, ListMetricsCommand } = require('@aws-sdk/client-cloudwatch');
const { SQSClient, ListQueuesCommand, GetQueueAttributesCommand } = require('@aws-sdk/client-sqs');
const { SNSClient, ListTopicsCommand, GetTopicAttributesCommand } = require('@aws-sdk/client-sns');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const { IAMClient, ListInstanceProfilesCommand } = require('@aws-sdk/client-iam');
const { SSMClient, GetInventoryCommand, SendCommandCommand, GetCommandInvocationCommand } = require('@aws-sdk/client-ssm');
const { mapFamily, healthFromStatus, estimateMonthlyCost } = require('../utils/normalizer');

// vCPU & memory lookup for common instance families (fallback when DescribeInstanceTypes unavailable)
const INSTANCE_SPECS = {
  't2.nano': { vcpu: 1, memGiB: 0.5 }, 't2.micro': { vcpu: 1, memGiB: 1 }, 't2.small': { vcpu: 1, memGiB: 2 },
  't2.medium': { vcpu: 2, memGiB: 4 }, 't2.large': { vcpu: 2, memGiB: 8 }, 't2.xlarge': { vcpu: 4, memGiB: 16 },
  't3.nano': { vcpu: 2, memGiB: 0.5 }, 't3.micro': { vcpu: 2, memGiB: 1 }, 't3.small': { vcpu: 2, memGiB: 2 },
  't3.medium': { vcpu: 2, memGiB: 4 }, 't3.large': { vcpu: 2, memGiB: 8 }, 't3.xlarge': { vcpu: 4, memGiB: 16 }, 't3.2xlarge': { vcpu: 8, memGiB: 32 },
  'm5.large': { vcpu: 2, memGiB: 8 }, 'm5.xlarge': { vcpu: 4, memGiB: 16 }, 'm5.2xlarge': { vcpu: 8, memGiB: 32 }, 'm5.4xlarge': { vcpu: 16, memGiB: 64 },
  'm6i.large': { vcpu: 2, memGiB: 8 }, 'm6i.xlarge': { vcpu: 4, memGiB: 16 }, 'm6i.2xlarge': { vcpu: 8, memGiB: 32 },
  'c5.large': { vcpu: 2, memGiB: 4 }, 'c5.xlarge': { vcpu: 4, memGiB: 8 }, 'c5.2xlarge': { vcpu: 8, memGiB: 16 }, 'c5.4xlarge': { vcpu: 16, memGiB: 32 },
  'c6i.large': { vcpu: 2, memGiB: 4 }, 'c6i.xlarge': { vcpu: 4, memGiB: 8 }, 'c6i.2xlarge': { vcpu: 8, memGiB: 16 },
  'r5.large': { vcpu: 2, memGiB: 16 }, 'r5.xlarge': { vcpu: 4, memGiB: 32 }, 'r5.2xlarge': { vcpu: 8, memGiB: 64 },
  'r6i.large': { vcpu: 2, memGiB: 16 }, 'r6i.xlarge': { vcpu: 4, memGiB: 32 }, 'r6i.2xlarge': { vcpu: 8, memGiB: 64 },
  'p3.2xlarge': { vcpu: 8, memGiB: 61 }, 'p3.8xlarge': { vcpu: 32, memGiB: 244 },
  'g4dn.xlarge': { vcpu: 4, memGiB: 16 }, 'g4dn.2xlarge': { vcpu: 8, memGiB: 32 },
};

const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'eu-west-1', 'eu-west-2', 'eu-central-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
  'ap-south-1', 'ca-central-1', 'sa-east-1',
];

class AWSService {
  constructor(credentials) {
    this.creds = credentials;
    this.region = credentials.region || 'us-east-1';
    this._instanceTypeCache = {};
    this._sgCache = {};
    this._igwCache = {};
  }

  getClientConfig(region) {
    const cfg = { region: region || this.region };
    if (this.creds.authType === 'keys') {
      cfg.credentials = {
        accessKeyId: this.creds.accessKeyId,
        secretAccessKey: this.creds.secretAccessKey,
        ...(this.creds.sessionToken ? { sessionToken: this.creds.sessionToken } : {}),
      };
    }
    return cfg;
  }

  async verifyConnection() {
    try {
      const sts = new STSClient(this.getClientConfig());
      const res = await sts.send(new GetCallerIdentityCommand({}));
      return { success: true, account: res.Account, arn: res.Arn, userId: res.UserId };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async getMetric(namespace, metricName, dimensions, region) {
    try {
      const cw = new CloudWatchClient(this.getClientConfig(region));
      const end = new Date();
      const start = new Date(end - 10 * 60 * 1000);
      const res = await cw.send(new GetMetricStatisticsCommand({
        Namespace: namespace,
        MetricName: metricName,
        Dimensions: dimensions,
        StartTime: start,
        EndTime: end,
        Period: 300,
        Statistics: ['Average'],
      }));
      const pts = res.Datapoints || [];
      if (!pts.length) return null;
      pts.sort((a, b) => b.Timestamp - a.Timestamp);
      return Math.round(pts[0].Average * 10) / 10;
    } catch { return null; }
  }

  // Fetch instance type specs (vCPU, memory) from AWS with cache
  async getInstanceTypeSpecs(instanceType, region) {
    if (!instanceType) return { vcpu: null, memGiB: null };
    const cacheKey = `${region}:${instanceType}`;
    if (this._instanceTypeCache[cacheKey]) return this._instanceTypeCache[cacheKey];
    // Use local lookup first
    if (INSTANCE_SPECS[instanceType]) {
      this._instanceTypeCache[cacheKey] = INSTANCE_SPECS[instanceType];
      return INSTANCE_SPECS[instanceType];
    }
    try {
      const ec2 = new EC2Client(this.getClientConfig(region));
      const res = await ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: [instanceType] }));
      const it = res.InstanceTypes?.[0];
      if (it) {
        const specs = {
          vcpu: it.VCpuInfo?.DefaultVCpus || null,
          memGiB: it.MemoryInfo?.SizeInMiB ? it.MemoryInfo.SizeInMiB / 1024 : null,
          gpus: it.GpuInfo?.Gpus?.[0]?.Count || 0,
          gpuModel: it.GpuInfo?.Gpus?.[0]?.Name || null,
          networkPerformance: it.NetworkInfo?.NetworkPerformance || null,
          storageSupported: it.InstanceStorageSupported || false,
          instanceStorageGB: it.InstanceStorageInfo?.TotalSizeInGB || 0,
          processorArch: it.ProcessorInfo?.SupportedArchitectures?.[0] || null,
          hypervisor: it.Hypervisor || null,
        };
        this._instanceTypeCache[cacheKey] = specs;
        return specs;
      }
    } catch {}
    return { vcpu: null, memGiB: null };
  }

  // Fetch all security groups in a region with full rules, cached
  async getSecurityGroupDetails(sgIds, region) {
    if (!sgIds || !sgIds.length) return [];
    try {
      const ec2 = new EC2Client(this.getClientConfig(region));
      const res = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: sgIds }));
      return (res.SecurityGroups || []).map(sg => ({
        id: sg.GroupId,
        name: sg.GroupName,
        description: sg.Description,
        vpcId: sg.VpcId,
        inboundRules: (sg.IpPermissions || []).map(p => ({
          protocol: p.IpProtocol === '-1' ? 'All' : p.IpProtocol,
          fromPort: p.FromPort,
          toPort: p.ToPort,
          sources: [
            ...(p.IpRanges || []).map(r => r.CidrIp),
            ...(p.Ipv6Ranges || []).map(r => r.CidrIpv6),
            ...(p.UserIdGroupPairs || []).map(r => r.GroupId),
          ],
        })),
        outboundRules: (sg.IpPermissionsEgress || []).map(p => ({
          protocol: p.IpProtocol === '-1' ? 'All' : p.IpProtocol,
          fromPort: p.FromPort,
          toPort: p.ToPort,
          destinations: [
            ...(p.IpRanges || []).map(r => r.CidrIp),
            ...(p.Ipv6Ranges || []).map(r => r.CidrIpv6),
          ],
        })),
      }));
    } catch { return []; }
  }

  // Fetch EBS volume sizes for a list of volume IDs
  async getEBSVolumeSizes(volumeIds, region) {
    if (!volumeIds || !volumeIds.length) return [];
    try {
      const ec2 = new EC2Client(this.getClientConfig(region));
      const res = await ec2.send(new DescribeVolumesCommand({ VolumeIds: volumeIds }));
      return (res.Volumes || []).map(v => ({
        id: v.VolumeId,
        sizeGB: v.Size || 0,
        type: v.VolumeType,
        state: v.State,
        iops: v.Iops,
        encrypted: v.Encrypted,
      }));
    } catch { return []; }
  }

  // Fetch disk usage metrics from CloudWatch Agent for an EC2 instance
  // Requires AWS CloudWatch Agent to be installed and publishing CWAgent metrics to CloudWatch.
  // Read EC2 disk usage from CloudWatch CWAgent namespace — read-only, no metrics created,
  // free within CloudWatch free tier (1M API requests/month free).
  // Returns all mounted filesystems the same shape as SSM Inventory data.
  async getInstanceDiskMetricsFromCWAgent(instanceId, region) {
    try {
      const cw = new CloudWatchClient(this.getClientConfig(region));
      // List all disk_used metrics for this instance (one entry per filesystem/path)
      const listRes = await cw.send(new ListMetricsCommand({
        Namespace: 'CWAgent',
        MetricName: 'disk_used',
        Dimensions: [{ Name: 'InstanceId', Value: instanceId }],
      }));
      const metrics = listRes.Metrics || [];
      if (!metrics.length) return null;

      const toGB = v => v != null ? Math.round(v / 1073741824 * 100) / 100 : null;

      // Fetch used / free / total for every filesystem in parallel
      const filesystems = await Promise.all(metrics.map(async metric => {
        const dims = metric.Dimensions;
        const path = dims.find(d => d.Name === 'path')?.Value || '/';
        const [used, free, total] = await Promise.all([
          this.getMetric('CWAgent', 'disk_used',  dims, region),
          this.getMetric('CWAgent', 'disk_free',  dims, region),
          this.getMetric('CWAgent', 'disk_total', dims, region),
        ]);
        if (used == null && free == null && total == null) return null;
        const diskTotalGB = toGB(total);
        const diskUsedGB  = toGB(used);
        const diskFreeGB  = toGB(free);
        return {
          name: path,
          diskTotalGB,
          diskUsedGB,
          diskFreeGB,
          utilization: diskTotalGB > 0 && diskUsedGB != null
            ? Math.round((diskUsedGB / diskTotalGB) * 100) : null,
        };
      }));

      const valid = filesystems.filter(f => f && f.diskTotalGB > 0);
      return valid.length > 0 ? valid : null;
    } catch { return null; }
  }

  // Fetch real S3 bucket size from CloudWatch BucketSizeBytes (accurate, no agent, just access keys)
  // CloudWatch S3 metrics are updated daily — no object listing limit
  async getS3BucketSizeFromCloudWatch(bucketName, region) {
    try {
      const cw = new CloudWatchClient(this.getClientConfig(region));
      // Discover which storage-type metrics exist for this bucket
      const listRes = await cw.send(new ListMetricsCommand({
        Namespace: 'AWS/S3',
        MetricName: 'BucketSizeBytes',
        Dimensions: [{ Name: 'BucketName', Value: bucketName }],
      }));
      const metrics = listRes.Metrics || [];
      if (!metrics.length) return null;

      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 3 * 24 * 60 * 60 * 1000); // 3 days back (S3 metrics are daily)

      let totalBytes = 0;
      await Promise.all(metrics.map(async metric => {
        try {
          const res = await cw.send(new GetMetricStatisticsCommand({
            Namespace: 'AWS/S3',
            MetricName: 'BucketSizeBytes',
            Dimensions: metric.Dimensions,
            StartTime: startTime,
            EndTime: endTime,
            Period: 86400,
            Statistics: ['Average'],
          }));
          const latest = (res.Datapoints || []).sort((a, b) => new Date(b.Timestamp) - new Date(a.Timestamp))[0];
          if (latest?.Average != null) totalBytes += latest.Average;
        } catch {}
      }));

      return totalBytes > 0 ? Math.round(totalBytes / 1073741824 * 1000) / 1000 : null;
    } catch { return null; }
  }

  // Fetch real S3 object count from CloudWatch NumberOfObjects
  async getS3ObjectCountFromCloudWatch(bucketName, region) {
    try {
      const cw = new CloudWatchClient(this.getClientConfig(region));
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 3 * 24 * 60 * 60 * 1000);
      const res = await cw.send(new GetMetricStatisticsCommand({
        Namespace: 'AWS/S3',
        MetricName: 'NumberOfObjects',
        Dimensions: [
          { Name: 'BucketName', Value: bucketName },
          { Name: 'StorageType', Value: 'AllStorageTypes' },
        ],
        StartTime: startTime,
        EndTime: endTime,
        Period: 86400,
        Statistics: ['Average'],
      }));
      const latest = (res.Datapoints || []).sort((a, b) => new Date(b.Timestamp) - new Date(a.Timestamp))[0];
      return latest?.Average != null ? Math.round(latest.Average) : null;
    } catch { return null; }
  }

  // Fetch real filesystem usage from SSM Inventory (AWS:FileSystem)
  // Works on any instance with SSM Agent installed (default on AL2, AL2023, Windows Server 2016+)
  async getInstanceFilesystemData(instanceId, region) {
    try {
      const ssm = new SSMClient(this.getClientConfig(region));
      const res = await ssm.send(new GetInventoryCommand({
        Filters: [{ Key: 'AWS:InstanceInformation.InstanceId', Values: [instanceId], Type: 'Equal' }],
        ResultAttributes: [{ TypeName: 'AWS:FileSystem' }],
        MaxResults: 10,
      }));
      const entity = (res.Entities || [])[0];
      const fsData = entity?.Data?.['AWS:FileSystem']?.Content;
      if (!fsData || !fsData.length) return null;

      // Parse "X.XX GB" strings to numbers
      const parseGB = str => {
        if (!str) return null;
        const n = parseFloat(str);
        if (isNaN(n)) return null;
        const s = str.toUpperCase();
        if (s.includes('TB')) return Math.round(n * 1024 * 100) / 100;
        if (s.includes('MB')) return Math.round(n / 1024 * 100) / 100;
        return Math.round(n * 100) / 100; // already GB
      };

      // Prefer root filesystem (/), then C:, then largest
      const sorted = [...fsData].sort((a, b) => {
        const aRoot = a.Name === '/' || a.Name === 'C:' || a.MountPoint === '/';
        const bRoot = b.Name === '/' || b.Name === 'C:' || b.MountPoint === '/';
        if (aRoot && !bRoot) return -1;
        if (bRoot && !aRoot) return 1;
        return (parseGB(b.Size) || 0) - (parseGB(a.Size) || 0);
      });

      // Return all filesystems, not just root
      return sorted.map(fs => ({
        name: fs.Name || fs.MountPoint || '/',
        type: fs.Type,
        diskTotalGB: parseGB(fs.Size),
        diskUsedGB: parseGB(fs.UsedSpace),
        diskFreeGB: parseGB(fs.AvailableSpace),
        utilization: parseFloat(fs.Utilization) || null,
      })).filter(fs => fs.diskTotalGB > 0);
    } catch { return null; }
  }

  // Check if a VPC has an internet gateway attached
  async getInternetGatewayForVpc(vpcId, region) {
    if (!vpcId) return null;
    const cacheKey = `${region}:${vpcId}`;
    if (this._igwCache[cacheKey] !== undefined) return this._igwCache[cacheKey];
    try {
      const ec2 = new EC2Client(this.getClientConfig(region));
      const res = await ec2.send(new DescribeInternetGatewaysCommand({
        Filters: [{ Name: 'attachment.vpc-id', Values: [vpcId] }],
      }));
      const igw = res.InternetGateways?.[0];
      const result = igw ? { id: igw.InternetGatewayId, state: igw.Attachments?.[0]?.State } : null;
      this._igwCache[cacheKey] = result;
      return result;
    } catch { this._igwCache[cacheKey] = null; return null; }
  }

  // Detect OS from platform details or AMI name
  detectOS(platformDetails, platform) {
    if (platform === 'windows') return 'Windows';
    if (!platformDetails) return 'Linux';
    const pd = platformDetails.toLowerCase();
    if (pd.includes('windows')) return 'Windows';
    if (pd.includes('amazon linux')) return 'Amazon Linux';
    if (pd.includes('ubuntu')) return 'Ubuntu';
    if (pd.includes('red hat') || pd.includes('rhel')) return 'RHEL';
    if (pd.includes('suse') || pd.includes('sles')) return 'SUSE Linux';
    if (pd.includes('debian')) return 'Debian';
    if (pd.includes('centos')) return 'CentOS';
    return 'Linux';
  }

  async installCWAgent(instanceId, region) {
    const ssm = new SSMClient(this.getClientConfig(region));
    const res = await ssm.send(new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: 'AWS-ConfigureAWSPackage',
      Parameters: { action: ['Install'], name: ['AmazonCloudWatchAgent'] },
      TimeoutSeconds: 600,
      Comment: 'Install CloudWatch Agent via CloudNexus',
    }));
    const commandId = res.Command?.CommandId;
    if (!commandId) throw new Error('SSM did not return a CommandId');
    return commandId;
  }

  async configureCWAgent(instanceId, region, platform) {
    const ssm = new SSMClient(this.getClientConfig(region));
    const isWindows = (platform || '').toLowerCase().includes('windows');

    const linuxScript = [
      'mkdir -p /opt/aws/amazon-cloudwatch-agent/etc',
      `cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'EOF'`,
      JSON.stringify({ metrics: { namespace: 'CWAgent', metrics_collected: { disk: {
        measurement: ['used', 'free', 'total'],
        metrics_collection_interval: 300,
        resources: ['*'],
        ignore_file_system_types: ['sysfs','devtmpfs','tmpfs','squashfs','overlay','proc','cgroup'],
      } } } }),
      'EOF',
      '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json',
      'systemctl enable amazon-cloudwatch-agent 2>/dev/null || true',
      'echo "CWAgent configured and started"',
    ].join('\n');

    const windowsScript = [
      '$p = "C:\\ProgramData\\Amazon\\AmazonCloudWatchAgent\\amazon-cloudwatch-agent.json"',
      'New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null',
      `'${JSON.stringify({ metrics: { namespace: 'CWAgent', metrics_collected: { LogicalDisk: {
        measurement: ['% Free Space', 'Free Megabytes'],
        resources: ['*'],
        metrics_collection_interval: 300,
      } } } })}' | Out-File -FilePath $p -Encoding UTF8 -Force`,
      '& "C:\\Program Files\\Amazon\\AmazonCloudWatchAgent\\amazon-cloudwatch-agent-ctl.ps1" -a fetch-config -m ec2 -s -c file:$p',
      'Write-Host "CWAgent configured and started"',
    ].join('\n');

    const res = await ssm.send(new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: isWindows ? 'AWS-RunPowerShellScript' : 'AWS-RunShellScript',
      Parameters: { commands: isWindows ? windowsScript.split('\n') : linuxScript.split('\n') },
      TimeoutSeconds: 300,
      Comment: 'Configure CloudWatch Agent via CloudNexus',
    }));
    const commandId = res.Command?.CommandId;
    if (!commandId) throw new Error('SSM did not return a CommandId for configure step');
    return commandId;
  }

  async getCWAgentCommandStatus(commandId, instanceId, region) {
    const ssm = new SSMClient(this.getClientConfig(region));
    try {
      const res = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }));
      return {
        status: res.StatusDetails,
        stdout: (res.StandardOutputContent || '').slice(-800),
        stderr: (res.StandardErrorContent || '').slice(-400),
      };
    } catch (e) {
      if (e.name === 'InvocationDoesNotExist') return { status: 'Pending' };
      throw e;
    }
  }

  async getEC2Instances(region) {
    try {
      const ec2 = new EC2Client(this.getClientConfig(region));
      const instances = [];

      // Paginate DescribeInstances to ensure we fetch >100 instances when present
      let nextToken = undefined;
      do {
        const res = await ec2.send(new DescribeInstancesCommand({ MaxResults: 1000, NextToken: nextToken }));
        for (const r of res.Reservations || []) {
          for (const i of r.Instances || []) {
          // Include ALL states: running, stopped, stopping, pending, terminated, shutting-down
          const nameTag = i.Tags?.find(t => t.Key === 'Name')?.Value;
          const tags = Object.fromEntries((i.Tags || []).map(t => [t.Key, t.Value]));

          // Fetch metrics, instance type specs, security group details, IGW, EBS volumes & disk metrics in parallel
          const ebsVolumeIds = (i.BlockDeviceMappings || []).map(b => b.Ebs?.VolumeId).filter(Boolean);
          const [cpu, netIn, netOut, diskRead, diskWrite, specs, sgDetails, igw, ebsVolumes] = await Promise.all([
            this.getMetric('AWS/EC2', 'CPUUtilization', [{ Name: 'InstanceId', Value: i.InstanceId }], region),
            this.getMetric('AWS/EC2', 'NetworkIn', [{ Name: 'InstanceId', Value: i.InstanceId }], region),
            this.getMetric('AWS/EC2', 'NetworkOut', [{ Name: 'InstanceId', Value: i.InstanceId }], region),
            this.getMetric('AWS/EC2', 'DiskReadBytes', [{ Name: 'InstanceId', Value: i.InstanceId }], region),
            this.getMetric('AWS/EC2', 'DiskWriteBytes', [{ Name: 'InstanceId', Value: i.InstanceId }], region),
            this.getInstanceTypeSpecs(i.InstanceType, region),
            this.getSecurityGroupDetails((i.SecurityGroups || []).map(sg => sg.GroupId), region),
            this.getInternetGatewayForVpc(i.VpcId, region),
            this.getEBSVolumeSizes(ebsVolumeIds, region),
          ]);

          // Collect all network interfaces (multiple ENIs possible)
          const networkInterfaces = (i.NetworkInterfaces || []).map(nic => ({
            interfaceId: nic.NetworkInterfaceId,
            subnetId: nic.SubnetId,
            vpcId: nic.VpcId,
            privateIp: nic.PrivateIpAddress,
            privateIps: (nic.PrivateIpAddresses || []).map(pip => pip.PrivateIpAddress),
            publicIp: nic.Association?.PublicIp,
            publicDns: nic.Association?.PublicDnsName,
            macAddress: nic.MacAddress,
            status: nic.Status,
            description: nic.Description,
          }));

          // Root and EBS volumes
          const volumes = (i.BlockDeviceMappings || []).map(bdm => ({
            deviceName: bdm.DeviceName,
            volumeId: bdm.Ebs?.VolumeId,
            deleteOnTermination: bdm.Ebs?.DeleteOnTermination,
            attachTime: bdm.Ebs?.AttachTime,
            status: bdm.Ebs?.Status,
          }));

          instances.push({
            id: `aws-ec2-${i.InstanceId}`,
            rawId: i.InstanceId,
            name: nameTag || i.InstanceId,
            type: 'EC2 Instance',
            family: 'Compute',
            provider: 'aws',
            region,
            az: i.Placement?.AvailabilityZone,
            tenancy: i.Placement?.Tenancy,
            status: i.State?.Name,
            health: i.State?.Name === 'running' ? 'healthy' : healthFromStatus(i.State?.Name),

            // Specs
            instanceType: i.InstanceType,
            vcpu: specs.vcpu || (i.CpuOptions?.CoreCount ? i.CpuOptions.CoreCount * (i.CpuOptions.ThreadsPerCore || 1) : null),
            memGiB: specs.memGiB,
            gpus: specs.gpus || 0,
            gpuModel: specs.gpuModel || null,
            networkPerformance: specs.networkPerformance,
            processorArch: specs.processorArch,
            hypervisor: specs.hypervisor || i.Hypervisor,
            instanceStorageGB: specs.instanceStorageGB || 0,

            // Network
            ip: i.PrivateIpAddress,
            publicIp: i.PublicIpAddress,
            privateDns: i.PrivateDnsName,
            publicDns: i.PublicDnsName,
            vpc: i.VpcId,
            subnet: i.SubnetId,
            networkInterfaces,
            internetGateway: igw,
            isPrivate: !i.PublicIpAddress,
            networkAccess: i.PublicIpAddress ? 'public' : 'private',

            // Security
            securityGroups: sgDetails,
            iamRole: i.IamInstanceProfile?.Arn?.split('/').pop() || null,
            iamProfileArn: i.IamInstanceProfile?.Arn || null,

            // OS & Image
            os: this.detectOS(i.PlatformDetails, i.Platform),
            platform: i.Platform || 'linux',
            platformDetails: i.PlatformDetails,
            imageId: i.ImageId,
            kernelId: i.KernelId,

            // Storage — real EBS sizes from DescribeVolumes (access key only, no agent)
            rootDeviceName: i.RootDeviceName,
            rootDeviceType: i.RootDeviceType,
            volumes,
            ebsVolumes,
            storageGB: ebsVolumes.reduce((s, v) => s + (v.sizeGB || 0), 0) || null,
            filesystems: null,
            diskUsedGB: null,
            diskFreeGB: null,
            diskTotalGB: null,
            diskPath: null,

            // Monitoring & lifecycle
            monitoring: i.Monitoring?.State,
            launchTime: i.LaunchTime,
            uptime: i.LaunchTime ? formatUptime(i.LaunchTime) : null,
            lifecycleType: i.InstanceLifecycle || 'on-demand',
            stateTransitionReason: i.StateTransitionReason,
            ebsOptimized: i.EbsOptimized,
            enaSupport: i.EnaSupport,
            sourceDestCheck: i.SourceDestCheck,

            // Metrics
            cpu: cpu ?? null,
            networkInKB: netIn ? Math.round(netIn / 1024) : null,
            networkOutKB: netOut ? Math.round(netOut / 1024) : null,
            diskReadKB: diskRead ? Math.round(diskRead / 1024) : null,
            diskWriteKB: diskWrite ? Math.round(diskWrite / 1024) : null,

            cost: estimateMonthlyCost({ instanceType: i.InstanceType, family: 'Compute' }),
            tags,
            connections: [],
          });
          }
        }
        nextToken = res.NextToken;
      } while (nextToken);

      return instances;
    } catch (e) {
      console.error(`EC2 error [${region}]:`, e.message);
      return [];
    }
  }

  async getRDSInstances(region) {
    try {
      const rds = new RDSClient(this.getClientConfig(region));
      const res = await rds.send(new DescribeDBInstancesCommand({}));
      const instances = [];

      for (const db of res.DBInstances || []) {
        const [cpu, conns, freeStorage, readIOPS, writeIOPS, specs] = await Promise.all([
          this.getMetric('AWS/RDS', 'CPUUtilization', [{ Name: 'DBInstanceIdentifier', Value: db.DBInstanceIdentifier }], region),
          this.getMetric('AWS/RDS', 'DatabaseConnections', [{ Name: 'DBInstanceIdentifier', Value: db.DBInstanceIdentifier }], region),
          this.getMetric('AWS/RDS', 'FreeStorageSpace', [{ Name: 'DBInstanceIdentifier', Value: db.DBInstanceIdentifier }], region),
          this.getMetric('AWS/RDS', 'ReadIOPS', [{ Name: 'DBInstanceIdentifier', Value: db.DBInstanceIdentifier }], region),
          this.getMetric('AWS/RDS', 'WriteIOPS', [{ Name: 'DBInstanceIdentifier', Value: db.DBInstanceIdentifier }], region),
          this.getInstanceTypeSpecs(db.DBInstanceClass?.replace('db.', ''), region).catch(() => ({})),
        ]);

        instances.push({
          id: `aws-rds-${db.DBInstanceIdentifier}`,
          rawId: db.DBInstanceIdentifier,
          name: db.DBInstanceIdentifier,
          type: 'RDS Instance',
          family: 'Database',
          provider: 'aws',
          region,
          az: db.AvailabilityZone,
          secondaryAz: db.SecondaryAvailabilityZone,
          status: db.DBInstanceStatus,
          health: db.DBInstanceStatus === 'available' ? 'healthy' : healthFromStatus(db.DBInstanceStatus),

          // Specs
          instanceType: db.DBInstanceClass,
          vcpu: specs.vcpu || null,
          memGiB: specs.memGiB || null,
          engine: db.Engine,
          engineVersion: db.EngineVersion,
          licenseModel: db.LicenseModel,
          characterSetName: db.CharacterSetName,

          // Storage
          allocatedStorageGB: db.AllocatedStorage,
          maxAllocatedStorageGB: db.MaxAllocatedStorage,
          storageType: db.StorageType,
          storageEncrypted: db.StorageEncrypted,
          kmsKeyId: db.KmsKeyId,
          iops: db.Iops,

          // Network
          ip: db.Endpoint?.Address,
          endpoint: db.Endpoint?.Address,
          port: db.Endpoint?.Port,
          hostedZoneId: db.Endpoint?.HostedZoneId,
          vpc: db.DBSubnetGroup?.VpcId,
          subnetGroup: db.DBSubnetGroup?.DBSubnetGroupName,
          securityGroups: (db.VpcSecurityGroups || []).map(sg => ({ id: sg.VpcSecurityGroupId, status: sg.Status })),
          publiclyAccessible: db.PubliclyAccessible,
          // Mark private/public access for frontend filtering
          isPrivate: db.PubliclyAccessible === false || !db.Endpoint?.Address,
          networkAccess: db.PubliclyAccessible ? 'public' : 'private',

          // HA & backup
          multiAZ: db.MultiAZ,
          backupRetentionPeriod: db.BackupRetentionPeriod,
          preferredBackupWindow: db.PreferredBackupWindow,
          preferredMaintenanceWindow: db.PreferredMaintenanceWindow,
          latestRestorableTime: db.LatestRestorableTime,
          deletionProtection: db.DeletionProtection,
          replicaCount: db.ReadReplicaDBInstanceIdentifiers?.length || 0,
          readReplicaIds: db.ReadReplicaDBInstanceIdentifiers || [],
          sourceDbId: db.ReadReplicaSourceDBInstanceIdentifier || null,
          autoMinorVersionUpgrade: db.AutoMinorVersionUpgrade,
          parameterGroup: db.DBParameterGroups?.[0]?.DBParameterGroupName,

          // Metrics
          cpu: cpu ?? null,
          dbConnections: conns ? Math.round(conns) : null,
          freeStorageGB: freeStorage ? Math.round(freeStorage / 1073741824 * 10) / 10 : null,
          readIOPS: readIOPS ?? null,
          writeIOPS: writeIOPS ?? null,

          launchTime: db.InstanceCreateTime,
          uptime: db.InstanceCreateTime ? formatUptime(db.InstanceCreateTime) : null,
          cost: estimateMonthlyCost({ instanceType: db.DBInstanceClass, family: 'Database' }),
          tags: Object.fromEntries((db.TagList || []).map(t => [t.Key, t.Value])),
          connections: [],
        });
      }
      return instances;
    } catch (e) {
      console.error(`RDS error [${region}]:`, e.message);
      return [];
    }
  }

  async getS3Buckets() {
    try {
      const s3 = new S3Client(this.getClientConfig());
      const res = await s3.send(new ListBucketsCommand({}));
      const buckets = [];

      for (const b of (res.Buckets || []).slice(0, 50)) {
        let region = 'us-east-1';
        let objectCount = 0;
        let versioning = false;
        let encryption = null;
        let tags = {};
        let lifecycleRules = 0;
        let blockPublicAccess = false;

        // Get bucket region first so we can query CloudWatch in the right region
        await s3.send(new GetBucketLocationCommand({ Bucket: b.Name })).then(loc => {
          region = loc.LocationConstraint || 'us-east-1';
        }).catch(() => {});

        await Promise.allSettled([
          s3.send(new GetBucketVersioningCommand({ Bucket: b.Name })).then(v => {
            versioning = v.Status === 'Enabled';
          }),
          s3.send(new GetBucketEncryptionCommand({ Bucket: b.Name })).then(enc => {
            const rule = enc.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault;
            encryption = rule?.SSEAlgorithm || null;
          }),
          s3.send(new GetBucketTaggingCommand({ Bucket: b.Name })).then(t => {
            tags = Object.fromEntries((t.TagSet || []).map(t => [t.Key, t.Value]));
          }),
          s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: b.Name })).then(lc => {
            lifecycleRules = (lc.Rules || []).length;
          }),
          s3.send(new GetPublicAccessBlockCommand({ Bucket: b.Name })).then(pab => {
            const cfg = pab.PublicAccessBlockConfiguration || {};
            blockPublicAccess = !!(cfg.BlockPublicAcls || cfg.BlockPublicPolicy || cfg.RestrictPublicBuckets || cfg.IgnorePublicAcls);
          }).catch(() => {}),
          // Real object count via CloudWatch (no listing limit, accurate total)
          this.getS3ObjectCountFromCloudWatch(b.Name, region).then(count => {
            if (count != null) objectCount = count;
          }),
        ]);

        // Real bucket size via CloudWatch BucketSizeBytes (accurate, includes all objects, no 1000-object limit)
        const cwSizeGB = await this.getS3BucketSizeFromCloudWatch(b.Name, region);
        const sizeGB = cwSizeGB ?? 0;
        buckets.push({
          id: `aws-s3-${b.Name}`,
          rawId: b.Name,
          name: b.Name,
          type: 'S3 Bucket',
          family: 'Storage',
          provider: 'aws',
          region,
          status: 'Active',
          health: 'healthy',
          objectCount,
          sizeGB,
          sizeMB: Math.round(sizeGB * 1024 * 100) / 100,
          versioning,
          encryption,
          lifecycleRules,
          blockPublicAccess,
          isPrivate: blockPublicAccess,
          networkAccess: blockPublicAccess ? 'private' : 'public',
          creationDate: b.CreationDate,
          cost: Math.max(1, sizeGB * 0.023),
          tags,
          connections: [],
        });
      }
      return buckets;
    } catch (e) {
      console.error('S3 error:', e.message);
      return [];
    }
  }

  async getLambdaFunctions(region) {
    try {
      const lambda = new LambdaClient(this.getClientConfig(region));
      const res = await lambda.send(new ListFunctionsCommand({ MaxItems: 50 }));
      const functions = [];

      for (const fn of res.Functions || []) {
        const [invocations, errors, duration, throttles, concurrency, fnDetail] = await Promise.all([
          this.getMetric('AWS/Lambda', 'Invocations', [{ Name: 'FunctionName', Value: fn.FunctionName }], region),
          this.getMetric('AWS/Lambda', 'Errors', [{ Name: 'FunctionName', Value: fn.FunctionName }], region),
          this.getMetric('AWS/Lambda', 'Duration', [{ Name: 'FunctionName', Value: fn.FunctionName }], region),
          this.getMetric('AWS/Lambda', 'Throttles', [{ Name: 'FunctionName', Value: fn.FunctionName }], region),
          lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: fn.FunctionName })).catch(() => null),
          lambda.send(new GetFunctionCommand({ FunctionName: fn.FunctionName })).catch(() => null),
        ]);

        const config = fnDetail?.Configuration || fn;
        functions.push({
          id: `aws-lambda-${fn.FunctionArn?.split(':').pop() || fn.FunctionName}`,
          rawId: fn.FunctionName,
          name: fn.FunctionName,
          type: 'Lambda Function',
          family: 'Serverless',
          provider: 'aws',
          region,
          status: fn.State || 'Active',
          health: fn.State === 'Active' ? 'healthy' : healthFromStatus(fn.State),

          // Runtime & code
          runtime: fn.Runtime,
          handler: fn.Handler,
          codeSize: fn.CodeSize ? `${Math.round(fn.CodeSize / 1024)} KB` : null,
          codeSizeBytes: fn.CodeSize,
          description: fn.Description,
          functionArn: fn.FunctionArn,

          // Resources
          memorySize: fn.MemorySize,
          memorySizeMB: fn.MemorySize,
          timeout: fn.Timeout,
          ephemeralStorageMB: config.EphemeralStorage?.Size || 512,

          // Network
          vpc: config.VpcConfig?.VpcId || null,
          subnets: config.VpcConfig?.SubnetIds || [],
          securityGroupIds: config.VpcConfig?.SecurityGroupIds || [],
          isPrivate: !!(config.VpcConfig?.VpcId),
          networkAccess: config.VpcConfig?.VpcId ? 'private' : 'public',

          // Concurrency
          reservedConcurrency: concurrency?.ReservedConcurrentExecutions ?? null,

          // Layers
          layers: (fn.Layers || []).map(l => ({ arn: l.Arn, codeSize: l.CodeSize })),

          // Environment (keys only, not values for security)
          envVarKeys: Object.keys(fn.Environment?.Variables || {}),

          // Metadata
          lastModified: fn.LastModified,
          iamRole: fn.Role?.split('/').pop() || null,
          iamRoleArn: fn.Role,
          architectures: fn.Architectures || ['x86_64'],
          packageType: fn.PackageType,
          stateReason: fn.StateReason,
          stateReasonCode: fn.StateReasonCode,

          // Metrics
          invocations: invocations ? Math.round(invocations * 24 * 30) : null,
          errors: errors ? Math.round(errors) : null,
          duration: duration ? Math.round(duration) : null,
          throttles: throttles ? Math.round(throttles) : 0,

          cost: 0.5 + Math.random() * 3,
          tags: Object.fromEntries(Object.entries(fn.Tags || {})),
          connections: [],
        });
      }
      return functions;
    } catch (e) {
      console.error(`Lambda error [${region}]:`, e.message);
      return [];
    }
  }

  async getEKSClusters(region) {
    try {
      const eks = new EKSClient(this.getClientConfig(region));
      const list = await eks.send(new ListClustersCommand({}));
      const clusters = [];

      for (const name of list.clusters || []) {
        const detail = await eks.send(new DescribeClusterCommand({ name }));
        const c = detail.cluster;

        let nodes = 0;
        let nodeGroupDetails = [];
        let addons = [];

        await Promise.allSettled([
          eks.send(new ListNodegroupsCommand({ clusterName: name })).then(async ngList => {
            for (const ng of ngList.nodegroups || []) {
              try {
                const ngDetail = await eks.send(new DescribeNodegroupCommand({ clusterName: name, nodegroupName: ng }));
                const ngd = ngDetail.nodegroup;
                nodes += ngd?.scalingConfig?.desiredSize || 0;
                nodeGroupDetails.push({
                  name: ng,
                  status: ngd?.status,
                  instanceTypes: ngd?.instanceTypes || [],
                  desiredSize: ngd?.scalingConfig?.desiredSize,
                  minSize: ngd?.scalingConfig?.minSize,
                  maxSize: ngd?.scalingConfig?.maxSize,
                  amiType: ngd?.amiType,
                  diskSizeGB: ngd?.diskSize,
                  releaseVersion: ngd?.releaseVersion,
                  labels: ngd?.labels || {},
                });
              } catch {}
            }
          }),
          eks.send(new ListAddonsCommand({ clusterName: name })).then(async addonList => {
            for (const addon of addonList.addons || []) {
              try {
                const addonDetail = await eks.send(new DescribeAddonCommand({ clusterName: name, addonName: addon }));
                addons.push({
                  name: addon,
                  version: addonDetail.addon?.addonVersion,
                  status: addonDetail.addon?.status,
                });
              } catch {}
            }
          }),
        ]);

        const cpu = await this.getMetric('ContainerInsights', 'cluster_cpu_utilization',
          [{ Name: 'ClusterName', Value: name }], region);

        clusters.push({
          id: `aws-eks-${name}`,
          rawId: name,
          name,
          type: 'EKS Cluster',
          family: 'Container',
          provider: 'aws',
          region,
          status: c.status,
          health: c.status === 'ACTIVE' ? 'healthy' : healthFromStatus(c.status),
          kubernetesVersion: c.version,
          endpoint: c.endpoint,
          endpointPublicAccess: c.resourcesVpcConfig?.endpointPublicAccess,
          endpointPrivateAccess: c.resourcesVpcConfig?.endpointPrivateAccess,
          isPrivate: c.resourcesVpcConfig?.endpointPublicAccess === false,
          networkAccess: c.resourcesVpcConfig?.endpointPublicAccess === false ? 'private' : 'public',
          vpc: c.resourcesVpcConfig?.vpcId,
          subnets: c.resourcesVpcConfig?.subnetIds || [],
          securityGroups: c.resourcesVpcConfig?.securityGroupIds || [],
          clusterSecurityGroupId: c.resourcesVpcConfig?.clusterSecurityGroupId,
          nodes,
          nodeGroups: nodeGroupDetails.length,
          nodeGroupDetails,
          addons,
          pods: nodes * 10,
          runningPods: nodes * 9,
          loggingEnabled: c.logging?.clusterLogging?.some(l => l.enabled) || false,
          encryptionConfig: c.encryptionConfig?.length > 0,
          roleArn: c.roleArn,
          cpu: cpu ?? null,
          createdAt: c.createdAt,
          launchTime: c.createdAt,
          uptime: c.createdAt ? formatUptime(c.createdAt) : null,
          cost: estimateMonthlyCost({ family: 'Container' }) * (nodes || 1),
          tags: c.tags || {},
          connections: [],
        });
      }
      return clusters;
    } catch (e) {
      console.error(`EKS error [${region}]:`, e.message);
      return [];
    }
  }

  async getElastiCacheClusters(region) {
    try {
      const ec = new ElastiCacheClient(this.getClientConfig(region));
      const res = await ec.send(new DescribeCacheClustersCommand({ ShowCacheNodeInfo: true }));
      return (res.CacheClusters || []).map(c => ({
        id: `aws-elasticache-${c.CacheClusterId}`,
        rawId: c.CacheClusterId,
        name: c.CacheClusterId,
        type: 'ElastiCache Cluster',
        family: 'Cache',
        provider: 'aws',
        region,
        az: c.PreferredAvailabilityZone,
        status: c.CacheClusterStatus,
        health: c.CacheClusterStatus === 'available' ? 'healthy' : healthFromStatus(c.CacheClusterStatus),
        engine: c.Engine,
        engineVersion: c.EngineVersion,
        instanceType: c.CacheNodeType,
        numNodes: c.NumCacheNodes,
        endpoint: c.ConfigurationEndpoint?.Address || c.CacheNodes?.[0]?.Endpoint?.Address,
        port: c.ConfigurationEndpoint?.Port || c.CacheNodes?.[0]?.Endpoint?.Port,
        subnetGroup: c.CacheSubnetGroupName,
        securityGroups: (c.SecurityGroups || []).map(sg => ({ id: sg.SecurityGroupId, status: sg.Status })),
        isPrivate: true,
        networkAccess: 'private',
        snapshotRetentionLimit: c.SnapshotRetentionLimit,
        autoMinorVersionUpgrade: c.AutoMinorVersionUpgrade,
        transitEncryption: c.TransitEncryptionEnabled,
        atRestEncryption: c.AtRestEncryptionEnabled,
        replicationGroupId: c.ReplicationGroupId,
        launchTime: c.CacheClusterCreateTime,
        uptime: c.CacheClusterCreateTime ? formatUptime(c.CacheClusterCreateTime) : null,
        cost: estimateMonthlyCost({ instanceType: c.CacheNodeType, family: 'Cache' }),
        connections: [],
        tags: {},
      }));
    } catch (e) {
      console.error(`ElastiCache error [${region}]:`, e.message);
      return [];
    }
  }

  async getLoadBalancers(region) {
    try {
      const elbv2 = new ElasticLoadBalancingV2Client(this.getClientConfig(region));
      const res = await elbv2.send(new DescribeLoadBalancersCommand({}));
      const lbs = [];
      for (const lb of res.LoadBalancers || []) {
        let listeners = [];
        try {
          const listenersRes = await elbv2.send(new DescribeListenersCommand({ LoadBalancerArn: lb.LoadBalancerArn }));
          listeners = (listenersRes.Listeners || []).map(l => ({
            port: l.Port,
            protocol: l.Protocol,
            sslPolicy: l.SslPolicy,
          }));
        } catch {}

        lbs.push({
          id: `aws-alb-${lb.LoadBalancerName}`,
          rawId: lb.LoadBalancerArn,
          name: lb.LoadBalancerName,
          type: `${lb.Type?.toUpperCase() || 'ALB'} Load Balancer`,
          family: 'Networking',
          provider: 'aws',
          region,
          az: lb.AvailabilityZones?.map(az => az.ZoneName).join(', '),
          status: lb.State?.Code,
          health: lb.State?.Code === 'active' ? 'healthy' : healthFromStatus(lb.State?.Code),
          dnsName: lb.DNSName,
          hostedZoneId: lb.CanonicalHostedZoneId,
          scheme: lb.Scheme,
          isPrivate: lb.Scheme === 'internal',
          networkAccess: lb.Scheme === 'internal' ? 'private' : 'public',
          vpc: lb.VpcId,
          ipAddressType: lb.IpAddressType,
          securityGroups: lb.SecurityGroups || [],
          listeners,
          launchTime: lb.CreatedTime,
          uptime: lb.CreatedTime ? formatUptime(lb.CreatedTime) : null,
          cost: 25 + Math.random() * 15,
          connections: [],
          tags: {},
        });
      }
      return lbs;
    } catch (e) {
      console.error(`ALB error [${region}]:`, e.message);
      return [];
    }
  }

  async getSQSQueues(region) {
    try {
      const sqs = new SQSClient(this.getClientConfig(region));
      const res = await sqs.send(new ListQueuesCommand({ MaxResults: 50 }));
      const queues = [];
      for (const url of (res.QueueUrls || []).slice(0, 20)) {
        const name = url.split('/').pop();
        try {
          const attrs = await sqs.send(new GetQueueAttributesCommand({
            QueueUrl: url,
            AttributeNames: ['All'],
          }));
          const a = attrs.Attributes || {};
          queues.push({
            id: `aws-sqs-${name}`,
            rawId: url,
            name,
            type: 'SQS Queue',
            family: 'Messaging',
            provider: 'aws',
            region,
            status: 'Active',
            health: 'healthy',
            messages: parseInt(a.ApproximateNumberOfMessages) || 0,
            messagesInFlight: parseInt(a.ApproximateNumberOfMessagesNotVisible) || 0,
            messagesDelayed: parseInt(a.ApproximateNumberOfMessagesDelayed) || 0,
            retentionPeriodSec: parseInt(a.MessageRetentionPeriod) || 0,
            visibilityTimeoutSec: parseInt(a.VisibilityTimeout) || 30,
            maxMessageSizeBytes: parseInt(a.MaximumMessageSize) || 262144,
            receiveWaitTimeSec: parseInt(a.ReceiveMessageWaitTimeSeconds) || 0,
            isFifo: name.endsWith('.fifo'),
            isContentBased: a.ContentBasedDeduplication === 'true',
            dlqArn: a.RedrivePolicy ? JSON.parse(a.RedrivePolicy)?.deadLetterTargetArn : null,
            kmsKeyId: a.KmsMasterKeyId || null,
            queueArn: a.QueueArn,
            createdAt: a.CreatedTimestamp ? new Date(parseInt(a.CreatedTimestamp) * 1000).toISOString() : null,
            cost: 1 + Math.random() * 5,
            connections: [],
            tags: {},
          });
        } catch {}
      }
      return queues;
    } catch (e) {
      console.error(`SQS error [${region}]:`, e.message);
      return [];
    }
  }

  async getVPCs(region) {
    try {
      const ec2 = new EC2Client(this.getClientConfig(region));
      const [vpcsRes, subnetsRes, igwsRes, natGwsRes] = await Promise.all([
        ec2.send(new DescribeVpcsCommand({})),
        ec2.send(new DescribeSubnetsCommand({})),
        ec2.send(new DescribeInternetGatewaysCommand({})),
        ec2.send(new DescribeNatGatewaysCommand({})).catch(() => ({ NatGateways: [] })),
      ]);

      const subnetsByVpc = {};
      for (const s of subnetsRes.Subnets || []) {
        if (!subnetsByVpc[s.VpcId]) subnetsByVpc[s.VpcId] = [];
        subnetsByVpc[s.VpcId].push({
          id: s.SubnetId,
          cidr: s.CidrBlock,
          az: s.AvailabilityZone,
          public: s.MapPublicIpOnLaunch,
          availableIps: s.AvailableIpAddressCount,
          name: s.Tags?.find(t => t.Key === 'Name')?.Value,
        });
      }

      const igwsByVpc = {};
      for (const igw of igwsRes.InternetGateways || []) {
        for (const att of igw.Attachments || []) {
          igwsByVpc[att.VpcId] = { id: igw.InternetGatewayId, state: att.State };
        }
      }

      const natsByVpc = {};
      for (const nat of natGwsRes.NatGateways || []) {
        if (!natsByVpc[nat.VpcId]) natsByVpc[nat.VpcId] = [];
        natsByVpc[nat.VpcId].push({
          id: nat.NatGatewayId,
          state: nat.State,
          subnetId: nat.SubnetId,
          publicIp: nat.NatGatewayAddresses?.[0]?.PublicIp,
          privateIp: nat.NatGatewayAddresses?.[0]?.PrivateIp,
        });
      }

      return (vpcsRes.Vpcs || []).map(v => ({
        id: `aws-vpc-${v.VpcId}`,
        rawId: v.VpcId,
        name: v.Tags?.find(t => t.Key === 'Name')?.Value || v.VpcId,
        type: 'VPC',
        family: 'Networking',
        provider: 'aws',
        region,
        status: v.State,
        health: v.State === 'available' ? 'healthy' : healthFromStatus(v.State),
        cidr: v.CidrBlock,
        ipv6Cidr: v.Ipv6CidrBlockAssociationSet?.[0]?.Ipv6CidrBlock || null,
        isDefault: v.IsDefault,
        isPrivate: !igwsByVpc[v.VpcId],
        networkAccess: igwsByVpc[v.VpcId] ? 'public' : 'private',
        dhcpOptionsId: v.DhcpOptionsId,
        tenancy: v.InstanceTenancy,
        subnets: subnetsByVpc[v.VpcId] || [],
        internetGateway: igwsByVpc[v.VpcId] || null,
        natGateways: natsByVpc[v.VpcId] || [],
        cost: 0,
        tags: Object.fromEntries((v.Tags || []).map(t => [t.Key, t.Value])),
        connections: [],
      }));
    } catch (e) {
      return [];
    }
  }

  async getAllSecurityGroups(region) {
    try {
      const ec2 = new EC2Client(this.getClientConfig(region));
      const res = await ec2.send(new DescribeSecurityGroupsCommand({}));
      return (res.SecurityGroups || []).map(sg => ({
        id: `aws-sg-${sg.GroupId}`,
        rawId: sg.GroupId,
        name: sg.GroupName,
        type: 'Security Group',
        family: 'Security',
        provider: 'aws',
        region,
        vpcId: sg.VpcId,
        description: sg.Description,
        health: 'healthy',
        status: 'active',
        inboundRules: (sg.IpPermissions || []).map(p => ({
          protocol: p.IpProtocol === '-1' ? 'All' : p.IpProtocol,
          fromPort: p.FromPort,
          toPort: p.ToPort,
          sources: [
            ...(p.IpRanges  || []).map(r => ({ type: 'cidr',  value: r.CidrIp,     desc: r.Description || '' })),
            ...(p.Ipv6Ranges || []).map(r => ({ type: 'cidr6', value: r.CidrIpv6,   desc: r.Description || '' })),
            ...(p.UserIdGroupPairs || []).map(r => ({ type: 'sg', value: r.GroupId, name: r.GroupName || '', desc: r.Description || '' })),
          ],
        })),
        outboundRules: (sg.IpPermissionsEgress || []).map(p => ({
          protocol: p.IpProtocol === '-1' ? 'All' : p.IpProtocol,
          fromPort: p.FromPort,
          toPort: p.ToPort,
          destinations: [
            ...(p.IpRanges  || []).map(r => ({ type: 'cidr',  value: r.CidrIp,     desc: r.Description || '' })),
            ...(p.Ipv6Ranges || []).map(r => ({ type: 'cidr6', value: r.CidrIpv6,   desc: r.Description || '' })),
            ...(p.UserIdGroupPairs || []).map(r => ({ type: 'sg', value: r.GroupId, name: r.GroupName || '', desc: r.Description || '' })),
          ],
        })),
        cost: 0,
        tags: Object.fromEntries((sg.Tags || []).map(t => [t.Key, t.Value])),
        connections: [],
      }));
    } catch (e) {
      console.error(`Security groups error [${region}]:`, e.message);
      return [];
    }
  }

  async getRouteTables(region) {
    try {
      const ec2 = new EC2Client(this.getClientConfig(region));
      const res = await ec2.send(new DescribeRouteTablesCommand({}));
      return (res.RouteTables || []).map(rt => ({
        id: `aws-rt-${rt.RouteTableId}`,
        rawId: rt.RouteTableId,
        name: rt.Tags?.find(t => t.Key === 'Name')?.Value || rt.RouteTableId,
        type: 'Route Table',
        family: 'Networking',
        provider: 'aws',
        region,
        vpcId: rt.VpcId,
        isMain: (rt.Associations || []).some(a => a.Main),
        associations: (rt.Associations || []).map(a => ({
          id: a.RouteTableAssociationId,
          subnetId: a.SubnetId || null,
          isMain: a.Main || false,
          state: a.AssociationState?.State || 'associated',
        })),
        routes: (rt.Routes || []).map(r => ({
          destination: r.DestinationCidrBlock || r.DestinationIpv6CidrBlock || r.DestinationPrefixListId || '—',
          target: r.GatewayId || r.NatGatewayId || r.TransitGatewayId || r.VpcPeeringConnectionId || r.NetworkInterfaceId || r.InstanceId || 'local',
          state: r.State,
          origin: r.Origin,
        })),
        health: 'healthy',
        status: 'active',
        cost: 0,
        tags: Object.fromEntries((rt.Tags || []).map(t => [t.Key, t.Value])),
        connections: [],
      }));
    } catch (e) {
      console.error(`Route tables error [${region}]:`, e.message);
      return [];
    }
  }

  async getAlerts(region) {
    try {
      const cw = new CloudWatchClient(this.getClientConfig(region));
      const res = await cw.send(new DescribeAlarmsCommand({
        StateValue: 'ALARM',
        MaxRecords: 50,
      }));
      return (res.MetricAlarms || []).map(a => ({
        id: `aws-alarm-${a.AlarmName}`,
        title: a.AlarmName,
        message: a.AlarmDescription || `${a.MetricName} threshold exceeded`,
        severity: a.AlarmName.toLowerCase().includes('critical') ? 'critical' :
          a.AlarmName.toLowerCase().includes('error') ? 'critical' : 'warning',
        provider: 'aws',
        service: a.Dimensions?.[0]?.Value || 'Unknown',
        region,
        time: new Date(a.StateUpdatedTimestamp).toISOString(),
        acknowledged: false,
        raw: { state: a.StateValue, metric: a.MetricName, namespace: a.Namespace },
      }));
    } catch (e) {
      console.error(`CloudWatch alarms error [${region}]:`, e.message);
      return [];
    }
  }

  // Discover EFS filesystems and their real storage usage via CloudWatch StorageBytes
  // No EFS SDK or agent required — just access keys with cloudwatch:GetMetricStatistics
  async getEFSStorageFromCloudWatch(region) {
    try {
      const cw = new CloudWatchClient(this.getClientConfig(region));
      const listRes = await cw.send(new ListMetricsCommand({
        Namespace: 'AWS/EFS',
        MetricName: 'StorageBytes',
        Dimensions: [{ Name: 'StorageClass', Value: 'Total' }],
      }));
      const metrics = listRes.Metrics || [];
      if (!metrics.length) return [];

      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000);

      const resources = await Promise.all(metrics.map(async metric => {
        const fsId = metric.Dimensions.find(d => d.Name === 'FileSystemId')?.Value;
        if (!fsId) return null;
        try {
          const res = await cw.send(new GetMetricStatisticsCommand({
            Namespace: 'AWS/EFS',
            MetricName: 'StorageBytes',
            Dimensions: metric.Dimensions,
            StartTime: startTime,
            EndTime: endTime,
            Period: 3600,
            Statistics: ['Average'],
          }));
          const latest = (res.Datapoints || []).sort((a, b) => new Date(b.Timestamp) - new Date(a.Timestamp))[0];
          if (latest?.Average == null) return null;
          const sizeGB = Math.round(latest.Average / 1073741824 * 100) / 100;
          return {
            id: `aws-efs-${fsId}`,
            rawId: fsId,
            name: fsId,
            type: 'EFS Filesystem',
            family: 'Storage',
            provider: 'aws',
            region,
            status: 'Active',
            health: 'healthy',
            sizeGB,
            cost: Math.max(0.1, sizeGB * 0.30),
            tags: {},
            connections: [],
          };
        } catch { return null; }
      }));
      return resources.filter(Boolean);
    } catch { return []; }
  }

  async getAllResources() {
    // Determine regions to scan: explicit creds.regions, environment override, 'all' keyword, or default region
    const envRegions = process.env.AWS_REGIONS ? process.env.AWS_REGIONS.split(',').map(r => r.trim()).filter(Boolean) : null;
    let regions = this.creds.regions || envRegions || [this.region];
    if (Array.isArray(regions) && regions.length === 1 && regions[0] === 'all') regions = AWS_REGIONS;
    if (regions === 'all') regions = AWS_REGIONS;

    // Fetch S3 first so we can auto-add any bucket regions not already in the scan list
    const s3Resources = await this.getS3Buckets();
    const s3Regions = [...new Set(s3Resources.map(b => b.region).filter(Boolean))];
    const allRegions = [...new Set([...regions, ...s3Regions])];

    const results = await Promise.allSettled([
      ...allRegions.flatMap(r => [
        this.getEC2Instances(r),
        this.getRDSInstances(r),
        this.getLambdaFunctions(r),
        this.getEKSClusters(r),
        this.getElastiCacheClusters(r),
        this.getLoadBalancers(r),
        this.getSQSQueues(r),
        this.getVPCs(r),
        this.getAllSecurityGroups(r),
        this.getRouteTables(r),
        this.getEFSStorageFromCloudWatch(r),
      ]),
    ]);

    let allResources = [...s3Resources];
    for (const r of results) {
      if (r.status === 'fulfilled') allResources = allResources.concat(r.value);
    }
    buildConnectionGraph(allResources);
    return allResources;
  }

  async getAlertsAllRegions() {
    const envRegions = process.env.AWS_REGIONS ? process.env.AWS_REGIONS.split(',').map(r => r.trim()).filter(Boolean) : null;
    let regions = this.creds.regions || envRegions || [this.region];
    if (Array.isArray(regions) && regions.length === 1 && regions[0] === 'all') regions = AWS_REGIONS;
    if (regions === 'all') regions = AWS_REGIONS;
    const results = await Promise.allSettled(regions.map(r => this.getAlerts(r)));
    let all = [];
    for (const r of results) {
      if (r.status === 'fulfilled') all = all.concat(r.value);
    }
    return all;
  }
}

function buildConnectionGraph(resources) {
  const byVpc = {};
  const bySubnet = {};
  for (const r of resources) {
    if (r.vpc) {
      if (!byVpc[r.vpc]) byVpc[r.vpc] = [];
      byVpc[r.vpc].push(r.id);
    }
    if (r.subnet) {
      if (!bySubnet[r.subnet]) bySubnet[r.subnet] = [];
      bySubnet[r.subnet].push(r.id);
    }
  }
  for (const r of resources) {
    const conns = new Set();
    if (r.vpc && byVpc[r.vpc]) {
      byVpc[r.vpc].filter(id => id !== r.id).slice(0, 5).forEach(id => conns.add(id));
    }
    if (r.subnet && bySubnet[r.subnet]) {
      bySubnet[r.subnet].filter(id => id !== r.id).forEach(id => conns.add(id));
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

module.exports = AWSService;
