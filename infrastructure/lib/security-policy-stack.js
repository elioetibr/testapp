"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecurityPolicyStack = void 0;
const cdk = require("aws-cdk-lib");
const iam = require("aws-cdk-lib/aws-iam");
const config = require("aws-cdk-lib/aws-config");
const cloudtrail = require("aws-cdk-lib/aws-cloudtrail");
const s3 = require("aws-cdk-lib/aws-s3");
const kms = require("aws-cdk-lib/aws-kms");
const cloudwatch = require("aws-cdk-lib/aws-cloudwatch");
const cloudwatchActions = require("aws-cdk-lib/aws-cloudwatch-actions");
const sns = require("aws-cdk-lib/aws-sns");
const events = require("aws-cdk-lib/aws-events");
const targets = require("aws-cdk-lib/aws-events-targets");
class SecurityPolicyStack extends cdk.Stack {
    constructor(scope, id, props) {
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
    createKMSKey(props) {
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
    createComplianceBucket(props) {
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
    createCloudTrail(props) {
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
    createConfigService(props) {
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
    createComplianceRules(props) {
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
    getComplianceRulesForEnvironment(environment) {
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
    createAlertTopic(props) {
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
    createSecurityMonitoring(props) {
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
    createSecurityEventRules(props) {
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
                message: events.RuleTargetInput.fromText(`Security Alert: ${ruleConfig.description}\nEnvironment: ${props.environment}\nEvent: ${events.RuleTargetInput.fromEventPath('$.detail')}`),
            }));
            // Add tags
            cdk.Tags.of(rule).add('Environment', props.environment);
            cdk.Tags.of(rule).add('Component', 'Security-Events');
        });
    }
    createEnvironmentPolicies(props) {
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
    getPoliciesForEnvironment(environment) {
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
    createOutputs(props) {
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
                value: this.configService.name,
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
exports.SecurityPolicyStack = SecurityPolicyStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VjdXJpdHktcG9saWN5LXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic2VjdXJpdHktcG9saWN5LXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLG1DQUFtQztBQUNuQywyQ0FBMkM7QUFDM0MsaURBQWlEO0FBQ2pELHlEQUF5RDtBQUN6RCx5Q0FBeUM7QUFDekMsMkNBQTJDO0FBQzNDLHlEQUF5RDtBQUN6RCx3RUFBd0U7QUFDeEUsMkNBQTJDO0FBQzNDLGlEQUFpRDtBQUNqRCwwREFBMEQ7QUFrQjFELE1BQWEsbUJBQW9CLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFPaEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUErQjtRQUN2RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixnQ0FBZ0M7UUFDaEMsSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsWUFBWSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRXZDLHVDQUF1QztRQUN2QyxJQUFJLENBQUMsZ0JBQWdCLEdBQUcsSUFBSSxDQUFDLHNCQUFzQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRTNELHFDQUFxQztRQUNyQyxJQUFJLENBQUMsVUFBVSxHQUFHLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUUvQyw2Q0FBNkM7UUFDN0MsSUFBSSxLQUFLLENBQUMsaUJBQWlCLEVBQUU7WUFDM0IsSUFBSSxDQUFDLGFBQWEsR0FBRyxJQUFJLENBQUMsbUJBQW1CLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDckQsSUFBSSxDQUFDLHFCQUFxQixDQUFDLEtBQUssQ0FBQyxDQUFDO1NBQ25DO1FBRUQsaUJBQWlCO1FBQ2pCLElBQUksQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDLGdCQUFnQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRS9DLDZCQUE2QjtRQUM3QixJQUFJLEtBQUssQ0FBQyx3QkFBd0Is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QUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztnQkFDcEIsV0FBVyxFQUFFLEtBQUssQ0FBQyxXQUFXO2dCQUM5QixVQUFVLEVBQUUsS0FBSyxDQUFDLGlCQUFpQixJQUFJLEtBQUs7Z0JBQzVDLFVBQVUsRUFBRSxLQUFLLENBQUMsd0JBQXdCLElBQUksS0FBSztnQkFDbkQsVUFBVSxFQUFFLEtBQUssQ0FBQyxpQkFBaUIsSUFBSSxLQUFLO2dCQUM1QyxRQUFRLEVBQUUsQ0FBQyxDQUFDLEtBQUssQ0FBQyxnQkFBZ0I7Z0JBQ2xDLFNBQVMsRUFBRSxJQUFJLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRTthQUNwQyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7WUFDWCxXQUFXLEVBQUUsMENBQTBDO1NBQ3hELENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQWptQkQsa0RBaW1CQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBjb25maWcgZnJvbSAnYXdzLWNkay1saWIvYXdzLWNvbmZpZyc7XG5pbXBvcnQgKiBhcyBjbG91ZHRyYWlsIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZHRyYWlsJztcbmltcG9ydCAqIGFzIHMzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zMyc7XG5pbXBvcnQgKiBhcyBrbXMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWttcyc7XG5pbXBvcnQgKiBhcyBjbG91ZHdhdGNoIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZHdhdGNoJztcbmltcG9ydCAqIGFzIGNsb3Vkd2F0Y2hBY3Rpb25zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZHdhdGNoLWFjdGlvbnMnO1xuaW1wb3J0ICogYXMgc25zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zbnMnO1xuaW1wb3J0ICogYXMgZXZlbnRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1ldmVudHMnO1xuaW1wb3J0ICogYXMgdGFyZ2V0cyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZXZlbnRzLXRhcmdldHMnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2VjdXJpdHlQb2xpY3lTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICBlbnZpcm9ubWVudDogc3RyaW5nO1xuICAvLyBTZWN1cml0eSBjb25maWd1cmF0aW9uIGJ5IGVudmlyb25tZW50XG4gIGVuZm9yY2VDb21wbGlhbmNlPzogYm9vbGVhbjtcbiAgZW5hYmxlQWR2YW5jZWRNb25pdG9yaW5nPzogYm9vbGVhbjtcbiAgYWxlcnRpbmdFbmRwb2ludD86IHN0cmluZztcbiAgcmV0ZW50aW9uRGF5cz86IG51bWJlcjtcbiAgXG4gIC8vIEVudmlyb25tZW50LXNwZWNpZmljIHBvbGljaWVzXG4gIGFsbG93ZWRSZWdpb25zPzogc3RyaW5nW107XG4gIHJlcXVpcmVkVGFncz86IHsgW2tleTogc3RyaW5nXTogc3RyaW5nW10gfTtcbiAgbWF4SW5zdGFuY2VUeXBlcz86IHN0cmluZ1tdO1xuICBlbmZvcmNlRW5jcnlwdGlvbj86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBjbGFzcyBTZWN1cml0eVBvbGljeVN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IGNsb3VkVHJhaWw6IGNsb3VkdHJhaWwuVHJhaWw7XG4gIHB1YmxpYyByZWFkb25seSBjb25maWdTZXJ2aWNlOiBjb25maWcuQ2ZuQ29uZmlndXJhdGlvblJlY29yZGVyO1xuICBwdWJsaWMgcmVhZG9ubHkgY29tcGxpYW5jZUJ1Y2tldDogczMuQnVja2V0O1xuICBwdWJsaWMgcmVhZG9ubHkga21zS2V5OiBrbXMuS2V5O1xuICBwdWJsaWMgcmVhZG9ubHkgYWxlcnRUb3BpYzogc25zLlRvcGljO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBTZWN1cml0eVBvbGljeVN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIENyZWF0ZSBLTVMga2V5IGZvciBlbmNyeXB0aW9uXG4gICAgdGhpcy5rbXNLZXkgPSB0aGlzLmNyZWF0ZUtNU0tleShwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgUzMgYnVja2V0IGZvciBjb21wbGlhbmNlIGRhdGFcbiAgICB0aGlzLmNvbXBsaWFuY2VCdWNrZXQgPSB0aGlzLmNyZWF0ZUNvbXBsaWFuY2VCdWNrZXQocHJvcHMpO1xuXG4gICAgLy8gU2V0dXAgQ2xvdWRUcmFpbCBmb3IgYXVkaXQgbG9nZ2luZ1xuICAgIHRoaXMuY2xvdWRUcmFpbCA9IHRoaXMuY3JlYXRlQ2xvdWRUcmFpbChwcm9wcyk7XG5cbiAgICAvLyBTZXR1cCBBV1MgQ29uZmlnIGZvciBjb21wbGlhbmNlIG1vbml0b3JpbmdcbiAgICBpZiAocHJvcHMuZW5mb3JjZUNvbXBsaWFuY2UpIHtcbiAgICAgIHRoaXMuY29uZmlnU2VydmljZSA9IHRoaXMuY3JlYXRlQ29uZmlnU2VydmljZShwcm9wcyk7XG4gICAgICB0aGlzLmNyZWF0ZUNvbXBsaWFuY2VSdWxlcyhwcm9wcyk7XG4gICAgfVxuXG4gICAgLy8gU2V0dXAgYWxlcnRpbmdcbiAgICB0aGlzLmFsZXJ0VG9waWMgPSB0aGlzLmNyZWF0ZUFsZXJ0VG9waWMocHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIHNlY3VyaXR5IG1vbml0b3JpbmdcbiAgICBpZiAocHJvcHMuZW5hYmxlQWR2YW5jZWRNb25pdG9yaW5nKSB7XG4gICAgICB0aGlzLmNyZWF0ZVNlY3VyaXR5TW9uaXRvcmluZyhwcm9wcyk7XG4gICAgfVxuXG4gICAgLy8gRW52aXJvbm1lbnQtc3BlY2lmaWMgcG9saWNpZXNcbiAgICB0aGlzLmNyZWF0ZUVudmlyb25tZW50UG9saWNpZXMocHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIG91dHB1dHNcbiAgICB0aGlzLmNyZWF0ZU91dHB1dHMocHJvcHMpO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVLTVNLZXkocHJvcHM6IFNlY3VyaXR5UG9saWN5U3RhY2tQcm9wcyk6IGttcy5LZXkge1xuICAgIGNvbnN0IGtleSA9IG5ldyBrbXMuS2V5KHRoaXMsICdTZWN1cml0eVBvbGljeUtNU0tleScsIHtcbiAgICAgIGFsaWFzOiBgdGVzdGFwcC1zZWN1cml0eS0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICBkZXNjcmlwdGlvbjogYEtNUyBrZXkgZm9yIFRlc3RBcHAgc2VjdXJpdHkgcG9saWNpZXMgaW4gJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgZW5hYmxlS2V5Um90YXRpb246IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicsXG4gICAgICByZW1vdmFsUG9saWN5OiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nIFxuICAgICAgICA/IGNkay5SZW1vdmFsUG9saWN5LlJFVEFJTiBcbiAgICAgICAgOiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuXG4gICAgLy8gR3JhbnQgQ2xvdWRUcmFpbCBhbmQgQ29uZmlnIGFjY2Vzc1xuICAgIGtleS5hZGRUb1Jlc291cmNlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIHNpZDogJ0FsbG93Q2xvdWRUcmFpbEVuY3J5cHRpb24nLFxuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgcHJpbmNpcGFsczogW25ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnY2xvdWR0cmFpbC5hbWF6b25hd3MuY29tJyldLFxuICAgICAgYWN0aW9uczogWydrbXM6R2VuZXJhdGVEYXRhS2V5KicsICdrbXM6RGVzY3JpYmVLZXknXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgfSkpO1xuXG4gICAga2V5LmFkZFRvUmVzb3VyY2VQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgc2lkOiAnQWxsb3dDb25maWdFbmNyeXB0aW9uJyxcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIHByaW5jaXBhbHM6IFtuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2NvbmZpZy5hbWF6b25hd3MuY29tJyldLFxuICAgICAgYWN0aW9uczogWydrbXM6R2VuZXJhdGVEYXRhS2V5KicsICdrbXM6RGVzY3JpYmVLZXknXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgfSkpO1xuXG4gICAgLy8gQWRkIHRhZ3NcbiAgICBjZGsuVGFncy5vZihrZXkpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2Yoa2V5KS5hZGQoJ0NvbXBvbmVudCcsICdTZWN1cml0eS1LTVMnKTtcbiAgICBjZGsuVGFncy5vZihrZXkpLmFkZCgnUHVycG9zZScsICdDb21wbGlhbmNlLUVuY3J5cHRpb24nKTtcblxuICAgIHJldHVybiBrZXk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUNvbXBsaWFuY2VCdWNrZXQocHJvcHM6IFNlY3VyaXR5UG9saWN5U3RhY2tQcm9wcyk6IHMzLkJ1Y2tldCB7XG4gICAgY29uc3QgYnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCAnQ29tcGxpYW5jZUJ1Y2tldCcsIHtcbiAgICAgIGJ1Y2tldE5hbWU6IGB0ZXN0YXBwLXNlY3VyaXR5LWNvbXBsaWFuY2UtJHtwcm9wcy5lbnZpcm9ubWVudH0tJHt0aGlzLmFjY291bnR9YCxcbiAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uS01TLFxuICAgICAgZW5jcnlwdGlvbktleTogdGhpcy5rbXNLZXksXG4gICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgdmVyc2lvbmVkOiB0cnVlLFxuICAgICAgbGlmZWN5Y2xlUnVsZXM6IFt7XG4gICAgICAgIGlkOiAnQ29tcGxpYW5jZURhdGFMaWZlY3ljbGUnLFxuICAgICAgICBlbmFibGVkOiB0cnVlLFxuICAgICAgICB0cmFuc2l0aW9uczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIHN0b3JhZ2VDbGFzczogczMuU3RvcmFnZUNsYXNzLklORlJFUVVFTlRfQUNDRVNTLFxuICAgICAgICAgICAgdHJhbnNpdGlvbkFmdGVyOiBjZGsuRHVyYXRpb24uZGF5cygzMCksXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBzdG9yYWdlQ2xhc3M6IHMzLlN0b3JhZ2VDbGFzcy5HTEFDSUVSLFxuICAgICAgICAgICAgdHJhbnNpdGlvbkFmdGVyOiBjZGsuRHVyYXRpb24uZGF5cyg5MCksXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBzdG9yYWdlQ2xhc3M6IHMzLlN0b3JhZ2VDbGFzcy5ERUVQX0FSQ0hJVkUsXG4gICAgICAgICAgICB0cmFuc2l0aW9uQWZ0ZXI6IGNkay5EdXJhdGlvbi5kYXlzKDM2NSksXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgICAgZXhwaXJhdGlvbjogY2RrLkR1cmF0aW9uLmRheXMocHJvcHMucmV0ZW50aW9uRGF5cyB8fCAyNTU1KSwgLy8gNyB5ZWFycyBkZWZhdWx0XG4gICAgICB9XSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgXG4gICAgICAgID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOIFxuICAgICAgICA6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKGJ1Y2tldCkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZihidWNrZXQpLmFkZCgnQ29tcG9uZW50JywgJ1NlY3VyaXR5LVN0b3JhZ2UnKTtcbiAgICBjZGsuVGFncy5vZihidWNrZXQpLmFkZCgnUHVycG9zZScsICdDb21wbGlhbmNlLURhdGEnKTtcblxuICAgIHJldHVybiBidWNrZXQ7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUNsb3VkVHJhaWwocHJvcHM6IFNlY3VyaXR5UG9saWN5U3RhY2tQcm9wcyk6IGNsb3VkdHJhaWwuVHJhaWwge1xuICAgIGNvbnN0IHRyYWlsID0gbmV3IGNsb3VkdHJhaWwuVHJhaWwodGhpcywgJ1NlY3VyaXR5Q2xvdWRUcmFpbCcsIHtcbiAgICAgIHRyYWlsTmFtZTogYHRlc3RhcHAtc2VjdXJpdHktdHJhaWwtJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgYnVja2V0OiB0aGlzLmNvbXBsaWFuY2VCdWNrZXQsXG4gICAgICBzM0tleVByZWZpeDogJ2Nsb3VkdHJhaWwtbG9ncy8nLFxuICAgICAgZW5jcnlwdGlvbktleTogdGhpcy5rbXNLZXksXG4gICAgICBpbmNsdWRlR2xvYmFsU2VydmljZUV2ZW50czogdHJ1ZSxcbiAgICAgIGlzTXVsdGlSZWdpb25UcmFpbDogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyxcbiAgICAgIGVuYWJsZUZpbGVWYWxpZGF0aW9uOiB0cnVlLFxuICAgICAgc2VuZFRvQ2xvdWRXYXRjaExvZ3M6IHByb3BzLmVuYWJsZUFkdmFuY2VkTW9uaXRvcmluZyxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBldmVudCBzZWxlY3RvcnMgZm9yIGVuaGFuY2VkIG1vbml0b3JpbmdcbiAgICBpZiAocHJvcHMuZW5hYmxlQWR2YW5jZWRNb25pdG9yaW5nKSB7XG4gICAgICB0cmFpbC5hZGRFdmVudFNlbGVjdG9yKGNsb3VkdHJhaWwuRGF0YVJlc291cmNlVHlwZS5TM19PQkpFQ1QsIFtcbiAgICAgICAgYCR7dGhpcy5jb21wbGlhbmNlQnVja2V0LmJ1Y2tldEFybn0vKmBcbiAgICAgIF0sIHtcbiAgICAgICAgcmVhZFdyaXRlVHlwZTogY2xvdWR0cmFpbC5SZWFkV3JpdGVUeXBlLkFMTCxcbiAgICAgICAgaW5jbHVkZU1hbmFnZW1lbnRFdmVudHM6IHRydWUsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKHRyYWlsKS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKHRyYWlsKS5hZGQoJ0NvbXBvbmVudCcsICdTZWN1cml0eS1BdWRpdCcpO1xuICAgIGNkay5UYWdzLm9mKHRyYWlsKS5hZGQoJ1B1cnBvc2UnLCAnQ29tcGxpYW5jZS1Mb2dnaW5nJyk7XG5cbiAgICByZXR1cm4gdHJhaWw7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUNvbmZpZ1NlcnZpY2UocHJvcHM6IFNlY3VyaXR5UG9saWN5U3RhY2tQcm9wcyk6IGNvbmZpZy5DZm5Db25maWd1cmF0aW9uUmVjb3JkZXIge1xuICAgIC8vIENyZWF0ZSBDb25maWcgc2VydmljZSByb2xlXG4gICAgY29uc3QgY29uZmlnUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnQ29uZmlnU2VydmljZVJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnY29uZmlnLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIG1hbmFnZWRQb2xpY2llczogW1xuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoJ3NlcnZpY2Utcm9sZS9Db25maWdSb2xlJyksXG4gICAgICBdLFxuICAgICAgaW5saW5lUG9saWNpZXM6IHtcbiAgICAgICAgQ29tcGxpYW5jZUJ1Y2tldEFjY2VzczogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAnczM6R2V0QnVja2V0QWNsJyxcbiAgICAgICAgICAgICAgICAnczM6UHV0T2JqZWN0JyxcbiAgICAgICAgICAgICAgICAnczM6R2V0QnVja2V0TG9jYXRpb24nLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICAgICAgICB0aGlzLmNvbXBsaWFuY2VCdWNrZXQuYnVja2V0QXJuLFxuICAgICAgICAgICAgICAgIGAke3RoaXMuY29tcGxpYW5jZUJ1Y2tldC5idWNrZXRBcm59LypgLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICdrbXM6R2VuZXJhdGVEYXRhS2V5KicsXG4gICAgICAgICAgICAgICAgJ2ttczpEZXNjcmliZUtleScsXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIHJlc291cmNlczogW3RoaXMua21zS2V5LmtleUFybl0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgQ29uZmlnIGRlbGl2ZXJ5IGNoYW5uZWxcbiAgICBjb25zdCBkZWxpdmVyeUNoYW5uZWwgPSBuZXcgY29uZmlnLkNmbkRlbGl2ZXJ5Q2hhbm5lbCh0aGlzLCAnQ29uZmlnRGVsaXZlcnlDaGFubmVsJywge1xuICAgICAgbmFtZTogYHRlc3RhcHAtY29uZmlnLWRlbGl2ZXJ5LSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIHMzQnVja2V0TmFtZTogdGhpcy5jb21wbGlhbmNlQnVja2V0LmJ1Y2tldE5hbWUsXG4gICAgICBzM0tleVByZWZpeDogJ2NvbmZpZy1oaXN0b3J5LycsXG4gICAgICBjb25maWdTbmFwc2hvdERlbGl2ZXJ5UHJvcGVydGllczoge1xuICAgICAgICBkZWxpdmVyeUZyZXF1ZW5jeTogJ1R3ZW50eUZvdXJfSG91cnMnLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSBDb25maWcgcmVjb3JkZXJcbiAgICBjb25zdCBjb25maWdSZWNvcmRlciA9IG5ldyBjb25maWcuQ2ZuQ29uZmlndXJhdGlvblJlY29yZGVyKHRoaXMsICdDb25maWdSZWNvcmRlcicsIHtcbiAgICAgIG5hbWU6IGB0ZXN0YXBwLWNvbmZpZy1yZWNvcmRlci0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICByb2xlQXJuOiBjb25maWdSb2xlLnJvbGVBcm4sXG4gICAgICByZWNvcmRpbmdHcm91cDoge1xuICAgICAgICBhbGxTdXBwb3J0ZWQ6IHRydWUsXG4gICAgICAgIGluY2x1ZGVHbG9iYWxSZXNvdXJjZVR5cGVzOiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nLFxuICAgICAgICByZXNvdXJjZVR5cGVzOiB1bmRlZmluZWQsIC8vIFVzZSBhbGxTdXBwb3J0ZWQgaW5zdGVhZFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbmZpZ1JlY29yZGVyLmFkZERlcGVuZGVuY3koZGVsaXZlcnlDaGFubmVsKTtcblxuICAgIC8vIEFkZCB0YWdzXG4gICAgY2RrLlRhZ3Mub2YoY29uZmlnUm9sZSkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZihjb25maWdSb2xlKS5hZGQoJ0NvbXBvbmVudCcsICdTZWN1cml0eS1Db25maWcnKTtcblxuICAgIHJldHVybiBjb25maWdSZWNvcmRlcjtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlQ29tcGxpYW5jZVJ1bGVzKHByb3BzOiBTZWN1cml0eVBvbGljeVN0YWNrUHJvcHMpOiB2b2lkIHtcbiAgICAvLyBFbnZpcm9ubWVudC1zcGVjaWZpYyBjb21wbGlhbmNlIHJ1bGVzXG4gICAgY29uc3QgcnVsZXMgPSB0aGlzLmdldENvbXBsaWFuY2VSdWxlc0ZvckVudmlyb25tZW50KHByb3BzLmVudmlyb25tZW50KTtcblxuICAgIHJ1bGVzLmZvckVhY2goKHJ1bGUsIGluZGV4KSA9PiB7XG4gICAgICBjb25zdCBjb25maWdSdWxlID0gbmV3IGNvbmZpZy5DZm5Db25maWdSdWxlKHRoaXMsIGBDb21wbGlhbmNlUnVsZSR7aW5kZXh9YCwge1xuICAgICAgICBjb25maWdSdWxlTmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tJHtydWxlLm5hbWV9YCxcbiAgICAgICAgZGVzY3JpcHRpb246IHJ1bGUuZGVzY3JpcHRpb24sXG4gICAgICAgIHNvdXJjZToge1xuICAgICAgICAgIG93bmVyOiBydWxlLnNvdXJjZS5vd25lcixcbiAgICAgICAgICBzb3VyY2VJZGVudGlmaWVyOiBydWxlLnNvdXJjZS5zb3VyY2VJZGVudGlmaWVyLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICBcbiAgICAgIC8vIEVuc3VyZSBjb25maWcgc2VydmljZSBleGlzdHMgYmVmb3JlIGNyZWF0aW5nIHJ1bGVzXG4gICAgICBjb25maWdSdWxlLm5vZGUuYWRkRGVwZW5kZW5jeSh0aGlzLmNvbmZpZ1NlcnZpY2UpO1xuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBnZXRDb21wbGlhbmNlUnVsZXNGb3JFbnZpcm9ubWVudChlbnZpcm9ubWVudDogc3RyaW5nKSB7XG4gICAgY29uc3QgYmFzZVJ1bGVzID0gW1xuICAgICAge1xuICAgICAgICBuYW1lOiAnZW5jcnlwdGVkLXZvbHVtZXMnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ0NoZWNrcyBpZiBFQlMgdm9sdW1lcyBhcmUgZW5jcnlwdGVkJyxcbiAgICAgICAgc291cmNlOiB7XG4gICAgICAgICAgb3duZXI6ICdBV1MnLFxuICAgICAgICAgIHNvdXJjZUlkZW50aWZpZXI6ICdFTkNSWVBURURfVk9MVU1FUycsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBuYW1lOiAncm9vdC1hY2Nlc3Mta2V5LWNoZWNrJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdDaGVja3MgaWYgcm9vdCB1c2VyIGhhcyBhY2Nlc3Mga2V5cycsXG4gICAgICAgIHNvdXJjZToge1xuICAgICAgICAgIG93bmVyOiAnQVdTJyxcbiAgICAgICAgICBzb3VyY2VJZGVudGlmaWVyOiAnUk9PVF9BQ0NFU1NfS0VZX0NIRUNLJyxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIG5hbWU6ICdzMy1idWNrZXQtcHVibGljLXJlYWQtcHJvaGliaXRlZCcsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQ2hlY2tzIGlmIFMzIGJ1Y2tldHMgYWxsb3cgcHVibGljIHJlYWQgYWNjZXNzJyxcbiAgICAgICAgc291cmNlOiB7XG4gICAgICAgICAgb3duZXI6ICdBV1MnLFxuICAgICAgICAgIHNvdXJjZUlkZW50aWZpZXI6ICdTM19CVUNLRVRfUFVCTElDX1JFQURfUFJPSElCSVRFRCcsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBuYW1lOiAnczMtYnVja2V0LXB1YmxpYy13cml0ZS1wcm9oaWJpdGVkJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdDaGVja3MgaWYgUzMgYnVja2V0cyBhbGxvdyBwdWJsaWMgd3JpdGUgYWNjZXNzJyxcbiAgICAgICAgc291cmNlOiB7XG4gICAgICAgICAgb3duZXI6ICdBV1MnLFxuICAgICAgICAgIHNvdXJjZUlkZW50aWZpZXI6ICdTM19CVUNLRVRfUFVCTElDX1dSSVRFX1BST0hJQklURUQnLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICBdO1xuXG4gICAgY29uc3QgcHJvZHVjdGlvblJ1bGVzID0gW1xuICAgICAge1xuICAgICAgICBuYW1lOiAnY2xvdWR0cmFpbC1lbmFibGVkJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdDaGVja3MgaWYgQ2xvdWRUcmFpbCBpcyBlbmFibGVkJyxcbiAgICAgICAgc291cmNlOiB7XG4gICAgICAgICAgb3duZXI6ICdBV1MnLFxuICAgICAgICAgIHNvdXJjZUlkZW50aWZpZXI6ICdDTE9VRF9UUkFJTF9FTkFCTEVEJyxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIG5hbWU6ICdtZmEtZW5hYmxlZC1mb3ItaWFtLWNvbnNvbGUtYWNjZXNzJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdDaGVja3MgaWYgTUZBIGlzIGVuYWJsZWQgZm9yIElBTSB1c2VycycsXG4gICAgICAgIHNvdXJjZToge1xuICAgICAgICAgIG93bmVyOiAnQVdTJyxcbiAgICAgICAgICBzb3VyY2VJZGVudGlmaWVyOiAnTUZBX0VOQUJMRURfRk9SX0lBTV9DT05TT0xFX0FDQ0VTUycsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBuYW1lOiAncmVxdWlyZWQtdGFncycsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQ2hlY2tzIGlmIHJlc291cmNlcyBoYXZlIHJlcXVpcmVkIHRhZ3MnLFxuICAgICAgICBzb3VyY2U6IHtcbiAgICAgICAgICBvd25lcjogJ0FXUycsXG4gICAgICAgICAgc291cmNlSWRlbnRpZmllcjogJ1JFUVVJUkVEX1RBR1MnLFxuICAgICAgICB9LFxuICAgICAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgcmVxdWlyZWRUYWdLZXlzOiAnRW52aXJvbm1lbnQsUHJvamVjdCxNYW5hZ2VkQnknLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICBdO1xuXG4gICAgcmV0dXJuIGVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgPyBbLi4uYmFzZVJ1bGVzLCAuLi5wcm9kdWN0aW9uUnVsZXNdIDogYmFzZVJ1bGVzO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVBbGVydFRvcGljKHByb3BzOiBTZWN1cml0eVBvbGljeVN0YWNrUHJvcHMpOiBzbnMuVG9waWMge1xuICAgIGNvbnN0IHRvcGljID0gbmV3IHNucy5Ub3BpYyh0aGlzLCAnU2VjdXJpdHlBbGVydFRvcGljJywge1xuICAgICAgdG9waWNOYW1lOiBgdGVzdGFwcC1zZWN1cml0eS1hbGVydHMtJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgZGlzcGxheU5hbWU6IGBUZXN0QXBwIFNlY3VyaXR5IEFsZXJ0cyAtICR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIG1hc3RlcktleTogdGhpcy5rbXNLZXksXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgZW1haWwgc3Vic2NyaXB0aW9uIGlmIHByb3ZpZGVkXG4gICAgaWYgKHByb3BzLmFsZXJ0aW5nRW5kcG9pbnQpIHtcbiAgICAgIG5ldyBzbnMuU3Vic2NyaXB0aW9uKHRoaXMsICdBbGVydEVtYWlsU3Vic2NyaXB0aW9uJywge1xuICAgICAgICB0b3BpYyxcbiAgICAgICAgcHJvdG9jb2w6IHNucy5TdWJzY3JpcHRpb25Qcm90b2NvbC5FTUFJTCxcbiAgICAgICAgZW5kcG9pbnQ6IHByb3BzLmFsZXJ0aW5nRW5kcG9pbnQsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKHRvcGljKS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKHRvcGljKS5hZGQoJ0NvbXBvbmVudCcsICdTZWN1cml0eS1BbGVydGluZycpO1xuXG4gICAgcmV0dXJuIHRvcGljO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVTZWN1cml0eU1vbml0b3JpbmcocHJvcHM6IFNlY3VyaXR5UG9saWN5U3RhY2tQcm9wcyk6IHZvaWQge1xuICAgIC8vIENyZWF0ZSBDbG91ZFdhdGNoIGFsYXJtcyBmb3Igc2VjdXJpdHkgZXZlbnRzXG4gICAgY29uc3Qgc2VjdXJpdHlBbGFybXMgPSBbXG4gICAgICB7XG4gICAgICAgIG5hbWU6ICdVbmF1dGhvcml6ZWRBUElDYWxsc0FsYXJtJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdBbGFybSBmb3IgdW5hdXRob3JpemVkIEFQSSBjYWxscycsXG4gICAgICAgIG1ldHJpY05hbWU6ICdVbmF1dGhvcml6ZWRBUElDYWxscycsXG4gICAgICAgIHRocmVzaG9sZDogMSxcbiAgICAgICAgcGVyaW9kOiAzMDAsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBuYW1lOiAnUm9vdFVzYWdlQWxhcm0nLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ0FsYXJtIGZvciByb290IGFjY291bnQgdXNhZ2UnLFxuICAgICAgICBtZXRyaWNOYW1lOiAnUm9vdEFjY291bnRVc2FnZScsIFxuICAgICAgICB0aHJlc2hvbGQ6IDEsXG4gICAgICAgIHBlcmlvZDogMzAwLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgbmFtZTogJ0NvbnNvbGVTaWduaW5GYWlsdXJlc0FsYXJtJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdBbGFybSBmb3IgY29uc29sZSBzaWduaW4gZmFpbHVyZXMnLFxuICAgICAgICBtZXRyaWNOYW1lOiAnQ29uc29sZVNpZ25pbkZhaWx1cmVzJyxcbiAgICAgICAgdGhyZXNob2xkOiAzLFxuICAgICAgICBwZXJpb2Q6IDMwMCxcbiAgICAgIH0sXG4gICAgXTtcblxuICAgIHNlY3VyaXR5QWxhcm1zLmZvckVhY2goYWxhcm1Db25maWcgPT4ge1xuICAgICAgY29uc3QgYWxhcm0gPSBuZXcgY2xvdWR3YXRjaC5BbGFybSh0aGlzLCBhbGFybUNvbmZpZy5uYW1lLCB7XG4gICAgICAgIGFsYXJtTmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tJHthbGFybUNvbmZpZy5uYW1lfWAsXG4gICAgICAgIGFsYXJtRGVzY3JpcHRpb246IGFsYXJtQ29uZmlnLmRlc2NyaXB0aW9uLFxuICAgICAgICBtZXRyaWM6IG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICAgICAgbmFtZXNwYWNlOiAnVGVzdEFwcC9TZWN1cml0eScsXG4gICAgICAgICAgbWV0cmljTmFtZTogYWxhcm1Db25maWcubWV0cmljTmFtZSxcbiAgICAgICAgICBzdGF0aXN0aWM6ICdTdW0nLFxuICAgICAgICAgIHBlcmlvZDogY2RrLkR1cmF0aW9uLnNlY29uZHMoYWxhcm1Db25maWcucGVyaW9kKSxcbiAgICAgICAgfSksXG4gICAgICAgIHRocmVzaG9sZDogYWxhcm1Db25maWcudGhyZXNob2xkLFxuICAgICAgICBldmFsdWF0aW9uUGVyaW9kczogMSxcbiAgICAgICAgdHJlYXRNaXNzaW5nRGF0YTogY2xvdWR3YXRjaC5UcmVhdE1pc3NpbmdEYXRhLk5PVF9CUkVBQ0hJTkcsXG4gICAgICB9KTtcblxuICAgICAgLy8gQWRkIFNOUyBub3RpZmljYXRpb25cbiAgICAgIGFsYXJtLmFkZEFsYXJtQWN0aW9uKG5ldyBjbG91ZHdhdGNoQWN0aW9ucy5TbnNBY3Rpb24odGhpcy5hbGVydFRvcGljKSk7XG5cbiAgICAgIC8vIEFkZCB0YWdzXG4gICAgICBjZGsuVGFncy5vZihhbGFybSkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICAgIGNkay5UYWdzLm9mKGFsYXJtKS5hZGQoJ0NvbXBvbmVudCcsICdTZWN1cml0eS1Nb25pdG9yaW5nJyk7XG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgRXZlbnRCcmlkZ2UgcnVsZXMgZm9yIHNlY3VyaXR5IGV2ZW50c1xuICAgIHRoaXMuY3JlYXRlU2VjdXJpdHlFdmVudFJ1bGVzKHByb3BzKTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlU2VjdXJpdHlFdmVudFJ1bGVzKHByb3BzOiBTZWN1cml0eVBvbGljeVN0YWNrUHJvcHMpOiB2b2lkIHtcbiAgICBjb25zdCBzZWN1cml0eUV2ZW50UnVsZXMgPSBbXG4gICAgICB7XG4gICAgICAgIG5hbWU6ICdDb25maWdDb21wbGlhbmNlQ2hhbmdlUnVsZScsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnVHJpZ2dlciBvbiBDb25maWcgY29tcGxpYW5jZSBjaGFuZ2VzJyxcbiAgICAgICAgZXZlbnRQYXR0ZXJuOiB7XG4gICAgICAgICAgc291cmNlOiBbJ2F3cy5jb25maWcnXSxcbiAgICAgICAgICBkZXRhaWxUeXBlOiBbJ0NvbmZpZyBSdWxlcyBDb21wbGlhbmNlIENoYW5nZSddLFxuICAgICAgICAgIGRldGFpbDoge1xuICAgICAgICAgICAgbmV3RXZhbHVhdGlvblJlc3VsdDoge1xuICAgICAgICAgICAgICBjb21wbGlhbmNlVHlwZTogWydOT05fQ09NUExJQU5UJ10sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBuYW1lOiAnU2VjdXJpdHlHcm91cENoYW5nZVJ1bGUnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1RyaWdnZXIgb24gc2VjdXJpdHkgZ3JvdXAgY2hhbmdlcycsXG4gICAgICAgIGV2ZW50UGF0dGVybjoge1xuICAgICAgICAgIHNvdXJjZTogWydhd3MuZWMyJ10sXG4gICAgICAgICAgZGV0YWlsVHlwZTogWydBV1MgQVBJIENhbGwgdmlhIENsb3VkVHJhaWwnXSxcbiAgICAgICAgICBkZXRhaWw6IHtcbiAgICAgICAgICAgIGV2ZW50U291cmNlOiBbJ2VjMi5hbWF6b25hd3MuY29tJ10sXG4gICAgICAgICAgICBldmVudE5hbWU6IFtcbiAgICAgICAgICAgICAgJ0F1dGhvcml6ZVNlY3VyaXR5R3JvdXBJbmdyZXNzJyxcbiAgICAgICAgICAgICAgJ0F1dGhvcml6ZVNlY3VyaXR5R3JvdXBFZ3Jlc3MnLFxuICAgICAgICAgICAgICAnUmV2b2tlU2VjdXJpdHlHcm91cEluZ3Jlc3MnLFxuICAgICAgICAgICAgICAnUmV2b2tlU2VjdXJpdHlHcm91cEVncmVzcycsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBuYW1lOiAnSUFNUG9saWN5Q2hhbmdlUnVsZScsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnVHJpZ2dlciBvbiBJQU0gcG9saWN5IGNoYW5nZXMnLFxuICAgICAgICBldmVudFBhdHRlcm46IHtcbiAgICAgICAgICBzb3VyY2U6IFsnYXdzLmlhbSddLFxuICAgICAgICAgIGRldGFpbFR5cGU6IFsnQVdTIEFQSSBDYWxsIHZpYSBDbG91ZFRyYWlsJ10sXG4gICAgICAgICAgZGV0YWlsOiB7XG4gICAgICAgICAgICBldmVudFNvdXJjZTogWydpYW0uYW1hem9uYXdzLmNvbSddLFxuICAgICAgICAgICAgZXZlbnROYW1lOiBbXG4gICAgICAgICAgICAgICdDcmVhdGVQb2xpY3knLFxuICAgICAgICAgICAgICAnQ3JlYXRlUm9sZScsXG4gICAgICAgICAgICAgICdBdHRhY2hVc2VyUG9saWN5JyxcbiAgICAgICAgICAgICAgJ0F0dGFjaFJvbGVQb2xpY3knLFxuICAgICAgICAgICAgICAnUHV0VXNlclBvbGljeScsXG4gICAgICAgICAgICAgICdQdXRSb2xlUG9saWN5JyxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgXTtcblxuICAgIHNlY3VyaXR5RXZlbnRSdWxlcy5mb3JFYWNoKHJ1bGVDb25maWcgPT4ge1xuICAgICAgY29uc3QgcnVsZSA9IG5ldyBldmVudHMuUnVsZSh0aGlzLCBydWxlQ29uZmlnLm5hbWUsIHtcbiAgICAgICAgcnVsZU5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LSR7cnVsZUNvbmZpZy5uYW1lfWAsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBydWxlQ29uZmlnLmRlc2NyaXB0aW9uLFxuICAgICAgICBldmVudFBhdHRlcm46IHJ1bGVDb25maWcuZXZlbnRQYXR0ZXJuLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIEFkZCBTTlMgdG9waWMgYXMgdGFyZ2V0XG4gICAgICBydWxlLmFkZFRhcmdldChuZXcgdGFyZ2V0cy5TbnNUb3BpYyh0aGlzLmFsZXJ0VG9waWMsIHtcbiAgICAgICAgbWVzc2FnZTogZXZlbnRzLlJ1bGVUYXJnZXRJbnB1dC5mcm9tVGV4dChcbiAgICAgICAgICBgU2VjdXJpdHkgQWxlcnQ6ICR7cnVsZUNvbmZpZy5kZXNjcmlwdGlvbn1cXG5FbnZpcm9ubWVudDogJHtwcm9wcy5lbnZpcm9ubWVudH1cXG5FdmVudDogJHtldmVudHMuUnVsZVRhcmdldElucHV0LmZyb21FdmVudFBhdGgoJyQuZGV0YWlsJyl9YFxuICAgICAgICApLFxuICAgICAgfSkpO1xuXG4gICAgICAvLyBBZGQgdGFnc1xuICAgICAgY2RrLlRhZ3Mub2YocnVsZSkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICAgIGNkay5UYWdzLm9mKHJ1bGUpLmFkZCgnQ29tcG9uZW50JywgJ1NlY3VyaXR5LUV2ZW50cycpO1xuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVFbnZpcm9ubWVudFBvbGljaWVzKHByb3BzOiBTZWN1cml0eVBvbGljeVN0YWNrUHJvcHMpOiB2b2lkIHtcbiAgICAvLyBDcmVhdGUgZW52aXJvbm1lbnQtc3BlY2lmaWMgSUFNIHBvbGljaWVzXG4gICAgY29uc3QgZW52aXJvbm1lbnRQb2xpY2llcyA9IHRoaXMuZ2V0UG9saWNpZXNGb3JFbnZpcm9ubWVudChwcm9wcy5lbnZpcm9ubWVudCk7XG5cbiAgICBlbnZpcm9ubWVudFBvbGljaWVzLmZvckVhY2goKHBvbGljeSwgaW5kZXgpID0+IHtcbiAgICAgIG5ldyBpYW0uTWFuYWdlZFBvbGljeSh0aGlzLCBgRW52aXJvbm1lbnRQb2xpY3kke2luZGV4fWAsIHtcbiAgICAgICAgbWFuYWdlZFBvbGljeU5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LSR7cG9saWN5Lm5hbWV9YCxcbiAgICAgICAgZGVzY3JpcHRpb246IHBvbGljeS5kZXNjcmlwdGlvbixcbiAgICAgICAgc3RhdGVtZW50czogcG9saWN5LnN0YXRlbWVudHMubWFwKHN0bXQgPT4gbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoc3RtdCkpLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGdldFBvbGljaWVzRm9yRW52aXJvbm1lbnQoZW52aXJvbm1lbnQ6IHN0cmluZykge1xuICAgIGNvbnN0IGRldlBvbGljaWVzID0gW1xuICAgICAge1xuICAgICAgICBuYW1lOiAnZGV2ZWxvcGVyLWFjY2VzcycsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnRGV2ZWxvcG1lbnQgZW52aXJvbm1lbnQgYWNjZXNzIHBvbGljeScsXG4gICAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICdlY3M6KicsXG4gICAgICAgICAgICAgICdlY3I6KicsXG4gICAgICAgICAgICAgICdsb2dzOionLFxuICAgICAgICAgICAgICAnY2xvdWR3YXRjaDoqJyxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgICAgICAgY29uZGl0aW9uczoge1xuICAgICAgICAgICAgICBTdHJpbmdFcXVhbHM6IHtcbiAgICAgICAgICAgICAgICAnYXdzOlJlcXVlc3RlZFJlZ2lvbic6IFsndXMtZWFzdC0xJywgJ3VzLXdlc3QtMiddLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICBdO1xuXG4gICAgY29uc3Qgc3RhZ2luZ1BvbGljaWVzID0gW1xuICAgICAge1xuICAgICAgICBuYW1lOiAnc3RhZ2luZy1yZXN0cmljdGVkLWFjY2VzcycsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnU3RhZ2luZyBlbnZpcm9ubWVudCByZXN0cmljdGVkIGFjY2VzcyBwb2xpY3knLFxuICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAnZWNzOkRlc2NyaWJlU2VydmljZXMnLFxuICAgICAgICAgICAgICAnZWNzOkRlc2NyaWJlVGFza3MnLFxuICAgICAgICAgICAgICAnZWNzOlVwZGF0ZVNlcnZpY2UnLFxuICAgICAgICAgICAgICAnbG9nczpEZXNjcmliZUxvZ0dyb3VwcycsXG4gICAgICAgICAgICAgICdsb2dzOkRlc2NyaWJlTG9nU3RyZWFtcycsXG4gICAgICAgICAgICAgICdsb2dzOkdldExvZ0V2ZW50cycsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5ERU5ZLFxuICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAnaWFtOionLFxuICAgICAgICAgICAgICAna21zOionLFxuICAgICAgICAgICAgICAnY29uZmlnOionLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgXTtcblxuICAgIGNvbnN0IHByb2R1Y3Rpb25Qb2xpY2llcyA9IFtcbiAgICAgIHtcbiAgICAgICAgbmFtZTogJ3Byb2R1Y3Rpb24tbWluaW1hbC1hY2Nlc3MnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1Byb2R1Y3Rpb24gZW52aXJvbm1lbnQgbWluaW1hbCBhY2Nlc3MgcG9saWN5JyxcbiAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgJ2VjczpEZXNjcmliZVNlcnZpY2VzJyxcbiAgICAgICAgICAgICAgJ2VjczpEZXNjcmliZVRhc2tzJyxcbiAgICAgICAgICAgICAgJ2xvZ3M6RGVzY3JpYmVMb2dHcm91cHMnLFxuICAgICAgICAgICAgICAnbG9nczpEZXNjcmliZUxvZ1N0cmVhbXMnLFxuICAgICAgICAgICAgICAnbG9nczpHZXRMb2dFdmVudHMnLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuREVOWSxcbiAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgJ2lhbToqJyxcbiAgICAgICAgICAgICAgJ2ttczoqJyxcbiAgICAgICAgICAgICAgJ2NvbmZpZzoqJyxcbiAgICAgICAgICAgICAgJ2VjczpDcmVhdGVTZXJ2aWNlJyxcbiAgICAgICAgICAgICAgJ2VjczpEZWxldGVTZXJ2aWNlJyxcbiAgICAgICAgICAgICAgJ2VjczpVcGRhdGVTZXJ2aWNlJyxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIF07XG5cbiAgICBzd2l0Y2ggKGVudmlyb25tZW50KSB7XG4gICAgICBjYXNlICdkZXYnOlxuICAgICAgICByZXR1cm4gZGV2UG9saWNpZXM7XG4gICAgICBjYXNlICdzdGFnaW5nJzpcbiAgICAgICAgcmV0dXJuIHN0YWdpbmdQb2xpY2llcztcbiAgICAgIGNhc2UgJ3Byb2R1Y3Rpb24nOlxuICAgICAgICByZXR1cm4gcHJvZHVjdGlvblBvbGljaWVzO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgcmV0dXJuIGRldlBvbGljaWVzO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlT3V0cHV0cyhwcm9wczogU2VjdXJpdHlQb2xpY3lTdGFja1Byb3BzKTogdm9pZCB7XG4gICAgLy8gQ2xvdWRUcmFpbCBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Nsb3VkVHJhaWxBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy5jbG91ZFRyYWlsLnRyYWlsQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdDbG91ZFRyYWlsIEFSTiBmb3Igc2VjdXJpdHkgYXVkaXQgbG9nZ2luZycsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQ2xvdWRUcmFpbEFybmAsXG4gICAgfSk7XG5cbiAgICAvLyBDb21wbGlhbmNlIGJ1Y2tldCBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0NvbXBsaWFuY2VCdWNrZXROYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMuY29tcGxpYW5jZUJ1Y2tldC5idWNrZXROYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdTMyBidWNrZXQgZm9yIGNvbXBsaWFuY2UgZGF0YSBzdG9yYWdlJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Db21wbGlhbmNlQnVja2V0TmFtZWAsXG4gICAgfSk7XG5cbiAgICAvLyBLTVMga2V5IG91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnU2VjdXJpdHlLTVNLZXlJZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmttc0tleS5rZXlJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnS01TIGtleSBJRCBmb3Igc2VjdXJpdHkgZW5jcnlwdGlvbicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tU2VjdXJpdHlLTVNLZXlJZGAsXG4gICAgfSk7XG5cbiAgICAvLyBBbGVydCB0b3BpYyBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1NlY3VyaXR5QWxlcnRUb3BpY0FybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmFsZXJ0VG9waWMudG9waWNBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ1NOUyB0b3BpYyBBUk4gZm9yIHNlY3VyaXR5IGFsZXJ0cycsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tU2VjdXJpdHlBbGVydFRvcGljQXJuYCxcbiAgICB9KTtcblxuICAgIC8vIENvbmZpZyBzZXJ2aWNlIG91dHB1dHMgKGlmIGVuYWJsZWQpXG4gICAgaWYgKHByb3BzLmVuZm9yY2VDb21wbGlhbmNlKSB7XG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ29uZmlnUmVjb3JkZXJOYW1lJywge1xuICAgICAgICB2YWx1ZTogdGhpcy5jb25maWdTZXJ2aWNlLm5hbWUhLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ0FXUyBDb25maWcgcmVjb3JkZXIgbmFtZScsXG4gICAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Db25maWdSZWNvcmRlck5hbWVgLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gU2VjdXJpdHkgcG9zdHVyZSBzdW1tYXJ5XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1NlY3VyaXR5UG9zdHVyZVN1bW1hcnknLCB7XG4gICAgICB2YWx1ZTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBlbnZpcm9ubWVudDogcHJvcHMuZW52aXJvbm1lbnQsXG4gICAgICAgIGNvbXBsaWFuY2U6IHByb3BzLmVuZm9yY2VDb21wbGlhbmNlIHx8IGZhbHNlLFxuICAgICAgICBtb25pdG9yaW5nOiBwcm9wcy5lbmFibGVBZHZhbmNlZE1vbml0b3JpbmcgfHwgZmFsc2UsXG4gICAgICAgIGVuY3J5cHRpb246IHByb3BzLmVuZm9yY2VFbmNyeXB0aW9uIHx8IGZhbHNlLFxuICAgICAgICBhbGVydGluZzogISFwcm9wcy5hbGVydGluZ0VuZHBvaW50LFxuICAgICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIH0sIG51bGwsIDIpLFxuICAgICAgZGVzY3JpcHRpb246ICdTZWN1cml0eSBwb3N0dXJlIHN1bW1hcnkgZm9yIGVudmlyb25tZW50JyxcbiAgICB9KTtcbiAgfVxufSJdfQ==