"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecretsLoader = void 0;
const fs = require("fs");
const path = require("path");
const child_process_1 = require("child_process");
const yaml = require("js-yaml");
class SecretsLoader {
    constructor(environment) {
        this.environment = environment;
        this.projectRoot = path.resolve(__dirname, '../..');
    }
    /**
     * Load and decrypt secrets for the specified environment
     */
    loadSecrets() {
        const secretsFile = path.join(this.projectRoot, 'secrets', this.environment, 'secrets.enc.yaml');
        if (!fs.existsSync(secretsFile)) {
            throw new Error(`Secrets file not found: ${secretsFile}`);
        }
        try {
            // Check if SOPS is available
            (0, child_process_1.execSync)('which sops', { stdio: 'pipe' });
            // Decrypt the secrets file using SOPS
            const decryptedContent = (0, child_process_1.execSync)(`sops -d "${secretsFile}"`, {
                encoding: 'utf8',
                cwd: this.projectRoot
            });
            // Parse the YAML content
            const secrets = yaml.load(decryptedContent);
            // Validate the structure
            this.validateSecrets(secrets);
            return secrets;
        }
        catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('sops')) {
                    console.warn(`SOPS not available or secrets not encrypted. Using plaintext secrets for ${this.environment}`);
                    // Fallback to reading plaintext file
                    const content = fs.readFileSync(secretsFile, 'utf8');
                    const secrets = yaml.load(content);
                    this.validateSecrets(secrets);
                    return secrets;
                }
            }
            throw new Error(`Failed to load secrets for environment ${this.environment}: ${error}`);
        }
    }
    /**
     * Load secrets with fallback to environment variables
     */
    loadSecretsWithFallback() {
        try {
            return this.loadSecrets();
        }
        catch (error) {
            console.warn(`Failed to load SOPS secrets, using environment variables fallback: ${error}`);
            console.warn('This is expected in CI/CD environments where KMS access may not be configured');
            // Fallback to environment variables
            return {
                secret_key: process.env.SECRET_KEY || 'default-secret',
                jwt_secret: process.env.JWT_SECRET || 'default-jwt-secret',
                required_setting: process.env.REQUIRED_SETTING || this.environment,
                api_key: process.env.API_KEY || '',
                webhook_secret: process.env.WEBHOOK_SECRET || '',
                datadog_api_key: process.env.DATADOG_API_KEY || '',
                sentry_dsn: process.env.SENTRY_DSN || '',
            };
        }
    }
    /**
     * Get a specific secret value by path (e.g., 'database.password')
     */
    getSecret(secretPath) {
        const secrets = this.loadSecretsWithFallback();
        const pathParts = secretPath.split('.');
        let value = secrets;
        for (const part of pathParts) {
            value = value?.[part];
        }
        if (typeof value !== 'string') {
            throw new Error(`Secret not found or not a string: ${secretPath}`);
        }
        return value;
    }
    /**
     * Export secrets as environment variables format
     */
    exportAsEnvVars() {
        const secrets = this.loadSecretsWithFallback();
        const envVars = {};
        // Flatten the secrets object
        const flatten = (obj, prefix = '') => {
            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    const value = obj[key];
                    const envKey = prefix ? `${prefix}_${key.toUpperCase()}` : key.toUpperCase();
                    if (typeof value === 'object' && value !== null) {
                        flatten(value, envKey);
                    }
                    else {
                        envVars[envKey] = String(value);
                    }
                }
            }
        };
        flatten(secrets);
        return envVars;
    }
    validateSecrets(secrets) {
        const requiredPaths = [
            'secret_key',
            'required_setting'
        ];
        for (const path of requiredPaths) {
            const pathParts = path.split('.');
            let value = secrets;
            for (const part of pathParts) {
                value = value?.[part];
            }
            if (!value) {
                throw new Error(`Required secret missing: ${path}`);
            }
        }
    }
    /**
     * Check if running in CI/CD environment
     */
    static isCI() {
        return !!(process.env.CI || process.env.GITHUB_ACTIONS || process.env.JENKINS_URL);
    }
    /**
     * Create secrets loader for current environment
     */
    static forEnvironment(environment) {
        const env = environment || process.env.NODE_ENV || process.env.ENVIRONMENT || 'dev';
        return new SecretsLoader(env);
    }
}
exports.SecretsLoader = SecretsLoader;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VjcmV0cy1sb2FkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzZWNyZXRzLWxvYWRlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSx5QkFBeUI7QUFDekIsNkJBQTZCO0FBQzdCLGlEQUF5QztBQUN6QyxnQ0FBZ0M7QUFZaEMsTUFBYSxhQUFhO0lBSXhCLFlBQVksV0FBbUI7UUFDN0IsSUFBSSxDQUFDLFdBQVcsR0FBRyxXQUFXLENBQUM7UUFDL0IsSUFBSSxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUMsT0FBTyxDQUFDLFNBQVMsRUFBRSxPQUFPLENBQUMsQ0FBQztJQUN0RCxDQUFDO0lBRUQ7O09BRUc7SUFDSSxXQUFXO1FBQ2hCLE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFdBQVcsRUFBRSxTQUFTLEVBQUUsSUFBSSxDQUFDLFdBQVcsRUFBRSxrQkFBa0IsQ0FBQyxDQUFDO1FBRWpHLElBQUksQ0FBQyxFQUFFLENBQUMsVUFBVSxDQUFDLFdBQVcsQ0FBQyxFQUFFO1lBQy9CLE1BQU0sSUFBSSxLQUFLLENBQUMsMkJBQTJCLFdBQVcsRUFBRSxDQUFDLENBQUM7U0FDM0Q7UUFFRCxJQUFJO1lBQ0YsNkJBQTZCO1lBQzdCLElBQUEsd0JBQVEsRUFBQyxZQUFZLEVBQUUsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQztZQUUxQyxzQ0FBc0M7WUFDdEMsTUFBTSxnQkFBZ0IsR0FBRyxJQUFBLHdCQUFRLEVBQUMsWUFBWSxXQUFXLEdBQUcsRUFBRTtnQkFDNUQsUUFBUSxFQUFFLE1BQU07Z0JBQ2hCLEdBQUcsRUFBRSxJQUFJLENBQUMsV0FBVzthQUN0QixDQUFDLENBQUM7WUFFSCx5QkFBeUI7WUFDekIsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBa0IsQ0FBQztZQUU3RCx5QkFBeUI7WUFDekIsSUFBSSxDQUFDLGVBQWUsQ0FBQyxPQUFP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QUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsV0FBVyxDQUFDLENBQUM7SUFDckYsQ0FBQztJQUVEOztPQUVHO0lBQ0ksTUFBTSxDQUFDLGNBQWMsQ0FBQyxXQUFvQjtRQUMvQyxNQUFNLEdBQUcsR0FBRyxXQUFXLElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxRQUFRLElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxXQUFXLElBQUksS0FBSyxDQUFDO1FBQ3BGLE9BQU8sSUFBSSxhQUFhLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDaEMsQ0FBQztDQUNGO0FBMUpELHNDQTBKQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGZzIGZyb20gJ2ZzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBleGVjU3luYyB9IGZyb20gJ2NoaWxkX3Byb2Nlc3MnO1xuaW1wb3J0ICogYXMgeWFtbCBmcm9tICdqcy15YW1sJztcblxuZXhwb3J0IGludGVyZmFjZSBTZWNyZXRzQ29uZmlnIHtcbiAgc2VjcmV0X2tleTogc3RyaW5nO1xuICBqd3Rfc2VjcmV0OiBzdHJpbmc7XG4gIHJlcXVpcmVkX3NldHRpbmc6IHN0cmluZztcbiAgYXBpX2tleTogc3RyaW5nO1xuICB3ZWJob29rX3NlY3JldDogc3RyaW5nO1xuICBkYXRhZG9nX2FwaV9rZXk6IHN0cmluZztcbiAgc2VudHJ5X2Rzbjogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgU2VjcmV0c0xvYWRlciB7XG4gIHByaXZhdGUgZW52aXJvbm1lbnQ6IHN0cmluZztcbiAgcHJpdmF0ZSBwcm9qZWN0Um9vdDogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKGVudmlyb25tZW50OiBzdHJpbmcpIHtcbiAgICB0aGlzLmVudmlyb25tZW50ID0gZW52aXJvbm1lbnQ7XG4gICAgdGhpcy5wcm9qZWN0Um9vdCA9IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsICcuLi8uLicpO1xuICB9XG5cbiAgLyoqXG4gICAqIExvYWQgYW5kIGRlY3J5cHQgc2VjcmV0cyBmb3IgdGhlIHNwZWNpZmllZCBlbnZpcm9ubWVudFxuICAgKi9cbiAgcHVibGljIGxvYWRTZWNyZXRzKCk6IFNlY3JldHNDb25maWcge1xuICAgIGNvbnN0IHNlY3JldHNGaWxlID0gcGF0aC5qb2luKHRoaXMucHJvamVjdFJvb3QsICdzZWNyZXRzJywgdGhpcy5lbnZpcm9ubWVudCwgJ3NlY3JldHMuZW5jLnlhbWwnKTtcbiAgICBcbiAgICBpZiAoIWZzLmV4aXN0c1N5bmMoc2VjcmV0c0ZpbGUpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFNlY3JldHMgZmlsZSBub3QgZm91bmQ6ICR7c2VjcmV0c0ZpbGV9YCk7XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIC8vIENoZWNrIGlmIFNPUFMgaXMgYXZhaWxhYmxlXG4gICAgICBleGVjU3luYygnd2hpY2ggc29wcycsIHsgc3RkaW86ICdwaXBlJyB9KTtcbiAgICAgIFxuICAgICAgLy8gRGVjcnlwdCB0aGUgc2VjcmV0cyBmaWxlIHVzaW5nIFNPUFNcbiAgICAgIGNvbnN0IGRlY3J5cHRlZENvbnRlbnQgPSBleGVjU3luYyhgc29wcyAtZCBcIiR7c2VjcmV0c0ZpbGV9XCJgLCB7IFxuICAgICAgICBlbmNvZGluZzogJ3V0ZjgnLFxuICAgICAgICBjd2Q6IHRoaXMucHJvamVjdFJvb3QgXG4gICAgICB9KTtcbiAgICAgIFxuICAgICAgLy8gUGFyc2UgdGhlIFlBTUwgY29udGVudFxuICAgICAgY29uc3Qgc2VjcmV0cyA9IHlhbWwubG9hZChkZWNyeXB0ZWRDb250ZW50KSBhcyBTZWNyZXRzQ29uZmlnO1xuICAgICAgXG4gICAgICAvLyBWYWxpZGF0ZSB0aGUgc3RydWN0dXJlXG4gICAgICB0aGlzLnZhbGlkYXRlU2VjcmV0cyhzZWNyZXRzKTtcbiAgICAgIFxuICAgICAgcmV0dXJuIHNlY3JldHM7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yKSB7XG4gICAgICAgIGlmIChlcnJvci5tZXNzYWdlLmluY2x1ZGVzKCdzb3BzJykpIHtcbiAgICAgICAgICBjb25zb2xlLndhcm4oYFNPUFMgbm90IGF2YWlsYWJsZSBvciBzZWNyZXRzIG5vdCBlbmNyeXB0ZWQuIFVzaW5nIHBsYWludGV4dCBzZWNyZXRzIGZvciAke3RoaXMuZW52aXJvbm1lbnR9YCk7XG4gICAgICAgICAgLy8gRmFsbGJhY2sgdG8gcmVhZGluZyBwbGFpbnRleHQgZmlsZVxuICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBmcy5yZWFkRmlsZVN5bmMoc2VjcmV0c0ZpbGUsICd1dGY4Jyk7XG4gICAgICAgICAgY29uc3Qgc2VjcmV0cyA9IHlhbWwubG9hZChjb250ZW50KSBhcyBTZWNyZXRzQ29uZmlnO1xuICAgICAgICAgIHRoaXMudmFsaWRhdGVTZWNyZXRzKHNlY3JldHMpO1xuICAgICAgICAgIHJldHVybiBzZWNyZXRzO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBsb2FkIHNlY3JldHMgZm9yIGVudmlyb25tZW50ICR7dGhpcy5lbnZpcm9ubWVudH06ICR7ZXJyb3J9YCk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIExvYWQgc2VjcmV0cyB3aXRoIGZhbGxiYWNrIHRvIGVudmlyb25tZW50IHZhcmlhYmxlc1xuICAgKi9cbiAgcHVibGljIGxvYWRTZWNyZXRzV2l0aEZhbGxiYWNrKCk6IFBhcnRpYWw8U2VjcmV0c0NvbmZpZz4ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gdGhpcy5sb2FkU2VjcmV0cygpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLndhcm4oYEZhaWxlZCB0byBsb2FkIFNPUFMgc2VjcmV0cywgdXNpbmcgZW52aXJvbm1lbnQgdmFyaWFibGVzIGZhbGxiYWNrOiAke2Vycm9yfWApO1xuICAgICAgY29uc29sZS53YXJuKCdUaGlzIGlzIGV4cGVjdGVkIGluIENJL0NEIGVudmlyb25tZW50cyB3aGVyZSBLTVMgYWNjZXNzIG1heSBub3QgYmUgY29uZmlndXJlZCcpO1xuICAgICAgXG4gICAgICAvLyBGYWxsYmFjayB0byBlbnZpcm9ubWVudCB2YXJpYWJsZXNcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHNlY3JldF9rZXk6IHByb2Nlc3MuZW52LlNFQ1JFVF9LRVkgfHwgJ2RlZmF1bHQtc2VjcmV0JyxcbiAgICAgICAgand0X3NlY3JldDogcHJvY2Vzcy5lbnYuSldUX1NFQ1JFVCB8fCAnZGVmYXVsdC1qd3Qtc2VjcmV0JyxcbiAgICAgICAgcmVxdWlyZWRfc2V0dGluZzogcHJvY2Vzcy5lbnYuUkVRVUlSRURfU0VUVElORyB8fCB0aGlzLmVudmlyb25tZW50LFxuICAgICAgICBhcGlfa2V5OiBwcm9jZXNzLmVudi5BUElfS0VZIHx8ICcnLFxuICAgICAgICB3ZWJob29rX3NlY3JldDogcHJvY2Vzcy5lbnYuV0VCSE9PS19TRUNSRVQgfHwgJycsXG4gICAgICAgIGRhdGFkb2dfYXBpX2tleTogcHJvY2Vzcy5lbnYuREFUQURPR19BUElfS0VZIHx8ICcnLFxuICAgICAgICBzZW50cnlfZHNuOiBwcm9jZXNzLmVudi5TRU5UUllfRFNOIHx8ICcnLFxuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogR2V0IGEgc3BlY2lmaWMgc2VjcmV0IHZhbHVlIGJ5IHBhdGggKGUuZy4sICdkYXRhYmFzZS5wYXNzd29yZCcpXG4gICAqL1xuICBwdWJsaWMgZ2V0U2VjcmV0KHNlY3JldFBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3Qgc2VjcmV0cyA9IHRoaXMubG9hZFNlY3JldHNXaXRoRmFsbGJhY2soKTtcbiAgICBjb25zdCBwYXRoUGFydHMgPSBzZWNyZXRQYXRoLnNwbGl0KCcuJyk7XG4gICAgXG4gICAgbGV0IHZhbHVlOiBhbnkgPSBzZWNyZXRzO1xuICAgIGZvciAoY29uc3QgcGFydCBvZiBwYXRoUGFydHMpIHtcbiAgICAgIHZhbHVlID0gdmFsdWU/LltwYXJ0XTtcbiAgICB9XG4gICAgXG4gICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gJ3N0cmluZycpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgU2VjcmV0IG5vdCBmb3VuZCBvciBub3QgYSBzdHJpbmc6ICR7c2VjcmV0UGF0aH1gKTtcbiAgICB9XG4gICAgXG4gICAgcmV0dXJuIHZhbHVlO1xuICB9XG5cbiAgLyoqXG4gICAqIEV4cG9ydCBzZWNyZXRzIGFzIGVudmlyb25tZW50IHZhcmlhYmxlcyBmb3JtYXRcbiAgICovXG4gIHB1YmxpYyBleHBvcnRBc0VudlZhcnMoKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gICAgY29uc3Qgc2VjcmV0cyA9IHRoaXMubG9hZFNlY3JldHNXaXRoRmFsbGJhY2soKTtcbiAgICBjb25zdCBlbnZWYXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG5cbiAgICAvLyBGbGF0dGVuIHRoZSBzZWNyZXRzIG9iamVjdFxuICAgIGNvbnN0IGZsYXR0ZW4gPSAob2JqOiBhbnksIHByZWZpeCA9ICcnKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IGtleSBpbiBvYmopIHtcbiAgICAgICAgaWYgKG9iai5oYXNPd25Qcm9wZXJ0eShrZXkpKSB7XG4gICAgICAgICAgY29uc3QgdmFsdWUgPSBvYmpba2V5XTtcbiAgICAgICAgICBjb25zdCBlbnZLZXkgPSBwcmVmaXggPyBgJHtwcmVmaXh9XyR7a2V5LnRvVXBwZXJDYXNlKCl9YCA6IGtleS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICAgIFxuICAgICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmIHZhbHVlICE9PSBudWxsKSB7XG4gICAgICAgICAgICBmbGF0dGVuKHZhbHVlLCBlbnZLZXkpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBlbnZWYXJzW2VudktleV0gPSBTdHJpbmcodmFsdWUpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH07XG5cbiAgICBmbGF0dGVuKHNlY3JldHMpO1xuICAgIHJldHVybiBlbnZWYXJzO1xuICB9XG5cbiAgcHJpdmF0ZSB2YWxpZGF0ZVNlY3JldHMoc2VjcmV0czogYW55KTogdm9pZCB7XG4gICAgY29uc3QgcmVxdWlyZWRQYXRocyA9IFtcbiAgICAgICdzZWNyZXRfa2V5JyxcbiAgICAgICdyZXF1aXJlZF9zZXR0aW5nJ1xuICAgIF07XG5cbiAgICBmb3IgKGNvbnN0IHBhdGggb2YgcmVxdWlyZWRQYXRocykge1xuICAgICAgY29uc3QgcGF0aFBhcnRzID0gcGF0aC5zcGxpdCgnLicpO1xuICAgICAgbGV0IHZhbHVlOiBhbnkgPSBzZWNyZXRzO1xuICAgICAgXG4gICAgICBmb3IgKGNvbnN0IHBhcnQgb2YgcGF0aFBhcnRzKSB7XG4gICAgICAgIHZhbHVlID0gdmFsdWU/LltwYXJ0XTtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgaWYgKCF2YWx1ZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlcXVpcmVkIHNlY3JldCBtaXNzaW5nOiAke3BhdGh9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIENoZWNrIGlmIHJ1bm5pbmcgaW4gQ0kvQ0QgZW52aXJvbm1lbnRcbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgaXNDSSgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gISEocHJvY2Vzcy5lbnYuQ0kgfHwgcHJvY2Vzcy5lbnYuR0lUSFVCX0FDVElPTlMgfHwgcHJvY2Vzcy5lbnYuSkVOS0lOU19VUkwpO1xuICB9XG5cbiAgLyoqXG4gICAqIENyZWF0ZSBzZWNyZXRzIGxvYWRlciBmb3IgY3VycmVudCBlbnZpcm9ubWVudFxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBmb3JFbnZpcm9ubWVudChlbnZpcm9ubWVudD86IHN0cmluZyk6IFNlY3JldHNMb2FkZXIge1xuICAgIGNvbnN0IGVudiA9IGVudmlyb25tZW50IHx8IHByb2Nlc3MuZW52Lk5PREVfRU5WIHx8IHByb2Nlc3MuZW52LkVOVklST05NRU5UIHx8ICdkZXYnO1xuICAgIHJldHVybiBuZXcgU2VjcmV0c0xvYWRlcihlbnYpO1xuICB9XG59Il19