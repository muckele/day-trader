"""Test reconstruction content checks; never asserts production-image equivalence."""
import pathlib,subprocess,json,hashlib,os,tempfile,shutil
r=pathlib.Path(os.environ['PILOT_STATE']);expected=json.loads((pathlib.Path(__file__).parent/'tests/qualified-content.json').read_text())
def command(*a):return subprocess.check_output(a,text=True).strip()
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
result={};failures=[]
for role in ['backend','frontend','tools']:
 image=json.loads(command('docker','image','inspect','pilot-'+role+':test'))[0]
 result[role]={'id':image['Id'],'architecture':image['Architecture'],'sizeBytes':image['Size'],'rootfs':image['RootFS']['Layers']}
 if role=='tools':continue
 cid=command('docker','create','--network','none','pilot-'+role+':test')
 dest=r/('compare-'+role);dest.mkdir()
 try:
  if role=='backend':
   command('docker','cp',cid+':/app',str(dest))
   mismatch=[p for p,h in expected['backendAuthored'].items() if not (dest/p).is_file() or digest(dest/p)!=h]
   command('docker','cp',cid+':/usr/local/bin/node',str(dest/'node'))
   result[role]['authoredFilesCompared']=len(expected['backendAuthored'])
   result[role]['authoredMismatches']=len(mismatch)
   result[role]['nodeHashMatches']=digest(dest/'node')==expected['nodeSha256']
   command('docker','cp',cid+':/usr/share/day-trader/runtime-provenance.json',str(dest/'runtime.json'))
   runtime=json.loads((dest/'runtime.json').read_text())
   result[role]['packageVersionsMatch']=runtime['packages']==expected['packages']
   if mismatch or not result[role]['nodeHashMatches'] or not result[role]['packageVersionsMatch']:failures.append('BACKEND_CONTENT_DIFFERS')
  else:
   command('docker','cp',cid+':/usr/share/nginx/html',str(dest))
   mismatch=[p for p,h in expected['frontendStatic'].items() if not (dest/'html'/p).is_file() or digest(dest/'html'/p)!=h]
   result[role]['staticFilesCompared']=len(expected['frontendStatic']);result[role]['staticMismatches']=len(mismatch)
   if mismatch:failures.append('FRONTEND_CONTENT_DIFFERS')
 finally:command('docker','rm','-v',cid);shutil.rmtree(dest)
print(json.dumps({'testImageProvenance':result,'byteIdenticalProductionImages':False,'inheritsExactImageSecurityEvidence':False}))

if failures:raise SystemExit(','.join(failures))
