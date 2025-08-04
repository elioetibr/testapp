import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface MonitoringDashboardStackProps extends cdk.StackProps {
  environment: string;
  
  // Stack ARNs for cross-stack monitoring
  vpcStackName?: string;
  platformStackName?: string;
  applicationStackName?: string;
  securityStackName?: string;
  
  // Monitoring configuration
  alertingEmail?: string;
  alertingSlack?: string;
  retentionDays?: number;
  enableAdvancedMetrics?: boolean;
  enableCostAlerting?: boolean;
  
  // Thresholds
  errorRateThreshold?: number;
  responseTimeThreshold?: number;
  cpuThreshold?: number;
  memoryThreshold?: number;
}

export class MonitoringDashboardStack extends cdk.Stack {
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly alertTopic: sns.Topic;
  public readonly logInsights: logs.QueryDefinition[];
  public readonly alarms: cloudwatch.Alarm[];

  constructor(scope: Construct, id: string, props: MonitoringDashboardStackProps) {
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

  private createAlertTopic(props: MonitoringDashboardStackProps): sns.Topic {
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

  private createStackSpecificDashboard(props: MonitoringDashboardStackProps): cloudwatch.Dashboard {
    const dashboard = new cloudwatch.Dashboard(this, 'TestAppDashboard', {
      dashboardName: `TestApp-${props.environment}-Overview`,
    });

    // Application Health Section
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `# 🎯 TestApp ${props.environment.toUpperCase()} Environment Dashboard\n\n**Last Updated**: ${new Date().toISOString()}\n\n**Environment**: ${props.environment}`,
        width: 24,
        height: 3,
      })
    );

    // System Health Row
    dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
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
      }),
      new cloudwatch.SingleValueWidget({
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
      }),
      new cloudwatch.SingleValueWidget({
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
      }),
      new cloudwatch.SingleValueWidget({
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
      })
    );

    // ECS Performance Row
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
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
      }),
      new cloudwatch.GraphWidget({
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
      })
    );

    // Infrastructure Health Row
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
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
      }),
      new cloudwatch.GraphWidget({
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
      })
    );

    // Log Analysis Row (if advanced metrics enabled)
    if (props.enableAdvancedMetrics) {
      dashboard.addWidgets(
        new cloudwatch.TextWidget({
          markdown: `## 📝 Application Logs
Log analysis widgets are not supported in this CDK version.
Use CloudWatch Logs Insights directly to query:
- Error logs: \`/testapp/${props.environment}/application\`
- Query: \`fields @timestamp, @message | filter @message like /ERROR/\``,
          width: 12,
          height: 3,
        }),
        new cloudwatch.TextWidget({
          markdown: `## 🔍 Error Patterns
Monitor error patterns in CloudWatch Logs:
- Navigate to CloudWatch Logs Insights
- Select log group: \`/testapp/${props.environment}/application\`
- Query: \`fields @timestamp, @message | filter @message like /500/\``,
          width: 12,
          height: 3,
        })
      );
    }

    // Security Monitoring Row
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## 🔒 Security Monitoring\n\n**Environment**: ${props.environment}\n**Security Stack**: ${props.securityStackName || 'N/A'}\n**Last Security Scan**: Check CI/CD pipeline`,
        width: 12,
        height: 4,
      }),
      new cloudwatch.GraphWidget({
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
      })
    );

    return dashboard;
  }

  private createComprehensiveAlarms(props: MonitoringDashboardStackProps): cloudwatch.Alarm[] {
    const alarms: cloudwatch.Alarm[] = [];

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
      threshold: props.responseTimeThreshold || 2000, // 2 seconds in milliseconds
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

  private createLogInsightsQueries(props: MonitoringDashboardStackProps): any[] {
    // QueryDefinition creation is not fully compatible with this CDK version
    // Instead, we'll return an empty array and document the queries for manual creation
    const queries: any[] = [];

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

  private createDeploymentMonitoring(props: MonitoringDashboardStackProps): void {
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
    deploymentRule.addTarget(
      new targets.SnsTopic(this.alertTopic, {
        message: events.RuleTargetInput.fromText(
          `Deployment Event in ${props.environment}:\n${events.RuleTargetInput.fromEventPath('$.detail')}`
        ),
      })
    );

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
    metricsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      })
    );

    // Add Lambda target to rule
    deploymentMetricRule.addTarget(new targets.LambdaFunction(metricsFunction));
  }

  private createCostAlerting(props: MonitoringDashboardStackProps): void {
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
      threshold: props.environment === 'production' ? 1000 : 100, // Different thresholds per environment
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    costAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
  }

  private createCustomMetricsFunction(props: MonitoringDashboardStackProps): lambda.Function {
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
    customMetricsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudwatch:PutMetricData',
          'ecs:DescribeServices',
          'ecs:DescribeTasks',
          'elasticloadbalancing:DescribeLoadBalancers',
          'elasticloadbalancing:DescribeTargetHealth',
        ],
        resources: ['*'],
      })
    );

    // Schedule the function to run every 5 minutes
    const schedule = new events.Rule(this, 'CustomMetricsSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      description: 'Trigger custom metrics collection',
    });

    schedule.addTarget(new targets.LambdaFunction(customMetricsFunction));

    return customMetricsFunction;
  }

  private getLoadBalancerName(props: MonitoringDashboardStackProps): string {
    // This would normally be imported from the platform stack
    return `app/testapp-alb-${props.environment}/1234567890123456`;
  }

  private createOutputs(props: MonitoringDashboardStackProps): void {
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