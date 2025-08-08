import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elasticloadbalancingv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
export interface EcsPlatformStackProps extends cdk.StackProps {
    environment: string;
    vpcId: string;
    publicSubnetIds: string[];
    loadBalancerSecurityGroupId: string;
    clusterName?: string;
    repositoryName?: string;
    enableWAF?: boolean;
    certificateArn?: string;
    hostedZoneId?: string;
    baseDomain?: string;
    appName?: string;
}
export declare class EcsPlatformStack extends cdk.Stack {
    readonly cluster: ecs.Cluster;
    readonly repository: ecr.IRepository;
    readonly loadBalancer: elasticloadbalancingv2.ApplicationLoadBalancer;
    readonly httpListener: elasticloadbalancingv2.ApplicationListener;
    readonly httpsListener?: elasticloadbalancingv2.ApplicationListener;
    readonly certificate?: certificatemanager.ICertificate;
    readonly webACL?: wafv2.CfnWebACL;
    readonly logGroup: logs.LogGroup;
    readonly hostedZone?: route53.IHostedZone;
    constructor(scope: Construct, id: string, props: EcsPlatformStackProps);
    private createLogGroup;
    private createEcsCluster;
    private createEcrRepository;
    private createCertificate;
    private createApplicationLoadBalancer;
    private createHttpListener;
    private addHttpToHttpsRedirect;
    private createHttpsListener;
    private createHttpsListenerWithImportedCert;
    private createWAF;
    private associateWAFWithALB;
    private createOutputs;
}
