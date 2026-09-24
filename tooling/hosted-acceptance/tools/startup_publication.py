"""Bounded private-to-public startup evidence gate; never reads browser profiles."""
import base64, json, re, urllib.parse
MAX_CAPTURE=131072
MAX_PUBLIC=98304
class Withheld(Exception):
 pass

def variants(secrets):
 out=set()
 for secret in secrets:
  if not secret:continue
  out.add(secret)
  b=secret.encode()
  out.update([base64.b64encode(b).decode(),base64.urlsafe_b64encode(b).decode(),b.hex(),urllib.parse.quote(secret,safe=''),json.dumps(secret)[1:-1]])
  out.update(v.rstrip('=') for v in list(out) if len(v)>16)
 return sorted(out,key=len,reverse=True)

def clean(text,known):
 # Remove terminal controls before recognizing sensitive values or log commands.
 text=re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', '', text)
 text=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
 text=re.sub(r'[\x00-\x08\x0b-\x1f\x7f-\x9f]', '', text)
 text=re.sub(r'[\u202a-\u202e\u2066-\u2069]', '', text)
 for value in known:text=text.replace(value,'[REDACTED]')
 # Multi-line private objects cannot safely be interpreted as native error text.
 if re.search(r'(?i)(environment\s*(?:dump|variables|:|=)|process\.env|response\s*body|browser\s*state|storageState|private\s*config)',text):
  raise Withheld('sensitive_object_marker')
 if re.search(r'[\[{]\s*"[^"\n]+"\s*:',text):raise Withheld('structured_object_dump')
 if re.search(r'(?m)^\s*[A-Z_][A-Z0-9_]{1,}=',text):raise Withheld('environment_assignment')
 if re.search(r'-----BEGIN .*PRIVATE KEY-----',text):
  text=re.sub(r'-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)','[PRIVATE KEY REDACTED]',text)
 text=re.sub(r'(?im)^.*(?:authorization|proxy-authorization|set-cookie|cookie)\s*[:=].*$', '[AUTH HEADER REDACTED]', text)
 text=re.sub(r'(?i)\b(?:password|token|secret|capability|api[_-]?key)\s*[:=]\s*(?:"[^"\n]*"|\x27[^\x27\n]*\x27|[^\s,;]+)', '[CREDENTIAL REDACTED]',text)
 text=re.sub(r'(?i)\bBearer\s+[^\s,;]+','[BEARER REDACTED]',text)
 # Public Chromium relative source references survive; unexpected absolute paths do not.
 def path(m):
  p=m.group(0)
  roots=('/profile','/control','/tools','/opt/chromium','/tls','/gateway','/tmp','/dev/shm','/proc','/config')
  if p=='/opt' or (any(p==r or p.startswith(r+'/') for r in roots) and '..' not in p.split('/')):return p
  return '[PRIVATE PATH]'
 text=re.sub(r'file://[^\s\x27"<>]+','[PRIVATE FILE URL]',text)
 text=re.sub(r'(?<![\w./])/(?!/)[^\s\x27"<>\]\[),;]+',path,text)
 text=re.sub(r'::[A-Za-z][A-Za-z0-9_-]*(?: [^\r\n:]*)?::','[LOG COMMAND REMOVED]',text) # JSON framing also prevents commands.
 if any(v in text for v in known) or re.search(r'PRIVATE KEY-----|(?i:authorization)\s*:',text):
  raise Withheld('residual_sensitive_value')
 return text

def sanitize(value,known):
 if isinstance(value,str):return clean(value,known)
 if isinstance(value,list):return [sanitize(v,known) for v in value]
 if isinstance(value,dict):return {clean(k,known):sanitize(v,known) for k,v in value.items()}
 return value

def prepare(evidence,secrets):
 known=variants(secrets);records=[];used=0
 paths=[evidence/'startup-diagnostics.jsonl',*sorted((evidence/'startup-private').glob('*.txt'))]
 if len(paths)>12:raise Withheld('capture_file_count_limit')
 for f in paths:
  if not f.exists():continue
  name=f.name if re.fullmatch(r'[A-Za-z0-9_.-]{1,80}',f.name) else 'unknown'
  try:
   if f.is_symlink() or f.stat().st_size>MAX_CAPTURE:raise Withheld('capture_file_size_or_type_limit')
   source=f.read_text()
   # Check full private text first, including markers split across retained lines.
   obj=[json.loads(x) for x in source.splitlines()] if f.suffix=='.jsonl' else json.loads(source)
   if isinstance(obj,dict) and 'lines' in obj:
    joined='\n'.join(r['text'] for r in obj['lines'])
    clean(joined,known) # Object marker policy; no raw text is returned.
    if re.search(r'-----BEGIN .*PRIVATE KEY-----',joined):raise Withheld('multiline_private_key_marker')
   public=sanitize(obj,known)
   row={'check':'startup-excerpt' if f.suffix=='.txt' else 'startup-facts','source':name,'data':public}
   encoded=json.dumps(row,ensure_ascii=True)
   if len(encoded.encode())>MAX_PUBLIC-used:raise Withheld('public_output_budget')
   # Check the serialized envelope too, with JSON-escaped secret representations.
   if any(v in encoded for v in known):raise Withheld('serialized_secret_match')
   used+=len(encoded.encode());records.append(row)
  except Withheld as ex:records.append({'check':'startup-evidence-withheld','source':name,'reason':str(ex),'terminalWindowRetained':False})
  except Exception:records.append({'check':'startup-evidence-withheld','source':name,'reason':'invalid_capture_format','terminalWindowRetained':False})
 return records,{'check':'startup-publication','knownCredentialValues':len(secrets),'encodedRepresentations':len(known),'publicBytes':used,'publicLimitBytes':MAX_PUBLIC,'browserProfileRead':False,'rawArtifactsUploaded':False}
