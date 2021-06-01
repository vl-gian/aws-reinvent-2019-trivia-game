#!/usr/bin/env node
import codebuild = require('@aws-cdk/aws-codebuild');
import codepipeline = require('@aws-cdk/aws-codepipeline');
import notifications = require('@aws-cdk/aws-codestarnotifications');
import actions = require('@aws-cdk/aws-codepipeline-actions');
import cdk = require('@aws-cdk/core');

export interface TriviaGameCfnPipelineProps {
    stackName: string;
    templateName: string;
    pipelineName: string;
    directory: string;
}

/**
 * A common class for a pipeline that deploys a CloudFormation template.
 * [GitHub source] -> [CodeBuild build] -> [Deploy CFN 'test' stack] -> [Deploy CFN 'prod' stack]
 */
export class TriviaGameCfnPipeline extends cdk.Construct {
    public readonly pipeline: codepipeline.Pipeline;

    public readonly sourceOutput: codepipeline.Artifact;

    constructor(parent: cdk.Construct, name: string, props: TriviaGameCfnPipelineProps) {
        super(parent, name);

        const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
            pipelineName: 'reinvent-trivia-game-' + props.pipelineName,
        });
        this.pipeline = pipeline;

        new notifications.CfnNotificationRule(this, 'PipelineNotifications', {
            name: pipeline.pipelineName,
            detailType: 'FULL',
            resource: pipeline.pipelineArn,
            eventTypeIds: [ 'codepipeline-pipeline-pipeline-execution-failed' ],
            targets: [
                {
                    targetType: 'SNS',
                    targetAddress: cdk.Stack.of(this).formatArn({
                        service: 'sns',
                        resource: 'reinvent-trivia-notifications'
                    }),
                }
            ]
        });

        // Source
        const githubAccessToken = cdk.SecretValue.secretsManager('TriviaGitHubToken');
        const sourceOutput = new codepipeline.Artifact('SourceArtifact');
        const sourceAction = new actions.GitHubSourceAction({
            actionName: 'GitHubSource',
            owner: 'vl-gian',
            repo: 'aws-reinvent-2019-trivia-game',
            oauthToken: githubAccessToken,
            output: sourceOutput
        });
        pipeline.addStage({
            stageName: 'Source',
            actions: [sourceAction],
        });
        this.sourceOutput = sourceOutput;

        // Build
        const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
            buildSpec: codebuild.BuildSpec.fromSourceFilename(props.directory + '/buildspec.yml'),
            environment: {
              buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
              environmentVariables: {
                'ARTIFACTS_BUCKET': {
                    value: pipeline.artifactBucket.bucketName
                }
              },
              privileged: true
            }
        });

        const buildArtifact = new codepipeline.Artifact('BuildArtifact');
        const buildAction = new actions.CodeBuildAction({
            actionName: 'CodeBuild',
            project: buildProject,
            input: sourceOutput,
            outputs: [buildArtifact],
          });

        pipeline.addStage({
            stageName: 'Build',
            actions: [buildAction],
        });

        // Test
        const templatePrefix =  'TriviaGame' + props.templateName;
        const testStackName = 'TriviaGame' + props.stackName + 'Test';
        const changeSetName = 'StagedChangeSet';

        pipeline.addStage({
            stageName: 'Test',
            actions: [
                new actions.CloudFormationCreateReplaceChangeSetAction({
                    actionName: 'PrepareChangesTest',
                    stackName: testStackName,
                    changeSetName,
                    runOrder: 1,
                    adminPermissions: true,
                    templatePath: buildArtifact.atPath(templatePrefix + 'Test.template.yaml'),
                    templateConfiguration: buildArtifact.atPath('StackConfig.json'),
                }),
                new actions.CloudFormationExecuteChangeSetAction({
                    actionName: 'ExecuteChangesTest',
                    stackName: testStackName,
                    changeSetName,
                    runOrder: 2
                })
            ],
        });

        // Prod
        const prodStackName = 'TriviaGame' + props.stackName + 'Prod';

        pipeline.addStage({
            stageName: 'Prod',
            actions: [
                new actions.CloudFormationCreateReplaceChangeSetAction({
                    actionName: 'PrepareChangesProd',
                    stackName: prodStackName,
                    changeSetName,
                    runOrder: 1,
                    adminPermissions: true,
                    templatePath: buildArtifact.atPath(templatePrefix + 'Prod.template.yaml'),
                    templateConfiguration: buildArtifact.atPath('StackConfig.json'),
                }),
                new actions.CloudFormationExecuteChangeSetAction({
                    actionName: 'ExecuteChangesProd',
                    stackName: prodStackName,
                    changeSetName,
                    runOrder: 2
                })
            ],
        });
    }
}