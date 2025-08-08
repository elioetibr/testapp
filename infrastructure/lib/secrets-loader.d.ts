export interface SecretsConfig {
    secret_key: string;
    jwt_secret: string;
    required_setting: string;
    api_key: string;
    webhook_secret: string;
    datadog_api_key: string;
    sentry_dsn: string;
}
export declare class SecretsLoader {
    private environment;
    private projectRoot;
    constructor(environment: string);
    /**
     * Load and decrypt secrets for the specified environment
     */
    loadSecrets(): SecretsConfig;
    /**
     * Load secrets with fallback to environment variables
     */
    loadSecretsWithFallback(): Partial<SecretsConfig>;
    /**
     * Get a specific secret value by path (e.g., 'database.password')
     */
    getSecret(secretPath: string): string;
    /**
     * Export secrets as environment variables format
     */
    exportAsEnvVars(): Record<string, string>;
    private validateSecrets;
    /**
     * Check if running in CI/CD environment
     */
    static isCI(): boolean;
    /**
     * Create secrets loader for current environment
     */
    static forEnvironment(environment?: string): SecretsLoader;
}
