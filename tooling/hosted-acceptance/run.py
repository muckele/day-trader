"""Ephemeral hosted synthetic driver. Never emits private input or raw container logs."""
import os,sys,pathlib,json,subprocess,time,pty,termios,select,signal,hashlib
ROOT=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'tools'))
import provision as p
R=pathlib.Path(os.environ['PILOT_STATE']);P=R/'private';E=R/'evidence'
def run(*a,**kw):
 q=subprocess.run(a,capture_output=True,text=True,timeout=180,**kw)
 if q.returncode:
  for line in q.stdout.splitlines():
   if line.startswith('PROVISION_') and line.replace('_','').isalpha():report('provision-progress',stage=line)
  raise RuntimeError('COMMAND_FAILED_'+pathlib.Path(a[0]).name.replace('.','_'))
 return q.stdout.strip()
def report(name,**fields):print(json.dumps({'check':name,**fields}),flush=True)
def control(command,ok=True,**fields):
 m=json.loads((P/'intake.json').read_text())
 q={'run':m['run'],'capability':m['capability'],'command':command,**fields}
 out=subprocess.run(['docker','exec','--user','501:20','-i',m['container'],'node','/tools/control.cjs'],input=json.dumps(q),text=True,capture_output=True,timeout=150)
 r=json.loads(out.stdout or '{}')
 if r.get('ok')!=ok:raise RuntimeError('CONTROL_'+command.replace('-','_').upper())
 return r

def ready():
 for _ in range(60):
  try:
   if control('status')['stage']=='AWAIT_CREDENTIAL':return
  except Exception:pass
  time.sleep(1)
 raise RuntimeError('BROWSER_NOT_READY')
def restart_browser():
 run('docker','restart','dapt-hosted-browser');ready()
def operator(cancel=False):
 master,slave=pty.openpty();old=termios.tcgetattr(slave)
 child=subprocess.Popen([sys.executable,str(ROOT/'tools/credential-intake.py'),str(P/'intake.json')],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
 output=b'';sent=False;echo_off=False;password=json.loads((P/'synthetic.json').read_text())['password'].encode()
 deadline=time.monotonic()+70
 while child.poll() is None and time.monotonic()<deadline:
  if select.select([master],[],[],0.1)[0]:output+=os.read(master,4096)
  if b'no echo' in output and not sent:
   echo_off=not bool(termios.tcgetattr(slave)[3]&termios.ECHO)
   if cancel:child.send_signal(signal.SIGINT)
   else:os.write(master,password+b'\n')
   sent=True
 if child.poll() is None:child.kill();raise RuntimeError('PRIVATE_INPUT_TIMEOUT')
 restored=termios.tcgetattr(slave)[3]==old[3]
 os.close(master);os.close(slave)
 assert sent and echo_off and restored and password not in output
 assert child.returncode==(1 if cancel else 0)
 report('private-pty-cancel' if cancel else 'private-pty-login',passCheck=True,echoDisabled=True,echoRestored=True,noSecretEcho=True)
def startup_probe():
 return run('docker','exec','dapt-hosted-mongo','mongosh','--quiet','--eval',"const x=db.getSiblingDB('acceptance').operationalreadiness.findOne({_id:'execution-write-probe'});print(x?.checkedAt?.toISOString()||'pending')")
def wait_startup(previous='pending'):
 for _ in range(60):
  stamp=startup_probe()
  if stamp!='pending' and stamp!=previous:
   time.sleep(1)
   return
  time.sleep(1)
 raise RuntimeError('STARTUP_PROBE_NOT_READY')
def snapshot():
 script="const d=db.getSiblingDB('acceptance'); print(EJSON.stringify(d.getCollectionNames().sort().filter(n=>!n.startsWith('system.')).map(n=>[n,d.getCollection(n).find().sort({_id:1}).toArray()])))"
 data=run('docker','exec','dapt-hosted-mongo','mongosh','--quiet','--eval',script)
 return hashlib.sha256(data.encode()).hexdigest()
def tcp_denied(container,ip,port):
 code="const s=require('net').connect({host:process.argv[1],port:Number(process.argv[2])});s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));s.setTimeout(1500,()=>process.exit(0))"
 run('docker','exec','--user','501:20',container,'node','-e',code,ip,str(port))
def main():
 run(sys.executable,str(ROOT/'tools/provision.py'))
 ready()
 if os.environ.get('PILOT_DIAGNOSTIC_ONLY')=='1':
  report('diagnostic-startup-reached-ready',passCheck=True,qualificationExecuted=False)
  return
 wait_startup()
 report('browser-start',passCheck=True)
 # Test TLS before application observation, in a distinct isolated namespace.
 report('transport',result=run('docker','run','--rm','--network','none','--user','0','-v',str(P)+':/private:ro','-v',str(ROOT)+':/suite:ro','pilot-tools:test','node','/suite/tests/transport.integration.cjs'))
 run('docker','exec','dapt-hosted-standin','node','-e',"const s=require('net').connect(80,'127.0.0.1',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))")
 for name in ['browser','gateway']:
  # Private stand-in reachable only on permitted gateway 443; port 80 and IPv6 denied.
  tcp_denied('dapt-hosted-'+name,'172.29.93.10',80)
  tcp_denied('dapt-hosted-'+name,'::1',80)
 tcp_denied('dapt-hosted-browser','172.29.93.10',443)
 # Bind a known live IPv6 loopback target inside the gateway namespace.
 run('docker','exec','--user','501:20','-d','dapt-hosted-gateway','node','-e',"const fs=require('fs');require('net').createServer(s=>s.end()).listen(8089,'::1',()=>fs.writeFileSync('/state/ipv6-listening','ready'))")
 for _ in range(20):
  if (P/'gateway-state/ipv6-listening').exists():break
  time.sleep(.2)
 else:raise RuntimeError('IPV6_FIXTURE_NOT_LISTENING')
 tcp_denied('dapt-hosted-gateway','::1',8089)
 rules=(E/'gateway-ipv6.rules').read_text();assert ':OUTPUT DROP' in rules and ':INPUT DROP' in rules
 report('network-denial',passCheck=True,ipv4ListeningCanary=True,ipv6DefaultDropRules=True,ipv6ListeningCanary=True,ipv6ExternalReachabilityTested=False)
 control('security-probe');report('browser-route-bypass',passCheck=True)
 control('status',ok=False,run='wrong-run')
 control('status',ok=False,capability='wrong-capability')
 q=subprocess.run([sys.executable,str(ROOT/'tools/credential-intake.py'),str(P/'intake.json')],input='',text=True,capture_output=True)
 assert q.returncode==1
 report('private-protocol-wrong-run-capability-nontty',passCheck=True)
 # Validate private manifest destination and missing consumer using a PTY, with no input supplied.
 original=json.loads((P/'intake.json').read_text())
 for label,override in [('destination',{'destination':'https://wrong.invalid'}),('consumer',{'container':'0'*64})]:
  fake=P/('rejected-'+label+'.json');fake.write_text(json.dumps({**original,**override}));fake.chmod(0o600)
  master,slave=pty.openpty()
  child=subprocess.Popen([sys.executable,str(ROOT/'tools/credential-intake.py'),str(fake)],stdin=slave,stdout=slave,stderr=slave)
  assert child.wait(timeout=20)==1
  os.close(master);os.close(slave);fake.unlink()
 report('private-wrong-destination-consumer-absent',passCheck=True)
 operator(cancel=True);assert control('status')['stage']=='CANCELLED';restart_browser()
 challenge=control('credential-request');time.sleep(121)
 control('credential-consume',ok=False,request=challenge['request'],password='expired-synthetic')
 control('credential-cancel',request=challenge['request']);restart_browser()
 report('private-protocol-expiry',passCheck=True)
 operator()
 before=snapshot()
 held=control('observe-before');assert snapshot()==before
 report('observational-views-and-database',passCheck=True)
 old=json.loads(run('docker','inspect','dapt-hosted-backend'))[0]
 previous_probe=startup_probe()
 run('docker','restart','dapt-hosted-backend')
 for _ in range(45):
  q=subprocess.run(['docker','exec','dapt-hosted-backend','node','-e',"require('http').get('http://127.0.0.1:5001/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"],capture_output=True)
  if q.returncode==0:break
  time.sleep(1)
 else:raise RuntimeError('BACKEND_RESTART_NOT_READY')
 new=json.loads(run('docker','inspect','dapt-hosted-backend'))[0]
 assert old['Image']==new['Image'] and old['Config']['Env']==new['Config']['Env'] and old['Mounts']==new['Mounts'] and old['State']['StartedAt']!=new['State']['StartedAt'] and old['State']['Pid']!=new['State']['Pid']
 wait_startup(previous_probe)
 post_start=snapshot()
 control('restart-completed',request=held['restartRequest'],receipt={'image':new['Image'],'before':old['State']['StartedAt'],'after':new['State']['StartedAt'],'sameDatabase':True,'sameAuthConfiguration':True})
 assert snapshot()==post_start
 control('logout')
 report('restart-readiness-session-logout-revocation',passCheck=True)
 # Runtime reservation receipts are independent of actual provider request logs.
 state=json.loads((P/'gateway-state/gateway.json').read_text());assert state['paperReserved']==18
 provider=[json.loads(x) for x in (E/'upstream.jsonl').read_text().splitlines() if json.loads(x).get('type')=='provider']
 assert len(provider)==12 and all(x['method']=='GET' for x in provider)
 report('request-accounting',passCheck=True,providerReads=len(provider),gatewayReserved=state['paperReserved'],historicalSyntheticOffset=6)
 # Exercise parser framing and durable charging for uncertain upstream failures.
 report('gateway-framing',result=run('docker','exec','--user','501:20','dapt-hosted-browser','node','/tests/gateway.integration.cjs','framing'))
 attempts=json.loads((P/'gateway-state/gateway.json').read_text())['attempts']
 (E/'drop-response').touch(mode=0o600)
 report('gateway-uncertain-budget',result=run('docker','exec','--user','501:20','dapt-hosted-browser','node','/tests/gateway.integration.cjs','uncertain'))
 charged=json.loads((P/'gateway-state/gateway.json').read_text());assert charged['attempts']==attempts+11
 uncertain=[json.loads(x) for x in (E/'upstream.jsonl').read_text().splitlines() if json.loads(x).get('type')=='uncertain-fixture'];assert len(uncertain)==11
 run('docker','restart','dapt-hosted-gateway');time.sleep(3)
 report('gateway-durable-budget',result=run('docker','exec','--user','501:20','dapt-hosted-browser','node','/tests/gateway.integration.cjs','persisted'))
 # Gateway outage must fail closed even after a successful session.
 run('docker','stop','dapt-hosted-gateway')
 code="const https=require('https'),fs=require('fs');https.get({host:'127.0.0.1',servername:'day-trader-backend.fly.dev',path:'/health',headers:{host:'day-trader-backend.fly.dev'},ca:fs.readFileSync('/tls/cert.pem')},r=>{r.resume();r.on('end',()=>process.exit(r.statusCode===502?0:1))}).on('error',()=>process.exit(1))"
 run('docker','exec','--user','501:20','dapt-hosted-browser','node','-e',code)
 report('gateway-outage',passCheck=True)
 control('credential-consume',ok=False,request=challenge['request'],password='replayed-synthetic')
 report('replay-rejected',passCheck=True)
 secret=json.loads((P/'synthetic.json').read_text())['password'].encode();cap=json.loads((P/'config/run.json').read_text())['capability'].encode()
 for f in E.rglob('*'):
  if f.is_file():assert secret not in f.read_bytes() and cap not in f.read_bytes()
 report('evidence-leakage',passCheck=True)
 for name in ['login','views-before','readiness-before','readiness-after','restart','logout','leakage','sandbox']:
  d=json.loads((E/(name+'.json')).read_text());assert d['pass']
  # Only preselected booleans/counts leave the runner, never response bodies.
  report(name,passCheck=True)
def startup_summary(evidence=E,trial=None):
 # Raw captures are read only here, then redacted and checked before any emission.
 from startup_publication import prepare
 secrets=[]
 if (P/'synthetic.json').exists():secrets.append(json.loads((P/'synthetic.json').read_text())['password'])
 if (P/'config/run.json').exists():secrets.append(json.loads((P/'config/run.json').read_text())['capability'])
 if (P/'backend.env').exists():
  secrets.extend(line.split('=',1)[1] for line in (P/'backend.env').read_text().splitlines() if line.startswith('JWT_SECRET='))
 for f in [P/name/'key.pem' for name in ['tls','upstream','negative/wrong','negative/expired','negative/untrusted']]:
  if f.is_file() and f.stat().st_size<16384:
   text=f.read_text()
   if 'PRIVATE KEY' in text:
    secrets.extend([text.strip(),''.join(x for x in text.splitlines() if not x.startswith('-----'))])
    secrets.extend(x for x in text.splitlines() if not x.startswith('-----') and len(x)>16)
 records,gate=prepare(evidence,secrets)
 for row in records:print(json.dumps({**row,**({'trial':trial} if trial else {})}),flush=True)
 print(json.dumps({**gate,**({'trial':trial} if trial else {})}),flush=True)
 return records

if __name__=='__main__':
 code=0
 try:main()
 except Exception as e:
  code=1
  report('failure',code=str(e) if str(e).replace('_','').isalnum() else type(e).__name__)
  if (E/'controller-start.json').exists():
   d=json.loads((E/'controller-start.json').read_text());report('browser-start-failure',code=d.get('error'))
  if (E/'browser.jsonl').exists():
   for line in (E/'browser.jsonl').read_text().splitlines():
    d=json.loads(line)
    if d.get('type')=='check-rejected':report('controller-rejection',code=d['code'])
 finally:
  try:startup_summary()
  except Exception:code=1;report('startup-summary',passCheck=False)
 sys.exit(code)
