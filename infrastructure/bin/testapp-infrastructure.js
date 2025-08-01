#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("source-map-support/register");
const cdk = require("aws-cdk-lib");
const testapp_infrastructure_stack_1 = require("../lib/testapp-infrastructure-stack");
const app = new cdk.App();
// Get environment from context or default to 'dev'
const environment = app.node.tryGetContext('environment') || 'dev';
// Environment-specific configuration
const config = {
    dev: {
        enableIPv6: false,
        enableHANatGateways: false,
        maxAzs: 2,
        natGateways: 1,
        desiredCount: 1,
        cpu: 256,
        memoryLimitMiB: 512,
        // Network configuration
        vpcCidr: '10.0.0.0/16',
        publicSubnetCidrMask: 24,
        privateSubnetCidrMask: 24,
        // IPv6 not configured for dev
    },
    production: {
        enableIPv6: true,
        enableHANatGateways: true,
        maxAzs: 3,
        natGateways: 3,
        desiredCount: 3,
        cpu: 1024,
        memoryLimitMiB: 2048,
        // Network configuration
        vpcCidr: '10.2.0.0/16',
        publicSubnetCidrMask: 24,
        privateSubnetCidrMask: 22, // /22 = 1022 IPs per subnet for maximum scalability
        // IPv6 will use Amazon-provided block
        // To use custom IPv6: ipv6CidrBlock: '2001:0db8::/56'
    }
};
const envConfig = config[environment] || config.dev;
new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, `TestApp-${environment}`, {
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
    },
    environment,
    ...envConfig,
    tags: {
        Environment: environment,
        Project: 'TestApp',
        ManagedBy: 'CDK'
    }
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdGFwcC1pbmZyYXN0cnVjdHVyZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInRlc3RhcHAtaW5mcmFzdHJ1Y3R1cmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQ0EsdUNBQXFDO0FBQ3JDLG1DQUFtQztBQUNuQyxzRkFBaUY7QUFFakYsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7QUFFMUIsbURBQW1EO0FBQ25ELE1BQU0sV0FBVyxHQUFHLEdBQUcsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLGFBQWEsQ0FBQyxJQUFJLEtBQUssQ0FBQztBQUVuRSxxQ0FBcUM7QUFDckMsTUFBTSxNQUFNLEdBQUc7SUFDYixHQUFHLEVBQUU7UUFDSCxVQUFVLEVBQUUsS0FBSztRQUNqQixtQkFBbUIsRUFBRSxLQUFLO1FBQzFCLE1BQU0sRUFBRSxDQUFDO1FBQ1QsV0FBVyxFQUFFLENBQUM7UUFDZCxZQUFZLEVBQUUsQ0FBQztRQUNmLEdBQUcsRUFBRSxHQUFHO1FBQ1IsY0FBYyxFQUFFLEdBQUc7UUFDbkIsd0JBQXdCO1FBQ3hCLE9BQU8sRUFBRSxhQUFhO1FBQ3RCLG9CQUFvQixFQUFFLEVBQUU7UUFDeEIscUJBQXFCLEVBQUUsRUFBRTtRQUN6Qiw4QkFBOEI7S0FDL0I7SUFDRCxVQUFVLEVBQUU7UUFDVixVQUFVLEVBQUUsSUFBSTtRQUNoQixtQkFBbUIsRUFBRSxJQUFJO1FBQ3pCLE1BQU0sRUFBRSxDQUFDO1FBQ1QsV0FBVyxFQUFFLENBQUM7UUFDZCxZQUFZLEVBQUUsQ0FBQztRQUNmLEdBQUcsRUFBRSxJQUFJO1FBQ1QsY0FBYyxFQUFFLElBQUk7UUFDcEIsd0JBQXdCO1FBQ3hCLE9BQU8sRUFBRSxhQUFhO1FBQ3RCLG9CQUFvQixFQUFFLEVBQUU7UUFDeEIscUJBQXFCLEVBQUUsRUFBRSxFQUFHLG9EQUFvRDtRQUNoRixzQ0FBc0M7UUFDdEMsc0RBQXNEO0tBQ3ZEO0NBQ0YsQ0FBQztBQUVGLE1BQU0sU0FBUyxHQUFHLE1BQU0sQ0FBQyxXQUFrQyxDQUFDLElBQUksTUFBTSxDQUFDLEdBQUcsQ0FBQztBQUUzRSxJQUFJLHlEQUEwQixDQUFDLEdBQUcsRUFBRSxXQUFXLFdBQVcsRUFBRSxFQUFFO0lBQzVELEdBQUcsRUFBRTtRQUNILE9BQU8sRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLG1CQUFtQjtRQUN4QyxNQUFNLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxrQkFBa0I7S0FDdkM7SUFDRCxXQUFXO0lBQ1gsR0FBRyxTQUFTO0lBQ1osSUFBSSxFQUFFO1FBQ0osV0FBVyxFQUFFLFdBQVc7UUFDeEIsT0FBTyxFQUFFLFNBQVM7UUFDbEIsU0FBUyxFQUFFLEtBQUs7S0FDakI7Q0FDRixDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIjIS91c3IvYmluL2VudiBub2RlXG5pbXBvcnQgJ3NvdXJjZS1tYXAtc3VwcG9ydC9yZWdpc3Rlcic7XG5pbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2sgfSBmcm9tICcuLi9saWIvdGVzdGFwcC1pbmZyYXN0cnVjdHVyZS1zdGFjayc7XG5cbmNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG5cbi8vIEdldCBlbnZpcm9ubWVudCBmcm9tIGNvbnRleHQgb3IgZGVmYXVsdCB0byAnZGV2J1xuY29uc3QgZW52aXJvbm1lbnQgPSBhcHAubm9kZS50cnlHZXRDb250ZXh0KCdlbnZpcm9ubWVudCcpIHx8ICdkZXYnO1xuXG4vLyBFbnZpcm9ubWVudC1zcGVjaWZpYyBjb25maWd1cmF0aW9uXG5jb25zdCBjb25maWcgPSB7XG4gIGRldjoge1xuICAgIGVuYWJsZUlQdjY6IGZhbHNlLFxuICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IGZhbHNlLFxuICAgIG1heEF6czogMixcbiAgICBuYXRHYXRld2F5czogMSxcbiAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgY3B1OiAyNTYsXG4gICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICAvLyBOZXR3b3JrIGNvbmZpZ3VyYXRpb25cbiAgICB2cGNDaWRyOiAnMTAuMC4wLjAvMTYnLFxuICAgIHB1YmxpY1N1Ym5ldENpZHJNYXNrOiAyNCwgIC8vIC8yNCA9IDI1NCBJUHMgcGVyIHN1Ym5ldFxuICAgIHByaXZhdGVTdWJuZXRDaWRyTWFzazogMjQsXG4gICAgLy8gSVB2NiBub3QgY29uZmlndXJlZCBmb3IgZGV2XG4gIH0sXG4gIHByb2R1Y3Rpb246IHtcbiAgICBlbmFibGVJUHY2OiB0cnVlLFxuICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IHRydWUsXG4gICAgbWF4QXpzOiAzLFxuICAgIG5hdEdhdGV3YXlzOiAzLCAvLyBIQSBOQVQgR2F0ZXdheXMgLSBvbmUgcGVyIEFaXG4gICAgZGVzaXJlZENvdW50OiAzLFxuICAgIGNwdTogMTAyNCxcbiAgICBtZW1vcnlMaW1pdE1pQjogMjA0OCxcbiAgICAvLyBOZXR3b3JrIGNvbmZpZ3VyYXRpb25cbiAgICB2cGNDaWRyOiAnMTAuMi4wLjAvMTYnLFxuICAgIHB1YmxpY1N1Ym5ldENpZHJNYXNrOiAyNCxcbiAgICBwcml2YXRlU3VibmV0Q2lkck1hc2s6IDIyLCAgLy8gLzIyID0gMTAyMiBJUHMgcGVyIHN1Ym5ldCBmb3IgbWF4aW11bSBzY2FsYWJpbGl0eVxuICAgIC8vIElQdjYgd2lsbCB1c2UgQW1hem9uLXByb3ZpZGVkIGJsb2NrXG4gICAgLy8gVG8gdXNlIGN1c3RvbSBJUHY2OiBpcHY2Q2lkckJsb2NrOiAnMjAwMTowZGI4OjovNTYnXG4gIH1cbn07XG5cbmNvbnN0IGVudkNvbmZpZyA9IGNvbmZpZ1tlbnZpcm9ubWVudCBhcyBrZXlvZiB0eXBlb2YgY29uZmlnXSB8fCBjb25maWcuZGV2O1xuXG5uZXcgVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2soYXBwLCBgVGVzdEFwcC0ke2Vudmlyb25tZW50fWAsIHtcbiAgZW52OiB7XG4gICAgYWNjb3VudDogcHJvY2Vzcy5lbnYuQ0RLX0RFRkFVTFRfQUNDT1VOVCxcbiAgICByZWdpb246IHByb2Nlc3MuZW52LkNES19ERUZBVUxUX1JFR0lPTixcbiAgfSxcbiAgZW52aXJvbm1lbnQsXG4gIC4uLmVudkNvbmZpZyxcbiAgdGFnczoge1xuICAgIEVudmlyb25tZW50OiBlbnZpcm9ubWVudCxcbiAgICBQcm9qZWN0OiAnVGVzdEFwcCcsXG4gICAgTWFuYWdlZEJ5OiAnQ0RLJ1xuICB9XG59KTsiXX0=