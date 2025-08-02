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
        // Security enhancements (disabled by default)
        enableWAF: false,
        enableVPCFlowLogs: false,
        enableHTTPS: false,
        domainName: undefined,
        // Container security (disabled by default)
        enableNonRootContainer: false,
        enableReadOnlyRootFilesystem: false,
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
        privateSubnetCidrMask: 22,
        // IPv6 will use Amazon-provided block
        // To use custom IPv6: ipv6CidrBlock: '2001:0db8::/56'
        // Security enhancements (disabled by default - enable as needed)
        enableWAF: false,
        enableVPCFlowLogs: false,
        enableHTTPS: false,
        domainName: undefined,
        // Container security (disabled by default - enable as needed)
        enableNonRootContainer: false,
        enableReadOnlyRootFilesystem: false, // Set to true for read-only root filesystem
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdGFwcC1pbmZyYXN0cnVjdHVyZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInRlc3RhcHAtaW5mcmFzdHJ1Y3R1cmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQ0EsdUNBQXFDO0FBQ3JDLG1DQUFtQztBQUNuQyxzRkFBaUY7QUFFakYsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7QUFFMUIsbURBQW1EO0FBQ25ELE1BQU0sV0FBVyxHQUFHLEdBQUcsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLGFBQWEsQ0FBQyxJQUFJLEtBQUssQ0FBQztBQUVuRSxxQ0FBcUM7QUFDckMsTUFBTSxNQUFNLEdBQUc7SUFDYixHQUFHLEVBQUU7UUFDSCxVQUFVLEVBQUUsS0FBSztRQUNqQixtQkFBbUIsRUFBRSxLQUFLO1FBQzFCLE1BQU0sRUFBRSxDQUFDO1FBQ1QsV0FBVyxFQUFFLENBQUM7UUFDZCxZQUFZLEVBQUUsQ0FBQztRQUNmLEdBQUcsRUFBRSxHQUFHO1FBQ1IsY0FBYyxFQUFFLEdBQUc7UUFDbkIsd0JBQXdCO1FBQ3hCLE9BQU8sRUFBRSxhQUFhO1FBQ3RCLG9CQUFvQixFQUFFLEVBQUU7UUFDeEIscUJBQXFCLEVBQUUsRUFBRTtRQUN6Qiw4QkFBOEI7UUFDOUIsOENBQThDO1FBQzlDLFNBQVMsRUFBRSxLQUFLO1FBQ2hCLGlCQUFpQixFQUFFLEtBQUs7UUFDeEIsV0FBVyxFQUFFLEtBQUs7UUFDbEIsVUFBVSxFQUFFLFNBQVM7UUFDckIsMkNBQTJDO1FBQzNDLHNCQUFzQixFQUFFLEtBQUs7UUFDN0IsNEJBQTRCLEVBQUUsS0FBSztLQUNwQztJQUNELFVBQVUsRUFBRTtRQUNWLFVBQVUsRUFBRSxJQUFJO1FBQ2hCLG1CQUFtQixFQUFFLElBQUk7UUFDekIsTUFBTSxFQUFFLENBQUM7UUFDVCxXQUFXLEVBQUUsQ0FBQztRQUNkLFlBQVksRUFBRSxDQUFDO1FBQ2YsR0FBRyxFQUFFLElBQUk7UUFDVCxjQUFjLEVBQUUsSUFBSTtRQUNwQix3QkFBd0I7UUFDeEIsT0FBTyxFQUFFLGFBQWE7UUFDdEIsb0JBQW9CLEVBQUUsRUFBRTtRQUN4QixxQkFBcUIsRUFBRSxFQUFFO1FBQ3pCLHNDQUFzQztRQUN0QyxzREFBc0Q7UUFDdEQsaUVBQWlFO1FBQ2pFLFNBQVMsRUFBRSxLQUFLO1FBQ2hCLGlCQUFpQixFQUFFLEtBQUs7UUFDeEIsV0FBVyxFQUFFLEtBQUs7UUFDbEIsVUFBVSxFQUFFLFNBQVM7UUFDckIsOERBQThEO1FBQzlELHNCQUFzQixFQUFFLEtBQUs7UUFDN0IsNEJBQTRCLEVBQUUsS0FBSyxFQUFFLDRDQUE0QztLQUNsRjtDQUNGLENBQUM7QUFFRixNQUFNLFNBQVMsR0FBRyxNQUFNLENBQUMsV0FBa0MsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxHQUFHLENBQUM7QUFFM0UsSUFBSSx5REFBMEIsQ0FBQyxHQUFHLEVBQUUsV0FBVyxXQUFXLEVBQUUsRUFBRTtJQUM1RCxHQUFHLEVBQUU7UUFDSCxPQUFPLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxtQkFBbUI7UUFDeEMsTUFBTSxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsa0JBQWtCO0tBQ3ZDO0lBQ0QsV0FBVztJQUNYLEdBQUcsU0FBUztJQUNaLElBQUksRUFBRTtRQUNKLFdBQVcsRUFBRSxXQUFXO1FBQ3hCLE9BQU8sRUFBRSxTQUFTO1FBQ2xCLFNBQVMsRUFBRSxLQUFLO0tBQ2pCO0NBQ0YsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiIyEvdXNyL2Jpbi9lbnYgbm9kZVxuaW1wb3J0ICdzb3VyY2UtbWFwLXN1cHBvcnQvcmVnaXN0ZXInO1xuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrIH0gZnJvbSAnLi4vbGliL3Rlc3RhcHAtaW5mcmFzdHJ1Y3R1cmUtc3RhY2snO1xuXG5jb25zdCBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuXG4vLyBHZXQgZW52aXJvbm1lbnQgZnJvbSBjb250ZXh0IG9yIGRlZmF1bHQgdG8gJ2RldidcbmNvbnN0IGVudmlyb25tZW50ID0gYXBwLm5vZGUudHJ5R2V0Q29udGV4dCgnZW52aXJvbm1lbnQnKSB8fCAnZGV2JztcblxuLy8gRW52aXJvbm1lbnQtc3BlY2lmaWMgY29uZmlndXJhdGlvblxuY29uc3QgY29uZmlnID0ge1xuICBkZXY6IHtcbiAgICBlbmFibGVJUHY2OiBmYWxzZSxcbiAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICBtYXhBenM6IDIsXG4gICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgZGVzaXJlZENvdW50OiAxLFxuICAgIGNwdTogMjU2LFxuICAgIG1lbW9yeUxpbWl0TWlCOiA1MTIsXG4gICAgLy8gTmV0d29yayBjb25maWd1cmF0aW9uXG4gICAgdnBjQ2lkcjogJzEwLjAuMC4wLzE2JyxcbiAgICBwdWJsaWNTdWJuZXRDaWRyTWFzazogMjQsICAvLyAvMjQgPSAyNTQgSVBzIHBlciBzdWJuZXRcbiAgICBwcml2YXRlU3VibmV0Q2lkck1hc2s6IDI0LFxuICAgIC8vIElQdjYgbm90IGNvbmZpZ3VyZWQgZm9yIGRldlxuICAgIC8vIFNlY3VyaXR5IGVuaGFuY2VtZW50cyAoZGlzYWJsZWQgYnkgZGVmYXVsdClcbiAgICBlbmFibGVXQUY6IGZhbHNlLFxuICAgIGVuYWJsZVZQQ0Zsb3dMb2dzOiBmYWxzZSxcbiAgICBlbmFibGVIVFRQUzogZmFsc2UsXG4gICAgZG9tYWluTmFtZTogdW5kZWZpbmVkLCAvLyBTZXQgdG8geW91ciBkb21haW4gbmFtZSB3aGVuIGVuYWJsaW5nIEhUVFBTXG4gICAgLy8gQ29udGFpbmVyIHNlY3VyaXR5IChkaXNhYmxlZCBieSBkZWZhdWx0KVxuICAgIGVuYWJsZU5vblJvb3RDb250YWluZXI6IGZhbHNlLFxuICAgIGVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW06IGZhbHNlLFxuICB9LFxuICBwcm9kdWN0aW9uOiB7XG4gICAgZW5hYmxlSVB2NjogdHJ1ZSxcbiAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiB0cnVlLFxuICAgIG1heEF6czogMyxcbiAgICBuYXRHYXRld2F5czogMywgLy8gSEEgTkFUIEdhdGV3YXlzIC0gb25lIHBlciBBWlxuICAgIGRlc2lyZWRDb3VudDogMyxcbiAgICBjcHU6IDEwMjQsXG4gICAgbWVtb3J5TGltaXRNaUI6IDIwNDgsXG4gICAgLy8gTmV0d29yayBjb25maWd1cmF0aW9uXG4gICAgdnBjQ2lkcjogJzEwLjIuMC4wLzE2JyxcbiAgICBwdWJsaWNTdWJuZXRDaWRyTWFzazogMjQsXG4gICAgcHJpdmF0ZVN1Ym5ldENpZHJNYXNrOiAyMiwgIC8vIC8yMiA9IDEwMjIgSVBzIHBlciBzdWJuZXQgZm9yIG1heGltdW0gc2NhbGFiaWxpdHlcbiAgICAvLyBJUHY2IHdpbGwgdXNlIEFtYXpvbi1wcm92aWRlZCBibG9ja1xuICAgIC8vIFRvIHVzZSBjdXN0b20gSVB2NjogaXB2NkNpZHJCbG9jazogJzIwMDE6MGRiODo6LzU2J1xuICAgIC8vIFNlY3VyaXR5IGVuaGFuY2VtZW50cyAoZGlzYWJsZWQgYnkgZGVmYXVsdCAtIGVuYWJsZSBhcyBuZWVkZWQpXG4gICAgZW5hYmxlV0FGOiBmYWxzZSwgLy8gU2V0IHRvIHRydWUgdG8gZW5hYmxlIFdBRiBwcm90ZWN0aW9uXG4gICAgZW5hYmxlVlBDRmxvd0xvZ3M6IGZhbHNlLCAvLyBTZXQgdG8gdHJ1ZSB0byBlbmFibGUgVlBDIGZsb3cgbG9nc1xuICAgIGVuYWJsZUhUVFBTOiBmYWxzZSwgLy8gU2V0IHRvIHRydWUgdG8gZW5hYmxlIEhUVFBTL1RMU1xuICAgIGRvbWFpbk5hbWU6IHVuZGVmaW5lZCwgLy8gU2V0IHRvIHlvdXIgZG9tYWluIG5hbWUgd2hlbiBlbmFibGluZyBIVFRQUzogJ2V4YW1wbGUuY29tJ1xuICAgIC8vIENvbnRhaW5lciBzZWN1cml0eSAoZGlzYWJsZWQgYnkgZGVmYXVsdCAtIGVuYWJsZSBhcyBuZWVkZWQpXG4gICAgZW5hYmxlTm9uUm9vdENvbnRhaW5lcjogZmFsc2UsIC8vIFNldCB0byB0cnVlIGZvciBub24tcm9vdCBjb250YWluZXIgc2VjdXJpdHlcbiAgICBlbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtOiBmYWxzZSwgLy8gU2V0IHRvIHRydWUgZm9yIHJlYWQtb25seSByb290IGZpbGVzeXN0ZW1cbiAgfVxufTtcblxuY29uc3QgZW52Q29uZmlnID0gY29uZmlnW2Vudmlyb25tZW50IGFzIGtleW9mIHR5cGVvZiBjb25maWddIHx8IGNvbmZpZy5kZXY7XG5cbm5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsIGBUZXN0QXBwLSR7ZW52aXJvbm1lbnR9YCwge1xuICBlbnY6IHtcbiAgICBhY2NvdW50OiBwcm9jZXNzLmVudi5DREtfREVGQVVMVF9BQ0NPVU5ULFxuICAgIHJlZ2lvbjogcHJvY2Vzcy5lbnYuQ0RLX0RFRkFVTFRfUkVHSU9OLFxuICB9LFxuICBlbnZpcm9ubWVudCxcbiAgLi4uZW52Q29uZmlnLFxuICB0YWdzOiB7XG4gICAgRW52aXJvbm1lbnQ6IGVudmlyb25tZW50LFxuICAgIFByb2plY3Q6ICdUZXN0QXBwJyxcbiAgICBNYW5hZ2VkQnk6ICdDREsnXG4gIH1cbn0pOyJdfQ==