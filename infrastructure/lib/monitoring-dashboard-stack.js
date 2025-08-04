"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MonitoringDashboardStack = void 0;
const cdk = require("aws-cdk-lib");
const cloudwatch = require("aws-cdk-lib/aws-cloudwatch");
const cloudwatchActions = require("aws-cdk-lib/aws-cloudwatch-actions");
const sns = require("aws-cdk-lib/aws-sns");
const subscriptions = require("aws-cdk-lib/aws-sns-subscriptions");
const iam = require("aws-cdk-lib/aws-iam");
const events = require("aws-cdk-lib/aws-events");
const targets = require("aws-cdk-lib/aws-events-targets");
const lambda = require("aws-cdk-lib/aws-lambda");
class MonitoringDashboardStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // Create SNS topic for alerts
        this.alertTopic = this.createAlertTopic(props);
        // Create comprehensive dashboard
        this.dashboard = this.createStackSpecificDashboard(props);
        // Create CloudWatch alarms
        this.alarms = this.createComprehensiveAlarms(props);
        // Create Log Insights queries
        this.logInsights = this.createLogInsightsQueries(props);
        // Create deployment monitoring
        this.createDeploymentMonitoring(props);
        // Create cost monitoring (if enabled)
        if (props.enableCostAlerting) {
            this.createCostAlerting(props);
        }
        // Create custom metrics Lambda
        this.createCustomMetricsFunction(props);
        // Create outputs
        this.createOutputs(props);
    }
    createAlertTopic(props) {
        const topic = new sns.Topic(this, 'MonitoringAlertTopic', {
            topicName: `testapp-monitoring-alerts-${props.environment}`,
            displayName: `TestApp Monitoring Alerts - ${props.environment}`,
        });
        // Add email subscription
        if (props.alertingEmail) {
            topic.addSubscription(new subscriptions.EmailSubscription(props.alertingEmail));
        }
        // Add Slack subscription (webhook would be configured separately)
        if (props.alertingSlack) {
            // In a real implementation, this would use a Lambda function to send to Slack
            // For now, we'll add it as an email subscription
            topic.addSubscription(new subscriptions.EmailSubscription(props.alertingSlack));
        }
        // Add tags
        cdk.Tags.of(topic).add('Environment', props.environment);
        cdk.Tags.of(topic).add('Component', 'Monitoring-Alerts');
        return topic;
    }
    createStackSpecificDashboard(props) {
        const dashboard = new cloudwatch.Dashboard(this, 'TestAppDashboard', {
            dashboardName: `TestApp-${props.environment}-Overview`,
        });
        // Application Health Section
        dashboard.addWidgets(new cloudwatch.TextWidget({
            markdown: `# 🎯 TestApp ${props.environment.toUpperCase()} Environment Dashboard\n\n**Last Updated**: ${new Date().toISOString()}\n\n**Environment**: ${props.environment}`,
            width: 24,
            height: 3,
        }));
        // System Health Row
        dashboard.addWidgets(new cloudwatch.SingleValueWidget({
            title: '🚀 Application Status',
            metrics: [
                new cloudwatch.Metric({
                    namespace: 'AWS/ApplicationELB',
                    metricName: 'HealthyHostCount',
                    dimensionsMap: {
                        LoadBalancer: this.getLoadBalancerName(props),
                    },
                    statistic: 'Average',
                }),
            ],
            width: 6,
            height: 6,
        }), new cloudwatch.SingleValueWidget({
            title: '⚡ Response Time',
            metrics: [
                new cloudwatch.Metric({
                    namespace: 'AWS/ApplicationELB',
                    metricName: 'TargetResponseTime',
                    dimensionsMap: {
                        LoadBalancer: this.getLoadBalancerName(props),
                    },
                    statistic: 'Average',
                }),
            ],
            width: 6,
            height: 6,
        }), new cloudwatch.SingleValueWidget({
            title: '🔥 Error Rate',
            metrics: [
                new cloudwatch.Metric({
                    namespace: 'AWS/ApplicationELB',
                    metricName: 'HTTPCode_Target_5XX_Count',
                    dimensionsMap: {
                        LoadBalancer: this.getLoadBalancerName(props),
                    },
                    statistic: 'Sum',
                }),
            ],
            width: 6,
            height: 6,
        }), new cloudwatch.SingleValueWidget({
            title: '📈 Request Count',
            metrics: [
                new cloudwatch.Metric({
                    namespace: 'AWS/ApplicationELB',
                    metricName: 'RequestCount',
                    dimensionsMap: {
                        LoadBalancer: this.getLoadBalancerName(props),
                    },
                    statistic: 'Sum',
                }),
            ],
            width: 6,
            height: 6,
        }));
        // ECS Performance Row
        dashboard.addWidgets(new cloudwatch.GraphWidget({
            title: '🖥️ ECS Service Performance',
            left: [
                new cloudwatch.Metric({
                    namespace: 'AWS/ECS',
                    metricName: 'CPUUtilization',
                    dimensionsMap: {
                        ServiceName: `testapp-service-${props.environment}`,
                        ClusterName: `testapp-cluster-${props.environment}`,
                    },
                    statistic: 'Average',
                }),
            ],
            right: [
                new cloudwatch.Metric({
                    namespace: 'AWS/ECS',
                    metricName: 'MemoryUtilization',
                    dimensionsMap: {
                        ServiceName: `testapp-service-${props.environment}`,
                        ClusterName: `testapp-cluster-${props.environment}`,
                    },
                    statistic: 'Average',
                }),
            ],
            width: 12,
            height: 6,
        }), new cloudwatch.GraphWidget({
            title: '📊 Request & Error Metrics',
            left: [
                new cloudwatch.Metric({
                    namespace: 'AWS/ApplicationELB',
                    metricName: 'RequestCount',
                    dimensionsMap: {
                        LoadBalancer: this.getLoadBalancerName(props),
                    },
                    statistic: 'Sum',
                }),
            ],
            right: [
                new cloudwatch.Metric({
                    namespace: 'AWS/ApplicationELB',
                    metricName: 'HTTPCode_Target_4XX_Count',
                    dimensionsMap: {
                        LoadBalancer: this.getLoadBalancerName(props),
                    },
                    statistic: 'Sum',
                }),
                new cloudwatch.Metric({
                    namespace: 'AWS/ApplicationELB',
                    metricName: 'HTTPCode_Target_5XX_Count',
                    dimensionsMap: {
                        LoadBalancer: this.getLoadBalancerName(props),
                    },
                    statistic: 'Sum',
                }),
            ],
            width: 12,
            height: 6,
        }));
        // Infrastructure Health Row
        dashboard.addWidgets(new cloudwatch.GraphWidget({
            title: '🌐 Load Balancer Health',
            left: [
                new cloudwatch.Metric({
                    namespace: 'AWS/ApplicationELB',
                    metricName: 'HealthyHostCount',
                    dimensionsMap: {
                        LoadBalancer: this.getLoadBalancerName(props),
                    },
                    statistic: 'Average',
                }),
                new cloudwatch.Metric({
                    namespace: 'AWS/ApplicationELB',
                    metricName: 'UnHealthyHostCount',
                    dimensionsMap: {
                        LoadBalancer: this.getLoadBalancerName(props),
                    },
                    statistic: 'Average',
                }),
            ],
            width: 12,
            height: 6,
        }), new cloudwatch.GraphWidget({
            title: '⏱️ Response Time Percentiles',
            left: [
                new cloudwatch.Metric({
                    namespace: 'AWS/ApplicationELB',
                    metricName: 'TargetResponseTime',
                    dimensionsMap: {
                        LoadBalancer: this.getLoadBalancerName(props),
                    },
                    statistic: 'p50',
                }),
                new cloudwatch.Metric({
                    namespace: 'AWS/ApplicationELB',
                    metricName: 'TargetResponseTime',
                    dimensionsMap: {
                        LoadBalancer: this.getLoadBalancerName(props),
                    },
                    statistic: 'p95',
                }),
                new cloudwatch.Metric({
                    namespace: 'AWS/ApplicationELB',
                    metricName: 'TargetResponseTime',
                    dimensionsMap: {
                        LoadBalancer: this.getLoadBalancerName(props),
                    },
                    statistic: 'p99',
                }),
            ],
            width: 12,
            height: 6,
        }));
        // Log Analysis Row (if advanced metrics enabled)
        if (props.enableAdvancedMetrics) {
            dashboard.addWidgets(new cloudwatch.TextWidget({
                markdown: `## 📝 Application Logs
Log analysis widgets are not supported in this CDK version.
Use CloudWatch Logs Insights directly to query:
- Error logs: \`/testapp/${props.environment}/application\`
- Query: \`fields @timestamp, @message | filter @message like /ERROR/\``,
                width: 12,
                height: 3,
            }), new cloudwatch.TextWidget({
                markdown: `## 🔍 Error Patterns
Monitor error patterns in CloudWatch Logs:
- Navigate to CloudWatch Logs Insights
- Select log group: \`/testapp/${props.environment}/application\`
- Query: \`fields @timestamp, @message | filter @message like /500/\``,
                width: 12,
                height: 3,
            }));
        }
        // Security Monitoring Row
        dashboard.addWidgets(new cloudwatch.TextWidget({
            markdown: `## 🔒 Security Monitoring\n\n**Environment**: ${props.environment}\n**Security Stack**: ${props.securityStackName || 'N/A'}\n**Last Security Scan**: Check CI/CD pipeline`,
            width: 12,
            height: 4,
        }), new cloudwatch.GraphWidget({
            title: '🚨 Security Events',
            left: [
                new cloudwatch.Metric({
                    namespace: 'TestApp/Security',
                    metricName: 'SecurityEvents',
                    dimensionsMap: {
                        Environment: props.environment,
                    },
                    statistic: 'Sum',
                }),
            ],
            width: 12,
            height: 4,
        }));
        return dashboard;
    }
    createComprehensiveAlarms(props) {
        const alarms = [];
        // High error rate alarm
        const errorRateAlarm = new cloudwatch.Alarm(this, 'HighErrorRateAlarm', {
            alarmName: `TestApp-${props.environment}-HighErrorRate`,
            alarmDescription: 'High 5xx error rate detected',
            metric: new cloudwatch.Metric({
                namespace: 'AWS/ApplicationELB',
                metricName: 'HTTPCode_Target_5XX_Count',
                dimensionsMap: {
                    LoadBalancer: this.getLoadBalancerName(props),
                },
                statistic: 'Sum',
                period: cdk.Duration.minutes(5),
            }),
            threshold: props.errorRateThreshold || 10,
            evaluationPeriods: 2,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        errorRateAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
        alarms.push(errorRateAlarm);
        // High response time alarm
        const responseTimeAlarm = new cloudwatch.Alarm(this, 'HighResponseTimeAlarm', {
            alarmName: `TestApp-${props.environment}-HighResponseTime`,
            alarmDescription: 'High response time detected',
            metric: new cloudwatch.Metric({
                namespace: 'AWS/ApplicationELB',
                metricName: 'TargetResponseTime',
                dimensionsMap: {
                    LoadBalancer: this.getLoadBalancerName(props),
                },
                statistic: 'Average',
                period: cdk.Duration.minutes(5),
            }),
            threshold: props.responseTimeThreshold || 2000,
            evaluationPeriods: 3,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        responseTimeAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
        alarms.push(responseTimeAlarm);
        // High CPU utilization alarm
        const cpuAlarm = new cloudwatch.Alarm(this, 'HighCPUAlarm', {
            alarmName: `TestApp-${props.environment}-HighCPU`,
            alarmDescription: 'High CPU utilization detected',
            metric: new cloudwatch.Metric({
                namespace: 'AWS/ECS',
                metricName: 'CPUUtilization',
                dimensionsMap: {
                    ServiceName: `testapp-service-${props.environment}`,
                    ClusterName: `testapp-cluster-${props.environment}`,
                },
                statistic: 'Average',
                period: cdk.Duration.minutes(5),
            }),
            threshold: props.cpuThreshold || 80,
            evaluationPeriods: 3,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        cpuAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
        alarms.push(cpuAlarm);
        // High memory utilization alarm
        const memoryAlarm = new cloudwatch.Alarm(this, 'HighMemoryAlarm', {
            alarmName: `TestApp-${props.environment}-HighMemory`,
            alarmDescription: 'High memory utilization detected',
            metric: new cloudwatch.Metric({
                namespace: 'AWS/ECS',
                metricName: 'MemoryUtilization',
                dimensionsMap: {
                    ServiceName: `testapp-service-${props.environment}`,
                    ClusterName: `testapp-cluster-${props.environment}`,
                },
                statistic: 'Average',
                period: cdk.Duration.minutes(5),
            }),
            threshold: props.memoryThreshold || 85,
            evaluationPeriods: 3,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        memoryAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
        alarms.push(memoryAlarm);
        // No healthy hosts alarm
        const healthyHostsAlarm = new cloudwatch.Alarm(this, 'NoHealthyHostsAlarm', {
            alarmName: `TestApp-${props.environment}-NoHealthyHosts`,
            alarmDescription: 'No healthy hosts available',
            metric: new cloudwatch.Metric({
                namespace: 'AWS/ApplicationELB',
                metricName: 'HealthyHostCount',
                dimensionsMap: {
                    LoadBalancer: this.getLoadBalancerName(props),
                },
                statistic: 'Average',
                period: cdk.Duration.minutes(1),
            }),
            threshold: 1,
            evaluationPeriods: 2,
            comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        });
        healthyHostsAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
        alarms.push(healthyHostsAlarm);
        return alarms;
    }
    createLogInsightsQueries(props) {
        // QueryDefinition creation is not fully compatible with this CDK version
        // Instead, we'll return an empty array and document the queries for manual creation
        const queries = [];
        // Note: The following queries can be manually created in CloudWatch Logs Insights:
        // 
        // Error Analysis Query:
        // fields @timestamp, @message, @requestId
        // | filter @message like /ERROR/
        // | stats count() by bin(5m)
        // | sort @timestamp desc
        //
        // Performance Query:
        // fields @timestamp, @message, @duration
        // | filter @type = "REPORT"
        // | stats avg(@duration), max(@duration), min(@duration) by bin(5m)
        //
        // Security Events Query:
        // fields @timestamp, @message, sourceIP, userAgent
        // | filter @message like /403/ or @message like /401/ or @message like /SECURITY/
        // | stats count() by sourceIP
        // | sort count desc
        return queries;
    }
    createDeploymentMonitoring(props) {
        // Create EventBridge rule for deployment events
        const deploymentRule = new events.Rule(this, 'DeploymentEventsRule', {
            ruleName: `testapp-${props.environment}-deployment-events`,
            description: 'Monitor deployment events',
            eventPattern: {
                source: ['aws.ecs'],
                detailType: ['ECS Service Action'],
                detail: {
                    clusterArn: [
                        {
                            'exists': true,
                            'wildcard': `*testapp-cluster-${props.environment}*`,
                        },
                    ],
                },
            },
        });
        // Send deployment notifications to SNS
        deploymentRule.addTarget(new targets.SnsTopic(this.alertTopic, {
            message: events.RuleTargetInput.fromText(`Deployment Event in ${props.environment}:\n${events.RuleTargetInput.fromEventPath('$.detail')}`),
        }));
        // Create custom metric for deployment frequency
        const deploymentMetricRule = new events.Rule(this, 'DeploymentMetricsRule', {
            ruleName: `testapp-${props.environment}-deployment-metrics`,
            description: 'Track deployment frequency',
            eventPattern: {
                source: ['aws.ecs'],
                detailType: ['ECS Service Action'],
                detail: {
                    eventName: ['UpdateService'],
                },
            },
        });
        // Lambda function to emit custom metrics
        const metricsFunction = new lambda.Function(this, 'DeploymentMetricsFunction', {
            runtime: lambda.Runtime.PYTHON_3_9,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
import json
import boto3
from datetime import datetime

cloudwatch = boto3.client('cloudwatch')

def handler(event, context):
    try:
        # Extract deployment information
        detail = event.get('detail', {})
        cluster_name = detail.get('clusterArn', '').split('/')[-1]
        
        if 'testapp-cluster-${props.environment}' in cluster_name:
            # Emit deployment metric
            cloudwatch.put_metric_data(
                Namespace='TestApp/Deployments',
                MetricData=[
                    {
                        'MetricName': 'DeploymentCount',
                        'Dimensions': [
                            {
                                'Name': 'Environment',
                                'Value': '${props.environment}'
                            },
                            {
                                'Name': 'Cluster',
                                'Value': cluster_name
                            }
                        ],
                        'Value': 1,
                        'Unit': 'Count',
                        'Timestamp': datetime.now()
                    }
                ]
            )
            
        return {
            'statusCode': 200,
            'body': json.dumps('Metric emitted successfully')
        }
    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps(f'Error: {str(e)}')
        }
      `),
            environment: {
                ENVIRONMENT: props.environment,
            },
        });
        // Grant CloudWatch permissions
        metricsFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['cloudwatch:PutMetricData'],
            resources: ['*'],
        }));
        // Add Lambda target to rule
        deploymentMetricRule.addTarget(new targets.LambdaFunction(metricsFunction));
    }
    createCostAlerting(props) {
        // Cost anomaly detection (simplified - would use AWS Cost Anomaly Detection in practice)
        const costAlarm = new cloudwatch.Alarm(this, 'HighCostAlarm', {
            alarmName: `TestApp-${props.environment}-HighCost`,
            alarmDescription: 'High cost detected for environment',
            metric: new cloudwatch.Metric({
                namespace: 'AWS/Billing',
                metricName: 'EstimatedCharges',
                dimensionsMap: {
                    Currency: 'USD',
                },
                statistic: 'Maximum',
                period: cdk.Duration.hours(6),
            }),
            threshold: props.environment === 'production' ? 1000 : 100,
            evaluationPeriods: 1,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        costAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
    }
    createCustomMetricsFunction(props) {
        const customMetricsFunction = new lambda.Function(this, 'CustomMetricsFunction', {
            functionName: `testapp-${props.environment}-custom-metrics`,
            runtime: lambda.Runtime.PYTHON_3_9,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(5),
            code: lambda.Code.fromInline(`
import json
import boto3
import requests
from datetime import datetime
import os

cloudwatch = boto3.client('cloudwatch')
ecs = boto3.client('ecs')
elbv2 = boto3.client('elbv2')

def handler(event, context):
    environment = os.environ.get('ENVIRONMENT', '${props.environment}')
    
    try:
        # Collect custom application metrics
        metrics = []
        
        # ECS Service metrics
        cluster_name = f"testapp-cluster-{environment}"
        service_name = f"testapp-service-{environment}"
        
        # Get ECS service information
        try:
            services = ecs.describe_services(
                cluster=cluster_name,
                services=[service_name]
            )
            
            if services['services']:
                service = services['services'][0]
                running_count = service['runningCount']
                desired_count = service['desiredCount']
                
                metrics.extend([
                    {
                        'MetricName': 'ServiceRunningCount',
                        'Value': running_count,
                        'Unit': 'Count',
                        'Dimensions': [
                            {'Name': 'Environment', 'Value': environment},
                            {'Name': 'ServiceName', 'Value': service_name}
                        ]
                    },
                    {
                        'MetricName': 'ServiceDesiredCount', 
                        'Value': desired_count,
                        'Unit': 'Count',
                        'Dimensions': [
                            {'Name': 'Environment', 'Value': environment},
                            {'Name': 'ServiceName', 'Value': service_name}
                        ]
                    },
                    {
                        'MetricName': 'ServiceHealthRatio',
                        'Value': (running_count / max(desired_count, 1)) * 100,
                        'Unit': 'Percent',
                        'Dimensions': [
                            {'Name': 'Environment', 'Value': environment},
                            {'Name': 'ServiceName', 'Value': service_name}
                        ]
                    }
                ])
        except Exception as e:
            print(f"Error collecting ECS metrics: {e}")
        
        # Application health check
        try:
            # Get load balancer DNS
            load_balancers = elbv2.describe_load_balancers(
                Names=[f"testapp-alb-{environment}"]
            )
            
            if load_balancers['LoadBalancers']:
                lb_dns = load_balancers['LoadBalancers'][0]['DNSName']
                health_url = f"http://{lb_dns}/health/"
                
                # Perform health check
                response = requests.get(health_url, timeout=10)
                health_status = 1 if response.status_code == 200 else 0
                response_time = response.elapsed.total_seconds() * 1000
                
                metrics.extend([
                    {
                        'MetricName': 'ApplicationHealth',
                        'Value': health_status,
                        'Unit': 'Count',
                        'Dimensions': [
                            {'Name': 'Environment', 'Value': environment}
                        ]
                    },
                    {
                        'MetricName': 'HealthCheckResponseTime',
                        'Value': response_time,
                        'Unit': 'Milliseconds', 
                        'Dimensions': [
                            {'Name': 'Environment', 'Value': environment}
                        ]
                    }
                ])
        except Exception as e:
            print(f"Error collecting application metrics: {e}")
            # Emit unhealthy metric
            metrics.append({
                'MetricName': 'ApplicationHealth',
                'Value': 0,
                'Unit': 'Count',
                'Dimensions': [
                    {'Name': 'Environment', 'Value': environment}
                ]
            })
        
        # Emit all metrics
        if metrics:
            # Split into chunks of 20 (CloudWatch limit)
            for i in range(0, len(metrics), 20):
                chunk = metrics[i:i+20]
                cloudwatch.put_metric_data(
                    Namespace='TestApp/Custom',
                    MetricData=[
                        {
                            **metric,
                            'Timestamp': datetime.now()
                        } for metric in chunk
                    ]
                )
        
        return {
            'statusCode': 200,
            'body': json.dumps(f'Emitted {len(metrics)} custom metrics')
        }
        
    except Exception as e:
        print(f"Error in custom metrics function: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps(f'Error: {str(e)}')
        }
      `),
            environment: {
                ENVIRONMENT: props.environment,
            },
        });
        // Grant necessary permissions
        customMetricsFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'cloudwatch:PutMetricData',
                'ecs:DescribeServices',
                'ecs:DescribeTasks',
                'elasticloadbalancing:DescribeLoadBalancers',
                'elasticloadbalancing:DescribeTargetHealth',
            ],
            resources: ['*'],
        }));
        // Schedule the function to run every 5 minutes
        const schedule = new events.Rule(this, 'CustomMetricsSchedule', {
            schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
            description: 'Trigger custom metrics collection',
        });
        schedule.addTarget(new targets.LambdaFunction(customMetricsFunction));
        return customMetricsFunction;
    }
    getLoadBalancerName(props) {
        // This would normally be imported from the platform stack
        return `app/testapp-alb-${props.environment}/1234567890123456`;
    }
    createOutputs(props) {
        // Dashboard URL
        new cdk.CfnOutput(this, 'DashboardUrl', {
            value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${this.dashboard.dashboardName}`,
            description: 'CloudWatch Dashboard URL',
            exportName: `${this.stackName}-DashboardUrl`,
        });
        // Alert topic ARN
        new cdk.CfnOutput(this, 'AlertTopicArn', {
            value: this.alertTopic.topicArn,
            description: 'SNS topic for monitoring alerts',
            exportName: `${this.stackName}-AlertTopicArn`,
        });
        // Alarm count
        new cdk.CfnOutput(this, 'AlarmCount', {
            value: this.alarms.length.toString(),
            description: 'Number of CloudWatch alarms created',
        });
        // Log Insights queries count
        new cdk.CfnOutput(this, 'LogInsightsQueryCount', {
            value: this.logInsights.length.toString(),
            description: 'Number of Log Insights queries created',
        });
        // Monitoring summary
        new cdk.CfnOutput(this, 'MonitoringSummary', {
            value: JSON.stringify({
                environment: props.environment,
                dashboard: this.dashboard.dashboardName,
                alarms: this.alarms.length,
                logQueries: this.logInsights.length,
                alerting: !!props.alertingEmail,
                advancedMetrics: props.enableAdvancedMetrics || false,
                costAlerting: props.enableCostAlerting || false,
                timestamp: new Date().toISOString(),
            }),
            description: 'Monitoring configuration summary',
        });
    }
}
exports.MonitoringDashboardStack = MonitoringDashboardStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9uaXRvcmluZy1kYXNoYm9hcmQtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJtb25pdG9yaW5nLWRhc2hib2FyZC1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFDbkMseURBQXlEO0FBQ3pELHdFQUF3RTtBQUV4RSwyQ0FBMkM7QUFDM0MsbUVBQW1FO0FBQ25FLDJDQUEyQztBQUMzQyxpREFBaUQ7QUFDakQsMERBQTBEO0FBQzFELGlEQUFpRDtBQTBCakQsTUFBYSx3QkFBeUIsU0FBUSxHQUFHLENBQUMsS0FBSztJQU1yRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQW9DO1FBQzVFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLDhCQUE4QjtRQUM5QixJQUFJLENBQUMsVUFBVSxHQUFHLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUUvQyxpQ0FBaUM7UUFDakMsSUFBSSxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUMsNEJBQTRCLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFMUQsMkJBQTJCO1FBQzNCLElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDLHlCQUF5QixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRXBELDhCQUE4QjtRQUM5QixJQUFJLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQyx3QkFBd0IsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUV4RCwrQkFBK0I7UUFDL0IsSUFBSSxDQUFDLDBCQUEwQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRXZDLHNDQUFzQztRQUN0QyxJQUFJLEtBQUssQ0FBQyxrQkFBa0IsRUFBRTtZQUM1QixJQUFJLENBQUMsa0JBQWtCLENBQUMsS0FBSyxDQUFDLENBQUM7U0FDaEM7UUFFRCwrQkFBK0I7UUFDL0IsSUFBSSxDQUFDLDJCQUEyQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRXhDLGlC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UUFFSCxjQUFjO1FBQ2QsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7WUFDcEMsS0FBSyxFQUFFLElBQUksQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLFFBQVEsRUFBRTtZQUNwQyxXQUFXLEVBQUUscUNBQXFDO1NBQ25ELENBQUMsQ0FBQztRQUVILDZCQUE2QjtRQUM3QixJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHVCQUF1QixFQUFFO1lBQy9DLEtBQUssRUFBRSxJQUFJLENBQUMsV0FBVyxDQUFDLE1BQU0sQ0FBQyxRQUFRLEVBQUU7WUFDekMsV0FBVyxFQUFFLHdDQUF3QztTQUN0RCxDQUFDLENBQUM7UUFFSCxxQkFBcUI7UUFDckIsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxtQkFBbUIsRUFBRTtZQUMzQyxLQUFLLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztnQkFDcEIsV0FBVyxFQUFFLEtBQUssQ0FBQyxXQUFXO2dCQUM5QixTQUFTLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxhQUFhO2dCQUN2QyxNQUFNLEVBQUUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNO2dCQUMxQixVQUFVLEVBQUUsSUFBSSxDQUFDLFdBQVcsQ0FBQyxNQUFNO2dCQUNuQyxRQUFRLEVBQUUsQ0FBQyxDQUFDLEtBQUssQ0FBQyxhQUFhO2dCQUMvQixlQUFlLEVBQUUsS0FBSyxDQUFDLHFCQUFxQixJQUFJLEtBQUs7Z0JBQ3JELFlBQVksRUFBRSxLQUFLLENBQUMsa0JBQWtCLElBQUksS0FBSztnQkFDL0MsU0FBUyxFQUFFLElBQUksSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFO2FBQ3BDLENBQUM7WUFDRixXQUFXLEVBQUUsa0NBQWtDO1NBQ2hELENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQXJ5QkQsNERBcXlCQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBjbG91ZHdhdGNoIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZHdhdGNoJztcbmltcG9ydCAqIGFzIGNsb3Vkd2F0Y2hBY3Rpb25zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZHdhdGNoLWFjdGlvbnMnO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgKiBhcyBzbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNucyc7XG5pbXBvcnQgKiBhcyBzdWJzY3JpcHRpb25zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zbnMtc3Vic2NyaXB0aW9ucyc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBldmVudHMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWV2ZW50cyc7XG5pbXBvcnQgKiBhcyB0YXJnZXRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1ldmVudHMtdGFyZ2V0cyc7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcblxuZXhwb3J0IGludGVyZmFjZSBNb25pdG9yaW5nRGFzaGJvYXJkU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgZW52aXJvbm1lbnQ6IHN0cmluZztcbiAgXG4gIC8vIFN0YWNrIEFSTnMgZm9yIGNyb3NzLXN0YWNrIG1vbml0b3JpbmdcbiAgdnBjU3RhY2tOYW1lPzogc3RyaW5nO1xuICBwbGF0Zm9ybVN0YWNrTmFtZT86IHN0cmluZztcbiAgYXBwbGljYXRpb25TdGFja05hbWU/OiBzdHJpbmc7XG4gIHNlY3VyaXR5U3RhY2tOYW1lPzogc3RyaW5nO1xuICBcbiAgLy8gTW9uaXRvcmluZyBjb25maWd1cmF0aW9uXG4gIGFsZXJ0aW5nRW1haWw/OiBzdHJpbmc7XG4gIGFsZXJ0aW5nU2xhY2s/OiBzdHJpbmc7XG4gIHJldGVudGlvbkRheXM/OiBudW1iZXI7XG4gIGVuYWJsZUFkdmFuY2VkTWV0cmljcz86IGJvb2xlYW47XG4gIGVuYWJsZUNvc3RBbGVydGluZz86IGJvb2xlYW47XG4gIFxuICAvLyBUaHJlc2hvbGRzXG4gIGVycm9yUmF0ZVRocmVzaG9sZD86IG51bWJlcjtcbiAgcmVzcG9uc2VUaW1lVGhyZXNob2xkPzogbnVtYmVyO1xuICBjcHVUaHJlc2hvbGQ/OiBudW1iZXI7XG4gIG1lbW9yeVRocmVzaG9sZD86IG51bWJlcjtcbn1cblxuZXhwb3J0IGNsYXNzIE1vbml0b3JpbmdEYXNoYm9hcmRTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSBkYXNoYm9hcmQ6IGNsb3Vkd2F0Y2guRGFzaGJvYXJkO1xuICBwdWJsaWMgcmVhZG9ubHkgYWxlcnRUb3BpYzogc25zLlRvcGljO1xuICBwdWJsaWMgcmVhZG9ubHkgbG9nSW5zaWdodHM6IGxvZ3MuUXVlcnlEZWZpbml0aW9uW107XG4gIHB1YmxpYyByZWFkb25seSBhbGFybXM6IGNsb3Vkd2F0Y2guQWxhcm1bXTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogTW9uaXRvcmluZ0Rhc2hib2FyZFN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIENyZWF0ZSBTTlMgdG9waWMgZm9yIGFsZXJ0c1xuICAgIHRoaXMuYWxlcnRUb3BpYyA9IHRoaXMuY3JlYXRlQWxlcnRUb3BpYyhwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgY29tcHJlaGVuc2l2ZSBkYXNoYm9hcmRcbiAgICB0aGlzLmRhc2hib2FyZCA9IHRoaXMuY3JlYXRlU3RhY2tTcGVjaWZpY0Rhc2hib2FyZChwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgQ2xvdWRXYXRjaCBhbGFybXNcbiAgICB0aGlzLmFsYXJtcyA9IHRoaXMuY3JlYXRlQ29tcHJlaGVuc2l2ZUFsYXJtcyhwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgTG9nIEluc2lnaHRzIHF1ZXJpZXNcbiAgICB0aGlzLmxvZ0luc2lnaHRzID0gdGhpcy5jcmVhdGVMb2dJbnNpZ2h0c1F1ZXJpZXMocHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIGRlcGxveW1lbnQgbW9uaXRvcmluZ1xuICAgIHRoaXMuY3JlYXRlRGVwbG95bWVudE1vbml0b3JpbmcocHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIGNvc3QgbW9uaXRvcmluZyAoaWYgZW5hYmxlZClcbiAgICBpZiAocHJvcHMuZW5hYmxlQ29zdEFsZXJ0aW5nKSB7XG4gICAgICB0aGlzLmNyZWF0ZUNvc3RBbGVydGluZyhwcm9wcyk7XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIGN1c3RvbSBtZXRyaWNzIExhbWJkYVxuICAgIHRoaXMuY3JlYXRlQ3VzdG9tTWV0cmljc0Z1bmN0aW9uKHByb3BzKTtcblxuICAgIC8vIENyZWF0ZSBvdXRwdXRzXG4gICAgdGhpcy5jcmVhdGVPdXRwdXRzKHByb3BzKTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlQWxlcnRUb3BpYyhwcm9wczogTW9uaXRvcmluZ0Rhc2hib2FyZFN0YWNrUHJvcHMpOiBzbnMuVG9waWMge1xuICAgIGNvbnN0IHRvcGljID0gbmV3IHNucy5Ub3BpYyh0aGlzLCAnTW9uaXRvcmluZ0FsZXJ0VG9waWMnLCB7XG4gICAgICB0b3BpY05hbWU6IGB0ZXN0YXBwLW1vbml0b3JpbmctYWxlcnRzLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIGRpc3BsYXlOYW1lOiBgVGVzdEFwcCBNb25pdG9yaW5nIEFsZXJ0cyAtICR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBlbWFpbCBzdWJzY3JpcHRpb25cbiAgICBpZiAocHJvcHMuYWxlcnRpbmdFbWFpbCkge1xuICAgICAgdG9waWMuYWRkU3Vic2NyaXB0aW9uKG5ldyBzdWJzY3JpcHRpb25zLkVtYWlsU3Vic2NyaXB0aW9uKHByb3BzLmFsZXJ0aW5nRW1haWwpKTtcbiAgICB9XG5cbiAgICAvLyBBZGQgU2xhY2sgc3Vic2NyaXB0aW9uICh3ZWJob29rIHdvdWxkIGJlIGNvbmZpZ3VyZWQgc2VwYXJhdGVseSlcbiAgICBpZiAocHJvcHMuYWxlcnRpbmdTbGFjaykge1xuICAgICAgLy8gSW4gYSByZWFsIGltcGxlbWVudGF0aW9uLCB0aGlzIHdvdWxkIHVzZSBhIExhbWJkYSBmdW5jdGlvbiB0byBzZW5kIHRvIFNsYWNrXG4gICAgICAvLyBGb3Igbm93LCB3ZSdsbCBhZGQgaXQgYXMgYW4gZW1haWwgc3Vic2NyaXB0aW9uXG4gICAgICB0b3BpYy5hZGRTdWJzY3JpcHRpb24obmV3IHN1YnNjcmlwdGlvbnMuRW1haWxTdWJzY3JpcHRpb24ocHJvcHMuYWxlcnRpbmdTbGFjaykpO1xuICAgIH1cblxuICAgIC8vIEFkZCB0YWdzXG4gICAgY2RrLlRhZ3Mub2YodG9waWMpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2YodG9waWMpLmFkZCgnQ29tcG9uZW50JywgJ01vbml0b3JpbmctQWxlcnRzJyk7XG5cbiAgICByZXR1cm4gdG9waWM7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVN0YWNrU3BlY2lmaWNEYXNoYm9hcmQocHJvcHM6IE1vbml0b3JpbmdEYXNoYm9hcmRTdGFja1Byb3BzKTogY2xvdWR3YXRjaC5EYXNoYm9hcmQge1xuICAgIGNvbnN0IGRhc2hib2FyZCA9IG5ldyBjbG91ZHdhdGNoLkRhc2hib2FyZCh0aGlzLCAnVGVzdEFwcERhc2hib2FyZCcsIHtcbiAgICAgIGRhc2hib2FyZE5hbWU6IGBUZXN0QXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LU92ZXJ2aWV3YCxcbiAgICB9KTtcblxuICAgIC8vIEFwcGxpY2F0aW9uIEhlYWx0aCBTZWN0aW9uXG4gICAgZGFzaGJvYXJkLmFkZFdpZGdldHMoXG4gICAgICBuZXcgY2xvdWR3YXRjaC5UZXh0V2lkZ2V0KHtcbiAgICAgICAgbWFya2Rvd246IGAjIPCfjq8gVGVzdEFwcCAke3Byb3BzLmVudmlyb25tZW50LnRvVXBwZXJDYXNlKCl9IEVudmlyb25tZW50IERhc2hib2FyZFxcblxcbioqTGFzdCBVcGRhdGVkKio6ICR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpfVxcblxcbioqRW52aXJvbm1lbnQqKjogJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgICB3aWR0aDogMjQsXG4gICAgICAgIGhlaWdodDogMyxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vIFN5c3RlbSBIZWFsdGggUm93XG4gICAgZGFzaGJvYXJkLmFkZFdpZGdldHMoXG4gICAgICBuZXcgY2xvdWR3YXRjaC5TaW5nbGVWYWx1ZVdpZGdldCh7XG4gICAgICAgIHRpdGxlOiAn8J+agCBBcHBsaWNhdGlvbiBTdGF0dXMnLFxuICAgICAgICBtZXRyaWNzOiBbXG4gICAgICAgICAgbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgICAgICAgIG5hbWVzcGFjZTogJ0FXUy9BcHBsaWNhdGlvbkVMQicsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnSGVhbHRoeUhvc3RDb3VudCcsXG4gICAgICAgICAgICBkaW1lbnNpb25zTWFwOiB7XG4gICAgICAgICAgICAgIExvYWRCYWxhbmNlcjogdGhpcy5nZXRMb2FkQmFsYW5jZXJOYW1lKHByb3BzKSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBzdGF0aXN0aWM6ICdBdmVyYWdlJyxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSxcbiAgICAgICAgd2lkdGg6IDYsXG4gICAgICAgIGhlaWdodDogNixcbiAgICAgIH0pLFxuICAgICAgbmV3IGNsb3Vkd2F0Y2guU2luZ2xlVmFsdWVXaWRnZXQoe1xuICAgICAgICB0aXRsZTogJ+KaoSBSZXNwb25zZSBUaW1lJyxcbiAgICAgICAgbWV0cmljczogW1xuICAgICAgICAgIG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICAgICAgICBuYW1lc3BhY2U6ICdBV1MvQXBwbGljYXRpb25FTEInLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ1RhcmdldFJlc3BvbnNlVGltZScsXG4gICAgICAgICAgICBkaW1lbnNpb25zTWFwOiB7XG4gICAgICAgICAgICAgIExvYWRCYWxhbmNlcjogdGhpcy5nZXRMb2FkQmFsYW5jZXJOYW1lKHByb3BzKSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBzdGF0aXN0aWM6ICdBdmVyYWdlJyxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSxcbiAgICAgICAgd2lkdGg6IDYsXG4gICAgICAgIGhlaWdodDogNixcbiAgICAgIH0pLFxuICAgICAgbmV3IGNsb3Vkd2F0Y2guU2luZ2xlVmFsdWVXaWRnZXQoe1xuICAgICAgICB0aXRsZTogJ/CflKUgRXJyb3IgUmF0ZScsXG4gICAgICAgIG1ldHJpY3M6IFtcbiAgICAgICAgICBuZXcgY2xvdWR3YXRjaC5NZXRyaWMoe1xuICAgICAgICAgICAgbmFtZXNwYWNlOiAnQVdTL0FwcGxpY2F0aW9uRUxCJyxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6ICdIVFRQQ29kZV9UYXJnZXRfNVhYX0NvdW50JyxcbiAgICAgICAgICAgIGRpbWVuc2lvbnNNYXA6IHtcbiAgICAgICAgICAgICAgTG9hZEJhbGFuY2VyOiB0aGlzLmdldExvYWRCYWxhbmNlck5hbWUocHJvcHMpLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHN0YXRpc3RpYzogJ1N1bScsXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICAgIHdpZHRoOiA2LFxuICAgICAgICBoZWlnaHQ6IDYsXG4gICAgICB9KSxcbiAgICAgIG5ldyBjbG91ZHdhdGNoLlNpbmdsZVZhbHVlV2lkZ2V0KHtcbiAgICAgICAgdGl0bGU6ICfwn5OIIFJlcXVlc3QgQ291bnQnLFxuICAgICAgICBtZXRyaWNzOiBbXG4gICAgICAgICAgbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgICAgICAgIG5hbWVzcGFjZTogJ0FXUy9BcHBsaWNhdGlvbkVMQicsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnUmVxdWVzdENvdW50JyxcbiAgICAgICAgICAgIGRpbWVuc2lvbnNNYXA6IHtcbiAgICAgICAgICAgICAgTG9hZEJhbGFuY2VyOiB0aGlzLmdldExvYWRCYWxhbmNlck5hbWUocHJvcHMpLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHN0YXRpc3RpYzogJ1N1bScsXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICAgIHdpZHRoOiA2LFxuICAgICAgICBoZWlnaHQ6IDYsXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLyBFQ1MgUGVyZm9ybWFuY2UgUm93XG4gICAgZGFzaGJvYXJkLmFkZFdpZGdldHMoXG4gICAgICBuZXcgY2xvdWR3YXRjaC5HcmFwaFdpZGdldCh7XG4gICAgICAgIHRpdGxlOiAn8J+Wpe+4jyBFQ1MgU2VydmljZSBQZXJmb3JtYW5jZScsXG4gICAgICAgIGxlZnQ6IFtcbiAgICAgICAgICBuZXcgY2xvdWR3YXRjaC5NZXRyaWMoe1xuICAgICAgICAgICAgbmFtZXNwYWNlOiAnQVdTL0VDUycsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnQ1BVVXRpbGl6YXRpb24nLFxuICAgICAgICAgICAgZGltZW5zaW9uc01hcDoge1xuICAgICAgICAgICAgICBTZXJ2aWNlTmFtZTogYHRlc3RhcHAtc2VydmljZS0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICAgICAgICAgIENsdXN0ZXJOYW1lOiBgdGVzdGFwcC1jbHVzdGVyLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBzdGF0aXN0aWM6ICdBdmVyYWdlJyxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSxcbiAgICAgICAgcmlnaHQ6IFtcbiAgICAgICAgICBuZXcgY2xvdWR3YXRjaC5NZXRyaWMoe1xuICAgICAgICAgICAgbmFtZXNwYWNlOiAnQVdTL0VDUycsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnTWVtb3J5VXRpbGl6YXRpb24nLFxuICAgICAgICAgICAgZGltZW5zaW9uc01hcDoge1xuICAgICAgICAgICAgICBTZXJ2aWNlTmFtZTogYHRlc3RhcHAtc2VydmljZS0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICAgICAgICAgIENsdXN0ZXJOYW1lOiBgdGVzdGFwcC1jbHVzdGVyLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBzdGF0aXN0aWM6ICdBdmVyYWdlJyxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSxcbiAgICAgICAgd2lkdGg6IDEyLFxuICAgICAgICBoZWlnaHQ6IDYsXG4gICAgICB9KSxcbiAgICAgIG5ldyBjbG91ZHdhdGNoLkdyYXBoV2lkZ2V0KHtcbiAgICAgICAgdGl0bGU6ICfwn5OKIFJlcXVlc3QgJiBFcnJvciBNZXRyaWNzJyxcbiAgICAgICAgbGVmdDogW1xuICAgICAgICAgIG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICAgICAgICBuYW1lc3BhY2U6ICdBV1MvQXBwbGljYXRpb25FTEInLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ1JlcXVlc3RDb3VudCcsXG4gICAgICAgICAgICBkaW1lbnNpb25zTWFwOiB7XG4gICAgICAgICAgICAgIExvYWRCYWxhbmNlcjogdGhpcy5nZXRMb2FkQmFsYW5jZXJOYW1lKHByb3BzKSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBzdGF0aXN0aWM6ICdTdW0nLFxuICAgICAgICAgIH0pLFxuICAgICAgICBdLFxuICAgICAgICByaWdodDogW1xuICAgICAgICAgIG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICAgICAgICBuYW1lc3BhY2U6ICdBV1MvQXBwbGljYXRpb25FTEInLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ0hUVFBDb2RlX1RhcmdldF80WFhfQ291bnQnLFxuICAgICAgICAgICAgZGltZW5zaW9uc01hcDoge1xuICAgICAgICAgICAgICBMb2FkQmFsYW5jZXI6IHRoaXMuZ2V0TG9hZEJhbGFuY2VyTmFtZShwcm9wcyksXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgc3RhdGlzdGljOiAnU3VtJyxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBuZXcgY2xvdWR3YXRjaC5NZXRyaWMoe1xuICAgICAgICAgICAgbmFtZXNwYWNlOiAnQVdTL0FwcGxpY2F0aW9uRUxCJyxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6ICdIVFRQQ29kZV9UYXJnZXRfNVhYX0NvdW50JyxcbiAgICAgICAgICAgIGRpbWVuc2lvbnNNYXA6IHtcbiAgICAgICAgICAgICAgTG9hZEJhbGFuY2VyOiB0aGlzLmdldExvYWRCYWxhbmNlck5hbWUocHJvcHMpLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHN0YXRpc3RpYzogJ1N1bScsXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICAgIHdpZHRoOiAxMixcbiAgICAgICAgaGVpZ2h0OiA2LFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gSW5mcmFzdHJ1Y3R1cmUgSGVhbHRoIFJvd1xuICAgIGRhc2hib2FyZC5hZGRXaWRnZXRzKFxuICAgICAgbmV3IGNsb3Vkd2F0Y2guR3JhcGhXaWRnZXQoe1xuICAgICAgICB0aXRsZTogJ/CfjJAgTG9hZCBCYWxhbmNlciBIZWFsdGgnLFxuICAgICAgICBsZWZ0OiBbXG4gICAgICAgICAgbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgICAgICAgIG5hbWVzcGFjZTogJ0FXUy9BcHBsaWNhdGlvbkVMQicsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnSGVhbHRoeUhvc3RDb3VudCcsXG4gICAgICAgICAgICBkaW1lbnNpb25zTWFwOiB7XG4gICAgICAgICAgICAgIExvYWRCYWxhbmNlcjogdGhpcy5nZXRMb2FkQmFsYW5jZXJOYW1lKHByb3BzKSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBzdGF0aXN0aWM6ICdBdmVyYWdlJyxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBuZXcgY2xvdWR3YXRjaC5NZXRyaWMoe1xuICAgICAgICAgICAgbmFtZXNwYWNlOiAnQVdTL0FwcGxpY2F0aW9uRUxCJyxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6ICdVbkhlYWx0aHlIb3N0Q291bnQnLFxuICAgICAgICAgICAgZGltZW5zaW9uc01hcDoge1xuICAgICAgICAgICAgICBMb2FkQmFsYW5jZXI6IHRoaXMuZ2V0TG9hZEJhbGFuY2VyTmFtZShwcm9wcyksXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgc3RhdGlzdGljOiAnQXZlcmFnZScsXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICAgIHdpZHRoOiAxMixcbiAgICAgICAgaGVpZ2h0OiA2LFxuICAgICAgfSksXG4gICAgICBuZXcgY2xvdWR3YXRjaC5HcmFwaFdpZGdldCh7XG4gICAgICAgIHRpdGxlOiAn4o+x77iPIFJlc3BvbnNlIFRpbWUgUGVyY2VudGlsZXMnLFxuICAgICAgICBsZWZ0OiBbXG4gICAgICAgICAgbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgICAgICAgIG5hbWVzcGFjZTogJ0FXUy9BcHBsaWNhdGlvbkVMQicsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnVGFyZ2V0UmVzcG9uc2VUaW1lJyxcbiAgICAgICAgICAgIGRpbWVuc2lvbnNNYXA6IHtcbiAgICAgICAgICAgICAgTG9hZEJhbGFuY2VyOiB0aGlzLmdldExvYWRCYWxhbmNlck5hbWUocHJvcHMpLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHN0YXRpc3RpYzogJ3A1MCcsXG4gICAgICAgICAgfSksXG4gICAgICAgICAgbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgICAgICAgIG5hbWVzcGFjZTogJ0FXUy9BcHBsaWNhdGlvbkVMQicsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnVGFyZ2V0UmVzcG9uc2VUaW1lJyxcbiAgICAgICAgICAgIGRpbWVuc2lvbnNNYXA6IHtcbiAgICAgICAgICAgICAgTG9hZEJhbGFuY2VyOiB0aGlzLmdldExvYWRCYWxhbmNlck5hbWUocHJvcHMpLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHN0YXRpc3RpYzogJ3A5NScsXG4gICAgICAgICAgfSksXG4gICAgICAgICAgbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgICAgICAgIG5hbWVzcGFjZTogJ0FXUy9BcHBsaWNhdGlvbkVMQicsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnVGFyZ2V0UmVzcG9uc2VUaW1lJyxcbiAgICAgICAgICAgIGRpbWVuc2lvbnNNYXA6IHtcbiAgICAgICAgICAgICAgTG9hZEJhbGFuY2VyOiB0aGlzLmdldExvYWRCYWxhbmNlck5hbWUocHJvcHMpLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHN0YXRpc3RpYzogJ3A5OScsXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICAgIHdpZHRoOiAxMixcbiAgICAgICAgaGVpZ2h0OiA2LFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gTG9nIEFuYWx5c2lzIFJvdyAoaWYgYWR2YW5jZWQgbWV0cmljcyBlbmFibGVkKVxuICAgIGlmIChwcm9wcy5lbmFibGVBZHZhbmNlZE1ldHJpY3MpIHtcbiAgICAgIGRhc2hib2FyZC5hZGRXaWRnZXRzKFxuICAgICAgICBuZXcgY2xvdWR3YXRjaC5UZXh0V2lkZ2V0KHtcbiAgICAgICAgICBtYXJrZG93bjogYCMjIPCfk50gQXBwbGljYXRpb24gTG9nc1xuTG9nIGFuYWx5c2lzIHdpZGdldHMgYXJlIG5vdCBzdXBwb3J0ZWQgaW4gdGhpcyBDREsgdmVyc2lvbi5cblVzZSBDbG91ZFdhdGNoIExvZ3MgSW5zaWdodHMgZGlyZWN0bHkgdG8gcXVlcnk6XG4tIEVycm9yIGxvZ3M6IFxcYC90ZXN0YXBwLyR7cHJvcHMuZW52aXJvbm1lbnR9L2FwcGxpY2F0aW9uXFxgXG4tIFF1ZXJ5OiBcXGBmaWVsZHMgQHRpbWVzdGFtcCwgQG1lc3NhZ2UgfCBmaWx0ZXIgQG1lc3NhZ2UgbGlrZSAvRVJST1IvXFxgYCxcbiAgICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgICAgaGVpZ2h0OiAzLFxuICAgICAgICB9KSxcbiAgICAgICAgbmV3IGNsb3Vkd2F0Y2guVGV4dFdpZGdldCh7XG4gICAgICAgICAgbWFya2Rvd246IGAjIyDwn5SNIEVycm9yIFBhdHRlcm5zXG5Nb25pdG9yIGVycm9yIHBhdHRlcm5zIGluIENsb3VkV2F0Y2ggTG9nczpcbi0gTmF2aWdhdGUgdG8gQ2xvdWRXYXRjaCBMb2dzIEluc2lnaHRzXG4tIFNlbGVjdCBsb2cgZ3JvdXA6IFxcYC90ZXN0YXBwLyR7cHJvcHMuZW52aXJvbm1lbnR9L2FwcGxpY2F0aW9uXFxgXG4tIFF1ZXJ5OiBcXGBmaWVsZHMgQHRpbWVzdGFtcCwgQG1lc3NhZ2UgfCBmaWx0ZXIgQG1lc3NhZ2UgbGlrZSAvNTAwL1xcYGAsXG4gICAgICAgICAgd2lkdGg6IDEyLFxuICAgICAgICAgIGhlaWdodDogMyxcbiAgICAgICAgfSlcbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gU2VjdXJpdHkgTW9uaXRvcmluZyBSb3dcbiAgICBkYXNoYm9hcmQuYWRkV2lkZ2V0cyhcbiAgICAgIG5ldyBjbG91ZHdhdGNoLlRleHRXaWRnZXQoe1xuICAgICAgICBtYXJrZG93bjogYCMjIPCflJIgU2VjdXJpdHkgTW9uaXRvcmluZ1xcblxcbioqRW52aXJvbm1lbnQqKjogJHtwcm9wcy5lbnZpcm9ubWVudH1cXG4qKlNlY3VyaXR5IFN0YWNrKio6ICR7cHJvcHMuc2VjdXJpdHlTdGFja05hbWUgfHwgJ04vQSd9XFxuKipMYXN0IFNlY3VyaXR5IFNjYW4qKjogQ2hlY2sgQ0kvQ0QgcGlwZWxpbmVgLFxuICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgIGhlaWdodDogNCxcbiAgICAgIH0pLFxuICAgICAgbmV3IGNsb3Vkd2F0Y2guR3JhcGhXaWRnZXQoe1xuICAgICAgICB0aXRsZTogJ/CfmqggU2VjdXJpdHkgRXZlbnRzJyxcbiAgICAgICAgbGVmdDogW1xuICAgICAgICAgIG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICAgICAgICBuYW1lc3BhY2U6ICdUZXN0QXBwL1NlY3VyaXR5JyxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6ICdTZWN1cml0eUV2ZW50cycsXG4gICAgICAgICAgICBkaW1lbnNpb25zTWFwOiB7XG4gICAgICAgICAgICAgIEVudmlyb25tZW50OiBwcm9wcy5lbnZpcm9ubWVudCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBzdGF0aXN0aWM6ICdTdW0nLFxuICAgICAgICAgIH0pLFxuICAgICAgICBdLFxuICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgIGhlaWdodDogNCxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIHJldHVybiBkYXNoYm9hcmQ7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUNvbXByZWhlbnNpdmVBbGFybXMocHJvcHM6IE1vbml0b3JpbmdEYXNoYm9hcmRTdGFja1Byb3BzKTogY2xvdWR3YXRjaC5BbGFybVtdIHtcbiAgICBjb25zdCBhbGFybXM6IGNsb3Vkd2F0Y2guQWxhcm1bXSA9IFtdO1xuXG4gICAgLy8gSGlnaCBlcnJvciByYXRlIGFsYXJtXG4gICAgY29uc3QgZXJyb3JSYXRlQWxhcm0gPSBuZXcgY2xvdWR3YXRjaC5BbGFybSh0aGlzLCAnSGlnaEVycm9yUmF0ZUFsYXJtJywge1xuICAgICAgYWxhcm1OYW1lOiBgVGVzdEFwcC0ke3Byb3BzLmVudmlyb25tZW50fS1IaWdoRXJyb3JSYXRlYCxcbiAgICAgIGFsYXJtRGVzY3JpcHRpb246ICdIaWdoIDV4eCBlcnJvciByYXRlIGRldGVjdGVkJyxcbiAgICAgIG1ldHJpYzogbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgICAgbmFtZXNwYWNlOiAnQVdTL0FwcGxpY2F0aW9uRUxCJyxcbiAgICAgICAgbWV0cmljTmFtZTogJ0hUVFBDb2RlX1RhcmdldF81WFhfQ291bnQnLFxuICAgICAgICBkaW1lbnNpb25zTWFwOiB7XG4gICAgICAgICAgTG9hZEJhbGFuY2VyOiB0aGlzLmdldExvYWRCYWxhbmNlck5hbWUocHJvcHMpLFxuICAgICAgICB9LFxuICAgICAgICBzdGF0aXN0aWM6ICdTdW0nLFxuICAgICAgICBwZXJpb2Q6IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgfSksXG4gICAgICB0aHJlc2hvbGQ6IHByb3BzLmVycm9yUmF0ZVRocmVzaG9sZCB8fCAxMCxcbiAgICAgIGV2YWx1YXRpb25QZXJpb2RzOiAyLFxuICAgICAgdHJlYXRNaXNzaW5nRGF0YTogY2xvdWR3YXRjaC5UcmVhdE1pc3NpbmdEYXRhLk5PVF9CUkVBQ0hJTkcsXG4gICAgfSk7XG4gICAgZXJyb3JSYXRlQWxhcm0uYWRkQWxhcm1BY3Rpb24obmV3IGNsb3Vkd2F0Y2hBY3Rpb25zLlNuc0FjdGlvbih0aGlzLmFsZXJ0VG9waWMpKTtcbiAgICBhbGFybXMucHVzaChlcnJvclJhdGVBbGFybSk7XG5cbiAgICAvLyBIaWdoIHJlc3BvbnNlIHRpbWUgYWxhcm1cbiAgICBjb25zdCByZXNwb25zZVRpbWVBbGFybSA9IG5ldyBjbG91ZHdhdGNoLkFsYXJtKHRoaXMsICdIaWdoUmVzcG9uc2VUaW1lQWxhcm0nLCB7XG4gICAgICBhbGFybU5hbWU6IGBUZXN0QXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LUhpZ2hSZXNwb25zZVRpbWVgLFxuICAgICAgYWxhcm1EZXNjcmlwdGlvbjogJ0hpZ2ggcmVzcG9uc2UgdGltZSBkZXRlY3RlZCcsXG4gICAgICBtZXRyaWM6IG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICAgIG5hbWVzcGFjZTogJ0FXUy9BcHBsaWNhdGlvbkVMQicsXG4gICAgICAgIG1ldHJpY05hbWU6ICdUYXJnZXRSZXNwb25zZVRpbWUnLFxuICAgICAgICBkaW1lbnNpb25zTWFwOiB7XG4gICAgICAgICAgTG9hZEJhbGFuY2VyOiB0aGlzLmdldExvYWRCYWxhbmNlck5hbWUocHJvcHMpLFxuICAgICAgICB9LFxuICAgICAgICBzdGF0aXN0aWM6ICdBdmVyYWdlJyxcbiAgICAgICAgcGVyaW9kOiBjZGsuRHVyYXRpb24ubWludXRlcyg1KSxcbiAgICAgIH0pLFxuICAgICAgdGhyZXNob2xkOiBwcm9wcy5yZXNwb25zZVRpbWVUaHJlc2hvbGQgfHwgMjAwMCwgLy8gMiBzZWNvbmRzIGluIG1pbGxpc2Vjb25kc1xuICAgICAgZXZhbHVhdGlvblBlcmlvZHM6IDMsXG4gICAgICBjb21wYXJpc29uT3BlcmF0b3I6IGNsb3Vkd2F0Y2guQ29tcGFyaXNvbk9wZXJhdG9yLkdSRUFURVJfVEhBTl9USFJFU0hPTEQsXG4gICAgICB0cmVhdE1pc3NpbmdEYXRhOiBjbG91ZHdhdGNoLlRyZWF0TWlzc2luZ0RhdGEuTk9UX0JSRUFDSElORyxcbiAgICB9KTtcbiAgICByZXNwb25zZVRpbWVBbGFybS5hZGRBbGFybUFjdGlvbihuZXcgY2xvdWR3YXRjaEFjdGlvbnMuU25zQWN0aW9uKHRoaXMuYWxlcnRUb3BpYykpO1xuICAgIGFsYXJtcy5wdXNoKHJlc3BvbnNlVGltZUFsYXJtKTtcblxuICAgIC8vIEhpZ2ggQ1BVIHV0aWxpemF0aW9uIGFsYXJtXG4gICAgY29uc3QgY3B1QWxhcm0gPSBuZXcgY2xvdWR3YXRjaC5BbGFybSh0aGlzLCAnSGlnaENQVUFsYXJtJywge1xuICAgICAgYWxhcm1OYW1lOiBgVGVzdEFwcC0ke3Byb3BzLmVudmlyb25tZW50fS1IaWdoQ1BVYCxcbiAgICAgIGFsYXJtRGVzY3JpcHRpb246ICdIaWdoIENQVSB1dGlsaXphdGlvbiBkZXRlY3RlZCcsXG4gICAgICBtZXRyaWM6IG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICAgIG5hbWVzcGFjZTogJ0FXUy9FQ1MnLFxuICAgICAgICBtZXRyaWNOYW1lOiAnQ1BVVXRpbGl6YXRpb24nLFxuICAgICAgICBkaW1lbnNpb25zTWFwOiB7XG4gICAgICAgICAgU2VydmljZU5hbWU6IGB0ZXN0YXBwLXNlcnZpY2UtJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgICAgIENsdXN0ZXJOYW1lOiBgdGVzdGFwcC1jbHVzdGVyLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgICAgfSxcbiAgICAgICAgc3RhdGlzdGljOiAnQXZlcmFnZScsXG4gICAgICAgIHBlcmlvZDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICB9KSxcbiAgICAgIHRocmVzaG9sZDogcHJvcHMuY3B1VGhyZXNob2xkIHx8IDgwLFxuICAgICAgZXZhbHVhdGlvblBlcmlvZHM6IDMsXG4gICAgICB0cmVhdE1pc3NpbmdEYXRhOiBjbG91ZHdhdGNoLlRyZWF0TWlzc2luZ0RhdGEuTk9UX0JSRUFDSElORyxcbiAgICB9KTtcbiAgICBjcHVBbGFybS5hZGRBbGFybUFjdGlvbihuZXcgY2xvdWR3YXRjaEFjdGlvbnMuU25zQWN0aW9uKHRoaXMuYWxlcnRUb3BpYykpO1xuICAgIGFsYXJtcy5wdXNoKGNwdUFsYXJtKTtcblxuICAgIC8vIEhpZ2ggbWVtb3J5IHV0aWxpemF0aW9uIGFsYXJtXG4gICAgY29uc3QgbWVtb3J5QWxhcm0gPSBuZXcgY2xvdWR3YXRjaC5BbGFybSh0aGlzLCAnSGlnaE1lbW9yeUFsYXJtJywge1xuICAgICAgYWxhcm1OYW1lOiBgVGVzdEFwcC0ke3Byb3BzLmVudmlyb25tZW50fS1IaWdoTWVtb3J5YCxcbiAgICAgIGFsYXJtRGVzY3JpcHRpb246ICdIaWdoIG1lbW9yeSB1dGlsaXphdGlvbiBkZXRlY3RlZCcsXG4gICAgICBtZXRyaWM6IG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICAgIG5hbWVzcGFjZTogJ0FXUy9FQ1MnLFxuICAgICAgICBtZXRyaWNOYW1lOiAnTWVtb3J5VXRpbGl6YXRpb24nLFxuICAgICAgICBkaW1lbnNpb25zTWFwOiB7XG4gICAgICAgICAgU2VydmljZU5hbWU6IGB0ZXN0YXBwLXNlcnZpY2UtJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgICAgIENsdXN0ZXJOYW1lOiBgdGVzdGFwcC1jbHVzdGVyLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgICAgfSxcbiAgICAgICAgc3RhdGlzdGljOiAnQXZlcmFnZScsXG4gICAgICAgIHBlcmlvZDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICB9KSxcbiAgICAgIHRocmVzaG9sZDogcHJvcHMubWVtb3J5VGhyZXNob2xkIHx8IDg1LFxuICAgICAgZXZhbHVhdGlvblBlcmlvZHM6IDMsXG4gICAgICB0cmVhdE1pc3NpbmdEYXRhOiBjbG91ZHdhdGNoLlRyZWF0TWlzc2luZ0RhdGEuTk9UX0JSRUFDSElORyxcbiAgICB9KTtcbiAgICBtZW1vcnlBbGFybS5hZGRBbGFybUFjdGlvbihuZXcgY2xvdWR3YXRjaEFjdGlvbnMuU25zQWN0aW9uKHRoaXMuYWxlcnRUb3BpYykpO1xuICAgIGFsYXJtcy5wdXNoKG1lbW9yeUFsYXJtKTtcblxuICAgIC8vIE5vIGhlYWx0aHkgaG9zdHMgYWxhcm1cbiAgICBjb25zdCBoZWFsdGh5SG9zdHNBbGFybSA9IG5ldyBjbG91ZHdhdGNoLkFsYXJtKHRoaXMsICdOb0hlYWx0aHlIb3N0c0FsYXJtJywge1xuICAgICAgYWxhcm1OYW1lOiBgVGVzdEFwcC0ke3Byb3BzLmVudmlyb25tZW50fS1Ob0hlYWx0aHlIb3N0c2AsXG4gICAgICBhbGFybURlc2NyaXB0aW9uOiAnTm8gaGVhbHRoeSBob3N0cyBhdmFpbGFibGUnLFxuICAgICAgbWV0cmljOiBuZXcgY2xvdWR3YXRjaC5NZXRyaWMoe1xuICAgICAgICBuYW1lc3BhY2U6ICdBV1MvQXBwbGljYXRpb25FTEInLFxuICAgICAgICBtZXRyaWNOYW1lOiAnSGVhbHRoeUhvc3RDb3VudCcsXG4gICAgICAgIGRpbWVuc2lvbnNNYXA6IHtcbiAgICAgICAgICBMb2FkQmFsYW5jZXI6IHRoaXMuZ2V0TG9hZEJhbGFuY2VyTmFtZShwcm9wcyksXG4gICAgICAgIH0sXG4gICAgICAgIHN0YXRpc3RpYzogJ0F2ZXJhZ2UnLFxuICAgICAgICBwZXJpb2Q6IGNkay5EdXJhdGlvbi5taW51dGVzKDEpLFxuICAgICAgfSksXG4gICAgICB0aHJlc2hvbGQ6IDEsXG4gICAgICBldmFsdWF0aW9uUGVyaW9kczogMixcbiAgICAgIGNvbXBhcmlzb25PcGVyYXRvcjogY2xvdWR3YXRjaC5Db21wYXJpc29uT3BlcmF0b3IuTEVTU19USEFOX1RIUkVTSE9MRCxcbiAgICAgIHRyZWF0TWlzc2luZ0RhdGE6IGNsb3Vkd2F0Y2guVHJlYXRNaXNzaW5nRGF0YS5CUkVBQ0hJTkcsXG4gICAgfSk7XG4gICAgaGVhbHRoeUhvc3RzQWxhcm0uYWRkQWxhcm1BY3Rpb24obmV3IGNsb3Vkd2F0Y2hBY3Rpb25zLlNuc0FjdGlvbih0aGlzLmFsZXJ0VG9waWMpKTtcbiAgICBhbGFybXMucHVzaChoZWFsdGh5SG9zdHNBbGFybSk7XG5cbiAgICByZXR1cm4gYWxhcm1zO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVMb2dJbnNpZ2h0c1F1ZXJpZXMocHJvcHM6IE1vbml0b3JpbmdEYXNoYm9hcmRTdGFja1Byb3BzKTogYW55W10ge1xuICAgIC8vIFF1ZXJ5RGVmaW5pdGlvbiBjcmVhdGlvbiBpcyBub3QgZnVsbHkgY29tcGF0aWJsZSB3aXRoIHRoaXMgQ0RLIHZlcnNpb25cbiAgICAvLyBJbnN0ZWFkLCB3ZSdsbCByZXR1cm4gYW4gZW1wdHkgYXJyYXkgYW5kIGRvY3VtZW50IHRoZSBxdWVyaWVzIGZvciBtYW51YWwgY3JlYXRpb25cbiAgICBjb25zdCBxdWVyaWVzOiBhbnlbXSA9IFtdO1xuXG4gICAgLy8gTm90ZTogVGhlIGZvbGxvd2luZyBxdWVyaWVzIGNhbiBiZSBtYW51YWxseSBjcmVhdGVkIGluIENsb3VkV2F0Y2ggTG9ncyBJbnNpZ2h0czpcbiAgICAvLyBcbiAgICAvLyBFcnJvciBBbmFseXNpcyBRdWVyeTpcbiAgICAvLyBmaWVsZHMgQHRpbWVzdGFtcCwgQG1lc3NhZ2UsIEByZXF1ZXN0SWRcbiAgICAvLyB8IGZpbHRlciBAbWVzc2FnZSBsaWtlIC9FUlJPUi9cbiAgICAvLyB8IHN0YXRzIGNvdW50KCkgYnkgYmluKDVtKVxuICAgIC8vIHwgc29ydCBAdGltZXN0YW1wIGRlc2NcbiAgICAvL1xuICAgIC8vIFBlcmZvcm1hbmNlIFF1ZXJ5OlxuICAgIC8vIGZpZWxkcyBAdGltZXN0YW1wLCBAbWVzc2FnZSwgQGR1cmF0aW9uXG4gICAgLy8gfCBmaWx0ZXIgQHR5cGUgPSBcIlJFUE9SVFwiXG4gICAgLy8gfCBzdGF0cyBhdmcoQGR1cmF0aW9uKSwgbWF4KEBkdXJhdGlvbiksIG1pbihAZHVyYXRpb24pIGJ5IGJpbig1bSlcbiAgICAvL1xuICAgIC8vIFNlY3VyaXR5IEV2ZW50cyBRdWVyeTpcbiAgICAvLyBmaWVsZHMgQHRpbWVzdGFtcCwgQG1lc3NhZ2UsIHNvdXJjZUlQLCB1c2VyQWdlbnRcbiAgICAvLyB8IGZpbHRlciBAbWVzc2FnZSBsaWtlIC80MDMvIG9yIEBtZXNzYWdlIGxpa2UgLzQwMS8gb3IgQG1lc3NhZ2UgbGlrZSAvU0VDVVJJVFkvXG4gICAgLy8gfCBzdGF0cyBjb3VudCgpIGJ5IHNvdXJjZUlQXG4gICAgLy8gfCBzb3J0IGNvdW50IGRlc2NcblxuICAgIHJldHVybiBxdWVyaWVzO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVEZXBsb3ltZW50TW9uaXRvcmluZyhwcm9wczogTW9uaXRvcmluZ0Rhc2hib2FyZFN0YWNrUHJvcHMpOiB2b2lkIHtcbiAgICAvLyBDcmVhdGUgRXZlbnRCcmlkZ2UgcnVsZSBmb3IgZGVwbG95bWVudCBldmVudHNcbiAgICBjb25zdCBkZXBsb3ltZW50UnVsZSA9IG5ldyBldmVudHMuUnVsZSh0aGlzLCAnRGVwbG95bWVudEV2ZW50c1J1bGUnLCB7XG4gICAgICBydWxlTmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tZGVwbG95bWVudC1ldmVudHNgLFxuICAgICAgZGVzY3JpcHRpb246ICdNb25pdG9yIGRlcGxveW1lbnQgZXZlbnRzJyxcbiAgICAgIGV2ZW50UGF0dGVybjoge1xuICAgICAgICBzb3VyY2U6IFsnYXdzLmVjcyddLFxuICAgICAgICBkZXRhaWxUeXBlOiBbJ0VDUyBTZXJ2aWNlIEFjdGlvbiddLFxuICAgICAgICBkZXRhaWw6IHtcbiAgICAgICAgICBjbHVzdGVyQXJuOiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgICdleGlzdHMnOiB0cnVlLFxuICAgICAgICAgICAgICAnd2lsZGNhcmQnOiBgKnRlc3RhcHAtY2x1c3Rlci0ke3Byb3BzLmVudmlyb25tZW50fSpgLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIFNlbmQgZGVwbG95bWVudCBub3RpZmljYXRpb25zIHRvIFNOU1xuICAgIGRlcGxveW1lbnRSdWxlLmFkZFRhcmdldChcbiAgICAgIG5ldyB0YXJnZXRzLlNuc1RvcGljKHRoaXMuYWxlcnRUb3BpYywge1xuICAgICAgICBtZXNzYWdlOiBldmVudHMuUnVsZVRhcmdldElucHV0LmZyb21UZXh0KFxuICAgICAgICAgIGBEZXBsb3ltZW50IEV2ZW50IGluICR7cHJvcHMuZW52aXJvbm1lbnR9OlxcbiR7ZXZlbnRzLlJ1bGVUYXJnZXRJbnB1dC5mcm9tRXZlbnRQYXRoKCckLmRldGFpbCcpfWBcbiAgICAgICAgKSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vIENyZWF0ZSBjdXN0b20gbWV0cmljIGZvciBkZXBsb3ltZW50IGZyZXF1ZW5jeVxuICAgIGNvbnN0IGRlcGxveW1lbnRNZXRyaWNSdWxlID0gbmV3IGV2ZW50cy5SdWxlKHRoaXMsICdEZXBsb3ltZW50TWV0cmljc1J1bGUnLCB7XG4gICAgICBydWxlTmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tZGVwbG95bWVudC1tZXRyaWNzYCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnVHJhY2sgZGVwbG95bWVudCBmcmVxdWVuY3knLFxuICAgICAgZXZlbnRQYXR0ZXJuOiB7XG4gICAgICAgIHNvdXJjZTogWydhd3MuZWNzJ10sXG4gICAgICAgIGRldGFpbFR5cGU6IFsnRUNTIFNlcnZpY2UgQWN0aW9uJ10sXG4gICAgICAgIGRldGFpbDoge1xuICAgICAgICAgIGV2ZW50TmFtZTogWydVcGRhdGVTZXJ2aWNlJ10sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gTGFtYmRhIGZ1bmN0aW9uIHRvIGVtaXQgY3VzdG9tIG1ldHJpY3NcbiAgICBjb25zdCBtZXRyaWNzRnVuY3Rpb24gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdEZXBsb3ltZW50TWV0cmljc0Z1bmN0aW9uJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfOSxcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21JbmxpbmUoYFxuaW1wb3J0IGpzb25cbmltcG9ydCBib3RvM1xuZnJvbSBkYXRldGltZSBpbXBvcnQgZGF0ZXRpbWVcblxuY2xvdWR3YXRjaCA9IGJvdG8zLmNsaWVudCgnY2xvdWR3YXRjaCcpXG5cbmRlZiBoYW5kbGVyKGV2ZW50LCBjb250ZXh0KTpcbiAgICB0cnk6XG4gICAgICAgICMgRXh0cmFjdCBkZXBsb3ltZW50IGluZm9ybWF0aW9uXG4gICAgICAgIGRldGFpbCA9IGV2ZW50LmdldCgnZGV0YWlsJywge30pXG4gICAgICAgIGNsdXN0ZXJfbmFtZSA9IGRldGFpbC5nZXQoJ2NsdXN0ZXJBcm4nLCAnJykuc3BsaXQoJy8nKVstMV1cbiAgICAgICAgXG4gICAgICAgIGlmICd0ZXN0YXBwLWNsdXN0ZXItJHtwcm9wcy5lbnZpcm9ubWVudH0nIGluIGNsdXN0ZXJfbmFtZTpcbiAgICAgICAgICAgICMgRW1pdCBkZXBsb3ltZW50IG1ldHJpY1xuICAgICAgICAgICAgY2xvdWR3YXRjaC5wdXRfbWV0cmljX2RhdGEoXG4gICAgICAgICAgICAgICAgTmFtZXNwYWNlPSdUZXN0QXBwL0RlcGxveW1lbnRzJyxcbiAgICAgICAgICAgICAgICBNZXRyaWNEYXRhPVtcbiAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgJ01ldHJpY05hbWUnOiAnRGVwbG95bWVudENvdW50JyxcbiAgICAgICAgICAgICAgICAgICAgICAgICdEaW1lbnNpb25zJzogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ05hbWUnOiAnRW52aXJvbm1lbnQnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnVmFsdWUnOiAnJHtwcm9wcy5lbnZpcm9ubWVudH0nXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICdOYW1lJzogJ0NsdXN0ZXInLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnVmFsdWUnOiBjbHVzdGVyX25hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ1ZhbHVlJzogMSxcbiAgICAgICAgICAgICAgICAgICAgICAgICdVbml0JzogJ0NvdW50JyxcbiAgICAgICAgICAgICAgICAgICAgICAgICdUaW1lc3RhbXAnOiBkYXRldGltZS5ub3coKVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXVxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAnc3RhdHVzQ29kZSc6IDIwMCxcbiAgICAgICAgICAgICdib2R5JzoganNvbi5kdW1wcygnTWV0cmljIGVtaXR0ZWQgc3VjY2Vzc2Z1bGx5JylcbiAgICAgICAgfVxuICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZTpcbiAgICAgICAgcHJpbnQoZlwiRXJyb3I6IHtzdHIoZSl9XCIpXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAnc3RhdHVzQ29kZSc6IDUwMCxcbiAgICAgICAgICAgICdib2R5JzoganNvbi5kdW1wcyhmJ0Vycm9yOiB7c3RyKGUpfScpXG4gICAgICAgIH1cbiAgICAgIGApLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgRU5WSVJPTk1FTlQ6IHByb3BzLmVudmlyb25tZW50LFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEdyYW50IENsb3VkV2F0Y2ggcGVybWlzc2lvbnNcbiAgICBtZXRyaWNzRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnY2xvdWR3YXRjaDpQdXRNZXRyaWNEYXRhJ10sXG4gICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLyBBZGQgTGFtYmRhIHRhcmdldCB0byBydWxlXG4gICAgZGVwbG95bWVudE1ldHJpY1J1bGUuYWRkVGFyZ2V0KG5ldyB0YXJnZXRzLkxhbWJkYUZ1bmN0aW9uKG1ldHJpY3NGdW5jdGlvbikpO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVDb3N0QWxlcnRpbmcocHJvcHM6IE1vbml0b3JpbmdEYXNoYm9hcmRTdGFja1Byb3BzKTogdm9pZCB7XG4gICAgLy8gQ29zdCBhbm9tYWx5IGRldGVjdGlvbiAoc2ltcGxpZmllZCAtIHdvdWxkIHVzZSBBV1MgQ29zdCBBbm9tYWx5IERldGVjdGlvbiBpbiBwcmFjdGljZSlcbiAgICBjb25zdCBjb3N0QWxhcm0gPSBuZXcgY2xvdWR3YXRjaC5BbGFybSh0aGlzLCAnSGlnaENvc3RBbGFybScsIHtcbiAgICAgIGFsYXJtTmFtZTogYFRlc3RBcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tSGlnaENvc3RgLFxuICAgICAgYWxhcm1EZXNjcmlwdGlvbjogJ0hpZ2ggY29zdCBkZXRlY3RlZCBmb3IgZW52aXJvbm1lbnQnLFxuICAgICAgbWV0cmljOiBuZXcgY2xvdWR3YXRjaC5NZXRyaWMoe1xuICAgICAgICBuYW1lc3BhY2U6ICdBV1MvQmlsbGluZycsXG4gICAgICAgIG1ldHJpY05hbWU6ICdFc3RpbWF0ZWRDaGFyZ2VzJyxcbiAgICAgICAgZGltZW5zaW9uc01hcDoge1xuICAgICAgICAgIEN1cnJlbmN5OiAnVVNEJyxcbiAgICAgICAgfSxcbiAgICAgICAgc3RhdGlzdGljOiAnTWF4aW11bScsXG4gICAgICAgIHBlcmlvZDogY2RrLkR1cmF0aW9uLmhvdXJzKDYpLFxuICAgICAgfSksXG4gICAgICB0aHJlc2hvbGQ6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgPyAxMDAwIDogMTAwLCAvLyBEaWZmZXJlbnQgdGhyZXNob2xkcyBwZXIgZW52aXJvbm1lbnRcbiAgICAgIGV2YWx1YXRpb25QZXJpb2RzOiAxLFxuICAgICAgdHJlYXRNaXNzaW5nRGF0YTogY2xvdWR3YXRjaC5UcmVhdE1pc3NpbmdEYXRhLk5PVF9CUkVBQ0hJTkcsXG4gICAgfSk7XG5cbiAgICBjb3N0QWxhcm0uYWRkQWxhcm1BY3Rpb24obmV3IGNsb3Vkd2F0Y2hBY3Rpb25zLlNuc0FjdGlvbih0aGlzLmFsZXJ0VG9waWMpKTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlQ3VzdG9tTWV0cmljc0Z1bmN0aW9uKHByb3BzOiBNb25pdG9yaW5nRGFzaGJvYXJkU3RhY2tQcm9wcyk6IGxhbWJkYS5GdW5jdGlvbiB7XG4gICAgY29uc3QgY3VzdG9tTWV0cmljc0Z1bmN0aW9uID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnQ3VzdG9tTWV0cmljc0Z1bmN0aW9uJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS1jdXN0b20tbWV0cmljc2AsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM185LFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcbmltcG9ydCBqc29uXG5pbXBvcnQgYm90bzNcbmltcG9ydCByZXF1ZXN0c1xuZnJvbSBkYXRldGltZSBpbXBvcnQgZGF0ZXRpbWVcbmltcG9ydCBvc1xuXG5jbG91ZHdhdGNoID0gYm90bzMuY2xpZW50KCdjbG91ZHdhdGNoJylcbmVjcyA9IGJvdG8zLmNsaWVudCgnZWNzJylcbmVsYnYyID0gYm90bzMuY2xpZW50KCdlbGJ2MicpXG5cbmRlZiBoYW5kbGVyKGV2ZW50LCBjb250ZXh0KTpcbiAgICBlbnZpcm9ubWVudCA9IG9zLmVudmlyb24uZ2V0KCdFTlZJUk9OTUVOVCcsICcke3Byb3BzLmVudmlyb25tZW50fScpXG4gICAgXG4gICAgdHJ5OlxuICAgICAgICAjIENvbGxlY3QgY3VzdG9tIGFwcGxpY2F0aW9uIG1ldHJpY3NcbiAgICAgICAgbWV0cmljcyA9IFtdXG4gICAgICAgIFxuICAgICAgICAjIEVDUyBTZXJ2aWNlIG1ldHJpY3NcbiAgICAgICAgY2x1c3Rlcl9uYW1lID0gZlwidGVzdGFwcC1jbHVzdGVyLXtlbnZpcm9ubWVudH1cIlxuICAgICAgICBzZXJ2aWNlX25hbWUgPSBmXCJ0ZXN0YXBwLXNlcnZpY2Ute2Vudmlyb25tZW50fVwiXG4gICAgICAgIFxuICAgICAgICAjIEdldCBFQ1Mgc2VydmljZSBpbmZvcm1hdGlvblxuICAgICAgICB0cnk6XG4gICAgICAgICAgICBzZXJ2aWNlcyA9IGVjcy5kZXNjcmliZV9zZXJ2aWNlcyhcbiAgICAgICAgICAgICAgICBjbHVzdGVyPWNsdXN0ZXJfbmFtZSxcbiAgICAgICAgICAgICAgICBzZXJ2aWNlcz1bc2VydmljZV9uYW1lXVxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiBzZXJ2aWNlc1snc2VydmljZXMnXTpcbiAgICAgICAgICAgICAgICBzZXJ2aWNlID0gc2VydmljZXNbJ3NlcnZpY2VzJ11bMF1cbiAgICAgICAgICAgICAgICBydW5uaW5nX2NvdW50ID0gc2VydmljZVsncnVubmluZ0NvdW50J11cbiAgICAgICAgICAgICAgICBkZXNpcmVkX2NvdW50ID0gc2VydmljZVsnZGVzaXJlZENvdW50J11cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBtZXRyaWNzLmV4dGVuZChbXG4gICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICdNZXRyaWNOYW1lJzogJ1NlcnZpY2VSdW5uaW5nQ291bnQnLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ1ZhbHVlJzogcnVubmluZ19jb3VudCxcbiAgICAgICAgICAgICAgICAgICAgICAgICdVbml0JzogJ0NvdW50JyxcbiAgICAgICAgICAgICAgICAgICAgICAgICdEaW1lbnNpb25zJzogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsnTmFtZSc6ICdFbnZpcm9ubWVudCcsICdWYWx1ZSc6IGVudmlyb25tZW50fSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7J05hbWUnOiAnU2VydmljZU5hbWUnLCAnVmFsdWUnOiBzZXJ2aWNlX25hbWV9XG4gICAgICAgICAgICAgICAgICAgICAgICBdXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICdNZXRyaWNOYW1lJzogJ1NlcnZpY2VEZXNpcmVkQ291bnQnLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICdWYWx1ZSc6IGRlc2lyZWRfY291bnQsXG4gICAgICAgICAgICAgICAgICAgICAgICAnVW5pdCc6ICdDb3VudCcsXG4gICAgICAgICAgICAgICAgICAgICAgICAnRGltZW5zaW9ucyc6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7J05hbWUnOiAnRW52aXJvbm1lbnQnLCAnVmFsdWUnOiBlbnZpcm9ubWVudH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeydOYW1lJzogJ1NlcnZpY2VOYW1lJywgJ1ZhbHVlJzogc2VydmljZV9uYW1lfVxuICAgICAgICAgICAgICAgICAgICAgICAgXVxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAnTWV0cmljTmFtZSc6ICdTZXJ2aWNlSGVhbHRoUmF0aW8nLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ1ZhbHVlJzogKHJ1bm5pbmdfY291bnQgLyBtYXgoZGVzaXJlZF9jb3VudCwgMSkpICogMTAwLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ1VuaXQnOiAnUGVyY2VudCcsXG4gICAgICAgICAgICAgICAgICAgICAgICAnRGltZW5zaW9ucyc6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7J05hbWUnOiAnRW52aXJvbm1lbnQnLCAnVmFsdWUnOiBlbnZpcm9ubWVudH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeydOYW1lJzogJ1NlcnZpY2VOYW1lJywgJ1ZhbHVlJzogc2VydmljZV9uYW1lfVxuICAgICAgICAgICAgICAgICAgICAgICAgXVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXSlcbiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOlxuICAgICAgICAgICAgcHJpbnQoZlwiRXJyb3IgY29sbGVjdGluZyBFQ1MgbWV0cmljczoge2V9XCIpXG4gICAgICAgIFxuICAgICAgICAjIEFwcGxpY2F0aW9uIGhlYWx0aCBjaGVja1xuICAgICAgICB0cnk6XG4gICAgICAgICAgICAjIEdldCBsb2FkIGJhbGFuY2VyIEROU1xuICAgICAgICAgICAgbG9hZF9iYWxhbmNlcnMgPSBlbGJ2Mi5kZXNjcmliZV9sb2FkX2JhbGFuY2VycyhcbiAgICAgICAgICAgICAgICBOYW1lcz1bZlwidGVzdGFwcC1hbGIte2Vudmlyb25tZW50fVwiXVxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiBsb2FkX2JhbGFuY2Vyc1snTG9hZEJhbGFuY2VycyddOlxuICAgICAgICAgICAgICAgIGxiX2RucyA9IGxvYWRfYmFsYW5jZXJzWydMb2FkQmFsYW5jZXJzJ11bMF1bJ0ROU05hbWUnXVxuICAgICAgICAgICAgICAgIGhlYWx0aF91cmwgPSBmXCJodHRwOi8ve2xiX2Ruc30vaGVhbHRoL1wiXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgIyBQZXJmb3JtIGhlYWx0aCBjaGVja1xuICAgICAgICAgICAgICAgIHJlc3BvbnNlID0gcmVxdWVzdHMuZ2V0KGhlYWx0aF91cmwsIHRpbWVvdXQ9MTApXG4gICAgICAgICAgICAgICAgaGVhbHRoX3N0YXR1cyA9IDEgaWYgcmVzcG9uc2Uuc3RhdHVzX2NvZGUgPT0gMjAwIGVsc2UgMFxuICAgICAgICAgICAgICAgIHJlc3BvbnNlX3RpbWUgPSByZXNwb25zZS5lbGFwc2VkLnRvdGFsX3NlY29uZHMoKSAqIDEwMDBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBtZXRyaWNzLmV4dGVuZChbXG4gICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICdNZXRyaWNOYW1lJzogJ0FwcGxpY2F0aW9uSGVhbHRoJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICdWYWx1ZSc6IGhlYWx0aF9zdGF0dXMsXG4gICAgICAgICAgICAgICAgICAgICAgICAnVW5pdCc6ICdDb3VudCcsXG4gICAgICAgICAgICAgICAgICAgICAgICAnRGltZW5zaW9ucyc6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7J05hbWUnOiAnRW52aXJvbm1lbnQnLCAnVmFsdWUnOiBlbnZpcm9ubWVudH1cbiAgICAgICAgICAgICAgICAgICAgICAgIF1cbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgJ01ldHJpY05hbWUnOiAnSGVhbHRoQ2hlY2tSZXNwb25zZVRpbWUnLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ1ZhbHVlJzogcmVzcG9uc2VfdGltZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICdVbml0JzogJ01pbGxpc2Vjb25kcycsIFxuICAgICAgICAgICAgICAgICAgICAgICAgJ0RpbWVuc2lvbnMnOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeydOYW1lJzogJ0Vudmlyb25tZW50JywgJ1ZhbHVlJzogZW52aXJvbm1lbnR9XG4gICAgICAgICAgICAgICAgICAgICAgICBdXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBdKVxuICAgICAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGU6XG4gICAgICAgICAgICBwcmludChmXCJFcnJvciBjb2xsZWN0aW5nIGFwcGxpY2F0aW9uIG1ldHJpY3M6IHtlfVwiKVxuICAgICAgICAgICAgIyBFbWl0IHVuaGVhbHRoeSBtZXRyaWNcbiAgICAgICAgICAgIG1ldHJpY3MuYXBwZW5kKHtcbiAgICAgICAgICAgICAgICAnTWV0cmljTmFtZSc6ICdBcHBsaWNhdGlvbkhlYWx0aCcsXG4gICAgICAgICAgICAgICAgJ1ZhbHVlJzogMCxcbiAgICAgICAgICAgICAgICAnVW5pdCc6ICdDb3VudCcsXG4gICAgICAgICAgICAgICAgJ0RpbWVuc2lvbnMnOiBbXG4gICAgICAgICAgICAgICAgICAgIHsnTmFtZSc6ICdFbnZpcm9ubWVudCcsICdWYWx1ZSc6IGVudmlyb25tZW50fVxuICAgICAgICAgICAgICAgIF1cbiAgICAgICAgICAgIH0pXG4gICAgICAgIFxuICAgICAgICAjIEVtaXQgYWxsIG1ldHJpY3NcbiAgICAgICAgaWYgbWV0cmljczpcbiAgICAgICAgICAgICMgU3BsaXQgaW50byBjaHVua3Mgb2YgMjAgKENsb3VkV2F0Y2ggbGltaXQpXG4gICAgICAgICAgICBmb3IgaSBpbiByYW5nZSgwLCBsZW4obWV0cmljcyksIDIwKTpcbiAgICAgICAgICAgICAgICBjaHVuayA9IG1ldHJpY3NbaTppKzIwXVxuICAgICAgICAgICAgICAgIGNsb3Vkd2F0Y2gucHV0X21ldHJpY19kYXRhKFxuICAgICAgICAgICAgICAgICAgICBOYW1lc3BhY2U9J1Rlc3RBcHAvQ3VzdG9tJyxcbiAgICAgICAgICAgICAgICAgICAgTWV0cmljRGF0YT1bXG4gICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKiptZXRyaWMsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgJ1RpbWVzdGFtcCc6IGRhdGV0aW1lLm5vdygpXG4gICAgICAgICAgICAgICAgICAgICAgICB9IGZvciBtZXRyaWMgaW4gY2h1bmtcbiAgICAgICAgICAgICAgICAgICAgXVxuICAgICAgICAgICAgICAgIClcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAnc3RhdHVzQ29kZSc6IDIwMCxcbiAgICAgICAgICAgICdib2R5JzoganNvbi5kdW1wcyhmJ0VtaXR0ZWQge2xlbihtZXRyaWNzKX0gY3VzdG9tIG1ldHJpY3MnKVxuICAgICAgICB9XG4gICAgICAgIFxuICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZTpcbiAgICAgICAgcHJpbnQoZlwiRXJyb3IgaW4gY3VzdG9tIG1ldHJpY3MgZnVuY3Rpb246IHtlfVwiKVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgJ3N0YXR1c0NvZGUnOiA1MDAsXG4gICAgICAgICAgICAnYm9keSc6IGpzb24uZHVtcHMoZidFcnJvcjoge3N0cihlKX0nKVxuICAgICAgICB9XG4gICAgICBgKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIEVOVklST05NRU5UOiBwcm9wcy5lbnZpcm9ubWVudCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBHcmFudCBuZWNlc3NhcnkgcGVybWlzc2lvbnNcbiAgICBjdXN0b21NZXRyaWNzRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAnY2xvdWR3YXRjaDpQdXRNZXRyaWNEYXRhJyxcbiAgICAgICAgICAnZWNzOkRlc2NyaWJlU2VydmljZXMnLFxuICAgICAgICAgICdlY3M6RGVzY3JpYmVUYXNrcycsXG4gICAgICAgICAgJ2VsYXN0aWNsb2FkYmFsYW5jaW5nOkRlc2NyaWJlTG9hZEJhbGFuY2VycycsXG4gICAgICAgICAgJ2VsYXN0aWNsb2FkYmFsYW5jaW5nOkRlc2NyaWJlVGFyZ2V0SGVhbHRoJyxcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vIFNjaGVkdWxlIHRoZSBmdW5jdGlvbiB0byBydW4gZXZlcnkgNSBtaW51dGVzXG4gICAgY29uc3Qgc2NoZWR1bGUgPSBuZXcgZXZlbnRzLlJ1bGUodGhpcywgJ0N1c3RvbU1ldHJpY3NTY2hlZHVsZScsIHtcbiAgICAgIHNjaGVkdWxlOiBldmVudHMuU2NoZWR1bGUucmF0ZShjZGsuRHVyYXRpb24ubWludXRlcyg1KSksXG4gICAgICBkZXNjcmlwdGlvbjogJ1RyaWdnZXIgY3VzdG9tIG1ldHJpY3MgY29sbGVjdGlvbicsXG4gICAgfSk7XG5cbiAgICBzY2hlZHVsZS5hZGRUYXJnZXQobmV3IHRhcmdldHMuTGFtYmRhRnVuY3Rpb24oY3VzdG9tTWV0cmljc0Z1bmN0aW9uKSk7XG5cbiAgICByZXR1cm4gY3VzdG9tTWV0cmljc0Z1bmN0aW9uO1xuICB9XG5cbiAgcHJpdmF0ZSBnZXRMb2FkQmFsYW5jZXJOYW1lKHByb3BzOiBNb25pdG9yaW5nRGFzaGJvYXJkU3RhY2tQcm9wcyk6IHN0cmluZyB7XG4gICAgLy8gVGhpcyB3b3VsZCBub3JtYWxseSBiZSBpbXBvcnRlZCBmcm9tIHRoZSBwbGF0Zm9ybSBzdGFja1xuICAgIHJldHVybiBgYXBwL3Rlc3RhcHAtYWxiLSR7cHJvcHMuZW52aXJvbm1lbnR9LzEyMzQ1Njc4OTAxMjM0NTZgO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVPdXRwdXRzKHByb3BzOiBNb25pdG9yaW5nRGFzaGJvYXJkU3RhY2tQcm9wcyk6IHZvaWQge1xuICAgIC8vIERhc2hib2FyZCBVUkxcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRGFzaGJvYXJkVXJsJywge1xuICAgICAgdmFsdWU6IGBodHRwczovLyR7dGhpcy5yZWdpb259LmNvbnNvbGUuYXdzLmFtYXpvbi5jb20vY2xvdWR3YXRjaC9ob21lP3JlZ2lvbj0ke3RoaXMucmVnaW9ufSNkYXNoYm9hcmRzOm5hbWU9JHt0aGlzLmRhc2hib2FyZC5kYXNoYm9hcmROYW1lfWAsXG4gICAgICBkZXNjcmlwdGlvbjogJ0Nsb3VkV2F0Y2ggRGFzaGJvYXJkIFVSTCcsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tRGFzaGJvYXJkVXJsYCxcbiAgICB9KTtcblxuICAgIC8vIEFsZXJ0IHRvcGljIEFSTlxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBbGVydFRvcGljQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMuYWxlcnRUb3BpYy50b3BpY0FybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnU05TIHRvcGljIGZvciBtb25pdG9yaW5nIGFsZXJ0cycsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQWxlcnRUb3BpY0FybmAsXG4gICAgfSk7XG5cbiAgICAvLyBBbGFybSBjb3VudFxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBbGFybUNvdW50Jywge1xuICAgICAgdmFsdWU6IHRoaXMuYWxhcm1zLmxlbmd0aC50b1N0cmluZygpLFxuICAgICAgZGVzY3JpcHRpb246ICdOdW1iZXIgb2YgQ2xvdWRXYXRjaCBhbGFybXMgY3JlYXRlZCcsXG4gICAgfSk7XG5cbiAgICAvLyBMb2cgSW5zaWdodHMgcXVlcmllcyBjb3VudFxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdMb2dJbnNpZ2h0c1F1ZXJ5Q291bnQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5sb2dJbnNpZ2h0cy5sZW5ndGgudG9TdHJpbmcoKSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnTnVtYmVyIG9mIExvZyBJbnNpZ2h0cyBxdWVyaWVzIGNyZWF0ZWQnLFxuICAgIH0pO1xuXG4gICAgLy8gTW9uaXRvcmluZyBzdW1tYXJ5XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ01vbml0b3JpbmdTdW1tYXJ5Jywge1xuICAgICAgdmFsdWU6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgZW52aXJvbm1lbnQ6IHByb3BzLmVudmlyb25tZW50LFxuICAgICAgICBkYXNoYm9hcmQ6IHRoaXMuZGFzaGJvYXJkLmRhc2hib2FyZE5hbWUsXG4gICAgICAgIGFsYXJtczogdGhpcy5hbGFybXMubGVuZ3RoLFxuICAgICAgICBsb2dRdWVyaWVzOiB0aGlzLmxvZ0luc2lnaHRzLmxlbmd0aCxcbiAgICAgICAgYWxlcnRpbmc6ICEhcHJvcHMuYWxlcnRpbmdFbWFpbCxcbiAgICAgICAgYWR2YW5jZWRNZXRyaWNzOiBwcm9wcy5lbmFibGVBZHZhbmNlZE1ldHJpY3MgfHwgZmFsc2UsXG4gICAgICAgIGNvc3RBbGVydGluZzogcHJvcHMuZW5hYmxlQ29zdEFsZXJ0aW5nIHx8IGZhbHNlLFxuICAgICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIH0pLFxuICAgICAgZGVzY3JpcHRpb246ICdNb25pdG9yaW5nIGNvbmZpZ3VyYXRpb24gc3VtbWFyeScsXG4gICAgfSk7XG4gIH1cbn0iXX0=