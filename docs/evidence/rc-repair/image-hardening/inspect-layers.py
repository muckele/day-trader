import tarfile,json,pathlib,hashlib,re
out=pathlib.Path(__file__).resolve().parent
reports={}
for image in ['backend','frontend']:
 archive=pathlib.Path('/private/tmp/day-trader-hardened-'+image+'.tar')
 entries=[];flags=[];current={}
 with tarfile.open(archive) as a:
  manifest=json.load(a.extractfile('manifest.json'))[0]
  config=json.load(a.extractfile(manifest['Config']))
  for layer,diff in zip(manifest['Layers'],config['rootfs']['diff_ids']):
   with tarfile.open(fileobj=a.extractfile(layer)) as t:
    for member in t:
     name=member.name.lstrip('./')
     if not member.isfile() and not member.issym():continue
     record=dict(path=name,layer=diff,size=member.size,link=member.linkname or None)
     if member.isfile():
      data=t.extractfile(member).read();record['sha256']=hashlib.sha256(data).hexdigest()
      if b'-----BEGIN PRIVATE KEY-----' in data or b'-----BEGIN RSA PRIVATE KEY-----' in data or b'-----BEGIN OPENSSH PRIVATE KEY-----' in data:flags.append(dict(path=name,layer=diff,kind='private-key-marker'))
     if re.search(r'(^|/)(\.env(?:\..*)?|\.npmrc|\.ssh|id_rsa|id_ed25519|credentials|config\.json)$',name):flags.append(dict(path=name,layer=diff,kind='sensitive-path-review'))
     entries.append(record);current[name]=record
  (out/(image+'-layer-files.json')).write_text(json.dumps(entries,indent=2)+'\n')
  sensitive_config=[x for x in config.get('config',{}).get('Env',[]) if re.search(r'(?i)(secret|token|password|api_key)',x.split('=')[0])]
  reports[image]=dict(imageId='sha256:'+hashlib.sha256(a.extractfile(manifest['Config']).read()).hexdigest(),layers=config['rootfs']['diff_ids'],fileEntries=len(entries),flags=flags,sensitiveConfigNames=sensitive_config,config=config.get('config'),history=config.get('history'),archiveSha256=hashlib.sha256(archive.read_bytes()).hexdigest())
 (out/'layer-inspection.json').write_text(json.dumps(reports,indent=2)+'\n')
print(json.dumps({k:{a:v[a] for a in ['imageId','fileEntries','flags','sensitiveConfigNames']} for k,v in reports.items()},indent=2))
