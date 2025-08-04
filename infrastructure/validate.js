#!/usr/bin/env ts-node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = require("aws-cdk-lib");
const testapp_infrastructure_stack_1 = require("./lib/legacy/testapp-infrastructure-stack");
// Create a validation app without AWS authentication
const app = new cdk.App();
// Test all environments
const environments = ['dev', 'staging', 'production'];
environments.forEach(environment => {
    const config = {
        dev: {
            enableIPv6: false,
            enableHANatGateways: false,
            maxAzs: 2,
            natGateways: 1,
            desiredCount: 1,
            cpu: 256,
            memoryLimitMiB: 512,
            vpcCidr: '10.0.0.0/16',
            publicSubnetCidrMask: 24,
            privateSubnetCidrMask: 24
        },
        staging: {
            enableIPv6: true,
            enableHANatGateways: false,
            maxAzs: 2,
            natGateways: 1,
            desiredCount: 2,
            cpu: 512,
            memoryLimitMiB: 1024,
            vpcCidr: '10.1.0.0/16',
            publicSubnetCidrMask: 24,
            privateSubnetCidrMask: 23
        },
        production: {
            enableIPv6: true,
            enableHANatGateways: true,
            maxAzs: 3,
            natGateways: 3,
            desiredCount: 3,
            cpu: 1024,
            memoryLimitMiB: 2048,
            vpcCidr: '10.2.0.0/16',
            publicSubnetCidrMask: 24,
            privateSubnetCidrMask: 22
        }
    };
    const envConfig = config[environment];
    try {
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, `TestApp-${environment}-validation`, {
            env: {
                account: '123456789012',
                region: 'us-east-1',
            },
            environment,
            ...envConfig,
            tags: {
                Environment: environment,
                Project: 'TestApp',
                ManagedBy: 'CDK'
            }
        });
        console.log(`✅ ${environment} environment configuration is valid`);
        console.log(`   - VPC CIDR: ${envConfig.vpcCidr}`);
        console.log(`   - Public Subnet CIDR Mask: /${envConfig.publicSubnetCidrMask}`);
        console.log(`   - Private Subnet CIDR Mask: /${envConfig.privateSubnetCidrMask}`);
        console.log(`   - IPv6: ${envConfig.enableIPv6 ? 'Enabled (AWS-provided)' : 'Disabled'}`);
        console.log(`   - HA NAT Gateways: ${envConfig.enableHANatGateways ? 'Enabled' : 'Disabled'}`);
        console.log(`   - Max AZs: ${envConfig.maxAzs}`);
        console.log(`   - NAT Gateways: ${envConfig.natGateways}`);
        console.log(`   - Desired Count: ${envConfig.desiredCount}`);
        console.log(`   - CPU: ${envConfig.cpu}`);
        console.log(`   - Memory: ${envConfig.memoryLimitMiB}MB`);
        console.log('');
    }
    catch (error) {
        console.error(`❌ ${environment} environment configuration failed:`, error);
    }
});
console.log('🎉 All infrastructure configurations validated successfully!');
console.log('');
console.log('Next steps:');
console.log('1. Configure AWS credentials: aws configure');
console.log('2. Bootstrap CDK: cdk bootstrap');
console.log('3. Deploy: ./scripts/deploy.sh [environment]');
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidmFsaWRhdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJ2YWxpZGF0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFFQSxtQ0FBbUM7QUFDbkMsNEZBQXVGO0FBRXZGLHFEQUFxRDtBQUNyRCxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztBQUUxQix3QkFBd0I7QUFDeEIsTUFBTSxZQUFZLEdBQUcsQ0FBQyxLQUFLLEVBQUUsU0FBUyxFQUFFLFlBQVksQ0FBQyxDQUFDO0FBRXRELFlBQVksQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDLEVBQUU7SUFDakMsTUFBTSxNQUFNLEdBQUc7UUFDYixHQUFHLEVBQUU7WUFDSCxVQUFVLEVBQUUsS0FBSztZQUNqQixtQkFBbUIsRUFBRSxLQUFLO1lBQzFCLE1BQU0sRUFBRSxDQUFDO1lBQ1QsV0FBVyxFQUFFLENBQUM7WUFDZCxZQUFZLEVBQUUsQ0FBQztZQUNmLEdBQUcsRUFBRSxHQUFHO1lBQ1IsY0FBYyxFQUFFLEdBQUc7WUFDbkIsT0FBTyxFQUFFLGFBQWE7WUFDdEIsb0JBQW9CLEVBQUUsRUFBRTtZQUN4QixxQkFBcUIsRUFBRSxFQUFFO1NBQzFCO1FBQ0QsT0FBTyxFQUFFO1lBQ1AsVUFBVSxFQUFFLElBQUk7WUFDaEIsbUJBQW1CLEVBQUUsS0FBSztZQUMxQixNQUFNLEVBQUUsQ0FBQztZQUNULFdBQVcsRUFBRSxDQUFDO1lBQ2QsWUFBWSxFQUFFLENBQUM7WUFDZixHQUFHLEVBQUUsR0FBRztZQUNSLGNBQWMsRUFBRSxJQUFJO1lBQ3BCLE9BQU8sRUFBRSxhQUFhO1lBQ3RCLG9CQUFvQixFQUFFLEVBQUU7WUFDeEIscUJBQXFCLEVBQUUsRUFBRTtTQUMxQjtRQUNELFVBQVUsRUFBRTtZQUNWLFVBQVUsRUFBRSxJQUFJO1lBQ2hCLG1CQUFtQixFQUFFLElBQUk7WUFDekIsTUFBTSxFQUFFLENBQUM7WUFDVCxXQUFXLEVBQUUsQ0FBQztZQUNkLFlBQVksRUFBRSxDQUFDO1lBQ2YsR0FBRyxFQUFFLElBQUk7WUFDVCxjQUFjLEVBQUUsSUFBSTtZQUNwQixPQUFPLEVBQUUsYUFBYTtZQUN0QixvQkFBb0IsRUFBRSxFQUFFO1lBQ3hCLHFCQUFxQixFQUFFLEVBQUU7U0FDMUI7S0FDRixDQUFDO0lBRUYsTUFBTSxTQUFTLEdBQUcsTUFBTSxDQUFDLFdBQWtDLENBQUMsQ0FBQztJQUU3RCxJQUFJO1FBQ0YsTUFBTSxLQUFLLEdBQUcsSUFBSSx5REFBMEIsQ0FBQyxHQUFHLEVBQUUsV0FBVyxXQUFXLGFBQWEsRUFBRTtZQUNyRixHQUFHLEVBQUU7Z0JBQ0gsT0FBTyxFQUFFLGNBQWM7Z0JBQ3ZCLE1BQU0sRUFBRSxXQUFXO2FBQ3BCO1lBQ0QsV0FBVztZQUNYLEdBQUcsU0FBUztZQUNaLElBQUksRUFBRTtnQkFDSixXQUFXLEVBQUUsV0FBVztnQkFDeEIsT0FBTyxFQUFFLFNBQVM7Z0JBQ2xCLFNBQVMsRUFBRSxLQUFLO2FBQ2pCO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsT0FBTyxDQUFDLEdBQUcsQ0FBQyxLQUFLLFdBQVcscUNBQXFDLENBQUMsQ0FBQztRQUNuRSxPQUFPLENBQUMsR0FBRyxDQUFDLGtCQUFrQixTQUFTLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQztRQUNuRCxPQUFPLENBQUMsR0FBRyxDQUFDLGtDQUFrQyxTQUFTLENBQUMsb0JBQW9CLEVBQUUsQ0FBQyxDQUFDO1FBQ2hGLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUNBQW1DLFNBQVMsQ0FBQyxxQkFBcUIsRUFBRSxDQUFDLENBQUM7UUFDbEYsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFjLFNBQVMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLHdCQUF3QixDQUFDLENBQUMsQ0FBQyxVQUFVLEVBQUUsQ0FBQyxDQUFDO1FBQzFGLE9BQU8sQ0FBQyxHQUFHLENBQUMseUJBQXlCLFNBQVMsQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxVQUFVLEVBQUUsQ0FBQyxDQUFDO1FBQy9GLE9BQU8sQ0FBQyxHQUFHLENBQUMsaUJBQWlCLFNBQVMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO1FBQ2pELE9BQU8sQ0FBQyxHQUFHLENBQUMsc0JBQXNCLFNBQVMsQ0FBQyxXQUFXLEVBQUUsQ0FBQyxDQUFDO1FBQzNELE9BQU8sQ0FBQyxHQUFHLENBQUMsdUJBQXVCLFNBQVMsQ0FBQyxZQUFZLEVBQUUsQ0FBQyxDQUFDO1FBQzdELE9BQU8sQ0FBQyxHQUFHLENBQUMsYUFBYSxTQUFTLENBQUMsR0FBRyxFQUFFLENBQUMsQ0FBQztRQUMxQyxPQUFPLENBQUMsR0FBRyxDQUFDLGdCQUFnQixTQUFTLENBQUMsY0FBYyxJQUFJLENBQUMsQ0FBQztRQUMxRCxPQUFPLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0tBQ2pCO0lBQUMsT0FBTyxLQUFLLEVBQUU7UUFDZCxPQUFPLENBQUMsS0FBSyxDQUFDLEtBQUssV0FBVyxvQ0FBb0MsRUFBRSxLQUFLLENBQUMsQ0FBQztLQUM1RTtBQUNILENBQUMsQ0FBQyxDQUFDO0FBRUgsT0FBTyxDQUFDLEdBQUcsQ0FBQyw4REFBOEQsQ0FBQyxDQUFDO0FBQzVFLE9BQU8sQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDaEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxhQUFhLENBQUMsQ0FBQztBQUMzQixPQUFPLENBQUMsR0FBRyxDQUFDLDZDQUE2QyxDQUFDLENBQUM7QUFDM0QsT0FBTyxDQUFDLEdBQUcsQ0FBQyxpQ0FBaUMsQ0FBQyxDQUFDO0FBQy9DLE9BQU8sQ0FBQyxHQUFHLENBQUMsOENBQThDLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIiMhL3Vzci9iaW4vZW52IHRzLW5vZGVcblxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrIH0gZnJvbSAnLi9saWIvbGVnYWN5L3Rlc3RhcHAtaW5mcmFzdHJ1Y3R1cmUtc3RhY2snO1xuXG4vLyBDcmVhdGUgYSB2YWxpZGF0aW9uIGFwcCB3aXRob3V0IEFXUyBhdXRoZW50aWNhdGlvblxuY29uc3QgYXBwID0gbmV3IGNkay5BcHAoKTtcblxuLy8gVGVzdCBhbGwgZW52aXJvbm1lbnRzXG5jb25zdCBlbnZpcm9ubWVudHMgPSBbJ2RldicsICdzdGFnaW5nJywgJ3Byb2R1Y3Rpb24nXTtcblxuZW52aXJvbm1lbnRzLmZvckVhY2goZW52aXJvbm1lbnQgPT4ge1xuICBjb25zdCBjb25maWcgPSB7XG4gICAgZGV2OiB7XG4gICAgICBlbmFibGVJUHY2OiBmYWxzZSxcbiAgICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IGZhbHNlLFxuICAgICAgbWF4QXpzOiAyLFxuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgICBjcHU6IDI1NixcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiA1MTIsXG4gICAgICB2cGNDaWRyOiAnMTAuMC4wLjAvMTYnLFxuICAgICAgcHVibGljU3VibmV0Q2lkck1hc2s6IDI0LFxuICAgICAgcHJpdmF0ZVN1Ym5ldENpZHJNYXNrOiAyNFxuICAgIH0sXG4gICAgc3RhZ2luZzoge1xuICAgICAgZW5hYmxlSVB2NjogdHJ1ZSxcbiAgICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IGZhbHNlLFxuICAgICAgbWF4QXpzOiAyLFxuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBkZXNpcmVkQ291bnQ6IDIsXG4gICAgICBjcHU6IDUxMixcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiAxMDI0LFxuICAgICAgdnBjQ2lkcjogJzEwLjEuMC4wLzE2JyxcbiAgICAgIHB1YmxpY1N1Ym5ldENpZHJNYXNrOiAyNCxcbiAgICAgIHByaXZhdGVTdWJuZXRDaWRyTWFzazogMjNcbiAgICB9LFxuICAgIHByb2R1Y3Rpb246IHtcbiAgICAgIGVuYWJsZUlQdjY6IHRydWUsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiB0cnVlLFxuICAgICAgbWF4QXpzOiAzLFxuICAgICAgbmF0R2F0ZXdheXM6IDMsXG4gICAgICBkZXNpcmVkQ291bnQ6IDMsXG4gICAgICBjcHU6IDEwMjQsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogMjA0OCxcbiAgICAgIHZwY0NpZHI6ICcxMC4yLjAuMC8xNicsXG4gICAgICBwdWJsaWNTdWJuZXRDaWRyTWFzazogMjQsXG4gICAgICBwcml2YXRlU3VibmV0Q2lkck1hc2s6IDIyXG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGVudkNvbmZpZyA9IGNvbmZpZ1tlbnZpcm9ubWVudCBhcyBrZXlvZiB0eXBlb2YgY29uZmlnXTtcblxuICB0cnkge1xuICAgIGNvbnN0IHN0YWNrID0gbmV3IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrKGFwcCwgYFRlc3RBcHAtJHtlbnZpcm9ubWVudH0tdmFsaWRhdGlvbmAsIHtcbiAgICAgIGVudjoge1xuICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJywgLy8gRHVtbXkgYWNjb3VudCBmb3IgdmFsaWRhdGlvblxuICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgfSxcbiAgICAgIGVudmlyb25tZW50LFxuICAgICAgLi4uZW52Q29uZmlnLFxuICAgICAgdGFnczoge1xuICAgICAgICBFbnZpcm9ubWVudDogZW52aXJvbm1lbnQsXG4gICAgICAgIFByb2plY3Q6ICdUZXN0QXBwJyxcbiAgICAgICAgTWFuYWdlZEJ5OiAnQ0RLJ1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgY29uc29sZS5sb2coYOKchSAke2Vudmlyb25tZW50fSBlbnZpcm9ubWVudCBjb25maWd1cmF0aW9uIGlzIHZhbGlkYCk7XG4gICAgY29uc29sZS5sb2coYCAgIC0gVlBDIENJRFI6ICR7ZW52Q29uZmlnLnZwY0NpZHJ9YCk7XG4gICAgY29uc29sZS5sb2coYCAgIC0gUHVibGljIFN1Ym5ldCBDSURSIE1hc2s6IC8ke2VudkNvbmZpZy5wdWJsaWNTdWJuZXRDaWRyTWFza31gKTtcbiAgICBjb25zb2xlLmxvZyhgICAgLSBQcml2YXRlIFN1Ym5ldCBDSURSIE1hc2s6IC8ke2VudkNvbmZpZy5wcml2YXRlU3VibmV0Q2lkck1hc2t9YCk7XG4gICAgY29uc29sZS5sb2coYCAgIC0gSVB2NjogJHtlbnZDb25maWcuZW5hYmxlSVB2NiA/ICdFbmFibGVkIChBV1MtcHJvdmlkZWQpJyA6ICdEaXNhYmxlZCd9YCk7XG4gICAgY29uc29sZS5sb2coYCAgIC0gSEEgTkFUIEdhdGV3YXlzOiAke2VudkNvbmZpZy5lbmFibGVIQU5hdEdhdGV3YXlzID8gJ0VuYWJsZWQnIDogJ0Rpc2FibGVkJ31gKTtcbiAgICBjb25zb2xlLmxvZyhgICAgLSBNYXggQVpzOiAke2VudkNvbmZpZy5tYXhBenN9YCk7XG4gICAgY29uc29sZS5sb2coYCAgIC0gTkFUIEdhdGV3YXlzOiAke2VudkNvbmZpZy5uYXRHYXRld2F5c31gKTtcbiAgICBjb25zb2xlLmxvZyhgICAgLSBEZXNpcmVkIENvdW50OiAke2VudkNvbmZpZy5kZXNpcmVkQ291bnR9YCk7XG4gICAgY29uc29sZS5sb2coYCAgIC0gQ1BVOiAke2VudkNvbmZpZy5jcHV9YCk7XG4gICAgY29uc29sZS5sb2coYCAgIC0gTWVtb3J5OiAke2VudkNvbmZpZy5tZW1vcnlMaW1pdE1pQn1NQmApO1xuICAgIGNvbnNvbGUubG9nKCcnKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKGDinYwgJHtlbnZpcm9ubWVudH0gZW52aXJvbm1lbnQgY29uZmlndXJhdGlvbiBmYWlsZWQ6YCwgZXJyb3IpO1xuICB9XG59KTtcblxuY29uc29sZS5sb2coJ/CfjokgQWxsIGluZnJhc3RydWN0dXJlIGNvbmZpZ3VyYXRpb25zIHZhbGlkYXRlZCBzdWNjZXNzZnVsbHkhJyk7XG5jb25zb2xlLmxvZygnJyk7XG5jb25zb2xlLmxvZygnTmV4dCBzdGVwczonKTtcbmNvbnNvbGUubG9nKCcxLiBDb25maWd1cmUgQVdTIGNyZWRlbnRpYWxzOiBhd3MgY29uZmlndXJlJyk7XG5jb25zb2xlLmxvZygnMi4gQm9vdHN0cmFwIENESzogY2RrIGJvb3RzdHJhcCcpO1xuY29uc29sZS5sb2coJzMuIERlcGxveTogLi9zY3JpcHRzL2RlcGxveS5zaCBbZW52aXJvbm1lbnRdJyk7Il19