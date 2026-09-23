#!/usr/bin/env python3
"""Operator-local private input. No passwords in argv/env/files or output."""
import sys,os,json,subprocess,termios,signal,time,pathlib

def exchange(manifest,envelope):
 p=subprocess.run(['docker','exec','--user','501:20','-i',manifest['container'],'node','/tools/control.cjs'],input=json.dumps(envelope).encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=25)
 if p.returncode:raise RuntimeError('PRIVATE_CONTROLLER_UNAVAILABLE')
 r=json.loads(p.stdout)
 if not r.get('ok'):raise RuntimeError('PRIVATE_INPUT_REJECTED')
 return r

def main():
 if len(sys.argv)!=2 or not sys.stdin.isatty():raise RuntimeError('INTERACTIVE_TERMINAL_REQUIRED')
 p=pathlib.Path(sys.argv[1]);st=p.stat()
 if st.st_uid!=os.getuid() or st.st_mode&0o077:raise RuntimeError('PRIVATE_MANIFEST_PERMISSIONS')
 m=json.loads(p.read_text())
 if set(m)!=set(['container','run','capability','lock','source','destination']):raise RuntimeError('MANIFEST_REJECTED')
 if m['source']!='852fb22d9facf4bfe0bca7f419e22ee4bfbba17f' or m['destination']!='https://day-trader-backend.fly.dev':raise RuntimeError('DESTINATION_REJECTED')
 # Immutable container id and exact label are checked before asking for a password.
 inspect=subprocess.run(['docker','inspect','--format','{{json .Config.Labels}}',m['container']],capture_output=True,timeout=10,check=True)
 labels=json.loads(inspect.stdout)
 if labels.get('day-trader.acceptance')!=m['run'] or labels.get('day-trader.tool-lock')!=m['lock'] or len(m['container'])!=64:raise RuntimeError('CONTROLLER_IDENTITY_REJECTED')
 base={'run':m['run'],'capability':m['capability']};q=exchange(m,{**base,'command':'credential-request'})
 if q.get('destination')!=m['destination'] or q.get('source')!=m['source'] or q.get('lock')!=m['lock']:raise RuntimeError('CONSUMER_IDENTITY_REJECTED')
 fd=sys.stdin.fileno();old=termios.tcgetattr(fd);new=termios.tcgetattr(fd);new[3]&=~termios.ECHO
 def cancel(*_):raise KeyboardInterrupt()
 previous={s:signal.signal(s,cancel) for s in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]}
 buf=bytearray();success=False
 try:
  termios.tcsetattr(fd,termios.TCSAFLUSH,new);sys.stdout.write('Private Day Trader password (no echo; Ctrl-C cancels): ');sys.stdout.flush()
  while True:
   b=os.read(fd,1)
   if not b or b in [b'\n',b'\r']:break
   buf.extend(b)
   if len(buf)>1024:raise RuntimeError('INPUT_REJECTED')
  if not buf:raise RuntimeError('INPUT_REJECTED')
  r=exchange(m,{**base,'command':'credential-consume','request':q['request'],'password':buf.decode()});success=True
 finally:
  termios.tcsetattr(fd,termios.TCSAFLUSH,old)
  for s,h in previous.items():signal.signal(s,h)
  for i in range(len(buf)):buf[i]=0
  if not success:
   try:exchange(m,{**base,'command':'credential-cancel','request':q['request']})
   except Exception:pass
  sys.stdout.write('\n');sys.stdout.flush()
 print('Private input consumed once; controller owns the bounded UI attempt.')
if __name__=='__main__':
 try:main()
 except (Exception,KeyboardInterrupt):print('Private input cancelled or rejected; no automatic retry.',file=sys.stderr);sys.exit(1)
