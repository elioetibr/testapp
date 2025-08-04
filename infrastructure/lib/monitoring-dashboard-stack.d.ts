import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
export interface MonitoringDashboardStackProps extends cdk.StackProps {
    environment: string;
    vpcStackName?: string;
    platformStackName?: string;
    applicationStackName?: string;
    securityStackName?: string;
    alertingEmail?: string;
    alertingSlack?: string;
    retentionDays?: number;
    enableAdvancedMetrics?: boolean;
    enableCostAlerting?: boolean;
    errorRateThreshold?: number;
    responseTimeThreshold?: number;
    cpuThreshold?: number;
    memoryThreshold?: number;
}
export declare class MonitoringDashboardStack extends cdk.Stack {
    readonly dashboard: cloudwatch.Dashboard;
    readonly alertTopic: sns.Topic;
    readonly logInsights: logs.QueryDefinition[];
    readonly alarms: cloudwatch.Alarm[];
    constructor(scope: Construct, id: string, props: MonitoringDashboardStackProps);
    private createAlertTopic;
    private createStackSpecificDashboard;
    private createComprehensiveAlarms;
    private createLogInsightsQueries;
    private createDeploymentMonitoring;
    private createCostAlerting;
    private createCustomMetricsFunction;
    private getLoadBalancerName;
    private createOutputs;
}
