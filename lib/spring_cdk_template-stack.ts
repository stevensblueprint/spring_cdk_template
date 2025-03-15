import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsp from "aws-cdk-lib/aws-ecs-patterns";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as dotenv from "dotenv";
import { Construct } from "constructs";
import path = require("path");

interface SpringCdkTemplateStackProps extends cdk.StackProps {
  stackName: string;
  vpcName: string;
  pgSecurityGroup: string;
  dbName: string;
  ecrRepository: string;
  keyName: string;
  region: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch?: string;
  githubAccessTokenSecret: string;
  pipelineContainerName: string;
  pipelineName?: string;
}
export class SpringCdkTemplateStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: SpringCdkTemplateStackProps
  ) {
    super(scope, id, props);

    const repository = ecr.Repository.fromRepositoryName(
      this,
      `Repository-${props.stackName}`,
      props.ecrRepository
    );

    // ----- S3 Bucket for Database Scripts -----
    const scriptsBucket = new s3.Bucket(this, "DatabaseScriptsBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new s3deploy.BucketDeployment(this, "DeployScripts", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "../scripts"))],
      destinationBucket: scriptsBucket,
    });

    // ----- VPC -----
    const vpc = new ec2.Vpc(this, props.vpcName, {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // ----- PostgreSQL Security Group -----
    const pgSecurityGroup = new ec2.SecurityGroup(this, props.pgSecurityGroup, {
      vpc,
      description: "Security group for PostgreSQL server",
      allowAllOutbound: true,
    });

    pgSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      "Allow SSH access from anywhere"
    );

    pgSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(5432),
      "Allow inbound traffic from VPC"
    );

    // ----- PostgreSQL Credentials (Secrets Manager) -----
    const pgDBcreds = new secretsmanager.Secret(
      this,
      `pgCres${props.stackName}`,
      {
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: "postgres" }),
          generateStringKey: "password",
          excludeCharacters: "\"@/\\'*{}[]()&^%$#!+",
        },
      }
    );

    // ----- PostgreSQL Instance -----
    const pgInstance = new ec2.Instance(this, `DB-${props.stackName}`, {
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: pgSecurityGroup,
      requireImdsv2: true,
      associatePublicIpAddress: true,
      keyName: props.keyName,
    });

    pgInstance.userData.addCommands(
      // System updates and installations
      "sudo yum update -y",
      "sudo yum install postgresql15.x86_64 postgresql15-server aws-cli jq -y",

      // Initialize PostgreSQL database
      "sudo postgresql-setup --initdb",

      // Configure PostgreSQL to listen on all addresses
      "sudo sed -i \"s/#listen_addresses = 'localhost'/listen_addresses = '*'/\" /var/lib/pgsql/data/postgresql.conf",

      // Update authentication method from ident to md5
      'sudo sed -i "s/ident/md5/g" /var/lib/pgsql/data/pg_hba.conf',

      // Add VPC CIDR access rules to pg_hba.conf
      `echo "# Allow connections from VPC CIDR" | sudo tee -a /var/lib/pgsql/data/pg_hba.conf`,
      `echo "host all all ${vpc.vpcCidrBlock} md5" | sudo tee -a /var/lib/pgsql/data/pg_hba.conf`,

      // Start and enable PostgreSQL service
      "sudo systemctl start postgresql",
      "sudo systemctl enable postgresql",
      "sudo systemctl status postgresql",

      // Copy database scripts from S3
      `aws s3 cp s3://${scriptsBucket.bucketName}/ /tmp/db-scripts --recursive`,
      "chmod +x /tmp/db-scripts/*.sql",

      // Set PostgreSQL password from Secrets Manager
      `export PGPASSWORD=$(aws secretsmanager get-secret-value --secret-id ${pgDBcreds.secretArn} --region ${props.region} --query SecretString --output text | jq -r .password)`,
      "sudo -u postgres psql -f /tmp/db-scripts/init.sql",

      // Create postgres user password
      `sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD '$PGPASSWORD';"`,
      "systemctl restart postgresql"
    );

    // ----- VPOC Endpoints -----
    const s3Endpoint = new ec2.GatewayVpcEndpoint(this, "S3Endpoint", {
      vpc,
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    new ec2.InterfaceVpcEndpoint(this, "EcrDockerEndpoint", {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });

    new ec2.InterfaceVpcEndpoint(this, "EcrEndpoint", {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });

    new ec2.InterfaceVpcEndpoint(this, "CloudWatchLogsEndpoint", {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });

    new ec2.InterfaceVpcEndpoint(this, "SecretsManagerEndpoint", {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });

    // ----- ECS Cluster & Service -----
    const cluster = new ecs.Cluster(this, `Cluster-${props.stackName}`, {
      vpc,
      enableFargateCapacityProviders: true,
    });

    const image = ecs.ContainerImage.fromEcrRepository(repository, "latest");
    const envFile = loadEnvFile();
    console.log("Environment Variables: ", envFile);
    const sbService = new ecsp.ApplicationLoadBalancedFargateService(
      this,
      `Service-${props.stackName}`,
      {
        cluster,
        memoryLimitMiB: 512,
        cpu: 256,
        desiredCount: 1,
        taskImageOptions: {
          image: image,
          containerPort: 8080,
          containerName: props.pipelineContainerName,
          environment: envFile,
          secrets: {
            SPRING_DATASOURCE_PASSWORD: ecs.Secret.fromSecretsManager(
              pgDBcreds,
              "password"
            ),
          },
        },
        capacityProviderStrategies: [
          {
            capacityProvider: "FARGATE_SPOT",
            weight: 1,
          },
        ],
        deploymentController: {
          type: ecs.DeploymentControllerType.ECS,
        },
        circuitBreaker: { rollback: true },
        healthCheckGracePeriod: cdk.Duration.seconds(200),
        publicLoadBalancer: true,
        assignPublicIp: true,
        taskSubnets: {
          subnetType: ec2.SubnetType.PUBLIC,
        },
      }
    );

    sbService.targetGroup.configureHealthCheck({
      path: "/actuator/health",
      port: "8080",
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
      timeout: cdk.Duration.seconds(10),
      interval: cdk.Duration.seconds(30),
    });

    repository.grantPull(sbService.taskDefinition.executionRole!);

    sbService.service.connections.allowTo(
      pgInstance,
      ec2.Port.tcp(5432),
      "Allow traffic to PostgreSQL"
    );

    pgInstance.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("SecretsManagerReadWrite")
    );
    scriptsBucket.grantRead(pgInstance.role);

    sbService.taskDefinition.executionRole!.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonEC2ContainerRegistryFullAccess"
      )
    );

    sbService.taskDefinition.executionRole!.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("SecretsManagerReadWrite")
    );

    new cdk.CfnOutput(this, "InstancePublicIP", {
      value: pgInstance.instancePublicIp,
    });

    new cdk.CfnOutput(this, "LoadBalancerDNS", {
      value: sbService.loadBalancer.loadBalancerDnsName,
    });

    new cdk.CfnOutput(this, "EcrRepositoryUri", {
      value: repository.repositoryUri,
    });

    // ----- CodePipeline for Continuous Deployment -----
    const sourceOutput = new codepipeline.Artifact();
    const pipelineBuildOutput = new codepipeline.Artifact();

    // Github source action
    const sourceAction = new codepipeline_actions.GitHubSourceAction({
      actionName: "GitHub_Source",
      owner: props.githubOwner,
      repo: props.githubRepo,
      branch: props.githubBranch ?? "main",
      oauthToken: cdk.SecretValue.secretsManager(props.githubAccessTokenSecret),
      output: sourceOutput,
    });

    // CodeBuild project to build the Docker image, push to ECR, and output an image definitions file
    const buildProject = new codebuild.PipelineProject(
      this,
      `EcsBuildProject-${this.stackName}`,
      {
        environment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
          privileged: true,
        },
        buildSpec: codebuild.BuildSpec.fromObject({
          version: "0.2",
          phases: {
            pre_build: {
              commands: [
                "echo Logging in to Amazon ECR...",
                "aws --version",
                `REPOSITORY_URI=${repository.repositoryUri}`,
                "aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $REPOSITORY_URI",
                "COMMIT_HASH=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-7)",
                "IMAGE_TAG=${COMMIT_HASH:=latest}",
              ],
            },
            build: {
              commands: [
                "echo Building the Docker image...",
                "docker build -t $REPOSITORY_URI:latest .",
                "docker tag $REPOSITORY_URI:latest $REPOSITORY_URI:$IMAGE_TAG",
              ],
            },
            post_build: {
              commands: [
                "echo Pushing the Docker images...",
                "docker push $REPOSITORY_URI:latest",
                "docker push $REPOSITORY_URI:$IMAGE_TAG",
                "echo Writing image definitions file...",
                `printf '[{"name":"${props.pipelineContainerName}","imageUri":"%s"}]' $REPOSITORY_URI:latest > imagedefinitions.json`,
                "cat imagedefinitions.json",
              ],
            },
          },
          artifacts: {
            files: "imagedefinitions.json",
          },
        }),
      }
    );

    buildProject.role?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonEC2ContainerRegistryFullAccess"
      )
    );

    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: "Build_and_Push",
      project: buildProject,
      input: sourceOutput,
      outputs: [pipelineBuildOutput],
    });

    // ECS Deploy Action to update the ECS service with the new image.
    const deployAction = new codepipeline_actions.EcsDeployAction({
      actionName: "Deploy_to_ECS",
      service: sbService.service,
      input: pipelineBuildOutput,
    });

    new codepipeline.Pipeline(this, `Pipeline-${props.stackName}`, {
      pipelineName: props.pipelineName ?? `Pipeline-${props.stackName}`,
      stages: [
        {
          stageName: "Source",
          actions: [sourceAction],
        },
        {
          stageName: "Build",
          actions: [buildAction],
        },
        {
          stageName: "Deploy",
          actions: [deployAction],
        },
      ],
    });
  }
}

function loadEnvFile() {
  const envFilePath = path.join(__dirname, "../config/.env");
  const result = dotenv.config({ path: envFilePath });
  if (result.error) {
    throw result.error;
  }
  return result.parsed || {};
}
