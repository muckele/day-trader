"""Explicit hosted synthetic mode and private-value checks; no runtime provisioning."""
import os,json,pathlib
from startup_publication import variants
SOURCE='852fb22d9facf4bfe0bca7f419e22ee4bfbba17f'
GUARDS={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','GITHUB_REF':'refs/heads/codex/hosted-acceptance-tooling','GITHUB_RUN_ATTEMPT':'1','PILOT_REPOSITORY_VISIBILITY':'public','PILOT_APPLICATION_SOURCE':SOURCE,'PILOT_PROFILE':'production-rehearsal','PILOT_QUALIFICATION':'full-v1','PILOT_DIAGNOSTIC_ONLY':'0'}
def require(env=None):
 env=os.environ if env is None else env
 if any(env.get(k)!=v for k,v in GUARDS.items()) or env.get('PILOT_CRASHPAD_EXPERIMENT'):raise RuntimeError('HOSTED_SYNTHETIC_QUALIFICATION_ONLY')
def claim(root,env=None):
 require(env);(root/'qualification-started').touch(mode=0o600,exist_ok=False)
def private_values(private):
 values=[]
 for name,key in [('synthetic.json','password'),('config/run.json','capability')]:
  p=private/name
  if p.exists():values.append(json.loads(p.read_text())[key])
 if (private/'backend.env').exists():values.extend(x.split('=',1)[1] for x in (private/'backend.env').read_text().splitlines() if x.startswith('JWT_SECRET='))
 for name in ['tls','upstream','negative/wrong','negative/expired','negative/untrusted']:
  p=private/name/'key.pem'
  if p.exists():
   text=p.read_text();body=[x for x in text.splitlines() if not x.startswith('-----')]
   values.extend([text.strip(),''.join(body),*[x for x in body if len(x)>16]])
 return values

def scan(roots,secrets):
 known=[v.encode() for v in variants(secrets)];files=0
 for root in roots:
  paths=[root] if root.is_file() else root.rglob('*')
  for p in paths:
   if p.is_symlink():raise RuntimeError('LEAK_SCAN_SYMLINK_REJECTED')
   if p.is_file():
    files+=1;data=p.read_bytes()
    if any(v in data for v in known):raise RuntimeError('SHAREABLE_EVIDENCE_LEAKAGE')
 return {'files':files,'forbiddenMatches':0,'encodedRepresentations':len(known),'crashContentsRead':False}
def require_route(row):
 if row.get('unexpected')!=0 or row.get('pass') is not True:raise RuntimeError('UNEXPECTED_FRONTEND_ROUTE')
if __name__=='__main__':require()
