import subprocess, json, pathlib, time, uuid, tempfile, urllib.request, hashlib, socket, os, threading, http.server, mimetypes
root=pathlib.Path('/Users/Matt/Projects/day-trader')
out=root/'docs/evidence/rc-repair/runtime-containers';out.mkdir(parents=True,exist_ok=True)
runid='day-trader-rc-'+uuid.uuid4().hex[:8];net=runid+'-net';mongo=runid+'-mongo';backend=runid+'-backend';frontend=runid+'-frontend'
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
server=None
records=[];created=[];report={'scope':'Disposable Linux containers, internal network, synthetic owner; no external brokerage/SMTP/inference','commands':records}
def run(args, input=None, check=True):
 p=subprocess.run(args,input=input,text=True,capture_output=True,timeout=90)
 records.append({'args':args,'exit':p.returncode,'stdout':p.stdout[-10000:],'stderr':p.stderr[-10000:]})
 if check and p.returncode:raise RuntimeError(f'Command failed {args}: {p.stderr}')
 return p
try:
 run(['docker','network','create','--internal',net]);created.append(('network',net))
 run(['docker','run','-d','--rm','--name',mongo,'--network',net,'--tmpfs','/data/db','mongo:7','--replSet','mvp','--bind_ip_all']);created.append(('container',mongo))
 for attempt in range(60):
  p=run(['docker','exec',mongo,'mongosh','--quiet','--eval','db.adminCommand({ping:1})'],check=False)
  if p.returncode==0:break
  time.sleep(.5)
 run(['docker','exec',mongo,'mongosh','--quiet','--eval',f'rs.initiate({{_id:"mvp",members:[{{_id:0,host:"{mongo}:27017"}}]}})'])
 for attempt in range(60):
  if run(['docker','exec',mongo,'mongosh','--quiet','--eval','if (!db.hello().isWritablePrimary) quit(1)'],check=False).returncode==0:break
  time.sleep(.5)
 else:raise RuntimeError('Mongo primary unavailable')
 owner=uuid.uuid4().hex[:24]
 envpath=pathlib.Path(tempfile.mkstemp(prefix='rc-container-',suffix='.env')[1])
 envpath.write_text('\n'.join([f'MONGO_URI=mongodb://{mongo}:27017/mvp_test_container?replicaSet=mvp&directConnection=true',f'OWNER_USER_ID={owner}',f'JWT_SECRET={uuid.uuid4().hex}{uuid.uuid4().hex}','NODE_ENV=production','PORT=8080','ROBO_SCHEDULER_DISABLED=true','ROBOTRADER_WORKER_DISABLED=true','ROBO_EMAIL_PROVIDER=log','ALPACA_EXPECTED_PAPER_ACCOUNT_ID=acceptance-paper','ALPACA_BASE_URL=https://paper-api.alpaca.markets','BROKER_API_KEY=acceptance-dummy','BROKER_API_SECRET=acceptance-dummy-secret','FRONTEND_ORIGIN=http://127.0.0.1:8080'])+'\n')
 os.chmod(envpath,0o600)
 run(['docker','run','-d','--rm','--name',backend,'--network',net,'--env-file',str(envpath),'day-trader-rc-backend:node24']);created.append(('container',backend));envpath.unlink()
 for attempt in range(60):
  p=run(['docker','exec',backend,'node','-e',"fetch('http://127.0.0.1:8080/health').then(async r=>{console.log(await r.text());process.exitCode=r.ok?0:1}).catch(()=>process.exitCode=1)"],check=False)
  if p.returncode==0:break
  time.sleep(.5)
 else:raise RuntimeError('Production server startup unavailable')
 probe="""const assert=require('node:assert/strict');const m=require('mongoose');(async()=>{await m.connect(process.env.MONGO_URI);await require('./models/User').create({_id:process.env.OWNER_USER_ID,username:'container-owner',hash:await require('bcryptjs').hash('local-test-password',4),sessionVersion:0});const token=require('jsonwebtoken').sign({sub:process.env.OWNER_USER_ID,sessionVersion:0},process.env.JWT_SECRET,{algorithm:'HS256',expiresIn:'2m'});let data;for(let i=0;i<60;i++){const response=await fetch('http://127.0.0.1:8080/api/readiness',{headers:{authorization:'Bearer '+token}});data=await response.json();if(response.status===200)break;await new Promise(r=>setTimeout(r,500));}assert.equal(data.persistence.ready,true);assert.equal(data.persistence.indexesReady,true);assert.equal(data.persistence.writeReady,true);assert.equal(data.executionEnvironment,'alpaca-paper');assert.equal(data.accountBindingConfigured,true);assert.equal(data.releaseReady,false);assert.equal(process.env.NODE_ENV,'production');const unauth=await fetch('http://127.0.0.1:8080/api/readiness');assert.equal(unauth.status,401);console.log(JSON.stringify({node:process.version,execPath:process.execPath,openssl:process.versions.openssl,readiness:data,unauthenticatedStatus:unauth.status}));await m.disconnect();})().catch(e=>{console.error(e);process.exitCode=1});"""
 run(['docker','exec','-i',backend,'node'],input=probe)
 run(['docker','exec',backend,'npm','--version'])
 run(['docker','run','-d','--rm','--name',frontend,'--network',net,'day-trader-rc-frontend:node24']);created.append(('container',frontend))
 class ContainerHTTP(http.server.BaseHTTPRequestHandler):
  def do_GET(self):
   result=subprocess.run(['docker','exec',frontend,'wget','-qO-', 'http://127.0.0.1:8080'+self.path],capture_output=True,timeout=15)
   status=200 if result.returncode==0 else 502
   self.send_response(status);self.send_header('Content-Type',mimetypes.guess_type(self.path.split('?')[0])[0] or 'text/html');self.end_headers();self.wfile.write(result.stdout)
  def log_message(self,*args):pass
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),ContainerHTTP);port=server.server_address[1]
 threading.Thread(target=server.serve_forever,daemon=True).start()
 report['navigationTransport']='Loopback-only HTTP bridge forwards each request via docker exec wget to actual isolated nginx HTTP; no external container network'
 routes=['/','/login','/portfolio','/activity','/research','/analytics','/robotrader','/trading-system','/stock/AAPL'];routing=[]
 for route in routes:
  for attempt in range(60):
   try:
    with opener.open(f'http://127.0.0.1:{port}{route}',timeout=2) as response:body=response.read();status=response.status
    break
   except Exception:
    if attempt==59:raise
    time.sleep(.25)
  assert status==200 and b'<div id="root"></div>' in body
  routing.append({'route':route,'status':status,'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()})
 report['staticNavigation']=routing
 assert len({r['sha256'] for r in routing})==1
 run(['docker','exec',frontend,'nginx','-t']);run(['docker','exec',frontend,'nginx','-v'])
 browser_script="""const {chromium}=require('./frontend/node_modules/@playwright/test');(async()=>{const b=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});const page=await b.newPage();await page.route('**/*',r=>{const u=new URL(r.request().url());return u.origin===process.env.RC_CONTAINER_URL?r.continue():r.abort();});const response=await page.goto(process.env.RC_CONTAINER_URL+'/login');if(response.status()!==200)throw Error('Container navigation failed');await page.getByRole('button',{name:/sign in|log in/i}).waitFor();console.log(JSON.stringify({url:page.url(),status:response.status(),title:await page.title(),loginRendered:true}));await b.close()})().catch(e=>{console.error(e);process.exitCode=1});"""
 env=os.environ.copy();env['RC_CONTAINER_URL']=f'http://127.0.0.1:{port}';env['PLAYWRIGHT_CHROMIUM_EXECUTABLE']='/Users/Matt/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
 p=subprocess.run(['/private/tmp/day-trader-rc-node24/node-v24.21.0-darwin-arm64/bin/node','-e',browser_script],cwd=root,env=env,text=True,capture_output=True,timeout=60)
 report['browserNavigation']={'exit':p.returncode,'stdout':p.stdout,'stderr':p.stderr};assert p.returncode==0
 for image in ['day-trader-rc-backend:node24','day-trader-rc-frontend:node24']:
  data=json.loads(run(['docker','image','inspect',image]).stdout)[0]
  assert data['Os']=='linux';report.setdefault('images',[]).append({'tag':image,'id':data['Id'],'os':data['Os'],'architecture':data['Architecture'],'created':data['Created']})
 run(['docker','logs',backend]);report['ok']=True
except Exception as e:report['ok']=False;report['error']=str(e)
finally:
 if server:server.shutdown();server.server_close()
 for kind,name in reversed(created):
  run(['docker','rm','-f','-v',name] if kind=='container' else ['docker','network','rm',name],check=False)
 report['cleanupComplete']=all(item['exit']==0 for item in records[-len(created):])
 (out/'report.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps({k:v for k,v in report.items() if k!='commands'},indent=2))
 if not report.get('ok'):raise SystemExit(1)
