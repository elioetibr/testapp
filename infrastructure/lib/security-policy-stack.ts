import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as config from 'aws-cdk-lib/aws-config';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

export interface SecurityPolicyStackProps extends cdk.StackProps {
  environment: string;
  // Security configuration by environment
  enforceCompliance?: boolean;
  enableAdvancedMonitoring?: boolean;
  alertingEndpoint?: string;
  retentionDays?: number;
  
  // Environment-specific policies
  allowedRegions?: string[];
  requiredTags?: { [key: string]: string[] };
  maxInstanceTypes?: string[];
  enforceEncryption?: boolean;
}

export class SecurityPolicyStack extends cdk.Stack {
  public readonly cloudTrail: cloudtrail.Trail;
  public readonly configService: config.CfnConfigurationRecorder;
  public readonly complianceBucket: s3.Bucket;
  public readonly kmsKey: kms.Key;
  public readonly alertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: SecurityPolicyStackProps) {
    super(scope, id, props);

    // Create KMS key for encryption
    this.kmsKey = this.createKMSKey(props);

    // Create S3 bucket for compliance data
    this.complianceBucket = this.createComplianceBucket(props);

    // Setup CloudTrail for audit logging
    this.cloudTrail = this.createCloudTrail(props);

    // Setup AWS Config for compliance monitoring
    if (props.enforceCompliance) {
      this.configService = this.createConfigService(props);
      this.createComplianceRules(props);
    }

    // Setup alerting
    this.alertTopic = this.createAlertTopic(props);

    // Create security monitoring
    if (props.enableAdvancedMonitoring) {
      this.createSecurityMonitoring(props);
    }

    // Environment-specific policies
    this.createEnvironmentPolicies(props);

    // Create outputs
    this.createOutputs(props);
  }

  private createKMSKey(props: SecurityPolicyStackProps): kms.Key {
    const key = new kms.Key(this, 'SecurityPolicyKMSKey', {
      alias: `testapp-security-${props.environment}`,
      description: `KMS key for TestApp security policies in ${props.environment}`,
      enableKeyRotation: props.environment === 'production',
      removalPolicy: props.environment === 'production' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
    });

    // Grant CloudTrail and Config access
    key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudTrailEncryption',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
      actions: ['kms:GenerateDataKey*', 'kms:DescribeKey'],
      resources: ['*'],
    }));

    key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowConfigEncryption',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('config.amazonaws.com')],
      actions: ['kms:GenerateDataKey*', 'kms:DescribeKey'],
      resources: ['*'],
    }));

    // Add tags
    cdk.Tags.of(key).add('Environment', props.environment);
    cdk.Tags.of(key).add('Component', 'Security-KMS');
    cdk.Tags.of(key).add('Purpose', 'Compliance-Encryption');

    return key;
  }

  private createComplianceBucket(props: SecurityPolicyStackProps): s3.Bucket {
    const bucket = new s3.Bucket(this, 'ComplianceBucket', {
      bucketName: `testapp-security-compliance-${props.environment}-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      lifecycleRules: [{
        id: 'ComplianceDataLifecycle',
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
          {
            storageClass: s3.StorageClass.DEEP_ARCHIVE,
            transitionAfter: cdk.Duration.days(365),
          },
        ],
        expiration: cdk.Duration.days(props.retentionDays || 2555), // 7 years default
      }],
      removalPolicy: props.environment === 'production' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
    });

    // Add tags
    cdk.Tags.of(bucket).add('Environment', props.environment);
    cdk.Tags.of(bucket).add('Component', 'Security-Storage');
    cdk.Tags.of(bucket).add('Purpose', 'Compliance-Data');

    return bucket;
  }

  private createCloudTrail(props: SecurityPolicyStackProps): cloudtrail.Trail {
    const trail = new cloudtrail.Trail(this, 'SecurityCloudTrail', {
      trailName: `testapp-security-trail-${props.environment}`,
      bucket: this.complianceBucket,
      s3KeyPrefix: 'cloudtrail-logs/',
      encryptionKey: this.kmsKey,
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: props.environment === 'production',
      enableFileValidation: true,
      sendToCloudWatchLogs: props.enableAdvancedMonitoring,
    });

    // Add event selectors for enhanced monitoring
    if (props.enableAdvancedMonitoring) {
      trail.addEventSelector(cloudtrail.DataResourceType.S3_OBJECT, [
        `${this.complianceBucket.bucketArn}/*`
      ], {
        readWriteType: cloudtrail.ReadWriteType.ALL,
        includeManagementEvents: true,
      });
    }

    // Add tags
    cdk.Tags.of(trail).add('Environment', props.environment);
    cdk.Tags.of(trail).add('Component', 'Security-Audit');
    cdk.Tags.of(trail).add('Purpose', 'Compliance-Logging');

    return trail;
  }

  private createConfigService(props: SecurityPolicyStackProps): config.CfnConfigurationRecorder {
    // Create Config service role
    const configRole = new iam.Role(this, 'ConfigServiceRole', {
      assumedBy: new iam.ServicePrincipal('config.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/ConfigRole'),
      ],
      inlinePolicies: {
        ComplianceBucketAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                's3:GetBucketAcl',
                's3:PutObject',
                's3:GetBucketLocation',
              ],
              resources: [
                this.complianceBucket.bucketArn,
                `${this.complianceBucket.bucketArn}/*`,
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'kms:GenerateDataKey*',
                'kms:DescribeKey',
              ],
              resources: [this.kmsKey.keyArn],
            }),
          ],
        }),
      },
    });

    // Create Config delivery channel
    const deliveryChannel = new config.CfnDeliveryChannel(this, 'ConfigDeliveryChannel', {
      name: `testapp-config-delivery-${props.environment}`,
      s3BucketName: this.complianceBucket.bucketName,
      s3KeyPrefix: 'config-history/',
      configSnapshotDeliveryProperties: {
        deliveryFrequency: 'TwentyFour_Hours',
      },
    });

    // Create Config recorder
    const configRecorder = new config.CfnConfigurationRecorder(this, 'ConfigRecorder', {
      name: `testapp-config-recorder-${props.environment}`,
      roleArn: configRole.roleArn,
      recordingGroup: {
        allSupported: true,
        includeGlobalResourceTypes: props.environment === 'production',
        resourceTypes: undefined, // Use allSupported instead
      },
    });

    configRecorder.addDependency(deliveryChannel);

    // Add tags
    cdk.Tags.of(configRole).add('Environment', props.environment);
    cdk.Tags.of(configRole).add('Component', 'Security-Config');

    return configRecorder;
  }

  private createComplianceRules(props: SecurityPolicyStackProps): void {
    // Environment-specific compliance rules
    const rules = this.getComplianceRulesForEnvironment(props.environment);

    rules.forEach((rule, index) => {
      const configRule = new config.CfnConfigRule(this, `ComplianceRule${index}`, {
        configRuleName: `testapp-${props.environment}-${rule.name}`,
        description: rule.description,
        source: {
          owner: rule.source.owner,
          sourceIdentifier: rule.source.sourceIdentifier,
        },
      });
      
      // Ensure config service exists before creating rules
      configRule.node.addDependency(this.configService);
    });
  }

  private getComplianceRulesForEnvironment(environment: string) {
    const baseRules = [
      {
        name: 'encrypted-volumes',
        description: 'Checks if EBS volumes are encrypted',
        source: {
          owner: 'AWS',
          sourceIdentifier: 'ENCRYPTED_VOLUMES',
        },
      },
      {
        name: 'root-access-key-check',
        description: 'Checks if root user has access keys',
        source: {
          owner: 'AWS',
          sourceIdentifier: 'ROOT_ACCESS_KEY_CHECK',
        },
      },
      {
        name: 's3-bucket-public-read-prohibited',
        description: 'Checks if S3 buckets allow public read access',
        source: {
          owner: 'AWS',
          sourceIdentifier: 'S3_BUCKET_PUBLIC_READ_PROHIBITED',
        },
      },
      {
        name: 's3-bucket-public-write-prohibited',
        description: 'Checks if S3 buckets allow public write access',
        source: {
          owner: 'AWS',
          sourceIdentifier: 'S3_BUCKET_PUBLIC_WRITE_PROHIBITED',
        },
      },
    ];

    const productionRules = [
      {
        name: 'cloudtrail-enabled',
        description: 'Checks if CloudTrail is enabled',
        source: {
          owner: 'AWS',
          sourceIdentifier: 'CLOUD_TRAIL_ENABLED',
        },
      },
      {
        name: 'mfa-enabled-for-iam-console-access',
        description: 'Checks if MFA is enabled for IAM users',
        source: {
          owner: 'AWS',
          sourceIdentifier: 'MFA_ENABLED_FOR_IAM_CONSOLE_ACCESS',
        },
      },
      {
        name: 'required-tags',
        description: 'Checks if resources have required tags',
        source: {
          owner: 'AWS',
          sourceIdentifier: 'REQUIRED_TAGS',
        },
        parameters: {
          requiredTagKeys: 'Environment,Project,ManagedBy',
        },
      },
    ];

    return environment === 'production' ? [...baseRules, ...productionRules] : baseRules;
  }

  private createAlertTopic(props: SecurityPolicyStackProps): sns.Topic {
    const topic = new sns.Topic(this, 'SecurityAlertTopic', {
      topicName: `testapp-security-alerts-${props.environment}`,
      displayName: `TestApp Security Alerts - ${props.environment}`,
      masterKey: this.kmsKey,
    });

    // Add email subscription if provided
    if (props.alertingEndpoint) {
      new sns.Subscription(this, 'AlertEmailSubscription', {
        topic,
        protocol: sns.SubscriptionProtocol.EMAIL,
        endpoint: props.alertingEndpoint,
      });
    }

    // Add tags
    cdk.Tags.of(topic).add('Environment', props.environment);
    cdk.Tags.of(topic).add('Component', 'Security-Alerting');

    return topic;
  }

  private createSecurityMonitoring(props: SecurityPolicyStackProps): void {
    // Create CloudWatch alarms for security events
    const securityAlarms = [
      {
        name: 'UnauthorizedAPICallsAlarm',
        description: 'Alarm for unauthorized API calls',
        metricName: 'UnauthorizedAPICalls',
        threshold: 1,
        period: 300,
      },
      {
        name: 'RootUsageAlarm',
        description: 'Alarm for root account usage',
        metricName: 'RootAccountUsage', 
        threshold: 1,
        period: 300,
      },
      {
        name: 'ConsoleSigninFailuresAlarm',
        description: 'Alarm for console signin failures',
        metricName: 'ConsoleSigninFailures',
        threshold: 3,
        period: 300,
      },
    ];

    securityAlarms.forEach(alarmConfig => {
      const alarm = new cloudwatch.Alarm(this, alarmConfig.name, {
        alarmName: `testapp-${props.environment}-${alarmConfig.name}`,
        alarmDescription: alarmConfig.description,
        metric: new cloudwatch.Metric({
          namespace: 'TestApp/Security',
          metricName: alarmConfig.metricName,
          statistic: 'Sum',
          period: cdk.Duration.seconds(alarmConfig.period),
        }),
        threshold: alarmConfig.threshold,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

      // Add SNS notification
      alarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));

      // Add tags
      cdk.Tags.of(alarm).add('Environment', props.environment);
      cdk.Tags.of(alarm).add('Component', 'Security-Monitoring');
    });

    // Create EventBridge rules for security events
    this.createSecurityEventRules(props);
  }

  private createSecurityEventRules(props: SecurityPolicyStackProps): void {
    const securityEventRules = [
      {
        name: 'ConfigComplianceChangeRule',
        description: 'Trigger on Config compliance changes',
        eventPattern: {
          source: ['aws.config'],
          detailType: ['Config Rules Compliance Change'],
          detail: {
            newEvaluationResult: {
              complianceType: ['NON_COMPLIANT'],
            },
          },
        },
      },
      {
        name: 'SecurityGroupChangeRule',
        description: 'Trigger on security group changes',
        eventPattern: {
          source: ['aws.ec2'],
          detailType: ['AWS API Call via CloudTrail'],
          detail: {
            eventSource: ['ec2.amazonaws.com'],
            eventName: [
              'AuthorizeSecurityGroupIngress',
              'AuthorizeSecurityGroupEgress',
              'RevokeSecurityGroupIngress',
              'RevokeSecurityGroupEgress',
            ],
          },
        },
      },
      {
        name: 'IAMPolicyChangeRule',
        description: 'Trigger on IAM policy changes',
        eventPattern: {
          source: ['aws.iam'],
          detailType: ['AWS API Call via CloudTrail'],
          detail: {
            eventSource: ['iam.amazonaws.com'],
            eventName: [
              'CreatePolicy',
              'CreateRole',
              'AttachUserPolicy',
              'AttachRolePolicy',
              'PutUserPolicy',
              'PutRolePolicy',
            ],
          },
        },
      },
    ];

    securityEventRules.forEach(ruleConfig => {
      const rule = new events.Rule(this, ruleConfig.name, {
        ruleName: `testapp-${props.environment}-${ruleConfig.name}`,
        description: ruleConfig.description,
        eventPattern: ruleConfig.eventPattern,
      });

      // Add SNS topic as target
      rule.addTarget(new targets.SnsTopic(this.alertTopic, {
        message: events.RuleTargetInput.fromText(
          `Security Alert: ${ruleConfig.description}\nEnvironment: ${props.environment}\nEvent: ${events.RuleTargetInput.fromEventPath('$.detail')}`
        ),
      }));

      // Add tags
      cdk.Tags.of(rule).add('Environment', props.environment);
      cdk.Tags.of(rule).add('Component', 'Security-Events');
    });
  }

  private createEnvironmentPolicies(props: SecurityPolicyStackProps): void {
    // Create environment-specific IAM policies
    const environmentPolicies = this.getPoliciesForEnvironment(props.environment);

    environmentPolicies.forEach((policy, index) => {
      new iam.ManagedPolicy(this, `EnvironmentPolicy${index}`, {
        managedPolicyName: `testapp-${props.environment}-${policy.name}`,
        description: policy.description,
        statements: policy.statements.map(stmt => new iam.PolicyStatement(stmt)),
      });
    });
  }

  private getPoliciesForEnvironment(environment: string) {
    const devPolicies = [
      {
        name: 'developer-access',
        description: 'Development environment access policy',
        statements: [
          {
            effect: iam.Effect.ALLOW,
            actions: [
              'ecs:*',
              'ecr:*',
              'logs:*',
              'cloudwatch:*',
            ],
            resources: ['*'],
            conditions: {
              StringEquals: {
                'aws:RequestedRegion': ['us-east-1', 'us-west-2'],
              },
            },
          },
        ],
      },
    ];

    const stagingPolicies = [
      {
        name: 'staging-restricted-access',
        description: 'Staging environment restricted access policy',
        statements: [
          {
            effect: iam.Effect.ALLOW,
            actions: [
              'ecs:DescribeServices',
              'ecs:DescribeTasks',
              'ecs:UpdateService',
              'logs:DescribeLogGroups',
              'logs:DescribeLogStreams',
              'logs:GetLogEvents',
            ],
            resources: ['*'],
          },
          {
            effect: iam.Effect.DENY,
            actions: [
              'iam:*',
              'kms:*',
              'config:*',
            ],
            resources: ['*'],
          },
        ],
      },
    ];

    const productionPolicies = [
      {
        name: 'production-minimal-access',
        description: 'Production environment minimal access policy',
        statements: [
          {
            effect: iam.Effect.ALLOW,
            actions: [
              'ecs:DescribeServices',
              'ecs:DescribeTasks',
              'logs:DescribeLogGroups',
              'logs:DescribeLogStreams',
              'logs:GetLogEvents',
            ],
            resources: ['*'],
          },
          {
            effect: iam.Effect.DENY,
            actions: [
              'iam:*',
              'kms:*',
              'config:*',
              'ecs:CreateService',
              'ecs:DeleteService',
              'ecs:UpdateService',
            ],
            resources: ['*'],
          },
        ],
      },
    ];

    switch (environment) {
      case 'dev':
        return devPolicies;
      case 'staging':
        return stagingPolicies;
      case 'production':
        return productionPolicies;
      default:
        return devPolicies;
    }
  }

  private createOutputs(props: SecurityPolicyStackProps): void {
    // CloudTrail outputs
    new cdk.CfnOutput(this, 'CloudTrailArn', {
      value: this.cloudTrail.trailArn,
      description: 'CloudTrail ARN for security audit logging',
      exportName: `${this.stackName}-CloudTrailArn`,
    });

    // Compliance bucket outputs
    new cdk.CfnOutput(this, 'ComplianceBucketName', {
      value: this.complianceBucket.bucketName,
      description: 'S3 bucket for compliance data storage',
      exportName: `${this.stackName}-ComplianceBucketName`,
    });

    // KMS key outputs
    new cdk.CfnOutput(this, 'SecurityKMSKeyId', {
      value: this.kmsKey.keyId,
      description: 'KMS key ID for security encryption',
      exportName: `${this.stackName}-SecurityKMSKeyId`,
    });

    // Alert topic outputs
    new cdk.CfnOutput(this, 'SecurityAlertTopicArn', {
      value: this.alertTopic.topicArn,
      description: 'SNS topic ARN for security alerts',
      exportName: `${this.stackName}-SecurityAlertTopicArn`,
    });

    // Config service outputs (if enabled)
    if (props.enforceCompliance) {
      new cdk.CfnOutput(this, 'ConfigRecorderName', {
        value: this.configService.name!,
        description: 'AWS Config recorder name',
        exportName: `${this.stackName}-ConfigRecorderName`,
      });
    }

    // Security posture summary
    new cdk.CfnOutput(this, 'SecurityPostureSummary', {
      value: JSON.stringify({
        environment: props.environment,
        compliance: props.enforceCompliance || false,
        monitoring: props.enableAdvancedMonitoring || false,
        encryption: props.enforceEncryption || false,
        alerting: !!props.alertingEndpoint,
        timestamp: new Date().toISOString(),
      }, null, 2),
      description: 'Security posture summary for environment',
    });
  }
}