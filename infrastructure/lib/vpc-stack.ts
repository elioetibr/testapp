import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface VpcStackProps extends cdk.StackProps {
  environment: string;
  enableIPv6?: boolean;
  enableHANatGateways?: boolean;
  maxAzs?: number;
  natGateways?: number;
  // Network configuration
  vpcCidr?: string;
  publicSubnetCidrMask?: number;
  privateSubnetCidrMask?: number;
  // IPv6 configuration
  ipv6CidrBlock?: string;
  // Security enhancements
  enableVPCFlowLogs?: boolean;
}

export class VpcStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly publicSubnets: ec2.ISubnet[];
  public readonly applicationSecurityGroup: ec2.SecurityGroup;
  public readonly loadBalancerSecurityGroup: ec2.SecurityGroup;
  public readonly flowLogsBucket?: s3.Bucket;
  
  constructor(scope: Construct, id: string, props: VpcStackProps) {
    super(scope, id, props);

    // Create VPC Flow Logs bucket (if enabled)
    if (props.enableVPCFlowLogs) {
      this.flowLogsBucket = this.createVPCFlowLogsBucket(props);
    }

    // Create VPC with configurable options
    this.vpc = this.createVpc(props);
    this.privateSubnets = this.vpc.privateSubnets;
    this.publicSubnets = this.vpc.publicSubnets;

    // Create VPC Flow Logs (if enabled)
    if (props.enableVPCFlowLogs && this.flowLogsBucket) {
      this.createVPCFlowLogs(props);
    }

    // Create Security Groups
    this.loadBalancerSecurityGroup = this.createLoadBalancerSecurityGroup(props);
    this.applicationSecurityGroup = this.createApplicationSecurityGroup(props);

    // Create stack outputs
    this.createOutputs(props);
  }

  private createVpc(props: VpcStackProps): ec2.Vpc {
    const maxAzs = props.maxAzs || 3;
    const natGateways = props.natGateways || 1;

    const subnetConfiguration: ec2.SubnetConfiguration[] = [
      {
        name: 'Public',
        subnetType: ec2.SubnetType.PUBLIC,
        cidrMask: props.publicSubnetCidrMask || 24,
      },
      {
        name: 'Private',
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        cidrMask: props.privateSubnetCidrMask || 24,
      }
    ];

    const vpcProps: ec2.VpcProps = {
      maxAzs,
      natGateways: props.enableHANatGateways ? maxAzs : Math.min(natGateways, maxAzs),
      subnetConfiguration,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr || '10.0.0.0/16'),
    };

    // Add IPv6 support if enabled
    if (props.enableIPv6) {
      const vpc = new ec2.Vpc(this, 'TestAppVpc', vpcProps);

      // Add IPv6 CIDR block to VPC
      const ipv6CidrBlock = new ec2.CfnVPCCidrBlock(this, 'Ipv6CidrBlock', {
        vpcId: vpc.vpcId,
        ...(props.ipv6CidrBlock 
          ? { ipv6CidrBlock: props.ipv6CidrBlock }
          : { amazonProvidedIpv6CidrBlock: true }
        ),
      });

      // Configure IPv6 for public subnets
      vpc.publicSubnets.forEach((subnet, index) => {
        const cfnSubnet = subnet.node.defaultChild as ec2.CfnSubnet;
        cfnSubnet.ipv6CidrBlock = cdk.Fn.select(index, cdk.Fn.cidr(
          cdk.Fn.select(0, vpc.vpcIpv6CidrBlocks),
          256,
          '64'
        ));
        cfnSubnet.assignIpv6AddressOnCreation = true;
        cfnSubnet.addDependency(ipv6CidrBlock);
      });

      // Add IPv6 route for public subnets
      vpc.publicSubnets.forEach((subnet, index) => {
        new ec2.CfnRoute(this, `Ipv6Route-${index}`, {
          routeTableId: subnet.routeTable.routeTableId,
          destinationIpv6CidrBlock: '::/0',
          gatewayId: vpc.internetGatewayId,
        });
      });

      return vpc;
    }

    return new ec2.Vpc(this, 'TestAppVpc', vpcProps);
  }

  private createLoadBalancerSecurityGroup(props: VpcStackProps): ec2.SecurityGroup {
    const securityGroup = new ec2.SecurityGroup(this, 'LoadBalancerSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Application Load Balancer',
      allowAllOutbound: true,
    });

    // Allow HTTP traffic from anywhere
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP traffic from anywhere'
    );

    // Allow HTTPS traffic from anywhere
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic from anywhere'
    );

    // Add IPv6 rules if enabled
    if (props.enableIPv6) {
      securityGroup.addIngressRule(
        ec2.Peer.anyIpv6(),
        ec2.Port.tcp(80),
        'Allow HTTP traffic from anywhere (IPv6)'
      );

      securityGroup.addIngressRule(
        ec2.Peer.anyIpv6(),
        ec2.Port.tcp(443),
        'Allow HTTPS traffic from anywhere (IPv6)'
      );
    }

    // Add tags
    cdk.Tags.of(securityGroup).add('Name', `testapp-${props.environment}-alb-sg`);
    cdk.Tags.of(securityGroup).add('Environment', props.environment);
    cdk.Tags.of(securityGroup).add('Component', 'LoadBalancer');

    return securityGroup;
  }

  private createApplicationSecurityGroup(props: VpcStackProps): ec2.SecurityGroup {
    const securityGroup = new ec2.SecurityGroup(this, 'ApplicationSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for ECS applications',
      allowAllOutbound: true,
    });

    // Allow traffic from Load Balancer Security Group
    securityGroup.addIngressRule(
      this.loadBalancerSecurityGroup,
      ec2.Port.tcp(8000),
      'Allow traffic from Load Balancer'
    );

    // Allow health check traffic (if needed from different ports)
    securityGroup.addIngressRule(
      this.loadBalancerSecurityGroup,
      ec2.Port.tcpRange(8000, 8999),
      'Allow health check traffic from Load Balancer'
    );

    // Add tags
    cdk.Tags.of(securityGroup).add('Name', `testapp-${props.environment}-app-sg`);
    cdk.Tags.of(securityGroup).add('Environment', props.environment);
    cdk.Tags.of(securityGroup).add('Component', 'Application');

    return securityGroup;
  }

  private createVPCFlowLogsBucket(props: VpcStackProps): s3.Bucket {
    const bucket = new s3.Bucket(this, 'VPCFlowLogsBucket', {
      bucketName: `testapp-vpc-flow-logs-${props.environment}-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      lifecycleRules: [
        {
          id: 'DeleteOldFlowLogs',
          enabled: true,
          expiration: cdk.Duration.days(props.environment === 'production' ? 90 : 30),
        },
        {
          id: 'TransitionToIA',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
      removalPolicy: props.environment === 'production' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
    });

    // Add bucket policy for VPC Flow Logs service
    bucket.addToResourcePolicy(new cdk.aws_iam.PolicyStatement({
      sid: 'AWSLogDeliveryWrite',
      principals: [new cdk.aws_iam.ServicePrincipal('delivery.logs.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [`${bucket.bucketArn}/vpc-flow-logs/*`],
      conditions: {
        StringEquals: {
          's3:x-amz-acl': 'bucket-owner-full-control',
        },
      },
    }));

    bucket.addToResourcePolicy(new cdk.aws_iam.PolicyStatement({
      sid: 'AWSLogDeliveryCheck',
      principals: [new cdk.aws_iam.ServicePrincipal('delivery.logs.amazonaws.com')],
      actions: ['s3:GetBucketAcl', 's3:ListBucket'],
      resources: [bucket.bucketArn],
    }));

    // Tag the bucket
    cdk.Tags.of(bucket).add('Purpose', 'VPC-Flow-Logs');
    cdk.Tags.of(bucket).add('Environment', props.environment);
    cdk.Tags.of(bucket).add('ManagedBy', 'CDK');
    
    return bucket;
  }

  private createVPCFlowLogs(props: VpcStackProps): void {
    // Create VPC Flow Logs for entire VPC
    // Note: this.flowLogsBucket is guaranteed to exist when this method is called
    new ec2.FlowLog(this, 'VPCFlowLog', {
      resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
      destination: ec2.FlowLogDestination.toS3(this.flowLogsBucket, 'vpc-flow-logs/'),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    // Create Flow Logs for private subnets (more granular monitoring)
    this.vpc.privateSubnets.forEach((subnet, index) => {
      new ec2.FlowLog(this, `PrivateSubnetFlowLog${index}`, {
        resourceType: ec2.FlowLogResourceType.fromSubnet(subnet),
        destination: ec2.FlowLogDestination.toS3(this.flowLogsBucket!, `private-subnets/subnet-${index}/`),
        trafficType: ec2.FlowLogTrafficType.ALL,
      });
    });

    // Create Flow Logs for public subnets
    this.vpc.publicSubnets.forEach((subnet, index) => {
      new ec2.FlowLog(this, `PublicSubnetFlowLog${index}`, {
        resourceType: ec2.FlowLogResourceType.fromSubnet(subnet),
        destination: ec2.FlowLogDestination.toS3(this.flowLogsBucket!, `public-subnets/subnet-${index}/`),
        trafficType: ec2.FlowLogTrafficType.ALL,
      });
    });
  }

  private createOutputs(props: VpcStackProps): void {
    // Core VPC outputs
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID',
      exportName: `${this.stackName}-VpcId`,
    });

    new cdk.CfnOutput(this, 'VpcCidr', {
      value: this.vpc.vpcCidrBlock,
      description: 'VPC CIDR Block',
      exportName: `${this.stackName}-VpcCidr`,
    });

    // Subnet outputs
    new cdk.CfnOutput(this, 'PrivateSubnetIds', {
      value: this.privateSubnets.map(subnet => subnet.subnetId).join(','),
      description: 'Private Subnet IDs',
      exportName: `${this.stackName}-PrivateSubnetIds`,
    });

    // Export individual private subnet IDs for PR deployments
    if (this.privateSubnets.length > 0) {
      new cdk.CfnOutput(this, 'PrivateSubnet1Id', {
        value: this.privateSubnets[0].subnetId,
        description: 'Private Subnet 1 ID',
        exportName: `${this.stackName}-PrivateSubnet1Id`,
      });
    }
    
    if (this.privateSubnets.length > 1) {
      new cdk.CfnOutput(this, 'PrivateSubnet2Id', {
        value: this.privateSubnets[1].subnetId,
        description: 'Private Subnet 2 ID',
        exportName: `${this.stackName}-PrivateSubnet2Id`,
      });
    }

    new cdk.CfnOutput(this, 'PublicSubnetIds', {
      value: this.publicSubnets.map(subnet => subnet.subnetId).join(','),
      description: 'Public Subnet IDs',
      exportName: `${this.stackName}-PublicSubnetIds`,
    });

    // Availability Zones
    new cdk.CfnOutput(this, 'AvailabilityZones', {
      value: this.vpc.availabilityZones.join(','),
      description: 'Availability Zones',
      exportName: `${this.stackName}-AvailabilityZones`,
    });

    // Security Group outputs
    new cdk.CfnOutput(this, 'LoadBalancerSecurityGroupId', {
      value: this.loadBalancerSecurityGroup.securityGroupId,
      description: 'Load Balancer Security Group ID',
      exportName: `${this.stackName}-LoadBalancerSecurityGroupId`,
    });

    new cdk.CfnOutput(this, 'ApplicationSecurityGroupId', {
      value: this.applicationSecurityGroup.securityGroupId,
      description: 'Application Security Group ID',
      exportName: `${this.stackName}-ApplicationSecurityGroupId`,
    });

    // Flow Logs output (if enabled)
    if (this.flowLogsBucket) {
      new cdk.CfnOutput(this, 'FlowLogsBucketName', {
        value: this.flowLogsBucket.bucketName,
        description: 'VPC Flow Logs S3 Bucket Name',
        exportName: `${this.stackName}-FlowLogsBucketName`,
      });

      new cdk.CfnOutput(this, 'FlowLogsBucketArn', {
        value: this.flowLogsBucket.bucketArn,
        description: 'VPC Flow Logs S3 Bucket ARN',
        exportName: `${this.stackName}-FlowLogsBucketArn`,
      });
    }

    // IPv6 outputs (if enabled)
    if (props.enableIPv6) {
      new cdk.CfnOutput(this, 'VpcIpv6CidrBlocks', {
        value: cdk.Fn.join(',', this.vpc.vpcIpv6CidrBlocks),
        description: 'VPC IPv6 CIDR Blocks',
        exportName: `${this.stackName}-VpcIpv6CidrBlocks`,
      });
    }
  }
}