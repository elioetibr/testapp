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
    vpcCidr?: string;
    publicSubnetCidrMask?: number;
    privateSubnetCidrMask?: number;
    ipv6CidrBlock?: string;
    enableVPCFlowLogs?: boolean;
}
export declare class VpcStack extends cdk.Stack {
    readonly vpc: ec2.Vpc;
    readonly privateSubnets: ec2.ISubnet[];
    readonly publicSubnets: ec2.ISubnet[];
    readonly applicationSecurityGroup: ec2.SecurityGroup;
    readonly loadBalancerSecurityGroup: ec2.SecurityGroup;
    readonly flowLogsBucket?: s3.Bucket;
    constructor(scope: Construct, id: string, props: VpcStackProps);
    private createVpc;
    private createLoadBalancerSecurityGroup;
    private createApplicationSecurityGroup;
    private createVPCFlowLogsBucket;
    private createVPCFlowLogs;
    private createOutputs;
}
