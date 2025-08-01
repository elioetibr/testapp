import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as yaml from 'js-yaml';

export interface SecretsConfig {
  application: {
    secret_key: string;
    jwt_secret: string;
    required_setting: string;
  };
  external_services: {
    api_key: string;
    webhook_secret: string;
  };
  monitoring: {
    datadog_api_key: string;
    sentry_dsn: string;
  };
}

export class SecretsLoader {
  private environment: string;
  private projectRoot: string;

  constructor(environment: string) {
    this.environment = environment;
    this.projectRoot = path.resolve(__dirname, '../..');
  }

  /**
   * Load and decrypt secrets for the specified environment
   */
  public loadSecrets(): SecretsConfig {
    const secretsFile = path.join(this.projectRoot, 'secrets', this.environment, 'secrets.enc.yaml');
    
    if (!fs.existsSync(secretsFile)) {
      throw new Error(`Secrets file not found: ${secretsFile}`);
    }

    try {
      // Check if SOPS is available
      execSync('which sops', { stdio: 'pipe' });
      
      // Decrypt the secrets file using SOPS
      const decryptedContent = execSync(`sops -d "${secretsFile}"`, { 
        encoding: 'utf8',
        cwd: this.projectRoot 
      });
      
      // Parse the YAML content
      const secrets = yaml.load(decryptedContent) as SecretsConfig;
      
      // Validate the structure
      this.validateSecrets(secrets);
      
      return secrets;
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('sops')) {
          console.warn(`SOPS not available or secrets not encrypted. Using plaintext secrets for ${this.environment}`);
          // Fallback to reading plaintext file
          const content = fs.readFileSync(secretsFile, 'utf8');
          const secrets = yaml.load(content) as SecretsConfig;
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
  public loadSecretsWithFallback(): Partial<SecretsConfig> {
    try {
      return this.loadSecrets();
    } catch (error) {
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
  public getSecret(secretPath: string): string {
    const secrets = this.loadSecretsWithFallback();
    const pathParts = secretPath.split('.');
    
    let value: any = secrets;
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
  public exportAsEnvVars(): Record<string, string> {
    const secrets = this.loadSecretsWithFallback();
    const envVars: Record<string, string> = {};

    // Flatten the secrets object
    const flatten = (obj: any, prefix = '') => {
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          const value = obj[key];
          const envKey = prefix ? `${prefix}_${key.toUpperCase()}` : key.toUpperCase();
          
          if (typeof value === 'object' && value !== null) {
            flatten(value, envKey);
          } else {
            envVars[envKey] = String(value);
          }
        }
      }
    };

    flatten(secrets);
    return envVars;
  }

  private validateSecrets(secrets: any): void {
    const requiredPaths = [
      'application.secret_key',
      'application.required_setting'
    ];

    for (const path of requiredPaths) {
      const pathParts = path.split('.');
      let value: any = secrets;
      
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
  public static isCI(): boolean {
    return !!(process.env.CI || process.env.GITHUB_ACTIONS || process.env.JENKINS_URL);
  }

  /**
   * Create secrets loader for current environment
   */
  public static forEnvironment(environment?: string): SecretsLoader {
    const env = environment || process.env.NODE_ENV || process.env.ENVIRONMENT || 'dev';
    return new SecretsLoader(env);
  }
}