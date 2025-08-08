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
        secret_key: 'test-secret-key',
        jwt_secret: 'test-jwt-secret',
        required_setting: 'test',
        api_key: 'test-api-key-12345',
        webhook_secret: 'test-webhook-secret',
        datadog_api_key: 'test-datadog-key',
        sentry_dsn: 'test-sentry-dsn'
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
            expect(() => loader.loadSecrets()).toThrow('Required secret missing: secret_key');
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
                secret_key: 'default-secret',
                jwt_secret: 'default-jwt-secret',
                required_setting: 'test',
                api_key: '',
                webhook_secret: '',
                datadog_api_key: '',
                sentry_dsn: ''
            });
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load SOPS secrets, using environment variables fallback'));
            consoleSpy.mockRestore();
        });
    });
    describe('getSecret', () => {
        test('retrieves secret by path', () => {
            // Use the default mock setup from beforeEach which returns mockSecretsContent
            const loader = new secrets_loader_1.SecretsLoader('test');
            const secret = loader.getSecret('secret_key');
            expect(secret).toBe('test-secret-key');
        });
        test('retrieves secret by path', () => {
            const loader = new secrets_loader_1.SecretsLoader('test');
            const secret = loader.getSecret('api_key');
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
                'SECRET_KEY': 'test-secret-key',
                'JWT_SECRET': 'test-jwt-secret',
                'REQUIRED_SETTING': 'test',
                'API_KEY': 'test-api-key-12345',
                'WEBHOOK_SECRET': 'test-webhook-secret',
                'DATADOG_API_KEY': 'test-datadog-key',
                'SENTRY_DSN': 'test-sentry-dsn'
            });
        });
        test('handles flat structure correctly', () => {
            const loader = new secrets_loader_1.SecretsLoader('test');
            const envVars = loader.exportAsEnvVars();
            // Should return flat structure as environment variables
            expect(envVars).toEqual({
                'SECRET_KEY': 'test-secret-key',
                'JWT_SECRET': 'test-jwt-secret',
                'REQUIRED_SETTING': 'test',
                'API_KEY': 'test-api-key-12345',
                'WEBHOOK_SECRET': 'test-webhook-secret',
                'DATADOG_API_KEY': 'test-datadog-key',
                'SENTRY_DSN': 'test-sentry-dsn'
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
            expect(() => loader.loadSecrets()).toThrow('Required secret missing: secret_key');
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
            expect(() => loader.loadSecrets()).toThrow('Required secret missing: secret_key');
        });
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VjcmV0cy1sb2FkZXIudGVzdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNlY3JldHMtbG9hZGVyLnRlc3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSx5QkFBeUI7QUFFekIsaURBQXlDO0FBQ3pDLDBEQUFzRDtBQUV0RCxvQ0FBb0M7QUFDcEMsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUNoQixJQUFJLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxDQUFDO0FBQzNCLE1BQU0sTUFBTSxHQUFHLEVBQTRCLENBQUM7QUFDNUMsTUFBTSxZQUFZLEdBQUcsd0JBQWdELENBQUM7QUFFdEUsUUFBUSxDQUFDLGVBQWUsRUFBRSxHQUFHLEVBQUU7SUFDN0IsTUFBTSxrQkFBa0IsR0FBRztRQUN6QixVQUFVLEVBQUUsaUJBQWlCO1FBQzdCLFVBQVUsRUFBRSxpQkFBaUI7UUFDN0IsZ0JBQWdCLEVBQUUsTUFBTTtRQUN4QixPQUFPLEVBQUUsb0JBQW9CO1FBQzdCLGNBQWMsRUFBRSxxQkFBcUI7UUFDckMsZUFBZSxFQUFFLGtCQUFrQjtRQUNuQyxVQUFVLEVBQUUsaUJBQWlCO0tBQzlCLENBQUM7SUFFRixVQUFVLENBQUMsR0FBRyxFQUFFO1FBQ2QsSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO1FBQ3JCLCtDQUErQztRQUMvQyxNQUFNLENBQUMsVUFBVSxDQUFDLGVBQWUsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUN4QyxpREFBaUQ7UUFDakQsWUFBWSxDQUFDLGtCQUFrQixDQUFDLENBQUMsT0FBZSxFQUFFLEVBQUU7WUFDbEQsSUFBSSxPQUFPLEtBQUssWUFBWSxFQUFFO2dCQUM1QixPQUFPLHFCQUFxQixDQUFDO2FBQzlCO1lBQ0QsSUFBSSxPQUFPLENBQUMsUUFBUSxDQUFDLFNBQVMsQ0FBQyxFQUFFO2dCQUMvQixnQ0FBZ0M7Z0JBQ2hDLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFD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QzlCO2dCQUNELElBQUksT0FBTyxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUMsRUFBRTtvQkFDL0IsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLG9CQUFvQixDQUFDLENBQUM7aUJBQzdDO2dCQUNELE1BQU0sSUFBSSxLQUFLLENBQUMsbUJBQW1CLENBQUMsQ0FBQztZQUN2QyxDQUFDLENBQUMsQ0FBQztZQUVILE1BQU0sTUFBTSxHQUFHLElBQUksOEJBQWEsQ0FBQyxNQUFNLENBQUMsQ0FBQztZQUV6QyxNQUFNLENBQUMsR0FBRyxFQUFFLENBQUMsTUFBTSxDQUFDLFdBQVcsRUFBRSxDQUFDLENBQUMsT0FBTyxDQUN4QyxxQ0FBcUMsQ0FDdEMsQ0FBQztRQUNKLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGZzIGZyb20gJ2ZzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBleGVjU3luYyB9IGZyb20gJ2NoaWxkX3Byb2Nlc3MnO1xuaW1wb3J0IHsgU2VjcmV0c0xvYWRlciB9IGZyb20gJy4uL2xpYi9zZWNyZXRzLWxvYWRlcic7XG5cbi8vIE1vY2sgZnMgYW5kIGNoaWxkX3Byb2Nlc3MgbW9kdWxlc1xuamVzdC5tb2NrKCdmcycpO1xuamVzdC5tb2NrKCdjaGlsZF9wcm9jZXNzJyk7XG5jb25zdCBtb2NrRnMgPSBmcyBhcyBqZXN0Lk1vY2tlZDx0eXBlb2YgZnM+O1xuY29uc3QgbW9ja0V4ZWNTeW5jID0gZXhlY1N5bmMgYXMgamVzdC5Nb2NrZWRGdW5jdGlvbjx0eXBlb2YgZXhlY1N5bmM+O1xuXG5kZXNjcmliZSgnU2VjcmV0c0xvYWRlcicsICgpID0+IHtcbiAgY29uc3QgbW9ja1NlY3JldHNDb250ZW50ID0ge1xuICAgIHNlY3JldF9rZXk6ICd0ZXN0LXNlY3JldC1rZXknLFxuICAgIGp3dF9zZWNyZXQ6ICd0ZXN0LWp3dC1zZWNyZXQnLFxuICAgIHJlcXVpcmVkX3NldHRpbmc6ICd0ZXN0JyxcbiAgICBhcGlfa2V5OiAndGVzdC1hcGkta2V5LTEyMzQ1JyxcbiAgICB3ZWJob29rX3NlY3JldDogJ3Rlc3Qtd2ViaG9vay1zZWNyZXQnLFxuICAgIGRhdGFkb2dfYXBpX2tleTogJ3Rlc3QtZGF0YWRvZy1rZXknLFxuICAgIHNlbnRyeV9kc246ICd0ZXN0LXNlbnRyeS1kc24nXG4gIH07XG5cbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgamVzdC5jbGVhckFsbE1vY2tzKCk7XG4gICAgLy8gTW9jayBmcy5leGlzdHNTeW5jIHRvIHJldHVybiB0cnVlIGJ5IGRlZmF1bHRcbiAgICBtb2NrRnMuZXhpc3RzU3luYy5tb2NrUmV0dXJuVmFsdWUodHJ1ZSk7XG4gICAgLy8gTW9jayBleGVjU3luYyB0byBzaW11bGF0ZSBTT1BTIGJlaW5nIGF2YWlsYWJsZVxuICAgIG1vY2tFeGVjU3luYy5tb2NrSW1wbGVtZW50YXRpb24oKGNvbW1hbmQ6IHN0cmluZykgPT4ge1xuICAgICAgaWYgKGNvbW1hbmQgPT09ICd3aGljaCBzb3BzJykge1xuICAgICAgICByZXR1cm4gJy91c3IvbG9jYWwvYmluL3NvcHMnO1xuICAgICAgfVxuICAgICAgaWYgKGNvbW1hbmQuaW5jbHVkZXMoJ3NvcHMgLWQnKSkge1xuICAgICAgICAvLyBSZXR1cm4gZGVjcnlwdGVkIFlBTUwgY29udGVudFxuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkobW9ja1NlY3JldHNDb250ZW50KTtcbiAgICAgIH1cbiAgICAgIHRocm93IG5ldyBFcnJvcignQ29tbWFuZCBub3QgZm91bmQnKTtcbiAgICB9KTtcbiAgICAvLyBDbGVhciBhbnkgZW52aXJvbm1lbnQgdmFyaWFibGVzIHRoYXQgbWlnaHQgYWZmZWN0IHRlc3RzXG4gICAgZGVsZXRlIHByb2Nlc3MuZW52LkNJO1xuICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5HSVRIVUJfQUNUSU9OUztcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnYuSkVOS0lOU19VUkw7XG4gICAgZGVsZXRlIHByb2Nlc3MuZW52Lk5PREVfRU5WO1xuICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5FTlZJUk9OTUVOVDtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ2xvYWRTZWNyZXRzJywgKCkgPT4ge1xuICAgIHRlc3QoJ2xvYWRzIHNlY3JldHMgc3VjY2Vzc2Z1bGx5IGZyb20gU09QUycsICgpID0+IHtcbiAgICAgIG1vY2tGcy5yZWFkRmlsZVN5bmMubW9ja1JldHVyblZhbHVlKEpTT04uc3RyaW5naWZ5KG1vY2tTZWNyZXRzQ29udGVudCkpO1xuXG4gICAgICBjb25zdCBsb2FkZXIgPSBuZXcgU2VjcmV0c0xvYWRlcigndGVzdCcpO1xuICAgICAgY29uc3Qgc2VjcmV0cyA9IGxvYWRlci5sb2FkU2VjcmV0cygpO1xuXG4gICAgICBleHBlY3Qoc2VjcmV0cykudG9FcXVhbChtb2NrU2VjcmV0c0NvbnRlbnQpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnZmFsbHMgYmFjayB0byBwbGFpbnRleHQgd2hlbiBTT1BTIGVycm9yIG9jY3VycycsICgpID0+IHtcbiAgICAgIC8vIE1vY2sgZXhlY1N5bmMgdG8gdGhyb3cgYSBTT1BTIGVycm9yIGZpcnN0IHRpbWUsIHRoZW4gZnMucmVhZEZpbGVTeW5jIHN1Y2NlZWRzIGZvciBmYWxsYmFja1xuICAgICAgbW9ja0V4ZWNTeW5jLm1vY2tJbXBsZW1lbnRhdGlvbigoY29tbWFuZDogc3RyaW5nKSA9PiB7XG4gICAgICAgIGlmIChjb21tYW5kID09PSAnd2hpY2ggc29wcycpIHtcbiAgICAgICAgICByZXR1cm4gJy91c3IvbG9jYWwvYmluL3NvcHMnO1xuICAgICAgICB9XG4gICAgICAgIGlmIChjb21tYW5kLmluY2x1ZGVzKCdzb3BzIC1kJykpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3NvcHM6IGZhaWxlZCB0byBkZWNyeXB0Jyk7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDb21tYW5kIG5vdCBmb3VuZCcpO1xuICAgICAgfSk7XG4gICAgICBcbiAgICAgIC8vIE1vY2sgZnMucmVhZEZpbGVTeW5jIHRvIHJldHVybiB0aGUgcGxhaW50ZXh0IGNvbnRlbnQgZm9yIGZhbGxiYWNrXG4gICAgICBtb2NrRnMucmVhZEZpbGVTeW5jLm1vY2tSZXR1cm5WYWx1ZShKU09OLnN0cmluZ2lmeShtb2NrU2VjcmV0c0NvbnRlbnQpKTtcblxuICAgICAgY29uc3QgY29uc29sZVNweSA9IGplc3Quc3B5T24oY29uc29sZSwgJ3dhcm4nKS5tb2NrSW1wbGVtZW50YXRpb24oKTtcblxuICAgICAgY29uc3QgbG9hZGVyID0gbmV3IFNlY3JldHNMb2FkZXIoJ3Rlc3QnKTtcbiAgICAgIGNvbnN0IHNlY3JldHMgPSBsb2FkZXIubG9hZFNlY3JldHMoKTtcblxuICAgICAgZXhwZWN0KHNlY3JldHMpLnRvRXF1YWwobW9ja1NlY3JldHNDb250ZW50KTtcbiAgICAgIGV4cGVjdChjb25zb2xlU3B5KS50b0hhdmVCZWVuQ2FsbGVkV2l0aChcbiAgICAgICAgZXhwZWN0LnN0cmluZ0NvbnRhaW5pbmcoJ1NPUFMgbm90IGF2YWlsYWJsZSBvciBzZWNyZXRzIG5vdCBlbmNyeXB0ZWQnKVxuICAgICAgKTtcblxuICAgICAgY29uc29sZVNweS5tb2NrUmVzdG9yZSgpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndGhyb3dzIGVycm9yIGZvciBub24tU09QUyByZWxhdGVkIGVycm9ycycsICgpID0+IHtcbiAgICAgIC8vIE1vY2sgZXhlY1N5bmMgdG8gZmFpbCB3aXRoIGEgbm9uLVNPUFMgZXJyb3JcbiAgICAgIG1vY2tFeGVjU3luYy5tb2NrSW1wbGVtZW50YXRpb24oKGNvbW1hbmQ6IHN0cmluZykgPT4ge1xuICAgICAgICBpZiAoY29tbWFuZCA9PT0gJ3doaWNoIHNvcHMnKSB7XG4gICAgICAgICAgcmV0dXJuICcvdXNyL2xvY2FsL2Jpbi9zb3BzJztcbiAgICAgICAgfVxuICAgICAgICBpZiAoY29tbWFuZC5pbmNsdWRlcygnc29wcyAtZCcpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdGaWxlIG5vdCBmb3VuZCcpO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignQ29tbWFuZCBub3QgZm91bmQnKTtcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBsb2FkZXIgPSBuZXcgU2VjcmV0c0xvYWRlcigndGVzdCcpO1xuICAgICAgXG4gICAgICBleHBlY3QoKCkgPT4gbG9hZGVyLmxvYWRTZWNyZXRzKCkpLnRvVGhyb3coXG4gICAgICAgICdGYWlsZWQgdG8gbG9hZCBzZWNyZXRzIGZvciBlbnZpcm9ubWVudCB0ZXN0OiBFcnJvcjogRmlsZSBub3QgZm91bmQnXG4gICAgICApO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndGhyb3dzIGVycm9yIGZvciBtaXNzaW5nIHJlcXVpcmVkIHNlY3JldHMnLCAoKSA9PiB7XG4gICAgICBjb25zdCBpbmNvbXBsZXRlU2VjcmV0cyA9IHtcbiAgICAgICAgYXBwbGljYXRpb246IHtcbiAgICAgICAgICAvLyBtaXNzaW5nIHNlY3JldF9rZXlcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIFxuICAgICAgLy8gTW9jayBleGVjU3luYyB0byByZXR1cm4gdGhlIGluY29tcGxldGUgc2VjcmV0c1xuICAgICAgbW9ja0V4ZWNTeW5jLm1vY2tJbXBsZW1lbnRhdGlvbigoY29tbWFuZDogc3RyaW5nKSA9PiB7XG4gICAgICAgIGlmIChjb21tYW5kID09PSAnd2hpY2ggc29wcycpIHtcbiAgICAgICAgICByZXR1cm4gJy91c3IvbG9jYWwvYmluL3NvcHMnO1xuICAgICAgICB9XG4gICAgICAgIGlmIChjb21tYW5kLmluY2x1ZGVzKCdzb3BzIC1kJykpIHtcbiAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoaW5jb21wbGV0ZVNlY3JldHMpO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignQ29tbWFuZCBub3QgZm91bmQnKTtcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBsb2FkZXIgPSBuZXcgU2VjcmV0c0xvYWRlcigndGVzdCcpO1xuICAgICAgXG4gICAgICBleHBlY3QoKCkgPT4gbG9hZGVyLmxvYWRTZWNyZXRzKCkpLnRvVGhyb3coXG4gICAgICAgICdSZXF1aXJlZCBzZWNyZXQgbWlzc2luZzogc2VjcmV0X2tleSdcbiAgICAgICk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdsb2FkU2VjcmV0c1dpdGhGYWxsYmFjaycsICgpID0+IHtcbiAgICB0ZXN0KCdyZXR1cm5zIHNlY3JldHMgZnJvbSBsb2FkU2VjcmV0cyB3aGVuIGF2YWlsYWJsZScsICgpID0+IHtcbiAgICAgIC8vIFVzZSB0aGUgZGVmYXVsdCBtb2NrIHNldHVwIGZyb20gYmVmb3JlRWFjaCB3aGljaCBzdWNjZXNzZnVsbHkgcmV0dXJucyBzZWNyZXRzXG5cbiAgICAgIGNvbnN0IGxvYWRlciA9IG5ldyBTZWNyZXRzTG9hZGVyKCd0ZXN0Jyk7XG4gICAgICBjb25zdCBzZWNyZXRzID0gbG9hZGVyLmxvYWRTZWNyZXRzV2l0aEZhbGxiYWNrKCk7XG5cbiAgICAgIGV4cGVjdChzZWNyZXRzKS50b0VxdWFsKG1vY2tTZWNyZXRzQ29udGVudCk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdyZXR1cm5zIGZhbGxiYWNrIHNlY3JldHMgd2hlbiBsb2FkU2VjcmV0cyBmYWlscycsICgpID0+IHtcbiAgICAgIC8vIE1vY2sgZmlsZSBub3QgZXhpc3RpbmcgdG8gdHJpZ2dlciBmYWxsYmFjayBwYXRoXG4gICAgICBtb2NrRnMuZXhpc3RzU3luYy5tb2NrUmV0dXJuVmFsdWUoZmFsc2UpO1xuXG4gICAgICBjb25zdCBjb25zb2xlU3B5ID0gamVzdC5zcHlPbihjb25zb2xlLCAnd2FybicpLm1vY2tJbXBsZW1lbnRhdGlvbigpO1xuXG4gICAgICBjb25zdCBsb2FkZXIgPSBuZXcgU2VjcmV0c0xvYWRlcigndGVzdCcpO1xuICAgICAgY29uc3Qgc2VjcmV0cyA9IGxvYWRlci5sb2FkU2VjcmV0c1dpdGhGYWxsYmFjaygpO1xuXG4gICAgICAvLyBTaG91bGQgcmV0dXJuIGZhbGxiYWNrIHNlY3JldHMgd2l0aCB0ZXN0IGVudmlyb25tZW50XG4gICAgICBleHBlY3Qoc2VjcmV0cykudG9FcXVhbCh7XG4gICAgICAgIHNlY3JldF9rZXk6ICdkZWZhdWx0LXNlY3JldCcsXG4gICAgICAgIGp3dF9zZWNyZXQ6ICdkZWZhdWx0LWp3dC1zZWNyZXQnLFxuICAgICAgICByZXF1aXJlZF9zZXR0aW5nOiAndGVzdCcsXG4gICAgICAgIGFwaV9rZXk6ICcnLFxuICAgICAgICB3ZWJob29rX3NlY3JldDogJycsXG4gICAgICAgIGRhdGFkb2dfYXBpX2tleTogJycsXG4gICAgICAgIHNlbnRyeV9kc246ICcnXG4gICAgICB9KTtcblxuICAgICAgZXhwZWN0KGNvbnNvbGVTcHkpLnRvSGF2ZUJlZW5DYWxsZWRXaXRoKFxuICAgICAgICBleHBlY3Quc3RyaW5nQ29udGFpbmluZygnRmFpbGVkIHRvIGxvYWQgU09QUyBzZWNyZXRzLCB1c2luZyBlbnZpcm9ubWVudCB2YXJpYWJsZXMgZmFsbGJhY2snKVxuICAgICAgKTtcblxuICAgICAgY29uc29sZVNweS5tb2NrUmVzdG9yZSgpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnZ2V0U2VjcmV0JywgKCkgPT4ge1xuICAgIHRlc3QoJ3JldHJpZXZlcyBzZWNyZXQgYnkgcGF0aCcsICgpID0+IHtcbiAgICAgIC8vIFVzZSB0aGUgZGVmYXVsdCBtb2NrIHNldHVwIGZyb20gYmVmb3JlRWFjaCB3aGljaCByZXR1cm5zIG1vY2tTZWNyZXRzQ29udGVudFxuICAgICAgY29uc3QgbG9hZGVyID0gbmV3IFNlY3JldHNMb2FkZXIoJ3Rlc3QnKTtcbiAgICAgIGNvbnN0IHNlY3JldCA9IGxvYWRlci5nZXRTZWNyZXQoJ3NlY3JldF9rZXknKTtcblxuICAgICAgZXhwZWN0KHNlY3JldCkudG9CZSgndGVzdC1zZWNyZXQta2V5Jyk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdyZXRyaWV2ZXMgc2VjcmV0IGJ5IHBhdGgnLCAoKSA9PiB7XG4gICAgICBjb25zdCBsb2FkZXIgPSBuZXcgU2VjcmV0c0xvYWRlcigndGVzdCcpO1xuICAgICAgY29uc3Qgc2VjcmV0ID0gbG9hZGVyLmdldFNlY3JldCgnYXBpX2tleScpO1xuXG4gICAgICBleHBlY3Qoc2VjcmV0KS50b0JlKCd0ZXN0LWFwaS1rZXktMTIzNDUnKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3Rocm93cyBlcnJvciBmb3Igbm9uLWV4aXN0ZW50IHNlY3JldCBwYXRoJywgKCkgPT4ge1xuICAgICAgY29uc3QgbG9hZGVyID0gbmV3IFNlY3JldHNMb2FkZXIoJ3Rlc3QnKTtcbiAgICAgIFxuICAgICAgZXhwZWN0KCgpID0+IGxvYWRlci5nZXRTZWNyZXQoJ25vbmV4aXN0ZW50LnNlY3JldCcpKS50b1Rocm93KFxuICAgICAgICAnU2VjcmV0IG5vdCBmb3VuZCBvciBub3QgYSBzdHJpbmc6IG5vbmV4aXN0ZW50LnNlY3JldCdcbiAgICAgICk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCd0aHJvd3MgZXJyb3IgZm9yIG5vbi1zdHJpbmcgc2VjcmV0IHZhbHVlJywgKCkgPT4ge1xuICAgICAgY29uc3Qgc2VjcmV0c1dpdGhPYmplY3QgPSB7XG4gICAgICAgIGFwcGxpY2F0aW9uOiB7XG4gICAgICAgICAgY29uZmlnOiB7XG4gICAgICAgICAgICBuZXN0ZWQ6ICd2YWx1ZSdcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBcbiAgICAgIG1vY2tGcy5yZWFkRmlsZVN5bmMubW9ja1JldHVyblZhbHVlKEpTT04uc3RyaW5naWZ5KHNlY3JldHNXaXRoT2JqZWN0KSk7XG5cbiAgICAgIGNvbnN0IGxvYWRlciA9IG5ldyBTZWNyZXRzTG9hZGVyKCd0ZXN0Jyk7XG4gICAgICBcbiAgICAgIGV4cGVjdCgoKSA9PiBsb2FkZXIuZ2V0U2VjcmV0KCdhcHBsaWNhdGlvbi5jb25maWcnKSkudG9UaHJvdyhcbiAgICAgICAgJ1NlY3JldCBub3QgZm91bmQgb3Igbm90IGEgc3RyaW5nOiBhcHBsaWNhdGlvbi5jb25maWcnXG4gICAgICApO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnZXhwb3J0QXNFbnZWYXJzJywgKCkgPT4ge1xuICAgIHRlc3QoJ2ZsYXR0ZW5zIHNlY3JldHMgdG8gZW52aXJvbm1lbnQgdmFyaWFibGUgZm9ybWF0JywgKCkgPT4ge1xuICAgICAgY29uc3QgbG9hZGVyID0gbmV3IFNlY3JldHNMb2FkZXIoJ3Rlc3QnKTtcbiAgICAgIGNvbnN0IGVudlZhcnMgPSBsb2FkZXIuZXhwb3J0QXNFbnZWYXJzKCk7XG5cbiAgICAgIGV4cGVjdChlbnZWYXJzKS50b0VxdWFsKHtcbiAgICAgICAgJ1NFQ1JFVF9LRVknOiAndGVzdC1zZWNyZXQta2V5JyxcbiAgICAgICAgJ0pXVF9TRUNSRVQnOiAndGVzdC1qd3Qtc2VjcmV0JyxcbiAgICAgICAgJ1JFUVVJUkVEX1NFVFRJTkcnOiAndGVzdCcsXG4gICAgICAgICdBUElfS0VZJzogJ3Rlc3QtYXBpLWtleS0xMjM0NScsXG4gICAgICAgICdXRUJIT09LX1NFQ1JFVCc6ICd0ZXN0LXdlYmhvb2stc2VjcmV0JyxcbiAgICAgICAgJ0RBVEFET0dfQVBJX0tFWSc6ICd0ZXN0LWRhdGFkb2cta2V5JyxcbiAgICAgICAgJ1NFTlRSWV9EU04nOiAndGVzdC1zZW50cnktZHNuJ1xuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdoYW5kbGVzIGZsYXQgc3RydWN0dXJlIGNvcnJlY3RseScsICgpID0+IHtcbiAgICAgIGNvbnN0IGxvYWRlciA9IG5ldyBTZWNyZXRzTG9hZGVyKCd0ZXN0Jyk7XG4gICAgICBjb25zdCBlbnZWYXJzID0gbG9hZGVyLmV4cG9ydEFzRW52VmFycygpO1xuXG4gICAgICAvLyBTaG91bGQgcmV0dXJuIGZsYXQgc3RydWN0dXJlIGFzIGVudmlyb25tZW50IHZhcmlhYmxlc1xuICAgICAgZXhwZWN0KGVudlZhcnMpLnRvRXF1YWwoe1xuICAgICAgICAnU0VDUkVUX0tFWSc6ICd0ZXN0LXNlY3JldC1rZXknLFxuICAgICAgICAnSldUX1NFQ1JFVCc6ICd0ZXN0LWp3dC1zZWNyZXQnLFxuICAgICAgICAnUkVRVUlSRURfU0VUVElORyc6ICd0ZXN0JyxcbiAgICAgICAgJ0FQSV9LRVknOiAndGVzdC1hcGkta2V5LTEyMzQ1JyxcbiAgICAgICAgJ1dFQkhPT0tfU0VDUkVUJzogJ3Rlc3Qtd2ViaG9vay1zZWNyZXQnLFxuICAgICAgICAnREFUQURPR19BUElfS0VZJzogJ3Rlc3QtZGF0YWRvZy1rZXknLFxuICAgICAgICAnU0VOVFJZX0RTTic6ICd0ZXN0LXNlbnRyeS1kc24nXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ3N0YXRpYyBtZXRob2RzJywgKCkgPT4ge1xuICAgIHRlc3QoJ2lzQ0kgZGV0ZWN0cyBDSSBlbnZpcm9ubWVudCcsICgpID0+IHtcbiAgICAgIHByb2Nlc3MuZW52LkNJID0gJ3RydWUnO1xuICAgICAgZXhwZWN0KFNlY3JldHNMb2FkZXIuaXNDSSgpKS50b0JlKHRydWUpO1xuXG4gICAgICBkZWxldGUgcHJvY2Vzcy5lbnYuQ0k7XG4gICAgICBwcm9jZXNzLmVudi5HSVRIVUJfQUNUSU9OUyA9ICd0cnVlJztcbiAgICAgIGV4cGVjdChTZWNyZXRzTG9hZGVyLmlzQ0koKSkudG9CZSh0cnVlKTtcblxuICAgICAgZGVsZXRlIHByb2Nlc3MuZW52LkdJVEhVQl9BQ1RJT05TO1xuICAgICAgcHJvY2Vzcy5lbnYuSkVOS0lOU19VUkwgPSAnaHR0cDovL2plbmtpbnMuZXhhbXBsZS5jb20nO1xuICAgICAgZXhwZWN0KFNlY3JldHNMb2FkZXIuaXNDSSgpKS50b0JlKHRydWUpO1xuXG4gICAgICBkZWxldGUgcHJvY2Vzcy5lbnYuSkVOS0lOU19VUkw7XG4gICAgICBleHBlY3QoU2VjcmV0c0xvYWRlci5pc0NJKCkpLnRvQmUoZmFsc2UpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnZm9yRW52aXJvbm1lbnQgY3JlYXRlcyBsb2FkZXIgd2l0aCBzcGVjaWZpZWQgZW52aXJvbm1lbnQnLCAoKSA9PiB7XG4gICAgICBjb25zdCBsb2FkZXIgPSBTZWNyZXRzTG9hZGVyLmZvckVudmlyb25tZW50KCdwcm9kdWN0aW9uJyk7XG4gICAgICBleHBlY3QobG9hZGVyKS50b0JlSW5zdGFuY2VPZihTZWNyZXRzTG9hZGVyKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2ZvckVudmlyb25tZW50IHVzZXMgTk9ERV9FTlYgd2hlbiBubyBlbnZpcm9ubWVudCBzcGVjaWZpZWQnLCAoKSA9PiB7XG4gICAgICBwcm9jZXNzLmVudi5OT0RFX0VOViA9ICdkZXZlbG9wbWVudCc7XG4gICAgICBjb25zdCBsb2FkZXIgPSBTZWNyZXRzTG9hZGVyLmZvckVudmlyb25tZW50KCk7XG4gICAgICBleHBlY3QobG9hZGVyKS50b0JlSW5zdGFuY2VPZihTZWNyZXRzTG9hZGVyKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2ZvckVudmlyb25tZW50IHVzZXMgRU5WSVJPTk1FTlQgd2hlbiBOT0RFX0VOViBub3Qgc2V0JywgKCkgPT4ge1xuICAgICAgcHJvY2Vzcy5lbnYuRU5WSVJPTk1FTlQgPSAnc3RhZ2luZyc7XG4gICAgICBjb25zdCBsb2FkZXIgPSBTZWNyZXRzTG9hZGVyLmZvckVudmlyb25tZW50KCk7XG4gICAgICBleHBlY3QobG9hZGVyKS50b0JlSW5zdGFuY2VPZihTZWNyZXRzTG9hZGVyKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2ZvckVudmlyb25tZW50IGRlZmF1bHRzIHRvIGRldiB3aGVuIG5vIGVudmlyb25tZW50IHZhcmlhYmxlcyBzZXQnLCAoKSA9PiB7XG4gICAgICBjb25zdCBsb2FkZXIgPSBTZWNyZXRzTG9hZGVyLmZvckVudmlyb25tZW50KCk7XG4gICAgICBleHBlY3QobG9hZGVyKS50b0JlSW5zdGFuY2VPZihTZWNyZXRzTG9hZGVyKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ2Vycm9yIGhhbmRsaW5nIGVkZ2UgY2FzZXMnLCAoKSA9PiB7XG4gICAgdGVzdCgnaGFuZGxlcyBub24tRXJyb3IgZXhjZXB0aW9ucyBpbiBsb2FkU2VjcmV0cycsICgpID0+IHtcbiAgICAgIG1vY2tFeGVjU3luYy5tb2NrSW1wbGVtZW50YXRpb24oKGNvbW1hbmQ6IHN0cmluZykgPT4ge1xuICAgICAgICBpZiAoY29tbWFuZCA9PT0gJ3doaWNoIHNvcHMnKSB7XG4gICAgICAgICAgcmV0dXJuICcvdXNyL2xvY2FsL2Jpbi9zb3BzJztcbiAgICAgICAgfVxuICAgICAgICBpZiAoY29tbWFuZC5pbmNsdWRlcygnc29wcyAtZCcpKSB7XG4gICAgICAgICAgdGhyb3cgJ3N0cmluZyBlcnJvcic7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDb21tYW5kIG5vdCBmb3VuZCcpO1xuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IGxvYWRlciA9IG5ldyBTZWNyZXRzTG9hZGVyKCd0ZXN0Jyk7XG4gICAgICBcbiAgICAgIGV4cGVjdCgoKSA9PiBsb2FkZXIubG9hZFNlY3JldHMoKSkudG9UaHJvdyhcbiAgICAgICAgJ0ZhaWxlZCB0byBsb2FkIHNlY3JldHMgZm9yIGVudmlyb25tZW50IHRlc3Q6IHN0cmluZyBlcnJvcidcbiAgICAgICk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdoYW5kbGVzIG51bGwgc2VjcmV0IHZhbHVlcyBpbiB2YWxpZGF0aW9uJywgKCkgPT4ge1xuICAgICAgY29uc3Qgc2VjcmV0c1dpdGhOdWxsID0ge1xuICAgICAgICBhcHBsaWNhdGlvbjoge1xuICAgICAgICAgIHNlY3JldF9rZXk6IG51bGwsXG4gICAgICAgICAgcmVxdWlyZWRfc2V0dGluZzogJ3Rlc3QnXG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBcbiAgICAgIG1vY2tFeGVjU3luYy5tb2NrSW1wbGVtZW50YXRpb24oKGNvbW1hbmQ6IHN0cmluZykgPT4ge1xuICAgICAgICBpZiAoY29tbWFuZCA9PT0gJ3doaWNoIHNvcHMnKSB7XG4gICAgICAgICAgcmV0dXJuICcvdXNyL2xvY2FsL2Jpbi9zb3BzJztcbiAgICAgICAgfVxuICAgICAgICBpZiAoY29tbWFuZC5pbmNsdWRlcygnc29wcyAtZCcpKSB7XG4gICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHNlY3JldHNXaXRoTnVsbCk7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDb21tYW5kIG5vdCBmb3VuZCcpO1xuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IGxvYWRlciA9IG5ldyBTZWNyZXRzTG9hZGVyKCd0ZXN0Jyk7XG4gICAgICBcbiAgICAgIGV4cGVjdCgoKSA9PiBsb2FkZXIubG9hZFNlY3JldHMoKSkudG9UaHJvdyhcbiAgICAgICAgJ1JlcXVpcmVkIHNlY3JldCBtaXNzaW5nOiBzZWNyZXRfa2V5J1xuICAgICAgKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2hhbmRsZXMgdW5kZWZpbmVkIHNlY3JldCB2YWx1ZXMgaW4gdmFsaWRhdGlvbicsICgpID0+IHtcbiAgICAgIGNvbnN0IHNlY3JldHNXaXRoVW5kZWZpbmVkID0ge1xuICAgICAgICBhcHBsaWNhdGlvbjoge1xuICAgICAgICAgIHNlY3JldF9rZXk6IHVuZGVmaW5lZCxcbiAgICAgICAgICByZXF1aXJlZF9zZXR0aW5nOiAndGVzdCdcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIFxuICAgICAgbW9ja0V4ZWNTeW5jLm1vY2tJbXBsZW1lbnRhdGlvbigoY29tbWFuZDogc3RyaW5nKSA9PiB7XG4gICAgICAgIGlmIChjb21tYW5kID09PSAnd2hpY2ggc29wcycpIHtcbiAgICAgICAgICByZXR1cm4gJy91c3IvbG9jYWwvYmluL3NvcHMnO1xuICAgICAgICB9XG4gICAgICAgIGlmIChjb21tYW5kLmluY2x1ZGVzKCdzb3BzIC1kJykpIHtcbiAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoc2VjcmV0c1dpdGhVbmRlZmluZWQpO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignQ29tbWFuZCBub3QgZm91bmQnKTtcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBsb2FkZXIgPSBuZXcgU2VjcmV0c0xvYWRlcigndGVzdCcpO1xuICAgICAgXG4gICAgICBleHBlY3QoKCkgPT4gbG9hZGVyLmxvYWRTZWNyZXRzKCkpLnRvVGhyb3coXG4gICAgICAgICdSZXF1aXJlZCBzZWNyZXQgbWlzc2luZzogc2VjcmV0X2tleSdcbiAgICAgICk7XG4gICAgfSk7XG4gIH0pO1xufSk7Il19