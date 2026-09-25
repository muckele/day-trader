#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && ${GITHUB_REF:-} == refs/heads/codex/hosted-acceptance-tooling ]] || exit 2
[[ ${GITHUB_RUN_ATTEMPT:-} == 1 ]] || { echo 'Reruns are outside the pilot; use the remaining reviewed push if authorized.'; exit 2; }
export PILOT_DIAGNOSTIC_ONLY=0
export PILOT_STARTUP_PROBE_DIAGNOSTIC=once-v1
unset PILOT_CRASHPAD_EXPERIMENT
export PILOT_QUALIFICATION=full-v1
export PILOT_PROFILE=production-rehearsal
export PILOT_APPLICATION_SOURCE=852fb22d9facf4bfe0bca7f419e22ee4bfbba17f
python3 tooling/hosted-acceptance/tools/hosted_qualification.py
git diff --exit-code "$PILOT_APPLICATION_SOURCE" -- backend frontend .github/workflows/mvp.yml
export PILOT_STATE="$RUNNER_TEMP/acceptance-pilot"
mkdir -m 700 "$PILOT_STATE"
exec > >(tee "$PILOT_STATE/public.log") 2>&1
printf 'source=852fb22d9facf4bfe0bca7f419e22ee4bfbba17f tooling=%s run=%s attempt=%s\n' "$GITHUB_SHA" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT"
(while true; do df -B1 --output=avail "$RUNNER_TEMP" | tail -1 >> "$PILOT_STATE/disk-samples"; sleep 10; done) &
monitor=$!
finish() {
  code=$?
  kill "$monitor" 2>/dev/null || true
  sudo env GITHUB_ACTIONS=true RUNNER_ENVIRONMENT=github-hosted PILOT_STATE="$PILOT_STATE" python3 tooling/hosted-acceptance/cleanup.py
  python3 - <<'PY'
import os,pathlib,json
p=pathlib.Path(os.environ['PILOT_STATE'])/'disk-samples'
a=[int(x) for x in p.read_text().split()]
print(json.dumps({'diskInitialAvailableBytes':a[0],'diskMinimumObservedAvailableBytes':min(a),'diskMaximumObservedConsumptionBytes':max(a)-min(a),'sampleSeconds':10}))
PY
  if [[ $code == 0 ]]; then echo HOSTED_TOOLING_PILOT_VERIFIED; else echo HOSTED_TOOLING_PILOT_BLOCKED; fi
  python3 - <<'PY2' >> "$GITHUB_STEP_SUMMARY"
import pathlib,os
for line in (pathlib.Path(os.environ['PILOT_STATE'])/'public.log').read_text().splitlines():
 if line.startswith(('{','source=','HOSTED_')):print(line)
PY2
}
trap finish EXIT
python3 - <<'PY'
import json,os,shutil,subprocess
mem=int(next(x.split()[1] for x in open('/proc/meminfo') if x.startswith('MemTotal:')))*1024
paths=[os.environ['RUNNER_TEMP'],subprocess.check_output(['docker','info','--format','{{.DockerRootDir}}'],text=True).strip()]
free=min(shutil.disk_usage(p).free for p in paths)
# Conservative incremental peak, GiB; build stages run sequentially, no exported archives.
estimate={'tool_image_and_build_layers':4,'application_images_and_build_layers':3,'browser_download_and_extract':1,'disposable_mongo':1,'test_output':0.5,'reserve':2.5}
need=int(sum(estimate.values())*1024**3)
print(json.dumps({'cpus':os.cpu_count(),'memoryBytes':mem,'freeBytes':free,'estimateGiB':estimate,'requiredBytes':need,'shortageBytes':max(0,need-free)}))
if free<need or mem<7*1024**3 or os.cpu_count()<2:raise SystemExit('CAPACITY_BLOCKED')
PY
docker version --format 'client={{.Client.Version}} server={{.Server.Version}}'
docker info --format 'os={{.OSType}} arch={{.Architecture}} storage={{.Driver}} security={{json .SecurityOptions}}'
docker buildx version
node --test tooling/hosted-acceptance/tests/*.test.cjs
python3 tooling/hosted-acceptance/tests/startup_publication_test.py
python3 tooling/hosted-acceptance/tests/crashpad_experiment_test.py
python3 tooling/hosted-acceptance/tests/sandbox_verification_test.py
python3 tooling/hosted-acceptance/tests/qualification_test.py
python3 tooling/hosted-acceptance/tests/entry_accounting_test.py
python3 tooling/hosted-acceptance/tests/startup_probe_test.py
python3 tooling/hosted-acceptance/tests/startup_expression_test.py
mkdir "$PILOT_STATE/application"
git archive 852fb22d9facf4bfe0bca7f419e22ee4bfbba17f backend frontend | tar -x -C "$PILOT_STATE/application"
# No persistent cache imports/exports; logs here contain only public build inputs.
docker build --platform linux/amd64 --progress plain -t pilot-backend:test "$PILOT_STATE/application/backend"
docker build --platform linux/amd64 --progress plain --build-arg REACT_APP_API_URL=https://day-trader-backend.fly.dev -t pilot-frontend:test "$PILOT_STATE/application/frontend"
docker build --platform linux/amd64 --progress plain -f tooling/hosted-acceptance/Dockerfile -t pilot-tools:test "$PILOT_STATE/application"
docker pull mongo:7.0.16
python3 tooling/hosted-acceptance/provenance.py
sudo env GITHUB_ACTIONS=true RUNNER_ENVIRONMENT=github-hosted PILOT_STATE="$PILOT_STATE" GITHUB_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT" GITHUB_REF="$GITHUB_REF" PILOT_REPOSITORY_VISIBILITY="$PILOT_REPOSITORY_VISIBILITY" PILOT_APPLICATION_SOURCE="$PILOT_APPLICATION_SOURCE" PILOT_PROFILE="$PILOT_PROFILE" PILOT_QUALIFICATION="$PILOT_QUALIFICATION" PILOT_DIAGNOSTIC_ONLY="$PILOT_DIAGNOSTIC_ONLY" PILOT_STARTUP_PROBE_DIAGNOSTIC="$PILOT_STARTUP_PROBE_DIAGNOSTIC" python3 tooling/hosted-acceptance/run.py
