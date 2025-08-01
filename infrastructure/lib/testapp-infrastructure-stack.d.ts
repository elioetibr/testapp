import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';
export interface TestAppInfrastructureStackProps extends cdk.StackProps {
    environment: string;
    enableIPv6: boolean;
    enableHANatGateways: boolean;
    maxAzs: number;
    natGateways: number;
    desiredCount: number;
    cpu: number;
    memoryLimitMiB: number;
    vpcCidr?: string;
    publicSubnetCidrMask?: number;
    privateSubnetCidrMask?: number;
    ipv6CidrBlock?: string;
}
export declare class TestAppInfrastructureStack extends cdk.Stack {
    readonly vpc: ec2.Vpc;
    readonly cluster: ecs.Cluster;
    readonly repository: ecr.Repository;
    readonly fargateService: ecs_patterns.ApplicationLoadBalancedFargateService;
    private readonly secretsLoader;
    private readonly appSecrets;
    constructor(scope: Construct, id: string, props: TestAppInfrastructureStackProps);
    private createSecretsManagerSecret;
    private createVpc;
    private createEcrRepository;
    private createEcsCluster;
    private createFargateService;
    private createOutputs;
}
