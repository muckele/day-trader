import subprocess,json,datetime,pathlib
out=pathlib.Path(__file__).resolve().parent
version=subprocess.run(['docker','scout','version'],capture_output=True,text=True)
(out/'scout-version.txt').write_text(version.stdout+version.stderr)
for name,image in [('backend','sha256:7f640e73b61a18bb2ef2914dbef374ed89528aebe3a81e9fe9567f161a9a6019'),('frontend','sha256:a7aa7e54a5c65283c7851987f64cfa83352d40c9f11ea4fbac502e27ba1b5c2e')]:
 inspect=json.loads(subprocess.check_output(['docker','image','inspect',image]))[0]
 assert inspect['Id']==image and inspect['Os']=='linux' and inspect['Architecture']=='arm64'
 cmd=['docker','scout','cves','local://'+image,'--platform','linux/arm64','--exit-code','--locations','--format','sarif','--output',str(out/(name+'.sarif.json'))]
 start=datetime.datetime.now(datetime.timezone.utc).isoformat()
 p=subprocess.run(cmd,capture_output=True,text=True)
 (out/(name+'-scout.stdout.log')).write_text(p.stdout)
 (out/(name+'-scout.stderr.log')).write_text(p.stderr)
 record=dict(command=cmd,startedAt=start,finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),exitCode=p.returncode,imageId=image,platform='linux/arm64',layers=inspect['RootFS']['Layers'])
 (out/(name+'-scan-execution.json')).write_text(json.dumps(record,indent=2)+'\n')
 print(json.dumps(record),flush=True)
