"""Empty uncertain-response fixture, readable only by its existing UID501 consumer."""
import os,pathlib,stat

def verify(evidence):
 try:
  info=(pathlib.Path(evidence)/'drop-response').lstat()
  if not stat.S_ISREG(info.st_mode) or (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_size)!=(501,20,0o600,0):raise ValueError()
 except (OSError,ValueError):raise RuntimeError('DROP_RESPONSE_MARKER_CONTRACT_FAILED') from None
 return {'label':'drop-response-marker','exists':True,'regularFile':True,'uid':info.st_uid,'gid':info.st_gid,'mode':format(stat.S_IMODE(info.st_mode),'04o'),'size':info.st_size}

def create(evidence):
 marker=pathlib.Path(evidence)/'drop-response'
 try:
  marker.touch(mode=0o600)
  os.chown(marker,501,20)
  os.chmod(marker,0o600)
 except OSError:raise RuntimeError('DROP_RESPONSE_MARKER_CREATE_FAILED') from None
 return verify(evidence)
