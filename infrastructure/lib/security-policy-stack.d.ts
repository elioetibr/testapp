import * as cdk from 'aws-cdk-lib';
import * as config from 'aws-cdk-lib/aws-config';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
export interface SecurityPolicyStackProps extends cdk.StackProps {
    environment: string;
    enforceCompliance?: boolean;
    enableAdvancedMonitoring?: boolean;
    alertingEndpoint?: string;
    retentionDays?: number;
    allowedRegions?: string[];
    requiredTags?: {
        [key: string]: string[];
    };
    maxInstanceTypes?: string[];
    enforceEncryption?: boolean;
}
export declare class SecurityPolicyStack extends cdk.Stack {
    readonly cloudTrail: cloudtrail.Trail;
    readonly configService: config.CfnConfigurationRecorder;
    readonly complianceBucket: s3.Bucket;
    readonly kmsKey: kms.Key;
    readonly alertTopic: sns.Topic;
    constructor(scope: Construct, id: string, props: SecurityPolicyStackProps);
    private createKMSKey;
    private createComplianceBucket;
    private createCloudTrail;
    private createConfigService;
    private createComplianceRules;
    private getComplianceRulesForEnvironment;
    private createAlertTopic;
    private createSecurityMonitoring;
    private createSecurityEventRules;
    private createEnvironmentPolicies;
    private getPoliciesForEnvironment;
    private createOutputs;
}
