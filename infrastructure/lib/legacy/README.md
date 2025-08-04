# Legacy Monolithic Stack

This folder contains the original monolithic infrastructure stack that has been replaced by the modular architecture.

## Purpose

- **Integration Testing**: Used by `test/testapp-infrastructure.test.ts` for comprehensive end-to-end testing
- **Validation**: Used by `validate.ts` for configuration validation
- **Reference**: Serves as a complete example of the full infrastructure in a single stack

## Current Status

- ✅ **22/22 tests passing** - Provides excellent integration test coverage
- 🚫 **Not deployed** - Main deployment uses modular stacks (VPC, Platform, Application)
- 📚 **Documentation** - Good reference for understanding the complete architecture

## Modular Architecture

The active deployment uses these modular stacks:

1. **VpcStack** (`../vpc-stack.ts`) - Network infrastructure
2. **EcsPlatformStack** (`../ecs-platform-stack.ts`) - Container platform  
3. **ApplicationStack** (`../application-stack.ts`) - Fargate services

## Migration Notes

- All functionality has been preserved in the modular stacks
- Tests continue to validate the complete infrastructure
- Modular design provides better separation of concerns and deployment flexibility