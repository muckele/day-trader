#!/usr/bin/env python3
import os,pathlib,subprocess,json,secrets,hashlib,time,shutil,datetime
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
R=pathlib.Path(os.environ['PILOT_STATE']);T=pathlib.Path(__file__).resolve().parent;P=R/'private';E=R/'evidence';PREFIX='dapt-hosted'
BACK='pilot-backend:test';FRONT='pilot-frontend:test';MONGO='mongo:7.0.16';TOOL='pilot-tools:test'

def run(*a,**kw):
 p=subprocess.run(a,capture_output=True,text=True,timeout=120,**kw)
 if p.returncode:raise RuntimeError('COMMAND_FAILED '+a[0]+' '+a[1]+' '+str(p.returncode))
 return p.stdout.strip()
def save(p,x):
 p.write_text(x if isinstance(x,str) else json.dumps(x,indent=2));p.chmod(0o600)
 if E in p.parents:os.chown(p,501,20)
def certificate(dir,names,expired=False):
 dir.mkdir(mode=0o700,exist_ok=True);key=rsa.generate_private_key(public_exponent=65537,key_size=2048);now=datetime.datetime.now(datetime.timezone.utc);name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,names[0])]);cert=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(days=4)).not_valid_after(now+datetime.timedelta(days=-1 if expired else 3)).add_extension(x509.BasicConstraints(ca=True,path_length=None),critical=True).add_extension(x509.SubjectAlternativeName([x509.DNSName(n) for n in names]),critical=False).sign(key,hashes.SHA256());save(dir/'key.pem',key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.TraditionalOpenSSL,serialization.NoEncryption()).decode());save(dir/'cert.pem',cert.public_bytes(serialization.Encoding.PEM).decode())
def drun(role,opts,image,*args):
 print('PROVISION_'+role.upper(),flush=True)
 name=PREFIX+'-'+role;cid=run('docker','run','-d','--name',name,'--label','day-trader.acceptance='+PREFIX,'--label','day-trader.tool-lock='+LOCK,'--log-driver','none',*opts,image,*args);RES['containers'].append(cid);save(E/'resources.json',RES);return cid
if __name__=='__main__':
 if os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted':raise SystemExit('HOSTED_ONLY')
 R.mkdir(mode=0o700,exist_ok=True);P.mkdir(mode=0o700,exist_ok=True);E.mkdir(mode=0o700,exist_ok=True)
 if (P/'configured').exists():raise SystemExit('Existing run; no reset')
 BACK=run('docker','image','inspect',BACK,'--format','{{.Id}}');FRONT=run('docker','image','inspect',FRONT,'--format','{{.Id}}')
 TOOL=run('docker','image','inspect',TOOL,'--format','{{.Id}}')
 for d in ['config','tls','upstream','profile','gateway-state','control','negative']: (P/d).mkdir(mode=0o700,exist_ok=True)
 for n,hosts,expired in [('tls',['day-trader-frontend.fly.dev','day-trader-backend.fly.dev','fonts.googleapis.com','fonts.gstatic.com'],False),('upstream',['day-trader-frontend.fly.dev','day-trader-backend.fly.dev','paper-api.alpaca.markets'],False),('negative/wrong',['wrong.invalid'],False),('negative/expired',['day-trader-backend.fly.dev'],True),('negative/untrusted',['day-trader-backend.fly.dev'],False)]:certificate(P/n,hosts,expired)
 shutil.copyfile(P/'upstream/cert.pem',P/'upstream/ca.pem')
 x={'username':'synthetic-production-owner','password':'SyntheticOnly-'+secrets.token_urlsafe(24),'ownerId':secrets.token_hex(12)};save(P/'synthetic.json',x)
 cid=run('docker','create','--platform','linux/amd64',FRONT)
 try:run('docker','cp',cid+':/usr/share/nginx/html',str(P/'config/html'))
 finally:run('docker','rm','-v',cid)
 assets=['/'+str(f.relative_to(P/'config/html')) for f in (P/'config/html').rglob('*') if f.is_file() and not f.name.endswith('.map')];save(P/'config/assets.json',assets)
 paths={'/tools/'+f.name:f for f in T.iterdir() if f.is_file()};paths['/config/assets.json']=P/'config/assets.json';lock={'version':'production-observational-v2','hashes':{k:hashlib.sha256(v.read_bytes()).hexdigest() for k,v in paths.items()}};save(P/'config/lock.json',lock);LOCK=hashlib.sha256((P/'config/lock.json').read_bytes()).hexdigest();save(E/'source-lock.json',lock)
 config={'version':'production-observational-v2','source':'852fb22d9facf4bfe0bca7f419e22ee4bfbba17f','profile':'production-rehearsal','run':PREFIX,'paperAlready':6,'paperMaximum':60,'dataMaximum':60,'expectedOwner':x['ownerId'],'username':x['username'],'capability':secrets.token_hex(32),'upstreams':{'day-trader-frontend.fly.dev':['172.29.93.10'],'day-trader-backend.fly.dev':['172.29.93.10']},'testCA':'/upstream-trust/ca.pem','lock':LOCK,'backendImage':BACK};save(P/'config/run.json',config)
 save(P/'backend.env',dict_to_env:= '\n'.join(k+'='+v for k,v in {'NODE_ENV':'production','PORT':'5001','MONGO_URI':'mongodb://127.0.0.1:27017/acceptance?replicaSet=acceptance','MONGO_PREFER_LOCAL':'false','OWNER_USER_ID':x['ownerId'],'JWT_SECRET':secrets.token_hex(32),'FRONTEND_ORIGIN':'https://day-trader-frontend.fly.dev','ROBO_SCHEDULER_DISABLED':'true','APCA_API_KEY_ID':'synthetic-not-real','APCA_API_SECRET_KEY':'synthetic-not-real','APCA_BASE_URL':'https://paper-api.alpaca.markets','ALPACA_EXPECTED_PAPER_ACCOUNT_ID':'synthetic-paper-account','APP_PAPER_TRADES_SYNC_TO_ALPACA':'true','ROBO_EMAIL_PROVIDER':'disabled','NODE_EXTRA_CA_CERTS':'/certs/ca.pem'}.items())+'\n')
 RES={'run':PREFIX,'containers':[],'volumes':[],'networks':[]};save(E/'resources.json',RES)
 netname=PREFIX+'-upstream';run('docker','network','create','--internal','--subnet','172.29.93.0/24','--label','day-trader.acceptance='+PREFIX,netname);RES['networks'].append(netname);save(E/'resources.json',RES)
 for v in ['gateway','mongo']:
  name=PREFIX+'-'+v;run('docker','volume','create','--label','day-trader.acceptance='+PREFIX,name);RES['volumes'].append(name);save(E/'resources.json',RES)
 run('docker','run','--rm','--network','none','--user','0','-v',PREFIX+'-gateway:/gateway',TOOL,'sh','-c','chown 501:20 /gateway && chmod 700 /gateway')
 drun('mongo',['--network',netname,'--add-host','paper-api.alpaca.markets:127.0.0.1','--ip','172.29.93.10','-v',PREFIX+'-mongo:/data/db'],MONGO,'mongod','--replSet','acceptance','--bind_ip','127.0.0.1','--setParameter','ttlMonitorEnabled=false');time.sleep(3)
 run('docker','exec',PREFIX+'-mongo','mongosh','--quiet','--eval',"rs.initiate({_id:'acceptance',members:[{_id:0,host:'127.0.0.1:27017'}]})");time.sleep(3)
 ns='container:'+PREFIX+'-mongo'
 # Synthetic data and certificates are ephemeral. Owners match each isolated runtime.
 (P/'profile/home/.config/google-chrome-for-testing/Crash Reports').mkdir(parents=True,exist_ok=True,mode=0o700)
 for root,dirs,files in os.walk(P):
  os.chown(root,501,20)
  for f in files:os.chown(pathlib.Path(root)/f,501,20)
 os.chown(E,501,20)
 os.chmod(P/'upstream',0o755)
 for f in ['ca.pem','cert.pem']:os.chmod(P/'upstream'/f,0o644)
 print('PROVISION_SEED',flush=True)
 run('docker','run','--rm','--platform','linux/amd64','--network',ns,'--user','0','-v',str(P)+':/private:ro','-v',str(T)+':/tools:ro',BACK,'node','/tools/seed.cjs')
 drun('standin',['--network',ns,'--user','501:20','--cap-drop','ALL','--security-opt','no-new-privileges','-v',str(T)+':/tools:ro','-v',str(P/'upstream')+':/certs:ro','-v',str(E)+':/evidence'],TOOL,'node','/tools/standin.cjs')
 # Hosts file belongs to this task's backend container; no host/system DNS changes.
 drun('backend',['--platform','linux/amd64','--network',ns,'--env-file',str(P/'backend.env'),'--cap-drop','ALL','--security-opt','no-new-privileges','-v',str(P/'upstream')+':/certs:ro'],BACK)
 drun('frontend',['--platform','linux/amd64','--network',ns,'--security-opt','no-new-privileges'],FRONT)
 common=['-v',str(T)+':/tools:ro','-v',str(P/'config')+':/config:ro','-v',str(E)+':/evidence']
 drun('gateway',['--network',netname,'--ip','172.29.93.20','--user','0','--cap-drop','ALL','--cap-add','NET_ADMIN','--cap-add','DAC_OVERRIDE','--cap-add','SETUID','--cap-add','SETGID','--cap-add','SETPCAP','--security-opt','no-new-privileges',*common,'-v',str(P/'upstream')+':/upstream-trust:ro','-v',str(P/'gateway-state')+':/state','-v',PREFIX+'-gateway:/gateway'],TOOL,'sh','/tools/gateway-start.sh')
 time.sleep(3)
 cid=drun('browser',['--network','none','--user','501:20','--cap-drop','ALL','--security-opt','no-new-privileges','--security-opt','seccomp='+str(T/'chromium-seccomp.json'),'--shm-size','512m','--tmpfs','/control:mode=0700,uid=501,gid=20,size=1m','--ulimit','core=0:0','--tmpfs','/profile/home/.config/google-chrome-for-testing/Crash Reports:ro,mode=000,size=1m','-e','HOME=/profile/home','-e','DISPLAY=:99','-v',str(T.parent/'tests')+':/tests:ro',*common,'-v',str(P/'tls')+':/tls:ro','-v',str(P/'profile')+':/profile','-v',PREFIX+'-gateway:/gateway:ro'],TOOL,'sh','/tools/browser-start.sh')
 save(P/'intake.json',{'container':cid,'run':PREFIX,'capability':config['capability'],'lock':LOCK,'source':config['source'],'destination':'https://day-trader-backend.fly.dev'});save(P/'configured','configured')
 save(E/'resources.json',RES);print('SYNTHETIC_STACK_CREATED')
