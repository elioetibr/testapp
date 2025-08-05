"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const child_process_1 = require("child_process");
const secrets_loader_1 = require("../lib/secrets-loader");
// Mock fs and child_process modules
jest.mock('fs');
jest.mock('child_process');
const mockFs = fs;
const mockExecSync = child_process_1.execSync;
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
        mockExecSync.mockImplementation((command) => {
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
            const loader = new secrets_loader_1.SecretsLoader('test');
            const secrets = loader.loadSecrets();
            expect(secrets).toEqual(mockSecretsContent);
        });
        test('falls back to plaintext when SOPS error occurs', () => {
            // Mock execSync to throw a SOPS error first time, then fs.readFileSync succeeds for fallback
            mockExecSync.mockImplementation((command) => {
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
            const loader = new secrets_loader_1.SecretsLoader('test');
            const secrets = loader.loadSecrets();
            expect(secrets).toEqual(mockSecretsContent);
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('SOPS not available or secrets not encrypted'));
            consoleSpy.mockRestore();
        });
        test('throws error for non-SOPS related errors', () => {
            // Mock execSync to fail with a non-SOPS error
            mockExecSync.mockImplementation((command) => {
                if (command === 'which sops') {
                    return '/usr/local/bin/sops';
                }
                if (command.includes('sops -d')) {
                    throw new Error('File not found');
                }
                throw new Error('Command not found');
            });
            const loader = new secrets_loader_1.SecretsLoader('test');
            expect(() => loader.loadSecrets()).toThrow('Failed to load secrets for environment test: Error: File not found');
        });
        test('throws error for missing required secrets', () => {
            const incompleteSecrets = {
                application: {
                // missing secret_key
                }
            };
            // Mock execSync to return the incomplete secrets
            mockExecSync.mockImplementation((command) => {
                if (command === 'which sops') {
                    return '/usr/local/bin/sops';
                }
                if (command.includes('sops -d')) {
                    return JSON.stringify(incompleteSecrets);
                }
                throw new Error('Command not found');
            });
            const loader = new secrets_loader_1.SecretsLoader('test');
            expect(() => loader.loadSecrets()).toThrow('Required secret missing: application.secret_key');
        });
    });
    describe('loadSecretsWithFallback', () => {
        test('returns secrets from loadSecrets when available', () => {
            // Use the default mock setup from beforeEach which successfully returns secrets
            const loader = new secrets_loader_1.SecretsLoader('test');
            const secrets = loader.loadSecretsWithFallback();
            expect(secrets).toEqual(mockSecretsContent);
        });
        test('returns fallback secrets when loadSecrets fails', () => {
            // Mock file not existing to trigger fallback path
            mockFs.existsSync.mockReturnValue(false);
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
            const loader = new secrets_loader_1.SecretsLoader('test');
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
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load SOPS secrets, using environment variables fallback'));
            consoleSpy.mockRestore();
        });
    });
    describe('getSecret', () => {
        test('retrieves secret by path', () => {
            // Use the default mock setup from beforeEach which returns mockSecretsContent
            const loader = new secrets_loader_1.SecretsLoader('test');
            const secret = loader.getSecret('application.secret_key');
            expect(secret).toBe('test-secret-key');
        });
        test('retrieves nested secret by path', () => {
            const loader = new secrets_loader_1.SecretsLoader('test');
            const secret = loader.getSecret('external_services.api_key');
            expect(secret).toBe('test-api-key-12345');
        });
        test('throws error for non-existent secret path', () => {
            const loader = new secrets_loader_1.SecretsLoader('test');
            expect(() => loader.getSecret('nonexistent.secret')).toThrow('Secret not found or not a string: nonexistent.secret');
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
            const loader = new secrets_loader_1.SecretsLoader('test');
            expect(() => loader.getSecret('application.config')).toThrow('Secret not found or not a string: application.config');
        });
    });
    describe('exportAsEnvVars', () => {
        test('flattens secrets to environment variable format', () => {
            const loader = new secrets_loader_1.SecretsLoader('test');
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
                    required_setting: 'test' // Include required field to pass validation
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
            mockExecSync.mockImplementation((command) => {
                if (command === 'which sops') {
                    return '/usr/local/bin/sops';
                }
                if (command.includes('sops -d')) {
                    return JSON.stringify(nestedSecrets);
                }
                throw new Error('Command not found');
            });
            const loader = new secrets_loader_1.SecretsLoader('test');
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
            expect(secrets_loader_1.SecretsLoader.isCI()).toBe(true);
            delete process.env.CI;
            process.env.GITHUB_ACTIONS = 'true';
            expect(secrets_loader_1.SecretsLoader.isCI()).toBe(true);
            delete process.env.GITHUB_ACTIONS;
            process.env.JENKINS_URL = 'http://jenkins.example.com';
            expect(secrets_loader_1.SecretsLoader.isCI()).toBe(true);
            delete process.env.JENKINS_URL;
            expect(secrets_loader_1.SecretsLoader.isCI()).toBe(false);
        });
        test('forEnvironment creates loader with specified environment', () => {
            const loader = secrets_loader_1.SecretsLoader.forEnvironment('production');
            expect(loader).toBeInstanceOf(secrets_loader_1.SecretsLoader);
        });
        test('forEnvironment uses NODE_ENV when no environment specified', () => {
            process.env.NODE_ENV = 'development';
            const loader = secrets_loader_1.SecretsLoader.forEnvironment();
            expect(loader).toBeInstanceOf(secrets_loader_1.SecretsLoader);
        });
        test('forEnvironment uses ENVIRONMENT when NODE_ENV not set', () => {
            process.env.ENVIRONMENT = 'staging';
            const loader = secrets_loader_1.SecretsLoader.forEnvironment();
            expect(loader).toBeInstanceOf(secrets_loader_1.SecretsLoader);
        });
        test('forEnvironment defaults to dev when no environment variables set', () => {
            const loader = secrets_loader_1.SecretsLoader.forEnvironment();
            expect(loader).toBeInstanceOf(secrets_loader_1.SecretsLoader);
        });
    });
    describe('error handling edge cases', () => {
        test('handles non-Error exceptions in loadSecrets', () => {
            mockExecSync.mockImplementation((command) => {
                if (command === 'which sops') {
                    return '/usr/local/bin/sops';
                }
                if (command.includes('sops -d')) {
                    throw 'string error';
                }
                throw new Error('Command not found');
            });
            const loader = new secrets_loader_1.SecretsLoader('test');
            expect(() => loader.loadSecrets()).toThrow('Failed to load secrets for environment test: string error');
        });
        test('handles null secret values in validation', () => {
            const secretsWithNull = {
                application: {
                    secret_key: null,
                    required_setting: 'test'
                }
            };
            mockExecSync.mockImplementation((command) => {
                if (command === 'which sops') {
                    return '/usr/local/bin/sops';
                }
                if (command.includes('sops -d')) {
                    return JSON.stringify(secretsWithNull);
                }
                throw new Error('Command not found');
            });
            const loader = new secrets_loader_1.SecretsLoader('test');
            expect(() => loader.loadSecrets()).toThrow('Required secret missing: application.secret_key');
        });
        test('handles undefined secret values in validation', () => {
            const secretsWithUndefined = {
                application: {
                    secret_key: undefined,
                    required_setting: 'test'
                }
            };
            mockExecSync.mockImplementation((command) => {
                if (command === 'which sops') {
                    return '/usr/local/bin/sops';
                }
                if (command.includes('sops -d')) {
                    return JSON.stringify(secretsWithUndefined);
                }
                throw new Error('Command not found');
            });
            const loader = new secrets_loader_1.SecretsLoader('test');
            expect(() => loader.loadSecrets()).toThrow('Required secret missing: application.secret_key');
        });
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VjcmV0cy1sb2FkZXIudGVzdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNlY3JldHMtbG9hZGVyLnRlc3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSx5QkFBeUI7QUFFekIsaURBQXlDO0FBQ3pDLDBEQUFzRDtBQUV0RCxvQ0FBb0M7QUFDcEMsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUNoQixJQUFJLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxDQUFDO0FBQzNCLE1BQU0sTUFBTSxHQUFHLEVBQTRCLENBQUM7QUFDNUMsTUFBTSxZQUFZLEdBQUcsd0JBQWdELENBQUM7QUFFdEUsUUFBUSxDQUFDLGVBQWUsRUFBRSxHQUFHLEVBQUU7SUFDN0IsTUFBTSxrQkFBa0IsR0FBRztRQUN6QixXQUFXLEVBQUU7WUFDWCxVQUFVLEVBQUUsaUJBQWlCO1lBQzdCLFVBQVUsRUFBRSxpQkFBaUI7WUFDN0IsZ0JBQWdCLEVBQUUsTUFBTTtTQUN6QjtRQUNELGlCQUFpQixFQUFFO1lBQ2pCLE9BQU8sRUFBRSxvQkFBb0I7WUFDN0IsY0FBYyxFQUFFLHFCQUFxQjtTQUN0QztRQUNELFVBQVUsRUFBRTtZQUNWLGVBQWUsRUFBRSxrQkFBa0I7WUFDbkMsVUFBVSxFQUFFLGlCQUFpQjtTQUM5QjtLQUNGLENBQUM7SUFFRixVQUFVLENBQUMsR0FBRyxFQUFFO1FBQ2QsSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO1FBQ3JCLCtDQUErQztRQUMvQyxNQUFNLENBQUMsVUFBVSxDQUFDLGVBQWUsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUN4QyxpREFBaUQ7UUFDakQsWUFBWSxDQUFDLGtCQUFrQixDQUFDLENBQUMsT0FBZSxFQUFFLEVBQUU7WUFDbEQsSUFBSSxPQUFPLEtBQUssWUFBWSxFQUFFO2dCQUM1QixPQUFPLHFCQUFxQixDQUFDO2FBQzlCO1lBQ0QsSUFBSSxPQUFPLENBQUMsUUFBUSxDQUFDLFNBQVMsQ0FBQyxFQUFF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c0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgZnMgZnJvbSAnZnMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCB7IGV4ZWNTeW5jIH0gZnJvbSAnY2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQgeyBTZWNyZXRzTG9hZGVyIH0gZnJvbSAnLi4vbGliL3NlY3JldHMtbG9hZGVyJztcblxuLy8gTW9jayBmcyBhbmQgY2hpbGRfcHJvY2VzcyBtb2R1bGVzXG5qZXN0Lm1vY2soJ2ZzJyk7XG5qZXN0Lm1vY2soJ2NoaWxkX3Byb2Nlc3MnKTtcbmNvbnN0IG1vY2tGcyA9IGZzIGFzIGplc3QuTW9ja2VkPHR5cGVvZiBmcz47XG5jb25zdCBtb2NrRXhlY1N5bmMgPSBleGVjU3luYyBhcyBqZXN0Lk1vY2tlZEZ1bmN0aW9uPHR5cGVvZiBleGVjU3luYz47XG5cbmRlc2NyaWJlKCdTZWNyZXRzTG9hZGVyJywgKCkgPT4ge1xuICBjb25zdCBtb2NrU2VjcmV0c0NvbnRlbnQgPSB7XG4gICAgYXBwbGljYXRpb246IHtcbiAgICAgIHNlY3JldF9rZXk6ICd0ZXN0LXNlY3JldC1rZXknLFxuICAgICAgand0X3NlY3JldDogJ3Rlc3Qtand0LXNlY3JldCcsXG4gICAgICByZXF1aXJlZF9zZXR0aW5nOiAndGVzdCdcbiAgICB9LFxuICAgIGV4dGVybmFsX3NlcnZpY2VzOiB7XG4gICAgICBhcGlfa2V5OiAndGVzdC1hcGkta2V5LTEyMzQ1JyxcbiAgICAgIHdlYmhvb2tfc2VjcmV0OiAndGVzdC13ZWJob29rLXNlY3JldCdcbiAgICB9LFxuICAgIG1vbml0b3Jpbmc6IHtcbiAgICAgIGRhdGFkb2dfYXBpX2tleTogJ3Rlc3QtZGF0YWRvZy1rZXknLFxuICAgICAgc2VudHJ5X2RzbjogJ3Rlc3Qtc2VudHJ5LWRzbidcbiAgICB9XG4gIH07XG5cbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgamVzdC5jbGVhckFsbE1vY2tzKCk7XG4gICAgLy8gTW9jayBmcy5leGlzdHNTeW5jIHRvIHJldHVybiB0cnVlIGJ5IGRlZmF1bHRcbiAgICBtb2NrRnMuZXhpc3RzU3luYy5tb2NrUmV0dXJuVmFsdWUodHJ1ZSk7XG4gICAgLy8gTW9jayBleGVjU3luYyB0byBzaW11bGF0ZSBTT1BTIGJlaW5nIGF2YWlsYWJsZVxuICAgIG1vY2tFeGVjU3luYy5tb2NrSW1wbGVtZW50YXRpb24oKGNvbW1hbmQ6IHN0cmluZykgPT4ge1xuICAgICAgaWYgKGNvbW1hbmQgPT09ICd3aGljaCBzb3BzJykge1xuICAgICAgICByZXR1cm4gJy91c3IvbG9jYWwvYmluL3NvcHMnO1xuICAgICAgfVxuICAgICAgaWYgKGNvbW1hbmQuaW5jbHVkZXMoJ3NvcHMgLWQnKSkge1xuICAgICAgICAvLyBSZXR1cm4gZGVjcnlwdGVkIFlBTUwgY29udGVudFxuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkobW9ja1NlY3JldHNDb250ZW50KTtcbiAgICAgIH1cbiAgICAgIHRocm93IG5ldyBFcnJvcignQ29tbWFuZCBub3QgZm91bmQnKTtcbiAgICB9KTtcbiAgICAvLyBDbGVhciBhbnkgZW52aXJvbm1lbnQgdmFyaWFibGVzIHRoYXQgbWlnaHQgYWZmZWN0IHRlc3RzXG4gICAgZGVsZXRlIHByb2Nlc3MuZW52LkNJO1xuICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5HSVRIVUJfQUNUSU9OUztcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnYuSkVOS0lOU19VUkw7XG4gICAgZGVsZXRlIHByb2Nlc3MuZW52Lk5PREVfRU5WO1xuICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5FTlZJUk9OTUVOVDtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ2xvYWRTZWNyZXRzJywgKCkgPT4ge1xuICAgIHRlc3QoJ2xvYWRzIHNlY3JldHMgc3VjY2Vzc2Z1bGx5IGZyb20gU09QUycsICgpID0+IHtcbiAgICAgIG1vY2tGcy5yZWFkRmlsZVN5bmMubW9ja1JldHVyblZhbHVlKEpTT04uc3RyaW5naWZ5KG1vY2tTZWNyZXRzQ29udGVudCkpO1xuXG4gICAgICBjb25zdCBsb2FkZXIgPSBuZXcgU2VjcmV0c0xvYWRlcigndGVzdCcpO1xuICAgICAgY29uc3Qgc2VjcmV0cyA9IGxvYWRlci5sb2FkU2VjcmV0cygpO1xuXG4gICAgICBleHBlY3Qoc2VjcmV0cykudG9FcXVhbChtb2NrU2VjcmV0c0NvbnRlbnQpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnZmFsbHMgYmFjayB0byBwbGFpbnRleHQgd2hlbiBTT1BTIGVycm9yIG9jY3VycycsICgpID0+IHtcbiAgICAgIC8vIE1vY2sgZXhlY1N5bmMgdG8gdGhyb3cgYSBTT1BTIGVycm9yIGZpcnN0IHRpbWUsIHRoZW4gZnMucmVhZEZpbGVTeW5jIHN1Y2NlZWRzIGZvciBmYWxsYmFja1xuICAgICAgbW9ja0V4ZWNTeW5jLm1vY2tJbXBsZW1lbnRhdGlvbigoY29tbWFuZDogc3RyaW5nKSA9PiB7XG4gICAgICAgIGlmIChjb21tYW5kID09PSAnd2hpY2ggc29wcycpIHtcbiAgICAgICAgICByZXR1cm4gJy91c3IvbG9jYWwvYmluL3NvcHMnO1xuICAgICAgICB9XG4gICAgICAgIGlmIChjb21tYW5kLmluY2x1ZGVzKCdzb3BzIC1kJykpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3NvcHM6IGZhaWxlZCB0byBkZWNyeXB0Jyk7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDb21tYW5kIG5vdCBmb3VuZCcpO1xuICAgICAgfSk7XG4gICAgICBcbiAgICAgIC8vIE1vY2sgZnMucmVhZEZpbGVTeW5jIHRvIHJldHVybiB0aGUgcGxhaW50ZXh0IGNvbnRlbnQgZm9yIGZhbGxiYWNrXG4gICAgICBtb2NrRnMucmVhZEZpbGVTeW5jLm1vY2tSZXR1cm5WYWx1ZShKU09OLnN0cmluZ2lmeShtb2NrU2VjcmV0c0NvbnRlbnQpKTtcblxuICAgICAgY29uc3QgY29uc29sZVNweSA9IGplc3Quc3B5T24oY29uc29sZSwgJ3dhcm4nKS5tb2NrSW1wbGVtZW50YXRpb24oKTtcblxuICAgICAgY29uc3QgbG9hZGVyID0gbmV3IFNlY3JldHNMb2FkZXIoJ3Rlc3QnKTtcbiAgICAgIGNvbnN0IHNlY3JldHMgPSBsb2FkZXIubG9hZFNlY3JldHMoKTtcblxuICAgICAgZXhwZWN0KHNlY3JldHMpLnRvRXF1YWwobW9ja1NlY3JldHNDb250ZW50KTtcbiAgICAgIGV4cGVjdChjb25zb2xlU3B5KS50b0hhdmVCZWVuQ2FsbGVkV2l0aChcbiAgICAgICAgZXhwZWN0LnN0cmluZ0NvbnRhaW5pbmcoJ1NPUFMgbm90IGF2YWlsYWJsZSBvciBzZWNyZXRzIG5vdCBlbmNyeXB0ZWQnKVxuICAgICAgKTtcblxuICAgICAgY29uc29sZVNweS5tb2NrUmVzdG9yZSgpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndGhyb3dzIGVycm9yIGZvciBub24tU09QUyByZWxhdGVkIGVycm9ycycsICgpID0+IHtcbiAgICAgIC8vIE1vY2sgZXhlY1N5bmMgdG8gZmFpbCB3aXRoIGEgbm9uLVNPUFMgZXJyb3JcbiAgICAgIG1vY2tFeGVjU3luYy5tb2NrSW1wbGVtZW50YXRpb24oKGNvbW1hbmQ6IHN0cmluZykgPT4ge1xuICAgICAgICBpZiAoY29tbWFuZCA9PT0gJ3doaWNoIHNvcHMnKSB7XG4gICAgICAgICAgcmV0dXJuICcvdXNyL2xvY2FsL2Jpbi9zb3BzJztcbiAgICAgICAgfVxuICAgICAgICBpZiAoY29tbWFuZC5pbmNsdWRlcygnc29wcyAtZCcpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdGaWxlIG5vdCBmb3VuZCcpO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignQ29tbWFuZCBub3QgZm91bmQnKTtcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBsb2FkZXIgPSBuZXcgU2VjcmV0c0xvYWRlcigndGVzdCcpO1xuICAgICAgXG4gICAgICBleHBlY3QoKCkgPT4gbG9hZGVyLmxvYWRTZWNyZXRzKCkpLnRvVGhyb3coXG4gICAgICAgICdGYWlsZWQgdG8gbG9hZCBzZWNyZXRzIGZvciBlbnZpcm9ubWVudCB0ZXN0OiBFcnJvcjogRmlsZSBub3QgZm91bmQnXG4gICAgICApO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndGhyb3dzIGVycm9yIGZvciBtaXNzaW5nIHJlcXVpcmVkIHNlY3JldHMnLCAoKSA9PiB7XG4gICAgICBjb25zdCBpbmNvbXBsZXRlU2VjcmV0cyA9IHtcbiAgICAgICAgYXBwbGljYXRpb246IHtcbiAgICAgICAgICAvLyBtaXNzaW5nIHNlY3JldF9rZXlcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIFxuICAgICAgLy8gTW9jayBleGVjU3luYyB0byByZXR1cm4gdGhlIGluY29tcGxldGUgc2VjcmV0c1xuICAgICAgbW9ja0V4ZWNTeW5jLm1vY2tJbXBsZW1lbnRhdGlvbigoY29tbWFuZDogc3RyaW5nKSA9PiB7XG4gICAgICAgIGlmIChjb21tYW5kID09PSAnd2hpY2ggc29wcycpIHtcbiAgICAgICAgICByZXR1cm4gJy91c3IvbG9jYWwvYmluL3NvcHMnO1xuICAgICAgICB9XG4gICAgICAgIGlmIChjb21tYW5kLmluY2x1ZGVzKCdzb3BzIC1kJykpIHtcbiAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoaW5jb21wbGV0ZVNlY3JldHMpO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignQ29tbWFuZCBub3QgZm91bmQnKTtcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBsb2FkZXIgPSBuZXcgU2VjcmV0c0xvYWRlcigndGVzdCcpO1xuICAgICAgXG4gICAgICBleHBlY3QoKCkgPT4gbG9hZGVyLmxvYWRTZWNyZXRzKCkpLnRvVGhyb3coXG4gICAgICAgICdSZXF1aXJlZCBzZWNyZXQgbWlzc2luZzogYXBwbGljYXRpb24uc2VjcmV0X2tleSdcbiAgICAgICk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdsb2FkU2VjcmV0c1dpdGhGYWxsYmFjaycsICgpID0+IHtcbiAgICB0ZXN0KCdyZXR1cm5zIHNlY3JldHMgZnJvbSBsb2FkU2VjcmV0cyB3aGVuIGF2YWlsYWJsZScsICgpID0+IHtcbiAgICAgIC8vIFVzZSB0aGUgZGVmYXVsdCBtb2NrIHNldHVwIGZyb20gYmVmb3JlRWFjaCB3aGljaCBzdWNjZXNzZnVsbHkgcmV0dXJucyBzZWNyZXRzXG5cbiAgICAgIGNvbnN0IGxvYWRlciA9IG5ldyBTZWNyZXRzTG9hZGVyKCd0ZXN0Jyk7XG4gICAgICBjb25zdCBzZWNyZXRzID0gbG9hZGVyLmxvYWRTZWNyZXRzV2l0aEZhbGxiYWNrKCk7XG5cbiAgICAgIGV4cGVjdChzZWNyZXRzKS50b0VxdWFsKG1vY2tTZWNyZXRzQ29udGVudCk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdyZXR1cm5zIGZhbGxiYWNrIHNlY3JldHMgd2hlbiBsb2FkU2VjcmV0cyBmYWlscycsICgpID0+IHtcbiAgICAgIC8vIE1vY2sgZmlsZSBub3QgZXhpc3RpbmcgdG8gdHJpZ2dlciBmYWxsYmFjayBwYXRoXG4gICAgICBtb2NrRnMuZXhpc3RzU3luYy5tb2NrUmV0dXJuVmFsdWUoZmFsc2UpO1xuXG4gICAgICBjb25zdCBjb25zb2xlU3B5ID0gamVzdC5zcHlPbihjb25zb2xlLCAnd2FybicpLm1vY2tJbXBsZW1lbnRhdGlvbigpO1xuXG4gICAgICBjb25zdCBsb2FkZXIgPSBuZXcgU2VjcmV0c0xvYWRlcigndGVzdCcpO1xuICAgICAgY29uc3Qgc2VjcmV0cyA9IGxvYWRlci5sb2FkU2VjcmV0c1dpdGhGYWxsYmFjaygpO1xuXG4gICAgICAvLyBTaG91bGQgcmV0dXJuIGZhbGxiYWNrIHNlY3JldHMgd2l0aCB0ZXN0IGVudmlyb25tZW50XG4gICAgICBleHBlY3Qoc2VjcmV0cykudG9FcXVhbCh7XG4gICAgICAgIGFwcGxpY2F0aW9uOiB7XG4gICAgICAgICAgc2VjcmV0X2tleTogJ2RlZmF1bHQtc2VjcmV0JyxcbiAgICAgICAgICBqd3Rfc2VjcmV0OiAnZGVmYXVsdC1qd3Qtc2VjcmV0JyxcbiAgICAgICAgICByZXF1aXJlZF9zZXR0aW5nOiAndGVzdCdcbiAgICAgICAgfSxcbiAgICAgICAgZXh0ZXJuYWxfc2VydmljZXM6IHtcbiAgICAgICAgICBhcGlfa2V5OiAnJyxcbiAgICAgICAgICB3ZWJob29rX3NlY3JldDogJydcbiAgICAgICAgfSxcbiAgICAgICAgbW9uaXRvcmluZzoge1xuICAgICAgICAgIGRhdGFkb2dfYXBpX2tleTogJycsXG4gICAgICAgICAgc2VudHJ5X2RzbjogJydcbiAgICAgICAgfVxuICAgICAgfSk7XG5cbiAgICAgIGV4cGVjdChjb25zb2xlU3B5KS50b0hhdmVCZWVuQ2FsbGVkV2l0aChcbiAgICAgICAgZXhwZWN0LnN0cmluZ0NvbnRhaW5pbmcoJ0ZhaWxlZCB0byBsb2FkIFNPUFMgc2VjcmV0cywgdXNpbmcgZW52aXJvbm1lbnQgdmFyaWFibGVzIGZhbGxiYWNrJylcbiAgICAgICk7XG5cbiAgICAgIGNvbnNvbGVTcHkubW9ja1Jlc3RvcmUoKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ2dldFNlY3JldCcsICgpID0+IHtcbiAgICB0ZXN0KCdyZXRyaWV2ZXMgc2VjcmV0IGJ5IHBhdGgnLCAoKSA9PiB7XG4gICAgICAvLyBVc2UgdGhlIGRlZmF1bHQgbW9jayBzZXR1cCBmcm9tIGJlZm9yZUVhY2ggd2hpY2ggcmV0dXJucyBtb2NrU2VjcmV0c0NvbnRlbnRcbiAgICAgIGNvbnN0IGxvYWRlciA9IG5ldyBTZWNyZXRzTG9hZGVyKCd0ZXN0Jyk7XG4gICAgICBjb25zdCBzZWNyZXQgPSBsb2FkZXIuZ2V0U2VjcmV0KCdhcHBsaWNhdGlvbi5zZWNyZXRfa2V5Jyk7XG5cbiAgICAgIGV4cGVjdChzZWNyZXQpLnRvQmUoJ3Rlc3Qtc2VjcmV0LWtleScpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgncmV0cmlldmVzIG5lc3RlZCBzZWNyZXQgYnkgcGF0aCcsICgpID0+IHtcbiAgICAgIGNvbnN0IGxvYWRlciA9IG5ldyBTZWNyZXRzTG9hZGVyKCd0ZXN0Jyk7XG4gICAgICBjb25zdCBzZWNyZXQgPSBsb2FkZXIuZ2V0U2VjcmV0KCdleHRlcm5hbF9zZXJ2aWNlcy5hcGlfa2V5Jyk7XG5cbiAgICAgIGV4cGVjdChzZWNyZXQpLnRvQmUoJ3Rlc3QtYXBpLWtleS0xMjM0NScpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndGhyb3dzIGVycm9yIGZvciBub24tZXhpc3RlbnQgc2VjcmV0IHBhdGgnLCAoKSA9PiB7XG4gICAgICBjb25zdCBsb2FkZXIgPSBuZXcgU2VjcmV0c0xvYWRlcigndGVzdCcpO1xuICAgICAgXG4gICAgICBleHBlY3QoKCkgPT4gbG9hZGVyLmdldFNlY3JldCgnbm9uZXhpc3RlbnQuc2VjcmV0JykpLnRvVGhyb3coXG4gICAgICAgICdTZWNyZXQgbm90IGZvdW5kIG9yIG5vdCBhIHN0cmluZzogbm9uZXhpc3RlbnQuc2VjcmV0J1xuICAgICAgKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3Rocm93cyBlcnJvciBmb3Igbm9uLXN0cmluZyBzZWNyZXQgdmFsdWUnLCAoKSA9PiB7XG4gICAgICBjb25zdCBzZWNyZXRzV2l0aE9iamVjdCA9IHtcbiAgICAgICAgYXBwbGljYXRpb246IHtcbiAgICAgICAgICBjb25maWc6IHtcbiAgICAgICAgICAgIG5lc3RlZDogJ3ZhbHVlJ1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIFxuICAgICAgbW9ja0ZzLnJlYWRGaWxlU3luYy5tb2NrUmV0dXJuVmFsdWUoSlNPTi5zdHJpbmdpZnkoc2VjcmV0c1dpdGhPYmplY3QpKTtcblxuICAgICAgY29uc3QgbG9hZGVyID0gbmV3IFNlY3JldHNMb2FkZXIoJ3Rlc3QnKTtcbiAgICAgIFxuICAgICAgZXhwZWN0KCgpID0+IGxvYWRlci5nZXRTZWNyZXQoJ2FwcGxpY2F0aW9uLmNvbmZpZycpKS50b1Rocm93KFxuICAgICAgICAnU2VjcmV0IG5vdCBmb3VuZCBvciBub3QgYSBzdHJpbmc6IGFwcGxpY2F0aW9uLmNvbmZpZydcbiAgICAgICk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdleHBvcnRBc0VudlZhcnMnLCAoKSA9PiB7XG4gICAgdGVzdCgnZmxhdHRlbnMgc2VjcmV0cyB0byBlbnZpcm9ubWVudCB2YXJpYWJsZSBmb3JtYXQnLCAoKSA9PiB7XG4gICAgICBjb25zdCBsb2FkZXIgPSBuZXcgU2VjcmV0c0xvYWRlcigndGVzdCcpO1xuICAgICAgY29uc3QgZW52VmFycyA9IGxvYWRlci5leHBvcnRBc0VudlZhcnMoKTtcblxuICAgICAgZXhwZWN0KGVudlZhcnMpLnRvRXF1YWwoe1xuICAgICAgICAnQVBQTElDQVRJT05fU0VDUkVUX0tFWSc6ICd0ZXN0LXNlY3JldC1rZXknLFxuICAgICAgICAnQVBQTElDQVRJT05fSldUX1NFQ1JFVCc6ICd0ZXN0LWp3dC1zZWNyZXQnLFxuICAgICAgICAnQVBQTElDQVRJT05fUkVRVUlSRURfU0VUVElORyc6ICd0ZXN0JyxcbiAgICAgICAgJ0VYVEVSTkFMX1NFUlZJQ0VTX0FQSV9LRVknOiAndGVzdC1hcGkta2V5LTEyMzQ1JyxcbiAgICAgICAgJ0VYVEVSTkFMX1NFUlZJQ0VTX1dFQkhPT0tfU0VDUkVUJzogJ3Rlc3Qtd2ViaG9vay1zZWNyZXQnLFxuICAgICAgICAnTU9OSVRPUklOR19EQVRBRE9HX0FQSV9LRVknOiAndGVzdC1kYXRhZG9nLWtleScsXG4gICAgICAgICdNT05JVE9SSU5HX1NFTlRSWV9EU04nOiAndGVzdC1zZW50cnktZHNuJ1xuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdoYW5kbGVzIG5lc3RlZCBvYmplY3RzIGNvcnJlY3RseScsICgpID0+IHtcbiAgICAgIGNvbnN0IG5lc3RlZFNlY3JldHMgPSB7XG4gICAgICAgIGFwcGxpY2F0aW9uOiB7XG4gICAgICAgICAgc2VjcmV0X2tleTogJ3Rlc3Qtc2VjcmV0LWtleScsXG4gICAgICAgICAgcmVxdWlyZWRfc2V0dGluZzogJ3Rlc3QnICAvLyBJbmNsdWRlIHJlcXVpcmVkIGZpZWxkIHRvIHBhc3MgdmFsaWRhdGlvblxuICAgICAgICB9LFxuICAgICAgICBhcHA6IHtcbiAgICAgICAgICBhdXRoOiB7XG4gICAgICAgICAgICBqd3Q6IHtcbiAgICAgICAgICAgICAgc2VjcmV0OiAnand0LXNlY3JldCdcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH07XG5cbiAgICAgIC8vIE1vY2sgZXhlY1N5bmMgdG8gcmV0dXJuIG5lc3RlZCBzZWNyZXRzXG4gICAgICBtb2NrRXhlY1N5bmMubW9ja0ltcGxlbWVudGF0aW9uKChjb21tYW5kOiBzdHJpbmcpID0+IHtcbiAgICAgICAgaWYgKGNvbW1hbmQgPT09ICd3aGljaCBzb3BzJykge1xuICAgICAgICAgIHJldHVybiAnL3Vzci9sb2NhbC9iaW4vc29wcyc7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGNvbW1hbmQuaW5jbHVkZXMoJ3NvcHMgLWQnKSkge1xuICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShuZXN0ZWRTZWNyZXRzKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0NvbW1hbmQgbm90IGZvdW5kJyk7XG4gICAgICB9KTtcblxuICAgICAgY29uc3QgbG9hZGVyID0gbmV3IFNlY3JldHNMb2FkZXIoJ3Rlc3QnKTtcbiAgICAgIGNvbnN0IGVudlZhcnMgPSBsb2FkZXIuZXhwb3J0QXNFbnZWYXJzKCk7XG5cbiAgICAgIGV4cGVjdChlbnZWYXJzKS50b0VxdWFsKHtcbiAgICAgICAgJ0FQUExJQ0FUSU9OX1NFQ1JFVF9LRVknOiAndGVzdC1zZWNyZXQta2V5JyxcbiAgICAgICAgJ0FQUExJQ0FUSU9OX1JFUVVJUkVEX1NFVFRJTkcnOiAndGVzdCcsXG4gICAgICAgICdBUFBfQVVUSF9KV1RfU0VDUkVUJzogJ2p3dC1zZWNyZXQnXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ3N0YXRpYyBtZXRob2RzJywgKCkgPT4ge1xuICAgIHRlc3QoJ2lzQ0kgZGV0ZWN0cyBDSSBlbnZpcm9ubWVudCcsICgpID0+IHtcbiAgICAgIHByb2Nlc3MuZW52LkNJID0gJ3RydWUnO1xuICAgICAgZXhwZWN0KFNlY3JldHNMb2FkZXIuaXNDSSgpKS50b0JlKHRydWUpO1xuXG4gICAgICBkZWxldGUgcHJvY2Vzcy5lbnYuQ0k7XG4gICAgICBwcm9jZXNzLmVudi5HSVRIVUJfQUNUSU9OUyA9ICd0cnVlJztcbiAgICAgIGV4cGVjdChTZWNyZXRzTG9hZGVyLmlzQ0koKSkudG9CZSh0cnVlKTtcblxuICAgICAgZGVsZXRlIHByb2Nlc3MuZW52LkdJVEhVQl9BQ1RJT05TO1xuICAgICAgcHJvY2Vzcy5lbnYuSkVOS0lOU19VUkwgPSAnaHR0cDovL2plbmtpbnMuZXhhbXBsZS5jb20nO1xuICAgICAgZXhwZWN0KFNlY3JldHNMb2FkZXIuaXNDSSgpKS50b0JlKHRydWUpO1xuXG4gICAgICBkZWxldGUgcHJvY2Vzcy5lbnYuSkVOS0lOU19VUkw7XG4gICAgICBleHBlY3QoU2VjcmV0c0xvYWRlci5pc0NJKCkpLnRvQmUoZmFsc2UpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnZm9yRW52aXJvbm1lbnQgY3JlYXRlcyBsb2FkZXIgd2l0aCBzcGVjaWZpZWQgZW52aXJvbm1lbnQnLCAoKSA9PiB7XG4gICAgICBjb25zdCBsb2FkZXIgPSBTZWNyZXRzTG9hZGVyLmZvckVudmlyb25tZW50KCdwcm9kdWN0aW9uJyk7XG4gICAgICBleHBlY3QobG9hZGVyKS50b0JlSW5zdGFuY2VPZihTZWNyZXRzTG9hZGVyKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2ZvckVudmlyb25tZW50IHVzZXMgTk9ERV9FTlYgd2hlbiBubyBlbnZpcm9ubWVudCBzcGVjaWZpZWQnLCAoKSA9PiB7XG4gICAgICBwcm9jZXNzLmVudi5OT0RFX0VOViA9ICdkZXZlbG9wbWVudCc7XG4gICAgICBjb25zdCBsb2FkZXIgPSBTZWNyZXRzTG9hZGVyLmZvckVudmlyb25tZW50KCk7XG4gICAgICBleHBlY3QobG9hZGVyKS50b0JlSW5zdGFuY2VPZihTZWNyZXRzTG9hZGVyKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2ZvckVudmlyb25tZW50IHVzZXMgRU5WSVJPTk1FTlQgd2hlbiBOT0RFX0VOViBub3Qgc2V0JywgKCkgPT4ge1xuICAgICAgcHJvY2Vzcy5lbnYuRU5WSVJPTk1FTlQgPSAnc3RhZ2luZyc7XG4gICAgICBjb25zdCBsb2FkZXIgPSBTZWNyZXRzTG9hZGVyLmZvckVudmlyb25tZW50KCk7XG4gICAgICBleHBlY3QobG9hZGVyKS50b0JlSW5zdGFuY2VPZihTZWNyZXRzTG9hZGVyKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2ZvckVudmlyb25tZW50IGRlZmF1bHRzIHRvIGRldiB3aGVuIG5vIGVudmlyb25tZW50IHZhcmlhYmxlcyBzZXQnLCAoKSA9PiB7XG4gICAgICBjb25zdCBsb2FkZXIgPSBTZWNyZXRzTG9hZGVyLmZvckVudmlyb25tZW50KCk7XG4gICAgICBleHBlY3QobG9hZGVyKS50b0JlSW5zdGFuY2VPZihTZWNyZXRzTG9hZGVyKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ2Vycm9yIGhhbmRsaW5nIGVkZ2UgY2FzZXMnLCAoKSA9PiB7XG4gICAgdGVzdCgnaGFuZGxlcyBub24tRXJyb3IgZXhjZXB0aW9ucyBpbiBsb2FkU2VjcmV0cycsICgpID0+IHtcbiAgICAgIG1vY2tFeGVjU3luYy5tb2NrSW1wbGVtZW50YXRpb24oKGNvbW1hbmQ6IHN0cmluZykgPT4ge1xuICAgICAgICBpZiAoY29tbWFuZCA9PT0gJ3doaWNoIHNvcHMnKSB7XG4gICAgICAgICAgcmV0dXJuICcvdXNyL2xvY2FsL2Jpbi9zb3BzJztcbiAgICAgICAgfVxuICAgICAgICBpZiAoY29tbWFuZC5pbmNsdWRlcygnc29wcyAtZCcpKSB7XG4gICAgICAgICAgdGhyb3cgJ3N0cmluZyBlcnJvcic7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDb21tYW5kIG5vdCBmb3VuZCcpO1xuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IGxvYWRlciA9IG5ldyBTZWNyZXRzTG9hZGVyKCd0ZXN0Jyk7XG4gICAgICBcbiAgICAgIGV4cGVjdCgoKSA9PiBsb2FkZXIubG9hZFNlY3JldHMoKSkudG9UaHJvdyhcbiAgICAgICAgJ0ZhaWxlZCB0byBsb2FkIHNlY3JldHMgZm9yIGVudmlyb25tZW50IHRlc3Q6IHN0cmluZyBlcnJvcidcbiAgICAgICk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdoYW5kbGVzIG51bGwgc2VjcmV0IHZhbHVlcyBpbiB2YWxpZGF0aW9uJywgKCkgPT4ge1xuICAgICAgY29uc3Qgc2VjcmV0c1dpdGhOdWxsID0ge1xuICAgICAgICBhcHBsaWNhdGlvbjoge1xuICAgICAgICAgIHNlY3JldF9rZXk6IG51bGwsXG4gICAgICAgICAgcmVxdWlyZWRfc2V0dGluZzogJ3Rlc3QnXG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBcbiAgICAgIG1vY2tFeGVjU3luYy5tb2NrSW1wbGVtZW50YXRpb24oKGNvbW1hbmQ6IHN0cmluZykgPT4ge1xuICAgICAgICBpZiAoY29tbWFuZCA9PT0gJ3doaWNoIHNvcHMnKSB7XG4gICAgICAgICAgcmV0dXJuICcvdXNyL2xvY2FsL2Jpbi9zb3BzJztcbiAgICAgICAgfVxuICAgICAgICBpZiAoY29tbWFuZC5pbmNsdWRlcygnc29wcyAtZCcpKSB7XG4gICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHNlY3JldHNXaXRoTnVsbCk7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDb21tYW5kIG5vdCBmb3VuZCcpO1xuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IGxvYWRlciA9IG5ldyBTZWNyZXRzTG9hZGVyKCd0ZXN0Jyk7XG4gICAgICBcbiAgICAgIGV4cGVjdCgoKSA9PiBsb2FkZXIubG9hZFNlY3JldHMoKSkudG9UaHJvdyhcbiAgICAgICAgJ1JlcXVpcmVkIHNlY3JldCBtaXNzaW5nOiBhcHBsaWNhdGlvbi5zZWNyZXRfa2V5J1xuICAgICAgKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2hhbmRsZXMgdW5kZWZpbmVkIHNlY3JldCB2YWx1ZXMgaW4gdmFsaWRhdGlvbicsICgpID0+IHtcbiAgICAgIGNvbnN0IHNlY3JldHNXaXRoVW5kZWZpbmVkID0ge1xuICAgICAgICBhcHBsaWNhdGlvbjoge1xuICAgICAgICAgIHNlY3JldF9rZXk6IHVuZGVmaW5lZCxcbiAgICAgICAgICByZXF1aXJlZF9zZXR0aW5nOiAndGVzdCdcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIFxuICAgICAgbW9ja0V4ZWNTeW5jLm1vY2tJbXBsZW1lbnRhdGlvbigoY29tbWFuZDogc3RyaW5nKSA9PiB7XG4gICAgICAgIGlmIChjb21tYW5kID09PSAnd2hpY2ggc29wcycpIHtcbiAgICAgICAgICByZXR1cm4gJy91c3IvbG9jYWwvYmluL3NvcHMnO1xuICAgICAgICB9XG4gICAgICAgIGlmIChjb21tYW5kLmluY2x1ZGVzKCdzb3BzIC1kJykpIHtcbiAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoc2VjcmV0c1dpdGhVbmRlZmluZWQpO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignQ29tbWFuZCBub3QgZm91bmQnKTtcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBsb2FkZXIgPSBuZXcgU2VjcmV0c0xvYWRlcigndGVzdCcpO1xuICAgICAgXG4gICAgICBleHBlY3QoKCkgPT4gbG9hZGVyLmxvYWRTZWNyZXRzKCkpLnRvVGhyb3coXG4gICAgICAgICdSZXF1aXJlZCBzZWNyZXQgbWlzc2luZzogYXBwbGljYXRpb24uc2VjcmV0X2tleSdcbiAgICAgICk7XG4gICAgfSk7XG4gIH0pO1xufSk7Il19