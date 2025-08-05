import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { SecretsLoader } from '../lib/secrets-loader';

// Mock fs and child_process modules
jest.mock('fs');
jest.mock('child_process');
const mockFs = fs as jest.Mocked<typeof fs>;
const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

describe('SecretsLoader', () => {
  const mockSecretsContent = {
    application: {
      secret_key: 'test-secret-key',
      jwt_secret: 'test-jwt-secret',
      required_setting: 'test'
    },
    external_services: {
      api_key: 'test-api-key-12345',
      webhook_secret: 'test-webhook-secret'
    },
    monitoring: {
      datadog_api_key: 'test-datadog-key',
      sentry_dsn: 'test-sentry-dsn'
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock fs.existsSync to return true by default
    mockFs.existsSync.mockReturnValue(true);
    // Mock execSync to simulate SOPS being available
    mockExecSync.mockImplementation((command: string) => {
      if (command === 'which sops') {
        return '/usr/local/bin/sops';
      }
      if (command.includes('sops -d')) {
        // Return decrypted YAML content
        return JSON.stringify(mockSecretsContent);
      }
      throw new Error('Command not found');
    });
    // Clear any environment variables that might affect tests
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.JENKINS_URL;
    delete process.env.NODE_ENV;
    delete process.env.ENVIRONMENT;
  });

  describe('loadSecrets', () => {
    test('loads secrets successfully from SOPS', () => {
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockSecretsContent));

      const loader = new SecretsLoader('test');
      const secrets = loader.loadSecrets();

      expect(secrets).toEqual(mockSecretsContent);
    });

    test('falls back to plaintext when SOPS error occurs', () => {
      // Mock execSync to throw a SOPS error first time, then fs.readFileSync succeeds for fallback
      mockExecSync.mockImplementation((command: string) => {
        if (command === 'which sops') {
          return '/usr/local/bin/sops';
        }
        if (command.includes('sops -d')) {
          throw new Error('sops: failed to decrypt');
        }
        throw new Error('Command not found');
      });
      
      // Mock fs.readFileSync to return the plaintext content for fallback
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockSecretsContent));

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const loader = new SecretsLoader('test');
      const secrets = loader.loadSecrets();

      expect(secrets).toEqual(mockSecretsContent);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('SOPS not available or secrets not encrypted')
      );

      consoleSpy.mockRestore();
    });

    test('throws error for non-SOPS related errors', () => {
      // Mock execSync to fail with a non-SOPS error
      mockExecSync.mockImplementation((command: string) => {
        if (command === 'which sops') {
          return '/usr/local/bin/sops';
        }
        if (command.includes('sops -d')) {
          throw new Error('File not found');
        }
        throw new Error('Command not found');
      });

      const loader = new SecretsLoader('test');
      
      expect(() => loader.loadSecrets()).toThrow(
        'Failed to load secrets for environment test: Error: File not found'
      );
    });

    test('throws error for missing required secrets', () => {
      const incompleteSecrets = {
        application: {
          // missing secret_key
        }
      };
      
      // Mock execSync to return the incomplete secrets
      mockExecSync.mockImplementation((command: string) => {
        if (command === 'which sops') {
          return '/usr/local/bin/sops';
        }
        if (command.includes('sops -d')) {
          return JSON.stringify(incompleteSecrets);
        }
        throw new Error('Command not found');
      });

      const loader = new SecretsLoader('test');
      
      expect(() => loader.loadSecrets()).toThrow(
        'Required secret missing: application.secret_key'
      );
    });
  });

  describe('loadSecretsWithFallback', () => {
    test('returns secrets from loadSecrets when available', () => {
      // Use the default mock setup from beforeEach which successfully returns secrets

      const loader = new SecretsLoader('test');
      const secrets = loader.loadSecretsWithFallback();

      expect(secrets).toEqual(mockSecretsContent);
    });

    test('returns fallback secrets when loadSecrets fails', () => {
      // Mock file not existing to trigger fallback path
      mockFs.existsSync.mockReturnValue(false);

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const loader = new SecretsLoader('test');
      const secrets = loader.loadSecretsWithFallback();

      // Should return fallback secrets with test environment
      expect(secrets).toEqual({
        application: {
          secret_key: 'default-secret',
          jwt_secret: 'default-jwt-secret',
          required_setting: 'test'
        },
        external_services: {
          api_key: '',
          webhook_secret: ''
        },
        monitoring: {
          datadog_api_key: '',
          sentry_dsn: ''
        }
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load SOPS secrets, using environment variables fallback')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('getSecret', () => {
    test('retrieves secret by path', () => {
      // Use the default mock setup from beforeEach which returns mockSecretsContent
      const loader = new SecretsLoader('test');
      const secret = loader.getSecret('application.secret_key');

      expect(secret).toBe('test-secret-key');
    });

    test('retrieves nested secret by path', () => {
      const loader = new SecretsLoader('test');
      const secret = loader.getSecret('external_services.api_key');

      expect(secret).toBe('test-api-key-12345');
    });

    test('throws error for non-existent secret path', () => {
      const loader = new SecretsLoader('test');
      
      expect(() => loader.getSecret('nonexistent.secret')).toThrow(
        'Secret not found or not a string: nonexistent.secret'
      );
    });

    test('throws error for non-string secret value', () => {
      const secretsWithObject = {
        application: {
          config: {
            nested: 'value'
          }
        }
      };
      
      mockFs.readFileSync.mockReturnValue(JSON.stringify(secretsWithObject));

      const loader = new SecretsLoader('test');
      
      expect(() => loader.getSecret('application.config')).toThrow(
        'Secret not found or not a string: application.config'
      );
    });
  });

  describe('exportAsEnvVars', () => {
    test('flattens secrets to environment variable format', () => {
      const loader = new SecretsLoader('test');
      const envVars = loader.exportAsEnvVars();

      expect(envVars).toEqual({
        'APPLICATION_SECRET_KEY': 'test-secret-key',
        'APPLICATION_JWT_SECRET': 'test-jwt-secret',
        'APPLICATION_REQUIRED_SETTING': 'test',
        'EXTERNAL_SERVICES_API_KEY': 'test-api-key-12345',
        'EXTERNAL_SERVICES_WEBHOOK_SECRET': 'test-webhook-secret',
        'MONITORING_DATADOG_API_KEY': 'test-datadog-key',
        'MONITORING_SENTRY_DSN': 'test-sentry-dsn'
      });
    });

    test('handles nested objects correctly', () => {
      const nestedSecrets = {
        application: {
          secret_key: 'test-secret-key',
          required_setting: 'test'  // Include required field to pass validation
        },
        app: {
          auth: {
            jwt: {
              secret: 'jwt-secret'
            }
          }
        }
      };

      // Mock execSync to return nested secrets
      mockExecSync.mockImplementation((command: string) => {
        if (command === 'which sops') {
          return '/usr/local/bin/sops';
        }
        if (command.includes('sops -d')) {
          return JSON.stringify(nestedSecrets);
        }
        throw new Error('Command not found');
      });

      const loader = new SecretsLoader('test');
      const envVars = loader.exportAsEnvVars();

      expect(envVars).toEqual({
        'APPLICATION_SECRET_KEY': 'test-secret-key',
        'APPLICATION_REQUIRED_SETTING': 'test',
        'APP_AUTH_JWT_SECRET': 'jwt-secret'
      });
    });
  });

  describe('static methods', () => {
    test('isCI detects CI environment', () => {
      process.env.CI = 'true';
      expect(SecretsLoader.isCI()).toBe(true);

      delete process.env.CI;
      process.env.GITHUB_ACTIONS = 'true';
      expect(SecretsLoader.isCI()).toBe(true);

      delete process.env.GITHUB_ACTIONS;
      process.env.JENKINS_URL = 'http://jenkins.example.com';
      expect(SecretsLoader.isCI()).toBe(true);

      delete process.env.JENKINS_URL;
      expect(SecretsLoader.isCI()).toBe(false);
    });

    test('forEnvironment creates loader with specified environment', () => {
      const loader = SecretsLoader.forEnvironment('production');
      expect(loader).toBeInstanceOf(SecretsLoader);
    });

    test('forEnvironment uses NODE_ENV when no environment specified', () => {
      process.env.NODE_ENV = 'development';
      const loader = SecretsLoader.forEnvironment();
      expect(loader).toBeInstanceOf(SecretsLoader);
    });

    test('forEnvironment uses ENVIRONMENT when NODE_ENV not set', () => {
      process.env.ENVIRONMENT = 'staging';
      const loader = SecretsLoader.forEnvironment();
      expect(loader).toBeInstanceOf(SecretsLoader);
    });

    test('forEnvironment defaults to dev when no environment variables set', () => {
      const loader = SecretsLoader.forEnvironment();
      expect(loader).toBeInstanceOf(SecretsLoader);
    });
  });

  describe('error handling edge cases', () => {
    test('handles non-Error exceptions in loadSecrets', () => {
      mockExecSync.mockImplementation((command: string) => {
        if (command === 'which sops') {
          return '/usr/local/bin/sops';
        }
        if (command.includes('sops -d')) {
          throw 'string error';
        }
        throw new Error('Command not found');
      });

      const loader = new SecretsLoader('test');
      
      expect(() => loader.loadSecrets()).toThrow(
        'Failed to load secrets for environment test: string error'
      );
    });

    test('handles null secret values in validation', () => {
      const secretsWithNull = {
        application: {
          secret_key: null,
          required_setting: 'test'
        }
      };
      
      mockExecSync.mockImplementation((command: string) => {
        if (command === 'which sops') {
          return '/usr/local/bin/sops';
        }
        if (command.includes('sops -d')) {
          return JSON.stringify(secretsWithNull);
        }
        throw new Error('Command not found');
      });

      const loader = new SecretsLoader('test');
      
      expect(() => loader.loadSecrets()).toThrow(
        'Required secret missing: application.secret_key'
      );
    });

    test('handles undefined secret values in validation', () => {
      const secretsWithUndefined = {
        application: {
          secret_key: undefined,
          required_setting: 'test'
        }
      };
      
      mockExecSync.mockImplementation((command: string) => {
        if (command === 'which sops') {
          return '/usr/local/bin/sops';
        }
        if (command.includes('sops -d')) {
          return JSON.stringify(secretsWithUndefined);
        }
        throw new Error('Command not found');
      });

      const loader = new SecretsLoader('test');
      
      expect(() => loader.loadSecrets()).toThrow(
        'Required secret missing: application.secret_key'
      );
    });
  });
});