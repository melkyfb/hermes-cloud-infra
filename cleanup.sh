#!/usr/bin/env bash
# cleanup.sh — tear down every AWS resource this project created.
# Uses plain AWS CLI (CloudFormation delete-stack) so it works with a normal
# IAM admin user — no node/cdk and no cdk-bootstrap role assumption needed.
# Idempotent: safe to re-run. Deletes are allowed even under an account
# resource-creation hold (the hold blocks CREATE, not DELETE).
#
# Usage:
#   AWS_PROFILE=<admin> bash cleanup.sh          # standard cleanup
#   AWS_PROFILE=<admin> FULL=1 bash cleanup.sh   # also delete CDK bootstrap + secrets
#
# Set FULL=1 only if you are NOT going to redeploy later (it removes the shared
# CDKToolkit bootstrap stack and the Secrets Manager secrets).

set -uo pipefail

REGION="${AWS_REGION:-eu-central-1}"
EFS_NAMES=("freellmapi-server-data" "hermes-agent-home")
ECR_REPOS=("freellmapi" "hermes-agent")
# Delete order: dependents first (ApiGw/Ecs) → Ec2 → Efs/Ecr → Vpc last.
APP_STACKS=("HermesApiGatewayStack" "HermesEcsStack" "HermesEc2Stack" \
            "HermesEfsStack" "HermesEcrStack" "HermesVpcStack")
OIDC_STACK="github-oidc-trust-stack"
SECRETS=("hermes/freellmapi-keys" "hermes/telegram-bot-token")

acct="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo '?')"
echo "Account: $acct   Region: $REGION"
echo "Will DELETE:"
echo "  CFN stacks : ${APP_STACKS[*]} $OIDC_STACK"
echo "  EFS        : ${EFS_NAMES[*]} (RETAINed by the stacks)"
echo "  ECR repos  : ${ECR_REPOS[*]} (RETAINed by the stacks)"
[ "${FULL:-0}" = "1" ] && echo "  FULL=1     : CDKToolkit bootstrap + secrets (${SECRETS[*]})"
echo
read -r -p "Type DELETE to proceed: " confirm
[ "$confirm" = "DELETE" ] || { echo "aborted."; exit 1; }

del_stack () { # idempotent CFN stack delete + wait
  local s="$1"
  if aws cloudformation describe-stacks --stack-name "$s" --region "$REGION" >/dev/null 2>&1; then
    echo "== deleting stack: $s"
    aws cloudformation delete-stack --stack-name "$s" --region "$REGION"
    if aws cloudformation wait stack-delete-complete --stack-name "$s" --region "$REGION" 2>/dev/null; then
      echo "   ok: $s deleted"
    else
      echo "   WARN: $s did not reach DELETE_COMPLETE — inspect in the console"
    fi
  else
    echo "== stack not found, skip: $s"
  fi
}

# 0. Pre-clear any stuck VPC Link — it can block HermesApiGatewayStack deletion.
for L in $(aws apigatewayv2 get-vpc-links --region "$REGION" \
    --query "Items[?Name=='hermes-vpc-link'].VpcLinkId" --output text 2>/dev/null); do
  [ -n "$L" ] && { echo "== deleting vpc-link: $L"; \
    aws apigatewayv2 delete-vpc-link --vpc-link-id "$L" --region "$REGION" || true; }
done

# 1. Delete the CloudFormation stacks in dependency order.
for s in "${APP_STACKS[@]}"; do del_stack "$s"; done

# 2. Delete the RETAINed EFS filesystems (mount targets first). The stack delete
#    above usually removes the mount targets already; this is defensive.
for name in "${EFS_NAMES[@]}"; do
  for FS in $(aws efs describe-file-systems --region "$REGION" \
      --query "FileSystems[?Name=='$name'].FileSystemId" --output text 2>/dev/null); do
    [ -z "$FS" ] && continue
    echo "== EFS $name ($FS): clearing mount targets"
    for MT in $(aws efs describe-mount-targets --file-system-id "$FS" --region "$REGION" \
        --query 'MountTargets[].MountTargetId' --output text 2>/dev/null); do
      aws efs delete-mount-target --mount-target-id "$MT" --region "$REGION" || true
    done
    for _ in $(seq 1 24); do
      n=$(aws efs describe-mount-targets --file-system-id "$FS" --region "$REGION" \
          --query 'length(MountTargets)' --output text 2>/dev/null || echo 0)
      [ "$n" = "0" ] && break
      sleep 5
    done
    echo "== deleting EFS: $FS"
    aws efs delete-file-system --file-system-id "$FS" --region "$REGION" \
      || echo "   WARN: could not delete $FS (mount targets may still be terminating; re-run later)"
  done
done

# 3. Delete the RETAINed ECR repositories (--force removes images too).
for r in "${ECR_REPOS[@]}"; do
  if aws ecr describe-repositories --repository-names "$r" --region "$REGION" >/dev/null 2>&1; then
    echo "== deleting ECR repo: $r"
    aws ecr delete-repository --repository-name "$r" --force --region "$REGION" || true
  else
    echo "== ECR repo not found, skip: $r"
  fi
done

# 4. OIDC trust stack (provider + GitHubActionsDeployRole).
del_stack "$OIDC_STACK"

# 5. OPTIONAL deep clean (FULL=1): secrets + CDK bootstrap. Skip if you'll redeploy.
if [ "${FULL:-0}" = "1" ]; then
  for sec in "${SECRETS[@]}"; do
    aws secretsmanager delete-secret --secret-id "$sec" \
      --force-delete-without-recovery --region "$REGION" >/dev/null 2>&1 \
      && echo "== deleted secret: $sec" || echo "== secret not found, skip: $sec"
  done
  BKT=$(aws cloudformation describe-stack-resources --stack-name CDKToolkit --region "$REGION" \
        --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" \
        --output text 2>/dev/null)
  if [ -n "${BKT:-}" ] && [ "$BKT" != "None" ]; then
    echo "== emptying CDK bootstrap bucket: $BKT"
    aws s3 rm "s3://$BKT" --recursive || true
  fi
  del_stack "CDKToolkit"
fi

# 6. Verify nothing is left.
echo
echo "== remaining (should all be empty):"
echo -n "stacks: "; aws cloudformation list-stacks --region "$REGION" \
  --query "StackSummaries[?starts_with(StackName,'Hermes') && StackStatus!='DELETE_COMPLETE'].StackName" \
  --output text
echo -n "efs:    "; aws efs describe-file-systems --region "$REGION" \
  --query "FileSystems[?Name=='freellmapi-server-data'||Name=='hermes-agent-home'].FileSystemId" --output text
echo -n "ecr:    "; aws ecr describe-repositories --region "$REGION" \
  --query "repositories[?repositoryName=='freellmapi'||repositoryName=='hermes-agent'].repositoryName" \
  --output text 2>/dev/null
echo
echo "done."
