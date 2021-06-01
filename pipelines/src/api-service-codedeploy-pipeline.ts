#!/usr/bin/env node
import codebuild = require('@aws-cdk/aws-codebuild');
import codedeploy = require('@aws-cdk/aws-codedeploy');
import codepipeline = require('@aws-cdk/aws-codepipeline');
import notifications = require('@aws-cdk/aws-codestarnotifications');
import actions = require('@aws-cdk/aws-codepipeline-actions');
import ecr = require('@aws-cdk/aws-ecr');
import iam = require('@aws-cdk/aws-iam');
import cdk = require('@aws-cdk/core');

/**
 * Pipeline that builds a container image and deploys it to ECS using CodeDeploy blue-green deployments (no CloudFormation deployments).
 * [Sources: GitHub source, ECR base image] -> [CodeBuild build] -> [ECS (Blue/Green) Deploy Action to 'test' ECS service] -> [ECS (Blue/Green) Deploy Action to 'prod' ECS service]
 */
class TriviaGameBackendCodeDeployPipelineStack extends cdk.Stack {
    constructor(parent: cdk.App, name: string, props?: cdk.StackProps) {
        super(parent, name, props);

        const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
            pipelineName: 'reinvent-trivia-game-trivia-backend-with-codedeploy',
        });

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

        const baseImageRepo = ecr.Repository.fromRepositoryName(this, 'BaseRepo', 'reinvent-trivia-backend-base');
        const baseImageOutput = new codepipeline.Artifact('BaseImage');
        const dockerImageSourceAction = new actions.EcrSourceAction({
          actionName: 'BaseImage',
          repository: baseImageRepo,
          imageTag: 'release',
          output: baseImageOutput,
        });

        pipeline.addStage({
            stageName: 'Source',
            actions: [sourceAction, dockerImageSourceAction],
        });

        // Build
        const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
            buildSpec: codebuild.BuildSpec.fromSourceFilename('trivia-backend/infra/codedeploy-blue-green/buildspec.yml'),
            environment: {
              buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
              privileged: true
            }
        });

        buildProject.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                'cloudformation:DescribeStackResources'
            ],
            resources: ['*']
        }));

        buildProject.addToRolePolicy(new iam.PolicyStatement({
            actions: ["ecr:GetAuthorizationToken",
                "ecr:BatchCheckLayerAvailability",
                "ecr:GetDownloadUrlForLayer",
                "ecr:GetRepositoryPolicy",
                "ecr:DescribeRepositories",
                "ecr:ListImages",
                "ecr:DescribeImages",
                "ecr:BatchGetImage",
                "ecr:InitiateLayerUpload",
                "ecr:UploadLayerPart",
                "ecr:CompleteLayerUpload",
                "ecr:PutImage"
            ],
            resources: ["*"]
        }));

        const buildArtifact = new codepipeline.Artifact('BuildArtifact');
        const imageDetailsArtifact = new codepipeline.Artifact('ImageDetails');
        const buildAction = new actions.CodeBuildAction({
            actionName: 'CodeBuild',
            project: buildProject,
            input: sourceOutput,
            extraInputs: [baseImageOutput],
            outputs: [buildArtifact, imageDetailsArtifact],
          });

        pipeline.addStage({
            stageName: 'Build',
            actions: [buildAction],
        });

        // Deploy
        this.addDeployStage(pipeline, 'Test', buildArtifact, imageDetailsArtifact);
        this.addDeployStage(pipeline, 'Prod', buildArtifact, imageDetailsArtifact);
    }

    private addDeployStage(pipeline: codepipeline.Pipeline,
        stageName: string,
        buildOutput: codepipeline.Artifact,
        imageDetailsOutput: codepipeline.Artifact) {
        const deploymentGroup = codedeploy.EcsDeploymentGroup.fromEcsDeploymentGroupAttributes(
            pipeline, 'CodeDeployDeploymentGroup' + stageName, {
                application: codedeploy.EcsApplication.fromEcsApplicationName(
                    pipeline,
                    'CodeDeployApplication' + stageName,
                    'AppECS-default-trivia-backend-' + stageName.toLowerCase()
                ),
                deploymentGroupName: 'DgpECS-default-trivia-backend-' + stageName.toLowerCase(),
                deploymentConfig: codedeploy.EcsDeploymentConfig.fromEcsDeploymentConfigName(
                    pipeline,
                    'CodeDeployDeploymentConfig',
                    'trivia-backend-canary'
                )
            });

        pipeline.addStage({
            stageName,
            actions: [
                new actions.CodeDeployEcsDeployAction({
                    actionName: 'Deploy' + stageName,
                    deploymentGroup,
                    taskDefinitionTemplateFile:
                        new codepipeline.ArtifactPath(buildOutput, `task-definition-${stageName.toLowerCase()}.json`),
                    appSpecTemplateFile:
                        new codepipeline.ArtifactPath(buildOutput, `appspec-${stageName.toLowerCase()}.json`),
                    containerImageInputs: [{
                        input: imageDetailsOutput,
                        taskDefinitionPlaceholder: 'PLACEHOLDER'
                    }]
                })
            ]
        });
    }
}

const app = new cdk.App();
new TriviaGameBackendCodeDeployPipelineStack(app, 'TriviaGameBackendCodeDeployPipeline', {
    env: { account: process.env['CDK_DEFAULT_ACCOUNT'], region: 'us-east-1' },
    tags: {
        project: "reinvent-trivia"
    }
});
app.synth();