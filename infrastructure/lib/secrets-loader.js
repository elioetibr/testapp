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
                application: {
                    secret_key: process.env.APPLICATION_SECRET_KEY || 'default-secret',
                    jwt_secret: process.env.JWT_SECRET || 'default-jwt-secret',
                    required_setting: process.env.REQUIRED_SETTING || this.environment,
                },
                external_services: {
                    api_key: process.env.EXTERNAL_API_KEY || '',
                    webhook_secret: process.env.WEBHOOK_SECRET || '',
                },
                monitoring: {
                    datadog_api_key: process.env.DATADOG_API_KEY || '',
                    sentry_dsn: process.env.SENTRY_DSN || '',
                },
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
            'application.secret_key',
            'application.required_setting'
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VjcmV0cy1sb2FkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzZWNyZXRzLWxvYWRlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSx5QkFBeUI7QUFDekIsNkJBQTZCO0FBQzdCLGlEQUF5QztBQUN6QyxnQ0FBZ0M7QUFrQmhDLE1BQWEsYUFBYTtJQUl4QixZQUFZLFdBQW1CO1FBQzdCLElBQUksQ0FBQyxXQUFXLEdBQUcsV0FBVyxDQUFDO1FBQy9CLElBQUksQ0FBQyxXQUFXLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEVBQUUsT0FBTyxDQUFDLENBQUM7SUFDdEQsQ0FBQztJQUVEOztPQUVHO0lBQ0ksV0FBVztRQUNoQixNQUFNLFdBQVcsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsU0FBUyxFQUFFLElBQUksQ0FBQyxXQUFXLEVBQUUsa0JBQWtCLENBQUMsQ0FBQztRQUVqRyxJQUFJLENBQUMsRUFBRSxDQUFDLFVBQVUsQ0FBQyxXQUFXLENBQUMsRUFBRTtZQUMvQixNQUFNLElBQUksS0FBSyxDQUFDLDJCQUEyQixXQUFXLEVBQUUsQ0FBQyxDQUFDO1NBQzNEO1FBRUQsSUFBSTtZQUNGLDZCQUE2QjtZQUM3QixJQUFBLHdCQUFRLEVBQUMsWUFBWSxFQUFFLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUM7WUFFMUMsc0NBQXNDO1lBQ3RDLE1BQU0sZ0JBQWdCLEdBQUcsSUFBQSx3QkFBUSxFQUFDLFlBQVksV0FBVyxHQUFHLEVBQUU7Z0JBQzVELFFBQVEsRUFBRSxNQUFNO2dCQUNoQixHQUFHLEVBQUUsSUFBSSxDQUFDLFdBQVc7YUFDdEIsQ0FBQyxDQUFDO1lBRUgseUJBQXlCO1lBQ3pCLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLENBQWtCLENBQUM7WUFFN0QseUJBQXlCO1lBQ3pCLElBQUksQ0FBQyxlQUFlLENBQUMsT0FB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LE9BQU8sQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxFQUFFLElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFjLElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsQ0FBQztJQUNyRixDQUFDO0lBRUQ7O09BRUc7SUFDSSxNQUFNLENBQUMsY0FBYyxDQUFDLFdBQW9CO1FBQy9DLE1BQU0sR0FBRyxHQUFHLFdBQVcsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLFFBQVEsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLFdBQVcsSUFBSSxLQUFLLENBQUM7UUFDcEYsT0FBTyxJQUFJLGFBQWEsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNoQyxDQUFDO0NBQ0Y7QUFoS0Qsc0NBZ0tDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgZnMgZnJvbSAnZnMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCB7IGV4ZWNTeW5jIH0gZnJvbSAnY2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQgKiBhcyB5YW1sIGZyb20gJ2pzLXlhbWwnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFNlY3JldHNDb25maWcge1xuICBhcHBsaWNhdGlvbjoge1xuICAgIHNlY3JldF9rZXk6IHN0cmluZztcbiAgICBqd3Rfc2VjcmV0OiBzdHJpbmc7XG4gICAgcmVxdWlyZWRfc2V0dGluZzogc3RyaW5nO1xuICB9O1xuICBleHRlcm5hbF9zZXJ2aWNlczoge1xuICAgIGFwaV9rZXk6IHN0cmluZztcbiAgICB3ZWJob29rX3NlY3JldDogc3RyaW5nO1xuICB9O1xuICBtb25pdG9yaW5nOiB7XG4gICAgZGF0YWRvZ19hcGlfa2V5OiBzdHJpbmc7XG4gICAgc2VudHJ5X2Rzbjogc3RyaW5nO1xuICB9O1xufVxuXG5leHBvcnQgY2xhc3MgU2VjcmV0c0xvYWRlciB7XG4gIHByaXZhdGUgZW52aXJvbm1lbnQ6IHN0cmluZztcbiAgcHJpdmF0ZSBwcm9qZWN0Um9vdDogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKGVudmlyb25tZW50OiBzdHJpbmcpIHtcbiAgICB0aGlzLmVudmlyb25tZW50ID0gZW52aXJvbm1lbnQ7XG4gICAgdGhpcy5wcm9qZWN0Um9vdCA9IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsICcuLi8uLicpO1xuICB9XG5cbiAgLyoqXG4gICAqIExvYWQgYW5kIGRlY3J5cHQgc2VjcmV0cyBmb3IgdGhlIHNwZWNpZmllZCBlbnZpcm9ubWVudFxuICAgKi9cbiAgcHVibGljIGxvYWRTZWNyZXRzKCk6IFNlY3JldHNDb25maWcge1xuICAgIGNvbnN0IHNlY3JldHNGaWxlID0gcGF0aC5qb2luKHRoaXMucHJvamVjdFJvb3QsICdzZWNyZXRzJywgdGhpcy5lbnZpcm9ubWVudCwgJ3NlY3JldHMuZW5jLnlhbWwnKTtcbiAgICBcbiAgICBpZiAoIWZzLmV4aXN0c1N5bmMoc2VjcmV0c0ZpbGUpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFNlY3JldHMgZmlsZSBub3QgZm91bmQ6ICR7c2VjcmV0c0ZpbGV9YCk7XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIC8vIENoZWNrIGlmIFNPUFMgaXMgYXZhaWxhYmxlXG4gICAgICBleGVjU3luYygnd2hpY2ggc29wcycsIHsgc3RkaW86ICdwaXBlJyB9KTtcbiAgICAgIFxuICAgICAgLy8gRGVjcnlwdCB0aGUgc2VjcmV0cyBmaWxlIHVzaW5nIFNPUFNcbiAgICAgIGNvbnN0IGRlY3J5cHRlZENvbnRlbnQgPSBleGVjU3luYyhgc29wcyAtZCBcIiR7c2VjcmV0c0ZpbGV9XCJgLCB7IFxuICAgICAgICBlbmNvZGluZzogJ3V0ZjgnLFxuICAgICAgICBjd2Q6IHRoaXMucHJvamVjdFJvb3QgXG4gICAgICB9KTtcbiAgICAgIFxuICAgICAgLy8gUGFyc2UgdGhlIFlBTUwgY29udGVudFxuICAgICAgY29uc3Qgc2VjcmV0cyA9IHlhbWwubG9hZChkZWNyeXB0ZWRDb250ZW50KSBhcyBTZWNyZXRzQ29uZmlnO1xuICAgICAgXG4gICAgICAvLyBWYWxpZGF0ZSB0aGUgc3RydWN0dXJlXG4gICAgICB0aGlzLnZhbGlkYXRlU2VjcmV0cyhzZWNyZXRzKTtcbiAgICAgIFxuICAgICAgcmV0dXJuIHNlY3JldHM7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yKSB7XG4gICAgICAgIGlmIChlcnJvci5tZXNzYWdlLmluY2x1ZGVzKCdzb3BzJykpIHtcbiAgICAgICAgICBjb25zb2xlLndhcm4oYFNPUFMgbm90IGF2YWlsYWJsZSBvciBzZWNyZXRzIG5vdCBlbmNyeXB0ZWQuIFVzaW5nIHBsYWludGV4dCBzZWNyZXRzIGZvciAke3RoaXMuZW52aXJvbm1lbnR9YCk7XG4gICAgICAgICAgLy8gRmFsbGJhY2sgdG8gcmVhZGluZyBwbGFpbnRleHQgZmlsZVxuICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBmcy5yZWFkRmlsZVN5bmMoc2VjcmV0c0ZpbGUsICd1dGY4Jyk7XG4gICAgICAgICAgY29uc3Qgc2VjcmV0cyA9IHlhbWwubG9hZChjb250ZW50KSBhcyBTZWNyZXRzQ29uZmlnO1xuICAgICAgICAgIHRoaXMudmFsaWRhdGVTZWNyZXRzKHNlY3JldHMpO1xuICAgICAgICAgIHJldHVybiBzZWNyZXRzO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBsb2FkIHNlY3JldHMgZm9yIGVudmlyb25tZW50ICR7dGhpcy5lbnZpcm9ubWVudH06ICR7ZXJyb3J9YCk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIExvYWQgc2VjcmV0cyB3aXRoIGZhbGxiYWNrIHRvIGVudmlyb25tZW50IHZhcmlhYmxlc1xuICAgKi9cbiAgcHVibGljIGxvYWRTZWNyZXRzV2l0aEZhbGxiYWNrKCk6IFBhcnRpYWw8U2VjcmV0c0NvbmZpZz4ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gdGhpcy5sb2FkU2VjcmV0cygpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLndhcm4oYEZhaWxlZCB0byBsb2FkIFNPUFMgc2VjcmV0cywgdXNpbmcgZW52aXJvbm1lbnQgdmFyaWFibGVzIGZhbGxiYWNrOiAke2Vycm9yfWApO1xuICAgICAgY29uc29sZS53YXJuKCdUaGlzIGlzIGV4cGVjdGVkIGluIENJL0NEIGVudmlyb25tZW50cyB3aGVyZSBLTVMgYWNjZXNzIG1heSBub3QgYmUgY29uZmlndXJlZCcpO1xuICAgICAgXG4gICAgICAvLyBGYWxsYmFjayB0byBlbnZpcm9ubWVudCB2YXJpYWJsZXNcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFwcGxpY2F0aW9uOiB7XG4gICAgICAgICAgc2VjcmV0X2tleTogcHJvY2Vzcy5lbnYuQVBQTElDQVRJT05fU0VDUkVUX0tFWSB8fCAnZGVmYXVsdC1zZWNyZXQnLFxuICAgICAgICAgIGp3dF9zZWNyZXQ6IHByb2Nlc3MuZW52LkpXVF9TRUNSRVQgfHwgJ2RlZmF1bHQtand0LXNlY3JldCcsXG4gICAgICAgICAgcmVxdWlyZWRfc2V0dGluZzogcHJvY2Vzcy5lbnYuUkVRVUlSRURfU0VUVElORyB8fCB0aGlzLmVudmlyb25tZW50LFxuICAgICAgICB9LFxuICAgICAgICBleHRlcm5hbF9zZXJ2aWNlczoge1xuICAgICAgICAgIGFwaV9rZXk6IHByb2Nlc3MuZW52LkVYVEVSTkFMX0FQSV9LRVkgfHwgJycsXG4gICAgICAgICAgd2ViaG9va19zZWNyZXQ6IHByb2Nlc3MuZW52LldFQkhPT0tfU0VDUkVUIHx8ICcnLFxuICAgICAgICB9LFxuICAgICAgICBtb25pdG9yaW5nOiB7XG4gICAgICAgICAgZGF0YWRvZ19hcGlfa2V5OiBwcm9jZXNzLmVudi5EQVRBRE9HX0FQSV9LRVkgfHwgJycsXG4gICAgICAgICAgc2VudHJ5X2RzbjogcHJvY2Vzcy5lbnYuU0VOVFJZX0RTTiB8fCAnJyxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEdldCBhIHNwZWNpZmljIHNlY3JldCB2YWx1ZSBieSBwYXRoIChlLmcuLCAnZGF0YWJhc2UucGFzc3dvcmQnKVxuICAgKi9cbiAgcHVibGljIGdldFNlY3JldChzZWNyZXRQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IHNlY3JldHMgPSB0aGlzLmxvYWRTZWNyZXRzV2l0aEZhbGxiYWNrKCk7XG4gICAgY29uc3QgcGF0aFBhcnRzID0gc2VjcmV0UGF0aC5zcGxpdCgnLicpO1xuICAgIFxuICAgIGxldCB2YWx1ZTogYW55ID0gc2VjcmV0cztcbiAgICBmb3IgKGNvbnN0IHBhcnQgb2YgcGF0aFBhcnRzKSB7XG4gICAgICB2YWx1ZSA9IHZhbHVlPy5bcGFydF07XG4gICAgfVxuICAgIFxuICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFNlY3JldCBub3QgZm91bmQgb3Igbm90IGEgc3RyaW5nOiAke3NlY3JldFBhdGh9YCk7XG4gICAgfVxuICAgIFxuICAgIHJldHVybiB2YWx1ZTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFeHBvcnQgc2VjcmV0cyBhcyBlbnZpcm9ubWVudCB2YXJpYWJsZXMgZm9ybWF0XG4gICAqL1xuICBwdWJsaWMgZXhwb3J0QXNFbnZWYXJzKCk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xuICAgIGNvbnN0IHNlY3JldHMgPSB0aGlzLmxvYWRTZWNyZXRzV2l0aEZhbGxiYWNrKCk7XG4gICAgY29uc3QgZW52VmFyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuXG4gICAgLy8gRmxhdHRlbiB0aGUgc2VjcmV0cyBvYmplY3RcbiAgICBjb25zdCBmbGF0dGVuID0gKG9iajogYW55LCBwcmVmaXggPSAnJykgPT4ge1xuICAgICAgZm9yIChjb25zdCBrZXkgaW4gb2JqKSB7XG4gICAgICAgIGlmIChvYmouaGFzT3duUHJvcGVydHkoa2V5KSkge1xuICAgICAgICAgIGNvbnN0IHZhbHVlID0gb2JqW2tleV07XG4gICAgICAgICAgY29uc3QgZW52S2V5ID0gcHJlZml4ID8gYCR7cHJlZml4fV8ke2tleS50b1VwcGVyQ2FzZSgpfWAgOiBrZXkudG9VcHBlckNhc2UoKTtcbiAgICAgICAgICBcbiAgICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyAmJiB2YWx1ZSAhPT0gbnVsbCkge1xuICAgICAgICAgICAgZmxhdHRlbih2YWx1ZSwgZW52S2V5KTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgZW52VmFyc1tlbnZLZXldID0gU3RyaW5nKHZhbHVlKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9O1xuXG4gICAgZmxhdHRlbihzZWNyZXRzKTtcbiAgICByZXR1cm4gZW52VmFycztcbiAgfVxuXG4gIHByaXZhdGUgdmFsaWRhdGVTZWNyZXRzKHNlY3JldHM6IGFueSk6IHZvaWQge1xuICAgIGNvbnN0IHJlcXVpcmVkUGF0aHMgPSBbXG4gICAgICAnYXBwbGljYXRpb24uc2VjcmV0X2tleScsXG4gICAgICAnYXBwbGljYXRpb24ucmVxdWlyZWRfc2V0dGluZydcbiAgICBdO1xuXG4gICAgZm9yIChjb25zdCBwYXRoIG9mIHJlcXVpcmVkUGF0aHMpIHtcbiAgICAgIGNvbnN0IHBhdGhQYXJ0cyA9IHBhdGguc3BsaXQoJy4nKTtcbiAgICAgIGxldCB2YWx1ZTogYW55ID0gc2VjcmV0cztcbiAgICAgIFxuICAgICAgZm9yIChjb25zdCBwYXJ0IG9mIHBhdGhQYXJ0cykge1xuICAgICAgICB2YWx1ZSA9IHZhbHVlPy5bcGFydF07XG4gICAgICB9XG4gICAgICBcbiAgICAgIGlmICghdmFsdWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZXF1aXJlZCBzZWNyZXQgbWlzc2luZzogJHtwYXRofWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBDaGVjayBpZiBydW5uaW5nIGluIENJL0NEIGVudmlyb25tZW50XG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGlzQ0koKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuICEhKHByb2Nlc3MuZW52LkNJIHx8IHByb2Nlc3MuZW52LkdJVEhVQl9BQ1RJT05TIHx8IHByb2Nlc3MuZW52LkpFTktJTlNfVVJMKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDcmVhdGUgc2VjcmV0cyBsb2FkZXIgZm9yIGN1cnJlbnQgZW52aXJvbm1lbnRcbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgZm9yRW52aXJvbm1lbnQoZW52aXJvbm1lbnQ/OiBzdHJpbmcpOiBTZWNyZXRzTG9hZGVyIHtcbiAgICBjb25zdCBlbnYgPSBlbnZpcm9ubWVudCB8fCBwcm9jZXNzLmVudi5OT0RFX0VOViB8fCBwcm9jZXNzLmVudi5FTlZJUk9OTUVOVCB8fCAnZGV2JztcbiAgICByZXR1cm4gbmV3IFNlY3JldHNMb2FkZXIoZW52KTtcbiAgfVxufSJdfQ==