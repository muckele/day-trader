"""Offline contract tests. Linux effects exist only in the finite KernelPort below.

Breaks caught: omitted syscall/ABI restrictions, widened socket arguments,
unattested exec, incorrect UID/view/FD setup, TSYNC continuation and foreign reaping.
Numeric expectations are independently transcribed from approved Linux 6.8 /
glibc 2.39 / AAPCS64 evidence, coverage SHA256 7c8714c95a67d8a2e6c1b4c8b8481525a61976c81dfe2037c251add071ac9898.
"""
import ast
import builtins
import dataclasses
import hashlib
import hmac
import json
import importlib.util
import inspect
from pathlib import Path
import struct
import sys
import threading
import types
import unittest


def v1_bytes(value):
    body=json.dumps(value,sort_keys=True,separators=(',',':')).encode('ascii')
    return struct.pack('>I',len(body))+body


class V1Clock:
    def __init__(self): self.wall,self.mono=100,100
    def sample(self): return self.wall,self.mono


class V1Budget:
    """Same terminal-start rule as topology.CleanupBudget (C1): the one end is
    allocated only by start_terminal/clamp_end; remaining() never allocates."""
    def __init__(self): self.clock=V1Clock(); self.deadline=None; self.started=False
    def start_terminal(self):
        if not self.started: self.started=True; self.deadline=self.clock.mono+60000
        return self.remaining()
    def clamp_end(self,end):
        self.start_terminal(); self.deadline=min(self.deadline,end)
    def remaining(self):
        if not self.started: raise ValueError('CLEANUP_NOT_STARTED')
        return max(0,self.deadline-self.clock.mono)
    def call(self,op): return op(self.remaining())


class V1RoleTests(unittest.TestCase):
    # A removed original map/sequence check, fresh cleanup window, old waiting
    # observer, or transported nominal owner makes these assertions fail.
    def setup_roles(self):
        self.assertTrue(hasattr(c,'bind_original_roles'),'original role composition binding is absent')
        k=Kernel(); budget=V1Budget(); writes=[]; queue=[]; seq=0; init={}; current=None
        binding=c.CompositionBinding(1,RUN,'b'*64,'c'*64,'d'*64,1,10000)
        def write(owned,data):
            nonlocal seq,current
            self.assertIs(owned,k.children[owned.pid].owned)
            v=json.loads(data[4:]);writes.append((owned,v))
            if 'kind' in v: init[owned.role]=v;return
            unsigned=dict(v); supplied=unsigned.pop('mac')
            expected=hmac.new(bytes.fromhex(init[owned.role]['channelKeyHex']),b'acceptance:bootstrap-composition:v1\0'+owned.role.encode()+b':FROM_BOOTSTRAP\0'+v1_bytes(unsigned)[4:],hashlib.sha256).hexdigest()
            self.assertEqual(supplied,expected)
            if v['action']=='PREPARE':
                current=v['payload']; action='PREPARED'; payload=dict(requestSequence=v['sequence'],grantId=current['grantId'],reservationId='6'*32,generation=1)
            elif v['action']=='COMMIT':
                current=dict(current,**v['payload']); action='REFRESH'; payload=dict(requestSequence=v['sequence'],**v['payload'])
            elif v['action']=='CURRENT':
                action='STARTED';payload={key:current[key] for key in ('grantId','reservationId','commitId','generation')};payload['requestSequence']=v['sequence']
            elif v['action']=='CANCEL': action='CANCELLED';payload=dict(requestSequence=v['sequence'],generation=1)
            else: return
            seq+=1
            response=dict(version=1,binding=binding.to_record(),sequence=seq,role='BROWSER',childId=v['childId'],pipeId=v['pipeId'],action=action,payload=payload)
            response['mac']=hmac.new(bytes.fromhex(init['BROWSER']['channelKeyHex']),b'acceptance:bootstrap-composition:v1\0BROWSER:TO_BOOTSTRAP\0'+v1_bytes(response)[4:],hashlib.sha256).hexdigest()
            queue.append(v1_bytes(response))
        k.write_role=write;k.read_role=lambda owned,limit:queue.pop(0)
        original=c.bind_original_roles(ConfinementTests().config(k),binding,budget)
        proof=dict(proofDigest='e'*64,generation=1,expiresAtMs=9000,monotonicDeadlineMs=9000)
        checkpoint=dict(binding=binding.to_record(),generation=1,sequence=1,sourceIdentity='f'*32,lostCount=0)
        original.bind_current_source(types.SimpleNamespace(require_current=lambda:dict(**proof,eventCheckpoint=checkpoint)))
        return original,k,budget,proof,writes,init

    def test_v1_original_role_ids_never_select_foreign_pid_or_fd(self):
        roles,k,budget,proof,writes,init=self.setup_roles()
        originals=tuple(child.owned for child in k.children.values())
        self.assertEqual(tuple(x['role'] for x in init['CONTROLLER']['roles']),('CONTROLLER','BROWSER','VERIFIER','PROXY'))
        with self.assertRaises(c.ConfinementError): roles.audit('BROWSER','0'*32,'0'*32)
        self.assertTrue(all(any(owned is original for original in originals) for owned,_ in writes))
        self.assertEqual(roles.stop_owned(100)['status'],'STOPPED')
        self.assertEqual(set(k.stopped),{201,202,203,204})

    def test_v1_task13_poll_observes_only_the_retained_original_result_endpoint(self):
        calls=[];result=object();owned=c.NativeOwned(201,RUN,'BROWSER',object(),result)
        bindings=types.SimpleNamespace(select=lambda reads,writes,errors,timeout:
            (calls.append((reads,writes,errors,timeout)) or ([result],[],[])))
        self.assertIs(c.NativeKernelPort(bindings).poll_role(owned),True)
        self.assertEqual(calls,[([result],[],[],0)])
        bindings.select=lambda reads,writes,errors,timeout:([],[],[])
        self.assertIs(c.NativeKernelPort(bindings).poll_role(owned),False)

    def test_v1_fixed_frames_reject_unknown_and_ancillary_data(self):
        for mutate in ('unknown','ancillary','gap','mac','depth','duplicate'):
            roles,k,budget,proof,writes,init=self.setup_roles()
            row=init['CONTROLLER']['roles'][1]
            value=dict(version=1,binding=roles.binding.to_record(),sequence=1,**row,action='ADOPT',payload={})
            if mutate=='unknown':value['payload']={'pid':999}
            if mutate=='gap':value['sequence']=2
            if mutate=='depth':value['payload']={'x':[[[[[[[[[1]]]]]]]]]}
            value['mac']=hmac.new(bytes.fromhex(init['CONTROLLER']['channelKeyHex']),b'acceptance:bootstrap-composition:v1\0CONTROLLER:TO_BOOTSTRAP\0'+v1_bytes(value)[4:],hashlib.sha256).hexdigest()
            if mutate=='mac':value['mac']='0'*64
            data=v1_bytes(value)
            if mutate=='duplicate':
                body=data[4:].replace(b'"sequence":1',b'"sequence":1,"sequence":1');data=struct.pack('>I',len(body))+body
            with self.subTest(mutate=mutate),self.assertRaises(c.ConfinementError):roles.handle_controller(data,ancillary=(object(),) if mutate=='ancillary' else ())

    def test_v1_partial_start_retains_all_original_owners(self):
        k=Kernel(fail_spawn='PROXY');budget=V1Budget();seen=[]
        def stop(owned,ms):seen.append((owned,ms));budget.clock.mono+=11;return {'status':'TIMEOUT','pid':owned.pid,'run_id':RUN}
        k.stop_owned=stop
        self.assertTrue(hasattr(c,'bind_original_roles'),'partial role set ownership is absent')
        with self.assertRaises(c.ConfinementError) as raised:c.bind_original_roles(ConfinementTests().config(k),c.CompositionBinding(1,RUN,'b'*64,'c'*64,'d'*64,1,10000),budget)
        self.assertEqual(len(raised.exception.cleanup.originals),3)
        self.assertEqual([ms for _,ms in seen],[60000,59989,59978])

    def test_v1_python_preparation_owner_projects_only_fixed_result(self):
        roles,k,budget,proof,writes,init=self.setup_roles();owner=roles.prepare_browser(proof)
        self.assertIsInstance(owner,c.BootstrapBrowserPreparation)
        self.assertEqual(set(owner.to_prepare_result()),{'grantId','proofDigest','generation','expiresAtMs','monotonicDeadlineMs'})
        self.assertEqual(dict(owner.to_prepare_result(),grantId='x'),dict(proof,grantId='x'))
        with self.assertRaises(TypeError):json.dumps(owner)
        with self.assertRaises(c.ConfinementError):roles.commit_browser(dict(owner.to_prepare_result()))
        with self.assertRaises(c.ConfinementError):roles.commit_browser(owner)
        roles,k,budget,proof,writes,init=self.setup_roles();owner=roles.prepare_browser(proof)
        self.assertEqual(roles.commit_browser(owner),{'status':'ACTIVE','generation':1})
        self.assertEqual([v['action'] for _,v in writes if 'action' in v],['PREPARE','COMMIT','CURRENT'])
        with self.assertRaises(c.ConfinementError):roles.commit_browser(owner)

    def runtime(self,extra=True):
        legacy=ConfinementTests();k=legacy.observed_native();owned,s=next(iter(k._owned.items()));b=k.b
        launch=c.prepare_role('PROXY',c.RoleConfig(legacy.config(),c.role_fds('PROXY',RUN)))
        s.update(launch=launch,exec_identity=(1,999),digest=hashlib.sha256(c.filter_bytes(launch.filter)).hexdigest())
        old_read=b.read_file;old_list=b.os.listdir;old_link=b.os.readlink;old_stat=b.os.stat
        def read(path,*args):
            if '/fdinfo/' in path:return ('flags:\t0'+('1' if path.endswith('/4') else '2' if path.endswith('/5') else '0')+'\n').encode()
            if path.endswith('/cmdline'):return b'\0'.join(x.encode() for x in launch.argv)+b'\0'
            return old_read(path,*args).replace(b'10002',b'10004').replace(b'browser',b'proxy')
        b.read_file=read
        b.os.listdir=lambda p:['0','1','2','3','4']+(['5'] if extra else []) if p.endswith('/fd') else ['proxy'] if p.endswith('/run/acceptance') else old_list(p)
        b.os.readlink=lambda p:'socket:[50]' if p.endswith('/fd/5') else old_link(p)
        def stat(p):
            if '/fd/' in p:return types.SimpleNamespace(st_dev=2,st_ino=50 if p.endswith('/5') else 30 if p.endswith('/3') else 40 if p.endswith('/4') else 10)
            x=old_stat(p);x.st_uid=x.st_gid=10004;return x
        b.os.stat=stat;b.os.fstat=lambda fd:types.SimpleNamespace(st_dev=2,st_ino=50)
        proxy=c.NativeOwned(300,RUN,'PROXY',owned.command,owned.result,owned.identity)
        del k._owned[owned];k._owned[proxy]=s
        handoff=c.RoleHandoff(launch,c.RoleAttestation(**dict(pid=300,run_id=RUN,role='PROXY',uids=(10004,)*3,gids=(10004,)*3,groups=(),capabilities=(0,)*5,no_new_privs=1,seccomp=2,filter_digest=s['digest'],fds=launch.fds,views=launch.views,waiting=True,programs=launch.programs)),k,proxy)
        return k,handoff,b

    def test_v1_literal_proc_proxy_listener_is_current_not_inherited(self):
        k,h,b=self.runtime()
        # Exercise the existing raw observer before any new nominal API: this
        # used to reject the legitimate live listener as an inherited FD leak.
        rows=tuple(dict(fd=fd,kind=('NULL' if fd<3 else 'COMMAND' if fd==3 else 'RESULT' if fd==4 else 'PROXY_LISTENER'),device='2',inode=str(10 if fd<3 else 30 if fd==3 else 40 if fd==4 else 50),flags=1 if fd==4 else 2 if fd==5 else 0,ownerId='1'*32,acquiredGeneration=1) for fd in range(6))
        try:
            import inspect
            args={'current_fds':rows} if 'current_fds' in inspect.signature(c._native_observe).parameters else {}
            facts=c._native_observe(b,300,h.launch,hashlib.sha256(c.filter_bytes(h.launch.filter)).hexdigest(),{},False,**args)
        except (TypeError,c.ConfinementError) as error:self.fail('current listener observer rejected original runtime inventory: '+str(error))
        self.assertFalse(facts['waiting']);self.assertEqual(tuple(d.fd for d in facts['fds']),(0,1,2,3,4))

    @staticmethod
    def report(k,h,kinds=('NULL','NULL','NULL','COMMAND','RESULT','PROXY_LISTENER')):
        """Report rows for the literal child table, as one accepted C5 bracket yields them."""
        return tuple(dict(fd=row['fd'],kind=kinds[row['fd']],device=row['device'],inode=row['inode'],
                          flags=row['flags'],tfds=row['tfds']) for row in k.observe_child_descriptors(h))

    def inspect_runtime(self,drift=None):
        k,h,b=self.runtime(extra=False)
        self.assertTrue(hasattr(k,'bind_runtime_owner'),'runtime acquisition binding is absent')
        owner=object();k.bind_runtime_owner(h,'SERVICE',owner,'1'*32,'2'*32,1)
        old_list=b.os.listdir;b.os.listdir=lambda p:['0','1','2','3','4','5'] if p.endswith('/fd') else old_list(p)
        # E4/C5: the listener is adopted from one bracketed child observation, never registered.
        k._adopt_child_inventory(h,owner,self.report(k,h))
        if drift=='inode':b.os.stat=lambda p:types.SimpleNamespace(st_dev=2,st_ino=99)
        if drift=='unknown':b.os.listdir=lambda p:['0','1','2','3','4','5','6'] if p.endswith('/fd') else old_list(p)
        if drift=='owner':owner=object()
        return k.inspect_runtime(h,'SERVICE',owner)

    def test_v1_literal_proc_donated_recycled_or_unknown_fd_denied(self):
        for drift in ('inode','owner'):
            with self.subTest(drift=drift),self.assertRaises(c.ConfinementError):self.inspect_runtime(drift)

    def test_v1_runtime_inspect_does_not_force_waiting(self):
        if not hasattr(c.NativeKernelPort,'inspect_runtime'):
            k,h,b=self.runtime(extra=False)
            self.assertFalse(k.inspect(300)['waiting'],'live service inspection must not force WAITING')
        value=self.inspect_runtime();self.assertEqual(value['lifecycle'],'SERVICE');self.assertEqual(len(value['currentFDs']),6)

    def test_v1_unknown_runtime_internal_profile_is_unavailable(self):
        with self.assertRaisesRegex(c.ConfinementError,'NATIVE_CURRENT_INVENTORY_UNAVAILABLE'):self.inspect_runtime('unknown')

    def test_v1_proxy_runtime_descriptors_are_observed_never_registered(self):
        # E4/C5: the registry calls are gone; the child's own /proc is the only source.
        for name in ('register_runtime_descriptor','retire_runtime_descriptor'):
            self.assertFalse(hasattr(c.NativeKernelPort,name),name)
        k,h,b=self.runtime()
        rows=k.observe_child_descriptors(h)
        self.assertEqual([(r['fd'],r['device'],r['inode'],r['flags'],r['tfds'],r['link']) for r in rows],
                         [(0,'2','10',0,[],'/dev/null'),(1,'2','10',0,[],'/dev/null'),(2,'2','10',0,[],'/dev/null'),
                          (3,'2','30',0,[],'pipe:[30]'),(4,'2','40',1,[],'pipe:[40]'),(5,'2','50',2,[],'socket:[50]')])
        # Never this process's own descriptor table: a differing bootstrap fstat is ignored.
        b.os.fstat=lambda fd:types.SimpleNamespace(st_dev=9,st_ino=9000+fd)
        self.assertEqual(k.observe_child_descriptors(h),rows)
        old_read=b.read_file
        b.read_file=lambda path,*a:(old_read(path,*a)+b'tfd:        3 events:       19 data: 3  pos:0 ino:1e sdev:d\n'
                                    if path.endswith('/fdinfo/5') else old_read(path,*a))
        with self.assertRaisesRegex(c.ConfinementError,'^FD_DENIED$'):k.observe_child_descriptors(h)
        b.os.readlink=lambda p,old=b.os.readlink:'anon_inode:[eventpoll]' if p.endswith('/fd/5') else old(p)
        self.assertEqual(k.observe_child_descriptors(h)[5]['tfds'],[3])

    def test_v1_inherited_fds_and_retained_owner_ids_bind_adopted_inventory(self):
        self.assertTrue(hasattr(c.NativeKernelPort,'_adopt_child_inventory'),'no observed PROXY ledger (E4)')
        k,h,b=self.runtime(extra=False);owner=object()
        k.bind_runtime_owner(h,'SERVICE',owner,'1'*32,'2'*32,1)
        b.os.listdir=lambda p,old=b.os.listdir:['0','1','2','3','4','5'] if p.endswith('/fd') else old(p)
        first=k._adopt_child_inventory(h,owner,self.report(k,h))
        again=k._adopt_child_inventory(h,owner,self.report(k,h))
        self.assertEqual(first,again,'an unchanged identity keeps its ownerId')
        self.assertEqual(k.runtime_record(h)['currentFDs'],list(again))
        report=list(self.report(k,h))
        # An inherited identity never changes; a retained runtime identity keeps its flags and targets.
        for index,key,value in ((3,'inode','31'),(5,'flags',3),(5,'tfds',[3])):
            with self.subTest(index=index,key=key),self.assertRaisesRegex(c.ConfinementError,'^FD_DENIED$'):
                changed=[dict(row) for row in report];changed[index][key]=value
                k._adopt_child_inventory(h,owner,tuple(changed))
        with self.assertRaisesRegex(c.ConfinementError,'^AUTHORITY_LOST$'):
            k._adopt_child_inventory(h,object(),tuple(report))
        report[5]=dict(report[5],inode='51')
        replaced=k._adopt_child_inventory(h,owner,tuple(report))
        self.assertNotEqual(replaced[5]['ownerId'],again[5]['ownerId'],'a new identity is a new observed acquisition')

    def test_v1_proxy_frames_use_the_original_result_end_and_two_byte_bound(self):
        self.assertTrue(hasattr(c.NativeKernelPort,'read_proxy_frame'),'no PROXY v2 FD4 reader (E4)')
        pending=bytearray();reads=[];result=object()
        def consume(fd,n):
            part=bytes(pending[:n]);del pending[:n];reads.append(fd);return part
        b=types.SimpleNamespace(monotonic=lambda:0,select=lambda r,w,e,t:(r,[],[]),
                                os=types.SimpleNamespace(read=consume))
        k=c.NativeKernelPort(b);owned=c.NativeOwned(204,RUN,'PROXY',object(),result)
        k._owned[owned]={'terminal':None}
        def read(data):
            pending[:]=data;reads.clear()
            return k.read_proxy_frame(owned,100)
        self.assertEqual(read(b'\x00\x03abc'),b'\x00\x03abc');self.assertTrue(all(fd is result for fd in reads))
        for bad,code in ((b'\x00\x00',"FRAME_DENIED"),(b'\x40\x01',"FRAME_DENIED"),(b'',"CHANNEL_EOF")):
            with self.subTest(bad=bad),self.assertRaisesRegex(c.ConfinementError,'^'+code+'$'):read(bad)
        browser=c.NativeOwned(202,RUN,'BROWSER',object(),object());k._owned[browser]={'terminal':None}
        with self.assertRaisesRegex(c.ConfinementError,'^CHANNEL_DENIED$'):k.read_proxy_frame(browser,100)

    def test_runtime_wire_row_rejects_non_proxy_kinds_above_fd4(self):
        # compB M-2 (validator_laxity.py) and the T10 Python/Swift divergences
        # (runtime_row_divergence.py), exported unchanged for the Swift twin.
        base=composition_role_runtime();handoffs=role_handoffs()
        for row,handoff in zip(base,handoffs):
            self.assertEqual(c.validate_runtime_observation(row,handoff,row['lifecycle']),row)
        vectors=runtime_row_divergence_vectors(base)
        self.assertEqual([v['id'] for v in vectors],list(RUNTIME_ROW_VECTOR_IDS))
        for vector in vectors:
            with self.subTest(vector=vector['id']):
                changed=[index for index,row in enumerate(vector['roleRuntime']) if row!=base[index]]
                self.assertEqual(len(changed),1)
                index=changed[0];row=vector['roleRuntime'][index];handoff=handoffs[index]
                if vector['originals']=='SELF':
                    with self.assertRaisesRegex(c.ConfinementError,'^'+vector['code']+'$'):
                        c.validate_runtime_observation(row,handoff,row['lifecycle'])
                    with self.assertRaisesRegex(c.ConfinementError,'^'+vector['code']+'$'):
                        c.runtime_rows(row,row['role'],row['lifecycle'])
                    continue
                # Structurally valid: only the retained original comparison rejects it.
                self.assertIn('originals',inspect.signature(c.validate_runtime_observation).parameters)
                self.assertEqual(c.validate_runtime_observation(row,handoff,row['lifecycle']),row)
                self.assertEqual(c.validate_runtime_observation(row,handoff,row['lifecycle'],originals=row),row)
                with self.assertRaisesRegex(c.ConfinementError,'^'+vector['code']+'$'):
                    c.validate_runtime_observation(row,handoff,row['lifecycle'],originals=base[index])

    def test_v1_current_event_source_cannot_be_replaced(self):
        roles,k,budget,proof,writes,init=self.setup_roles();owner=roles.prepare_browser(proof)
        roles._source.require_current=lambda:dict(**proof,eventCheckpoint=dict(binding=roles.binding.to_record(),generation=1,sequence=2,sourceIdentity='0'*32,lostCount=0))
        with self.assertRaises(c.ConfinementError):roles.commit_browser(owner)
        self.assertEqual([v['action'] for _,v in writes if 'action' in v],['PREPARE'])

    def test_v1_inspect_uses_registered_current_lifecycle(self):
        k,h,b=self.runtime(extra=False);owner=object()
        k.bind_runtime_owner(h,'SERVICE',owner,'1'*32,'2'*32,1)
        self.assertFalse(k.inspect(300)['waiting'])

    def test_v1_controller_boolean_sequence_cannot_prepare(self):
        roles,k,budget,proof,writes,init=self.setup_roles()
        original=k.read_role
        def boolean_sequence(owned,limit):
            value=json.loads(original(owned,limit)[4:]);value['payload']['requestSequence']=True;value.pop('mac')
            value['mac']=hmac.new(bytes.fromhex(init['BROWSER']['channelKeyHex']),b'acceptance:bootstrap-composition:v1\0BROWSER:TO_BOOTSTRAP\0'+v1_bytes(value)[4:],hashlib.sha256).hexdigest()
            return v1_bytes(value)
        k.read_role=boolean_sequence
        with self.assertRaises(c.ConfinementError):roles.prepare_browser(proof)

    def test_v1_read_eof_clamps_original_cleanup_budget(self):
        roles,k,budget,proof,writes,init=self.setup_roles();k.read_role=lambda owned,limit:b''
        with self.assertRaises(c.ConfinementError):roles.prepare_browser(proof)
        self.assertEqual(budget.remaining(),0)

    def test_v1_malformed_prepare_terminally_consumes_original_owner(self):
        roles,k,budget,proof,writes,init=self.setup_roles()
        with self.assertRaises(c.ConfinementError) as raised:roles.prepare_browser(dict(proof,extra=True))
        self.assertIs(raised.exception.cleanup,roles)
        self.assertIsNotNone(budget.deadline)
        with self.assertRaises(c.ConfinementError):roles.prepare_browser(proof)
        self.assertFalse(any(v.get('action')=='PREPARE' for _,v in writes))

    def test_v1_cancel_eof_retains_owner_and_nonblocking_shared_cleanup(self):
        for native_error,delivered in ((False,None),(True,None),(False,223),(True,223)):
            with self.subTest(native_error=native_error,delivered=delivered):
                roles,k,budget,proof,writes,init=self.setup_roles();owner=roles.prepare_browser(proof);allowances=[]
                def eof(*args):
                    if native_error:raise c.ConfinementError('CHANNEL_EOF')
                    return b''
                k.read_role=eof
                k.stop_owned=lambda owned,ms:allowances.append(ms) or dict(status='TIMEOUT',pid=owned.pid,run_id=RUN)
                with self.assertRaisesRegex(c.ConfinementError,'CHANNEL_EOF') as raised:roles.cancel(delivered)
                self.assertIs(raised.exception.cleanup,owner);self.assertEqual(budget.remaining(),0)
                self.assertEqual(owner.stop_owned(60000)['status'],'TIMEOUT')
                self.assertEqual(allowances,[0]*4);budget.clock.mono+=1
                self.assertEqual(owner.stop_owned(60000)['status'],'TIMEOUT');self.assertEqual(allowances,[0]*8)

    def test_v1_python_clock_loss_keeps_original_nonblocking_cleanup(self):
        for fault in ('wall','mono','throw','shape'):
            with self.subTest(fault=fault):
                roles,k,budget,proof,writes,init=self.setup_roles();owner=roles.prepare_browser(proof);allowances=[]
                if fault in ('wall','mono'):setattr(budget.clock,fault,99)
                elif fault=='shape':budget.clock.sample=lambda:[]
                else:
                    def failed_clock():raise OSError('inert clock failure')
                    budget.clock.sample=failed_clock
                with self.assertRaises(c.ConfinementError) as raised:roles.commit_browser(owner)
                self.assertIs(raised.exception.cleanup,owner);self.assertEqual(budget.deadline,0)
                budget.clock=V1Clock()
                k.stop_owned=lambda owned,ms:allowances.append(ms) or dict(status='STOPPED',pid=owned.pid,run_id=RUN)
                self.assertEqual(owner.stop_owned(60000)['status'],'STOPPED');self.assertEqual(allowances,[0]*4)
                self.assertEqual(owner.stop_owned(60000)['status'],'STOPPED');self.assertEqual(allowances,[0]*4)
                with self.assertRaises(c.ConfinementError):roles.commit_browser(owner)

    def test_v1_original_wait_and_stop_reserve_atomically(self):
        for second_wait in (True,False):
            with self.subTest(second_wait=second_wait):
                roles,k,budget,proof,writes,init=self.setup_roles()
                lines,start=inspect.getsourcelines(c.OriginalRoleSet._stop_one)
                pause_line=start+next(i for i,line in enumerate(lines) if 'self._busy.add(id(owned))' in line)
                paused=threading.Event();resume=threading.Event();entered=threading.Event();overlap=threading.Event();release=threading.Event();second_started=threading.Event()
                guard=threading.Lock();active=0;peak=0;outcomes=[]
                def trace(frame,event,arg):
                    if frame.f_code is c.OriginalRoleSet._stop_one.__code__ and event=='line' and frame.f_lineno==pause_line:
                        paused.set();resume.wait(2)
                    return trace
                def callback(owned,ms):
                    nonlocal active,peak
                    if owned.role!='BROWSER':return dict(status='STOPPED',pid=owned.pid,run_id=RUN)
                    with guard:
                        active+=1;peak=max(peak,active)
                        if active==2:overlap.set()
                    entered.set();release.wait(2)
                    with guard:active-=1
                    return dict(status='EXITED',pid=owned.pid,run_id=RUN)
                k.wait_owned=callback;k.stop_owned=callback
                def invoke(first):
                    if first:sys.settrace(trace)
                    else:second_started.set()
                    try:outcomes.append(roles.wait_exit('BROWSER',100) if first or second_wait else roles.stop_owned(100))
                    except c.ConfinementError as error:outcomes.append(str(error))
                    finally:sys.settrace(None)
                first=threading.Thread(target=invoke,args=(True,));second=threading.Thread(target=invoke,args=(False,));first.start()
                try:
                    self.assertTrue(paused.wait(1));second.start();self.assertTrue(second_started.wait(1))
                    entered.wait(.05);resume.set();self.assertTrue(entered.wait(1));overlap.wait(.1)
                finally:
                    resume.set();release.set();first.join(2)
                    if second.ident is not None:second.join(2)
                self.assertFalse(first.is_alive());self.assertFalse(second.is_alive());self.assertEqual(peak,1)
                self.assertTrue('CLEANUP_UNCERTAIN' in outcomes or any(isinstance(v,dict) and v['status']=='TIMEOUT' for v in outcomes))
                self.assertEqual(budget.deadline,60100)

    def test_v1_cancel_at_each_forwarding_boundary_denies_commit(self):
        for action in ('PREPARE','COMMIT','CURRENT'):
            roles,k,budget,proof,writes,init=self.setup_roles();write=k.write_role
            def cancel_after_write(owned,data):
                write(owned,data)
                if json.loads(data[4:]).get('action')==action:roles._terminal=True
            k.write_role=cancel_after_write
            with self.subTest(action=action),self.assertRaises(c.ConfinementError):roles.commit_browser(roles.prepare_browser(proof))
            self.assertEqual(roles.stop_owned(25)['status'],'STOPPED')

    def test_v1_bound_role_set_cannot_start_original_config_twice(self):
        roles,k,budget,proof,writes,init=self.setup_roles()
        with self.assertRaises(c.ConfinementError):c.bind_original_roles(roles._config,roles.binding,budget)
        self.assertEqual(len(k.children),4)

    def test_v1_partial_start_pending_stop_is_never_overlapped(self):
        import threading
        k=Kernel(fail_spawn='BROWSER');budget=V1Budget();entered=threading.Event();release=threading.Event();calls=[];threads=[]
        def stop(owned,ms):
            calls.append(owned);entered.set();release.wait(1)
            return {'status':'STOPPED','pid':owned.pid,'run_id':RUN}
        def timed_call(op):
            thread=threading.Thread(target=lambda:op(1));threads.append(thread);thread.start();entered.wait(1)
            raise TimeoutError('inert waiter expires; callback remains alive')
        k.stop_owned=stop;budget.call=timed_call
        try:
            with self.assertRaises(c.ConfinementError) as failed:c.bind_original_roles(ConfinementTests().config(k),c.CompositionBinding(1,RUN,'b'*64,'c'*64,'d'*64,1,10000),budget)
            self.assertEqual(failed.exception.cleanup.stop_owned(1)['status'],'TIMEOUT')
            self.assertEqual(len(calls),1,'the original stop callback is still pending')
        finally:
            release.set()
            for thread in threads:thread.join(1)

    def test_v1_browser_runtime_transition_requires_original_completed_commit(self):
        roles,k,budget,proof,writes,init=self.setup_roles();owner=roles.prepare_browser(proof)
        self.assertFalse(getattr(owner,'_committed',False))
        roles.commit_browser(owner)
        self.assertTrue(getattr(owner,'_committed',False),'STARTED must retain the sole authorized browser lifecycle transition')

    def test_v1_native_zero_budget_only_polls_original_owner(self):
        b=InertBindings();k=c.NativeKernelPort(b);owned=c.NativeOwned(201,RUN,'BROWSER',20,21)
        k._owned[owned]={'outer':100,'terminal':None,'stop':22,'ready':23}
        b.os.write=lambda fd,data:len(data)
        b.os.waitpid=lambda pid,flags:(0,0)
        try:result=k.stop_owned(owned,0)
        except c.ConfinementError as error:self.fail('nonblocking original cleanup unavailable: '+str(error))
        self.assertEqual(result['status'],'TIMEOUT');self.assertEqual(b.clock,0)

    def test_v1_native_eof_is_not_a_fresh_cleanup_window(self):
        roles,k,budget,proof,writes,init=self.setup_roles()
        def eof(owned,limit):raise c.ConfinementError('CHANNEL_EOF')
        k.read_role=eof
        with self.assertRaises(c.ConfinementError):roles.prepare_browser(proof)
        self.assertEqual(budget.remaining(),0)

    def test_v1_failed_preparation_starts_shared_budget_before_late_cleanup(self):
        roles,k,budget,proof,writes,init=self.setup_roles()
        def fail(owned,limit):raise c.ConfinementError('AUTHORITY_LOST')
        k.read_role=fail
        with self.assertRaises(c.ConfinementError):roles.prepare_browser(proof)
        self.assertEqual(budget.deadline,60100)
        budget.clock.mono=70000
        self.assertEqual(budget.remaining(),0)

def composition_role_runtime():
    """The exported composition fixture's four roleRuntime rows (topology_test exporter)."""
    runtime=[]
    for index,role in enumerate(('CONTROLLER','BROWSER','VERIFIER','PROXY')):
        rows=[dict(fd=fd,kind='NULL' if fd<3 else 'COMMAND' if fd==3 else 'RESULT',
                   device='1',inode=str(100+index*10+fd),flags=1 if fd==4 else 0,
                   ownerId=('%x'%(index*5+fd+1))[-1]*32,acquiredGeneration=1) for fd in range(5)]
        if role=='PROXY':
            rows.append(dict(fd=5,kind='PROXY_LISTENER',device='1',inode='999',flags=0,
                             ownerId='9'*32,acquiredGeneration=1))
        runtime.append(dict(role=role,childId=('%x'%(index+1))*32,pipeId=('%x'%(index+5))*32,
            lifecycle='SERVICE' if role in ('CONTROLLER','PROXY') else 'WAITING',
            inheritedFDs=[0,1,2,3,4],currentFDs=rows))
    return runtime


RUNTIME_ROW_VECTOR_IDS=('controller_null_command_above_fd4','proxy_null_result_above_fd4',
    'proxy_command_above_fd4','vsock_without_accepted','connect_selector_without_accepted',
    'duplicate_device_inode','selector_aliases_socket','waiting_role_extra_fd','differs_from_originals')


def runtime_row_divergence_vectors(base):
    """Shared Python/Swift runtime-row divergence vectors (compB M-2, T10 review).

    Each changes exactly one role row of `base`. originals SELF: rejected against
    itself (a structural fault); FIXTURE: structurally valid, rejected only because
    it differs from the retained original. `code` is the Python failure.
    """
    import copy
    def extra(fd,kind,device,inode):
        return dict(fd=fd,kind=kind,device=device,inode=inode,flags=0,
                    ownerId='%032x'%(0xe0+fd),acquiredGeneration=1)
    def vector(identifier,index,rows=(),originals='SELF',code='FD_DENIED',change=None):
        runtime=copy.deepcopy(base)
        runtime[index]['currentFDs'].extend(rows)
        if change: change(runtime[index])
        return dict(id=identifier,code=code,originals=originals,roleRuntime=runtime)
    def listener_inode(row):row['currentFDs'][5]['inode']='998'
    return [
        vector('controller_null_command_above_fd4',0,(extra(9,'NULL','1','909'),extra(10,'COMMAND','1','910'))),
        vector('proxy_null_result_above_fd4',3,(extra(9,'NULL','1','909'),extra(11,'RESULT','1','911'))),
        vector('proxy_command_above_fd4',3,(extra(6,'COMMAND','1','906'),)),
        vector('vsock_without_accepted',3,(extra(6,'PROXY_VSOCK_STREAM','1','906'),)),
        vector('connect_selector_without_accepted',3,(extra(6,'PROXY_CONNECT_SELECTOR','16','1066'),)),
        vector('duplicate_device_inode',3,(extra(6,'PROXY_ACCEPTED_STREAM','1','999'),)),
        vector('selector_aliases_socket',3,(extra(6,'PROXY_STOP_SELECTOR','1','999'),)),
        vector('waiting_role_extra_fd',1,(extra(5,'PROXY_LISTENER','1','905'),),
               code='NATIVE_CURRENT_INVENTORY_UNAVAILABLE'),
        vector('differs_from_originals',3,originals='FIXTURE',change=listener_inode),
    ]


def role_handoffs():
    """One RoleHandoff per fixed role; only the launch role and type matter to the wire checks."""
    legacy=ConfinementTests();handoffs=[]
    for index,role in enumerate(c.UIDS):
        launch=c.prepare_role(role,c.RoleConfig(legacy.config(),c.role_fds(role,RUN)))
        attestation=c.RoleAttestation(**dict(pid=401+index,run_id=RUN,role=role,uids=(launch.uid,)*3,
            gids=(launch.uid,)*3,groups=(),capabilities=(0,)*5,no_new_privs=1,seccomp=2,
            filter_digest=hashlib.sha256(c.filter_bytes(launch.filter)).hexdigest(),fds=launch.fds,
            views=launch.views,waiting=True,programs=launch.programs))
        handoffs.append(c.RoleHandoff(launch,attestation,object(),c.NativeOwned(401+index,RUN,role,object(),object())))
    return tuple(handoffs)


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('acceptance_confinement', ROOT / 'guest/confinement.py')
c = None
if Path(spec.origin).exists():
    c = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = c
    spec.loader.exec_module(c)

RUN = 'a' * 32
ALLOW, DENY, KILL = 0x7fff0000, 0x00050001, 0x80000000


def evaluate(program, nr, args=(), arch=0xc00000b7):
    """Independent finite classic-BPF interpreter; no production policy helper.

    Linux seccomp_data: int nr @0, u32 arch @4, u64 ip @8, args @16.
    Only documented emitted instructions are admitted; malformed jumps fail.
    """
    data = struct.pack('<iIQ6Q', nr, arch, 0, *(tuple(args) + (0,) * (6-len(args))))
    a = 0
    pc = 0
    for _ in range(4096):
        if not 0 <= pc < len(program):
            raise AssertionError('filter has no return or an invalid jump')
        code, jt, jf, k = program[pc]
        if code == 0x20:
            if k % 4 or k > 60: raise AssertionError('invalid seccomp data load')
            a = struct.unpack_from('<I', data, k)[0]
        elif code == 0x15: pc += jt if a == k else jf
        elif code == 0x54: a &= k
        elif code == 0x06: return k
        else: raise AssertionError('unsupported BPF instruction')
        pc += 1
    raise AssertionError('unbounded filter')


class ExecBoundary(BaseException):
    pass


class InertBindings:
    """No host imports/calls. Sentinel names deliberately are not Linux numbers."""
    def __init__(self):
        self.calls=[]; self.clock=0; self.answer=0
        def record(name):
            def call(*args):
                self.calls.append((name,args))
                if name=='waitpid': return (0,0)
                if name=='getpid': return 201
            return call
        self.os=types.SimpleNamespace(**{n:record(n) for n in
            ('waitpid','waitstatus_to_exitcode','kill','execve','close','dup2','set_inheritable','getpid','setsid')},WNOHANG=object())
        self.signal=types.SimpleNamespace(SIGKILL=object())
        self.resource=types.SimpleNamespace(RLIMIT_CORE=object(),RLIMIT_NOFILE=object(),setrlimit=record('setrlimit'))
        self.syscall=self.invoke
        self.monotonic=lambda:self.clock
        self.sleep=self.advance
    def invoke(self,nr,*args): self.calls.append((nr,args)); return self.answer
    def advance(self,seconds): self.clock+=seconds


def helper_branch(launch,fault,cleanup='reaped',install=None):
    """Run real helper control flow over finite inert process/pipe effects.

    Fixed original child701, foreign999. No real fork, signal, FD or wait.
    Faults happen before the named effect. An exit sentinel ends simulation.
    fault 'foreign-pid': the helper's wait loop sees foreign999; 'bad-frame':
    the stop pipe yields a non-STOP frame; cleanup 'foreign': the post-signal
    wait sees foreign999. install(b,events), if given, adds recorders to the
    bindings before the run and may return the bindings object the port uses.
    """
    b=InertBindings(); events=[]; failed=False; signalled=False
    pairs=iter(((20,21),(22,23),(24,25),(26,27))); forks=iter((0,701))
    def fail_once(stage):
        nonlocal failed
        if fault==stage and not failed:
            failed=True
            if stage=='lost-child': raise ChildProcessError('inert ownership lost')
            raise OSError('inert '+stage+' fault')
    def syscall(nr,*args): events.append(('syscall',nr,args)); fail_once('before-inner')
    def fork():
        value=next(forks)
        if value==701: fail_once('inner-fork')
        events.append(('fork',value)); return value
    def close(fd):
        if fd==19: fail_once('pin-close')
    def setup(fd,blocking): events.append(('setup',fd,blocking)); fail_once('stop-setup')
    def select(read,write,error,timeout):
        events.append(('select',tuple(read),timeout)); fail_once('stop-select'); return ([24],[],[])
    def read(fd,size):
        events.append(('read',fd,size)); fail_once('stop-read')
        return b'HALT' if fault=='bad-frame' else b'STOP'
    def kill(pid,sig):
        nonlocal signalled
        events.append(('kill',pid,sig)); signalled=True
        if cleanup=='kill-error': raise OSError('inert kill failure')
        if cleanup=='kill-unexpected': raise RuntimeError('inert interrupted kill boundary')
    def wait(pid,flags):
        events.append(('waitpid',pid,flags))
        if flags is not b.os.WNOHANG: raise AssertionError('helper wait must remain bounded/nonblocking')
        fail_once('wait'); fail_once('lost-child')
        if fault=='natural-exit': return (701,0)
        if fault=='foreign-pid' and not signalled: return (999,0)
        if signalled:
            if cleanup=='reaped': return (701,0)
            if cleanup=='lost-child': raise ChildProcessError('inert cleanup ownership lost')
            if cleanup=='wait-error': raise OSError('inert cleanup wait failure')
            if cleanup=='foreign': return (999,0)
        return (0,0)
    def leave(code):
        # Real _exit cannot return/throw. Record only its first semantic exit;
        # the sentinel may traverse broad handlers while ending this simulation.
        if not any(e[0]=='exit' for e in events): events.append(('exit',code))
        raise ExecBoundary()
    b.check_appliance=lambda:None; b.pin_programs=lambda pins:{c.NODE:19}
    b.os.pipe2=lambda flags:next(pairs); b.os.fork=fork; b.os.close=close
    b.os.set_blocking=setup; b.os.read=read; b.os.kill=kill; b.os.waitpid=wait; b.os._exit=leave
    b.syscall=syscall; b.select=select
    port=install(b,events) if install is not None else None
    try: c.NativeKernelPort(b if port is None else port).spawn_waiting(launch,lambda port:None)
    except ExecBoundary: pass
    return b,events


class StrictSurface:
    """Test-only proxy. While state['armed'], every attribute read or write through it is appended to log as a
    dotted name BEFORE it is resolved, so a missing attribute is recorded too and the caller's broad exception
    handler cannot hide it. Namespace and module attributes are wrapped the same way; other values are returned
    unwrapped (any call needs an attribute read first). Unarmed, it only forwards."""
    def __init__(self,target,name,log,state):
        object.__setattr__(self,'_surface',(target,name,log,state))
    def __getattr__(self,attr):
        target,name,log,state=object.__getattribute__(self,'_surface')
        dotted=name+'.'+attr
        if state['armed']: log.append(dotted)
        value=getattr(target,attr)
        if isinstance(value,(types.SimpleNamespace,types.ModuleType)): return StrictSurface(value,dotted,log,state)
        return value
    def __setattr__(self,attr,value):
        target,name,log,state=object.__getattribute__(self,'_surface')
        if state['armed']: log.append(name+'.'+attr+'=')
        setattr(target,attr,value)


# K5 (Task 8b, fix round 1): the exact binding surface the outer helper may touch from its inner fork call until
# its _exit, derived from guest/confinement.py NativeKernelPort.spawn_waiting (outer-helper branch after
# `inner=b.os.fork()`, reap_inner, the except BaseException handler and the final _exit; file:line in the Task 8b
# report). None of these takes a path.
OUTER_HELPER_POST_FORK = frozenset({
    'b.os', 'b.os.close', 'b.os.set_blocking', 'b.os.waitpid', 'b.os.WNOHANG', 'b.os.read', 'b.os.kill',
    'b.os._exit', 'b.signal', 'b.signal.SIGKILL', 'b.select', 'b.monotonic', 'b.sleep'})
# Every helper_branch fault and cleanup mode; together they reach each helper error branch.
HELPER_FAULTS = ('before-inner', 'inner-fork', 'pin-close', 'stop-setup', 'stop-select', 'stop-read', 'wait',
                 'lost-child', 'foreign-pid', 'bad-frame', 'natural-exit', 'STOP')
HELPER_CLEANUPS = ('reaped', 'timeout', 'kill-error', 'kill-unexpected', 'wait-error', 'lost-child', 'foreign')
# Builtins confinement.py could name to reach a path or load code without going through its bindings.
PATH_BUILTINS = ('open', '__import__', 'exec', 'eval', 'compile')


class Kernel:
    """Finite effect double, NOT a confinement implementation or a native adapter.

    It records supplied kernel operations; the production filter and independent
    interpreter determine syscall results. It cannot open sockets, fork or exec.
    """
    def __init__(self, tsync=0, drift=None, fail_spawn=None):
        self.tsync = tsync
        self.drift = drift or {}
        self.fail_spawn = fail_spawn
        self.children = {}
        self.stopped = []
        self.next_pid = 200

    def spawn_waiting(self, launch, entry):
        if launch.role == self.fail_spawn: raise RuntimeError('finite spawn failure')
        self.next_pid += 1
        child = ChildKernel(self, self.next_pid, launch)
        self.children[child.pid] = child
        try:
            entry(child)
        except ExecBoundary:
            return child.owned
        except c.ConfinementError:
            raise c.RoleStartFailure(child.owned) from None
        raise AssertionError('exec must not return')

    def inspect(self, pid): return dict(self.children[pid].facts, **self.drift)
    def stop_owned(self, owned, deadline):
        if owned is not self.children[owned.pid].owned: raise AssertionError('foreign child')
        self.stopped.append(owned.pid)
        return {'status': 'STOPPED', 'pid': owned.pid, 'run_id': RUN}
    def wait_owned(self, owned, deadline):
        if owned is not self.children[owned.pid].owned: raise AssertionError('foreign child')
        return {'status': 'EXITED', 'pid': owned.pid, 'run_id': RUN}


class ChildKernel:
    def __init__(self, parent, pid, launch):
        self.parent, self.pid, self.launch = parent, pid, launch
        self.events = []
        self.owned = types.SimpleNamespace(pid=pid, run_id=RUN, role=launch.role,
                                           command=object(), result=object())
        self.facts = {'pid': pid, 'run_id': RUN, 'role': launch.role,
                      'uids': (0, 0, 0), 'gids': (0, 0, 0), 'groups': (0,),
                      'capabilities': (1, 1, 1, 1, 1), 'no_new_privs': 0,
                      'seccomp': 0, 'filter_digest': '', 'fds': (),
                      'views': None, 'waiting': False, 'programs': launch.programs}
    def establish_views(self, views):
        self.events.append('views'); self.facts['views'] = views
    def close_unaudited_fds(self, fds):
        self.events.append('fds'); self.facts['fds'] = fds
    def drop_credentials(self, uid, gid):
        self.events.append('credentials'); self.facts.update(uids=(uid,)*3, gids=(gid,)*3, groups=())
    def clear_capabilities(self):
        self.events.append('caps'); self.facts['capabilities'] = (0,)*5
    def inspect_programs(self):
        data = (('node/bin/node', b'synthetic-node'), ('python/bin/python3', b'synthetic-python'),
                ('chromium/chrome', b'synthetic-chrome'))
        runtime = tuple(c.ProgramPin('/opt/acceptance/runtime/'+p,hashlib.sha256(v).hexdigest()) for p,v in data)
        workers = tuple(c.ProgramPin('/opt/acceptance/guest/'+p,hashlib.sha256(v).hexdigest()) for p,v in (
            ('controller.cjs', b'controller'), ('browser-worker.cjs', b'browser'),
            ('verifier.cjs', b'verifier'), ('proxy.py', b'proxy')))
        return runtime+workers
    def no_new_privs(self):
        self.events.append('nnp'); self.facts['no_new_privs'] = 1
    def install_seccomp(self, program, flags):
        self.events.append(('filter', flags))
        if self.parent.tsync == 0:
            self.facts.update(seccomp=2, filter_digest=hashlib.sha256(b''.join(struct.pack('<HBBI', *i) for i in program)).hexdigest())
        return self.parent.tsync
    def inspect(self): return dict(self.facts, **self.parent.drift)
    def exec_pinned(self, argv, programs):
        self.events.append(('exec', argv, programs)); self.facts['waiting'] = True
        raise ExecBoundary()


class ConfinementTests(unittest.TestCase):
    def test_v1_ipv4_ipv6_descendant_catalogue_and_pinned_paths(self):
        s=importlib.util.spec_from_file_location('task5_descendant_probe',ROOT/'tests/guest/confinement_probe.py')
        probe=importlib.util.module_from_spec(s); s.loader.exec_module(probe)
        for family in ('IPV4','IPV6'):
            name='child_fork_exec_network_gpu_crash_helper_'+family.lower()
            expected=tuple('BROWSER.'+position+'.socket-'+family+'-TCP' for position in
                ('parent','fork','exec','network','gpu','crash'))+tuple(
                role+'.helper.socket-'+family+'-TCP' for role in ('CONTROLLER','VERIFIER'))
            self.assertEqual(getattr(probe.PROBES.get(name),'operations',()),expected)
            for position,sample in (('exec','exec'),('helper','exec'),('network','chromium-network'),
                                    ('gpu','chromium-gpu'),('crash','chromium-crash')):
                helper=position+'.socket-'+family+'-TCP'
                self.assertEqual(probe.HELPER_SAMPLES[helper],sample+'-'+family.lower())

    def api(self):
        self.assertIsNotNone(c, 'Task 8 confinement behavior is absent')
        return c
    def config(self, kernel=None, **changes):
        m = self.api()
        # Synthetic pins from literal bytes; no upstream executable is loaded.
        programs = tuple(m.ProgramPin(path, hashlib.sha256(data).hexdigest()) for path, data in (
            ('/opt/acceptance/runtime/node/bin/node', b'synthetic-node'),
            ('/opt/acceptance/runtime/python/bin/python3', b'synthetic-python'),
            ('/opt/acceptance/runtime/chromium/chrome', b'synthetic-chrome'),
            ('/opt/acceptance/guest/controller.cjs', b'controller'),
            ('/opt/acceptance/guest/browser-worker.cjs', b'browser'),
            ('/opt/acceptance/guest/verifier.cjs', b'verifier'),
            ('/opt/acceptance/guest/proxy.py', b'proxy')))
        return m.BootstrapConfig(kernel or Kernel(), RUN, programs, **changes)
    def observed_native(self,drift=None):
        b=InertBindings(); launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        base='/proc/300'; readonly=('opt','usr','lib','lib64','etc')
        files={base+'/status':b'Uid:\t10002 10002 10002 10002\nGid:\t10002 10002 10002 10002\nGroups:\nCapEff:\t0\nCapPrm:\t0\nCapInh:\t0\nCapAmb:\t0\nCapBnd:\t0\nNoNewPrivs:\t1\nSeccomp:\t2\n',
               base+'/fdinfo/3':b'flags:\t00\n',base+'/fdinfo/4':b'flags:\t01\n',
               base+'/cmdline':b'/opt/acceptance/runtime/node/bin/node\0/opt/acceptance/guest/browser-worker.cjs\0--inherited\0'}
        mounts=''.join('1 0 0:1 / /'+d+' '+('rw' if drift=='readonly' and d=='opt' else 'ro')+' - ext4 base ro\n' for d in readonly)
        mounts+=''.join('1 0 0:2 / /'+d+' rw - '+('ext4' if drift=='tmpfs' else 'tmpfs')+' base rw\n' for d in ('tmp','var','run/acceptance/browser','dev/shm'))
        files[base+'/mountinfo']=mounts.encode()
        b.read_file=lambda path,*a:files[path]; b.run_device=2
        b.os.listdir=lambda path:['0','1','2','3','4'] if path==base+'/fd' else ['null','shm'] if path==base+'/root/dev' else ['browser']
        def link(path):
            if '/fd/' in path: return '/dev/null' if path[-1] in '012' else 'pipe:[30]' if path[-1]=='3' else 'pipe:[40]'
            return ('user:[1]' if path.endswith('/user') else ('pid:[1]' if path.startswith('/proc/self') else 'pid:[20]') if path.endswith('/pid') else ('mnt:[1]' if path.startswith('/proc/self') else 'mnt:[20]'))
        b.os.readlink=link
        b.os.stat=lambda path:types.SimpleNamespace(st_dev=1 if path.endswith('/exe') or path.endswith('/root') or path.endswith('/.root') else 2,
            st_ino=999 if path.endswith('/exe') else 555,st_mode=0o700,st_uid=10002,st_gid=10002)
        k=c.NativeKernelPort(b); owned=c.NativeOwned(300,RUN,'BROWSER',object(),object())
        k._owned[owned]={'outer':200,'child':300,'terminal':None,'launch':launch,'digest':'e'*64,
            'links':('pipe:[30]','pipe:[40]'),'exec_identity':(1,777)}
        return k
    def test_R1_native_live_readonly_or_tmpfs_drift_denies_attestation(self):
        for drift in ('readonly','tmpfs'):
            with self.subTest(drift=drift), self.assertRaisesRegex(c.ConfinementError,'VIEW_DENIED'):
                self.observed_native(drift).inspect(300)
    def test_R1_native_actual_executable_inode_must_match_held_pin(self):
        with self.assertRaisesRegex(c.ConfinementError,'PROGRAM_DENIED'): self.observed_native().inspect(300)
    def test_R1_native_observation_conforms_to_public_KernelPort_fact_shape(self):
        k=self.observed_native()
        next(iter(k._owned.values()))['exec_identity']=(1,999)
        a=c.inspect_role(300,kernel=k)
        self.assertEqual((a.pid,a.role,a.uids,a.capabilities,a.no_new_privs,a.seccomp),(300,'BROWSER',(10002,)*3,(0,)*5,1,2))
    def test_channel_key_derivation_vectors(self):
        # C3 vectors, computed by the plan author with Python hmac from the C3
        # string; never edited to match an implementation.
        m=self.api(); capability=bytes([7])*32
        self.assertEqual(m.derive_channel_key(capability,'vsock-stream').hex(),
            '5814c7147c97464dd6833b65cfd337b5d6f8277a080522efe9c3f7f498d54d00')
        self.assertEqual(m.derive_channel_key(capability,'topology-admission').hex(),
            '49206226671c56e90e00b0198cbeca8b32acb63e5e5c714b12989d3172cf0e49')
        for label in ('vsock','topology-admission\0','TOPOLOGY-ADMISSION','',
                      'bootstrap-composition',b'vsock-stream',None):
            with self.subTest(label=label), self.assertRaises(m.ConfinementError):
                m.derive_channel_key(capability,label)
        for bad in (bytes(31),bytes(33),b'',bytearray(32),'\x07'*32,None):
            with self.subTest(capability=bad), self.assertRaises(m.ConfinementError):
                m.derive_channel_key(bad,'vsock-stream')

    def test_vsock_browser_controller_verifier_denied(self):
        for role in ('BROWSER', 'CONTROLLER', 'VERIFIER'):
            for nr in (198, 199):
                self.assertEqual(evaluate(self.api().build_filter(role), nr, (40, 1, 0)), DENY)
    def test_child_fork_exec_network_gpu_crash_helper_inherits(self):
        h = self.api().start_roles(self.config())
        browser = h['BROWSER']
        p = browser.launch.filter
        for kind in ('parent', 'fork', 'exec', 'network', 'gpu', 'crash'):
            with self.subTest(descendant=kind):
                self.assertEqual(evaluate(p, 198, (40, 1, 0)), DENY)
        self.assertEqual(evaluate(p, 220, (17,)), ALLOW)
        self.assertEqual(evaluate(p, 221), ALLOW)
        self.assertEqual(browser.attestation.capabilities, (0,)*5)
    def test_proxy_fixed_vsock_positive(self):
        m = self.api()
        self.assertEqual(evaluate(m.build_filter('PROXY'), 198, (40, 1, 0)), ALLOW)
        self.assertEqual(m.proxy_endpoint(), (2, 4050))
        self.assertEqual(evaluate(m.build_filter('PROXY'), 199, (40, 1, 0)), DENY)
    def test_socket_domain_type_protocol_and_high_words(self):
        p = self.api().build_filter('BROWSER')
        for nr in (198,199):
            for args in ((1,1,0),(1,2,0),(1,5,0),(2,1,0),(2,2,0),(10,1,0),(10,2,0),(2,1|0x80800,0)):
                self.assertEqual(evaluate(p,nr,args),ALLOW, args)
            for args in ((17,1,0),(16,2,0),(41,1,0),(2,3,0),(1,1,99),(2,1|0x1000,0),(1<<32|1,1,0),(2,1<<32|1,0),(2,1,1<<32)):
                self.assertEqual(evaluate(p,nr,args),DENY,args)
    def test_all_nonzero_protocol_scalars_fail_closed_without_unreviewed_constants(self):
        p=self.api().build_filter('BROWSER')
        for nr in (198,199):
            for family,kind in ((1,1),(1,2),(1,5),(2,1),(2,2),(10,1),(10,2)):
                self.assertEqual(evaluate(p,nr,(family,kind,0)),ALLOW)
                for nonzero in (1,6,17,123,0xffffffff,1<<32):
                    self.assertEqual(evaluate(p,nr,(family,kind,nonzero)),DENY,(nr,family,kind,nonzero))
    def test_io_uring_setup_register_enter_and_inherited_ring_denied(self):
        for role in ('CONTROLLER','BROWSER','VERIFIER','PROXY'):
            for nr in (425,426,427):
                self.assertEqual(evaluate(self.api().build_filter(role),nr,(9,)),DENY)
        config = self.config()
        with self.assertRaises(c.ConfinementError):
            c.prepare_role('BROWSER',c.RoleConfig(config, (c.Descriptor(7,'io_uring','ring','BROWSER',RUN),)))
    def test_alternate_ABI_denied(self):
        p = self.api().build_filter('BROWSER')
        for arch in (0x40000028,0xc000003e,0,0x800000b7):
            self.assertEqual(evaluate(p,198,(1,1,0),arch),KILL)
        self.assertEqual(evaluate(p,-1),KILL)
        self.assertEqual(evaluate(p,0x400000c6,(1,1,0)),KILL)
    def test_SCM_RIGHTS_proc_pidfd_ptrace_process_vm_theft_denied(self):
        m = self.api()
        for nr in (117,270,271,438,434):
            self.assertEqual(evaluate(m.build_filter('BROWSER'),nr),DENY)
        with self.assertRaises(m.ConfinementError): m.validate_channel_message(b'fixed',((1,1,b'fd'),),0)
        with self.assertRaises(m.ConfinementError): m.validate_channel_message(b'fixed',(),8)
        browser = m.start_roles(self.config())['BROWSER']
        self.assertEqual(browser.attestation.views.visible_roles,('BROWSER',))
        self.assertFalse(browser.attestation.views.console)
        self.assertEqual(browser.attestation.views.private_mode,0o700)
    def test_privilege_gain_denied(self):
        # E1 (C6): capset, the set*id family, setgroups and chroot are allowed for BROWSER only (Chromium's
        # namespace sandbox, BrowserSandboxFilterTests); every other role still denies them. setns, mount,
        # pivot_root and mknodat stay denied for every role (R1).
        for role in ('CONTROLLER','VERIFIER','PROXY'):
            for nr in (91,146,147,144,149,159,151,152,268,40,41,51,33):
                self.assertEqual(evaluate(self.api().build_filter(role),nr),DENY,(role,nr))
        for nr in (268,40,41,33):
            self.assertEqual(evaluate(self.api().build_filter('BROWSER'),nr),DENY,nr)
        for args in ((47,2,0),(38,0),(8,1),(28,0),(22,0)):
            self.assertEqual(evaluate(c.build_filter('BROWSER'),167,args),DENY)
        for args in ((39,),(21,),(4,0),(38,1)):
            self.assertEqual(evaluate(c.build_filter('BROWSER'),167,args),ALLOW)
    def test_chromium_inner_filter_tightening_preserved_without_listener(self):
        p=self.api().build_filter('BROWSER')
        self.assertEqual(evaluate(p,167,(22,2,1234)),ALLOW)
        for args in ((1,0,1234),(1,1,1234)):
            self.assertEqual(evaluate(p,277,args),ALLOW)
        for args in ((0,0,1234),(1,8,1234),(1,9,1234),(1,16,1234),(1<<32|1,0,1234),(1,1<<32,1234)):
            self.assertEqual(evaluate(p,277,args),DENY,args)
        # An added inner policy cannot override the outer AF_VSOCK denial.
        self.assertEqual(evaluate(p,198,(40,1,0)),DENY)
    def test_no_console_or_bridge_fd(self):
        m = self.api()
        for kind in ('console','tty','vsock','bridge','socket','io_uring'):
            with self.subTest(kind=kind):
                with self.assertRaises(m.ConfinementError):
                    m.prepare_role('BROWSER',m.RoleConfig(self.config(),(m.Descriptor(3,kind,'command','CONTROLLER',RUN),)))
    def test_bootstrap_arbitrary_argv_denied(self):
        m=self.api()
        with self.assertRaises(m.ConfinementError):
            m.prepare_role('BROWSER',m.RoleConfig(self.config(),m.role_fds('BROWSER',RUN),argv=('/bin/sh','-c','echo')))
        with self.assertRaises(m.ConfinementError): m.prepare_role('ROOT',m.RoleConfig(self.config(),()))
    def test_TSYNC_failure_abort(self):
        for failure in (-1,901,True):
            k=Kernel(tsync=failure)
            with self.assertRaises(self.api().ConfinementError): c.start_roles(self.config(k))
            self.assertFalse(any(any(isinstance(e,tuple) and e[0]=='exec' for e in child.events) for child in k.children.values()))
            self.assertEqual(k.stopped,[201])
    def test_exact_fd_inventory(self):
        m=self.api()
        h=m.start_roles(self.config())
        self.assertEqual(tuple(h),('CONTROLLER','BROWSER','VERIFIER','PROXY'))
        for role,uid in (('CONTROLLER',10001),('BROWSER',10002),('VERIFIER',10003),('PROXY',10004)):
            a=h[role].attestation
            self.assertEqual(a.uids,(uid,)*3)
            self.assertEqual(a.gids,(uid,)*3)
            self.assertEqual(tuple((f.fd,f.kind,f.purpose) for f in a.fds),((0,'null','stdin'),(1,'null','stdout'),(2,'null','stderr'),(3,'pipe','command'),(4,'pipe','result')))
        k=Kernel(drift={'fds':()})
        with self.assertRaises(m.ConfinementError): m.start_roles(self.config(k))
    def test_attestation_drift_aborts_and_reaps_only_owned_children(self):
        m=self.api()
        for drift in ({'uids':(0,0,0)},{'capabilities':(0,0,0,1,0)},{'no_new_privs':0},{'seccomp':0},{'run_id':'b'*32},{'filter_digest':'0'*64}):
            k=Kernel(drift=drift)
            with self.assertRaises(m.ConfinementError): m.start_roles(self.config(k))
            self.assertEqual(k.stopped,[201])
        k=Kernel(fail_spawn='VERIFIER')
        with self.assertRaises(m.ConfinementError): m.start_roles(self.config(k))
        self.assertEqual(k.stopped,[202,201])
    def test_exec_order_and_fixed_hash_identity(self):
        m=self.api(); k=Kernel(); h=m.start_roles(self.config(k))
        for child in k.children.values():
            self.assertEqual(child.events[:6],['views','fds','credentials','caps','nnp',('filter',1)])
            self.assertEqual(child.events[-1][0],'exec')
            self.assertEqual(child.events[-1][1][-1],'--inherited')
        self.assertEqual(h['BROWSER'].launch.argv,('/opt/acceptance/runtime/node/bin/node','/opt/acceptance/guest/browser-worker.cjs','--inherited'))
        bad=dataclasses.replace(self.config(),programs=())
        with self.assertRaises(m.ConfinementError): m.start_roles(bad)
        bad=dataclasses.replace(self.config(),programs=(m.ProgramPin('/opt/acceptance/runtime/node/bin/node','0'*64),)+self.config().programs[1:])
        with self.assertRaises(m.ConfinementError): m.start_roles(bad)
    def test_exit_handle_bound_to_run_and_owned_child(self):
        m=self.api(); k=Kernel(); h=m.start_roles(self.config(k))
        self.assertEqual(h['BROWSER'].wait_exit(100),{'status':'EXITED','pid':202,'run_id':RUN})
        self.assertEqual(h['VERIFIER'].stop_owned(100),{'status':'STOPPED','pid':203,'run_id':RUN})
        with self.assertRaises(m.ConfinementError): h['BROWSER'].wait_exit(True)
        with self.assertRaises(m.ConfinementError): m.inspect_role(999,kernel=k)
    def test_no_effect_port_default(self):
        with self.assertRaises(self.api().ConfinementError): c.start_roles(dataclasses.replace(self.config(),kernel=None))
    def test_descriptor_boolean_and_view_type_confusion_denied(self):
        m=self.api(); fds=m.role_fds('BROWSER',RUN)
        bad=(fds[0],dataclasses.replace(fds[1],fd=True),*fds[2:])
        with self.assertRaises(m.ConfinementError): m.prepare_role('BROWSER',m.RoleConfig(self.config(),bad))
        k=Kernel(drift={'views':dataclasses.replace(m.RoleViews('CONTROLLER','/run/acceptance/controller',('CONTROLLER',)),console=0)})
        with self.assertRaises(m.ConfinementError): m.start_roles(self.config(k))
    def test_owned_exit_rechecks_attestation_and_sanitizes_outcomes(self):
        m=self.api(); k=Kernel(); h=m.start_roles(self.config(k))['BROWSER']
        k.drift={'uids':(0,0,0)}
        self.assertEqual(h.stop_owned(100),{'status':'STOPPED','pid':202,'run_id':RUN})
        self.assertEqual(k.stopped,[202])
        k.drift={}; k.wait_owned=lambda owned,deadline:{'status':'EXITED','pid':owned.pid,'run_id':'b'*32}
        with self.assertRaises(m.ConfinementError): h.wait_exit(100)
    def test_R2_owned_cleanup_survives_lost_live_process_facts(self):
        m=self.api(); k=Kernel(); h=m.start_roles(self.config(k))['BROWSER']
        def gone(pid): raise ProcessLookupError('owned role exited')
        k.inspect=gone
        self.assertEqual(h.wait_exit(100),{'status':'EXITED','pid':202,'run_id':RUN})
        self.assertEqual(h.stop_owned(100),{'status':'STOPPED','pid':202,'run_id':RUN})
        self.assertEqual(k.stopped,[202])
    def test_R4_duplicate_pid_identity_or_endpoint_aborts_without_double_reaping(self):
        m=self.api()
        for collision in ('pid','identity','command','result','cross-direction'):
            with self.subTest(collision=collision):
                class Colliding(Kernel):
                    def spawn_waiting(self,launch,entry):
                        owned=super().spawn_waiting(launch,entry)
                        if len(self.children)==1:
                            self.first=owned; owned.identity=object()
                        elif len(self.children)==2:
                            if collision=='pid': owned.pid=self.first.pid
                            if collision=='identity': owned.identity=self.first.identity
                            if collision=='command': owned.command=self.first.command
                            if collision=='result': owned.result=self.first.result
                            if collision=='cross-direction': owned.command=self.first.result
                        return owned
                    def stop_owned(self,owned,deadline):
                        self.stopped.append(id(owned))
                        return {'status':'STOPPED','pid':owned.pid,'run_id':RUN}
                k=Colliding()
                with self.assertRaises(m.ConfinementError): m.start_roles(self.config(k))
                self.assertEqual(len(k.stopped),len(set(k.stopped)))
                self.assertIn(id(k.first),k.stopped)
                self.assertEqual(len(k.stopped),1 if collision=='pid' else 2)
    def test_R4_uncertain_rollback_is_explicit(self):
        m=self.api(); k=Kernel(fail_spawn='VERIFIER')
        k.stop_owned=lambda owned,deadline:{'status':'TIMEOUT','pid':owned.pid,'run_id':RUN}
        with self.assertRaisesRegex(m.ConfinementError,'REAP_UNCERTAIN'): m.start_roles(self.config(k))
    def test_R4_late_owned_endpoint_mutation_is_rechecked_before_publication(self):
        class LateMutation(Kernel):
            def spawn_waiting(self,*args):
                owned=super().spawn_waiting(*args)
                if len(self.children)==1: self.first=owned
                if len(self.children)==2: self.first.command=owned.result
                return owned
        k=LateMutation()
        with self.assertRaises(c.ConfinementError): c.start_roles(self.config(k))
        self.assertEqual(k.stopped,[204,203,202,201])
    def test_R4_equal_numeric_endpoint_directions_cannot_alias_across_roles(self):
        class NumericEndpoints(Kernel):
            def spawn_waiting(self,*args):
                owned=super().spawn_waiting(*args)
                owned.command=int('512'); owned.result=int(str(1000+owned.pid))
                return owned
        with self.assertRaises(c.ConfinementError): c.start_roles(self.config(NumericEndpoints()))
    def test_R1_native_selection_requires_mode_runtime_identity_and_validation(self):
        self.assertTrue(hasattr(c,'select_native_kernel'),'required gated native KernelPort source absent')
        effect=[]
        factory=lambda identity:effect.append(identity)
        for mode,identity,validator in [('worker',object(),lambda x:x),('bootstrap-check',None,lambda x:x),
                                        ('bootstrap-check',object(),lambda x:None)]:
            with self.assertRaisesRegex(c.ConfinementError,'NATIVE_GATE_DENIED'):
                c.select_native_kernel(mode,runtime_identity=identity,validate_runtime=validator,bindings_factory=factory)
        self.assertEqual(effect,[])
    def test_R1_native_selector_rejects_boolean_or_unpinned_guest_identity(self):
        effects=[]
        for value in (True,object(),{'python':'unreviewed'}):
            with self.assertRaisesRegex(c.ConfinementError,'NATIVE_GATE_DENIED'):
                c.select_native_kernel('bootstrap-check',runtime_identity=value,validate_runtime=lambda x:x,
                    bindings_factory=lambda identity:effects.append(identity))
        self.assertEqual(effects,[])
    def test_R1_native_required_named_APIs_fail_closed_when_missing(self):
        self.assertTrue(hasattr(c,'_native_apis'),'Linux named stdlib API validation absent')
        b=InertBindings()
        b.os.path=types.SimpleNamespace(isfile=lambda path:True,lexists=lambda path:False)
        for name in ('fork','pipe2','dup','set_blocking','readlink','listdir','stat','fstat','open','read','write','makedirs','chown','chroot','chdir','getppid','rmdir','unlink','_exit'):
            setattr(b.os,name,lambda *a:None)
        c._native_apis(b.os,b.signal,b.resource)
        del b.os.WNOHANG
        with self.assertRaisesRegex(c.ConfinementError,'NATIVE_API_UNAVAILABLE'): c._native_apis(b.os,b.signal,b.resource)
    def test_R1_raw_syscall_marshalling_relocates_Linux_pointer_and_preserves_errno(self):
        self.assertTrue(hasattr(c,'LinuxBindings'),'native libc/syscall source absent')
        buffers={}; errno=[0]; calls=[]
        class Scalar:
            def __init__(self,value): self.value=value
        class Buffer:
            def __init__(self,data): self.raw=data
        def create(data,size=None):
            out=Buffer(data if size is not None else data+b'\0'); buffers[4096+len(buffers)*256]=out; return out
        def invoke(nr,*args): calls.append((nr.value,tuple(x.value for x in args))); errno[0]=1; return -1
        ct=types.SimpleNamespace(c_long=Scalar,c_ulong=Scalar,c_void_p=Scalar,create_string_buffer=create,
            addressof=lambda b:next(k for k,v in buffers.items() if v is b),set_errno=lambda n:errno.__setitem__(0,n),get_errno=lambda:errno[0])
        backend=c.LinuxBindings.__new__(c.LinuxBindings); backend._ctypes=ct; backend._libc=types.SimpleNamespace(syscall=invoke)
        header=c.NativeMemory(bytearray(b'\x01\x00'+bytes(14)),{8:c.NativeMemory(bytearray(bytes.fromhex('0600000000000080')))})
        with self.assertRaises(PermissionError) as failure: backend.syscall(277,1,1,header)
        self.assertEqual(failure.exception.errno,1)
        self.assertEqual(calls,[(277,(1,1,4352))])
        self.assertEqual(struct.unpack_from('<Q',buffers[4352].raw,8)[0],4096)
        self.assertEqual(buffers[4096].raw,bytes.fromhex('0600000000000080'))
    def test_R1_stop_retries_are_nonblocking_and_send_one_fixed_frame(self):
        b=InertBindings(); k=c.NativeKernelPort(b); owned=c.NativeOwned(201,RUN,'BROWSER',object(),object())
        k._owned[owned]={'outer':201,'stop':11,'closed':False,'terminal':None}
        b.os.write=lambda fd,data:b.calls.append(('write',(fd,data))) or 4
        k.stop_owned(owned,1); k.stop_owned(owned,1)
        self.assertEqual([x for x in b.calls if x[0]=='write'],[('write',(11,b'STOP'))])
    def test_R1_child_credentials_use_pinned_raw_ABI_and_zero_capability_layout(self):
        self.assertTrue(hasattr(c,'NativeChildPort'),'native child effects absent')
        b=InertBindings(); launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        p=c.NativeChildPort(b,launch,{})
        p.drop_credentials(10002,10002); p.clear_capabilities(); p.no_new_privs()
        raw=[x for x in b.calls if type(x[0]) is int]
        self.assertEqual(raw[:2],[(159,(0,0)),(167,(47,4,0,0,0))])
        self.assertEqual(raw[2:43],[(167,(24,n,0,0,0)) for n in range(41)])
        self.assertEqual(raw[43:45],[(149,(10002,10002,10002)),(147,(10002,10002,10002))])
        nr,args=raw[45]; self.assertEqual(nr,91)
        self.assertEqual(bytes(args[0].data),bytes.fromhex('2205082000000000'))
        self.assertEqual(bytes(args[1].data),bytes(24))
        self.assertEqual(raw[-1],(167,(38,1,0,0,0)))
    def test_R1_native_filter_uses_explicit_Linux_fprog_layout_and_preserves_TSYNC_error(self):
        self.assertTrue(hasattr(c,'NativeChildPort'),'native seccomp boundary absent')
        b=InertBindings(); launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        p=c.NativeChildPort(b,launch,{})
        program=((0x20,0,0,4),(0x06,0,0,0x80000000))
        b.answer=71; self.assertEqual(p.install_seccomp(program,1),71)
        nr,args=b.calls[-1]; self.assertEqual((nr,args[:2]),(277,(1,1)))
        fprog=args[2]; self.assertEqual(bytes(fprog.data),b'\x02\x00'+bytes(14))
        self.assertEqual(tuple(fprog.pointers), (8,))
        self.assertEqual(bytes(fprog.pointers[8].data),bytes.fromhex('20000000040000000600000000000080'))
        b.answer=-1; self.assertEqual(p.install_seccomp(program,1),-1)
    def test_R1_owned_reaping_uses_named_apis_no_live_attestation_or_recycled_pid(self):
        self.assertTrue(hasattr(c,'NativeKernelPort'),'native owned process boundary absent')
        b=InertBindings(); k=c.NativeKernelPort(b)
        owned=c.NativeOwned(201,RUN,'BROWSER',object(),object())
        k._owned[owned]= {'outer':201,'stop':11,'closed':False,'terminal':None}
        b.os.write=lambda fd,data:b.calls.append(('write',(fd,data))) or len(data)
        result=k.stop_owned(owned,2)
        self.assertEqual(result,{'status':'TIMEOUT','pid':201,'run_id':RUN})
        self.assertIn(('write',(11,b'STOP')),b.calls)
        self.assertIn(('waitpid',(201,b.os.WNOHANG)),b.calls)
        self.assertFalse(any(n=='kill' for n,_ in b.calls)) # only trusted direct-parent helper signals inner child
        foreign=c.NativeOwned(201,RUN,'BROWSER',object(),object())
        with self.assertRaisesRegex(c.ConfinementError,'EXIT_DENIED'): k.stop_owned(foreign,2)
        b.os.waitpid=lambda pid,flags:(pid,0)
        self.assertEqual(k.wait_owned(owned,2)['status'],'EXITED')
        b.os.waitpid=lambda *args: (_ for _ in ()).throw(AssertionError('recycled PID must not be waited'))
        self.assertEqual(k.stop_owned(owned,2)['status'],'EXITED')
    def test_R1_post_fork_parent_failure_preserves_owned_cleanup_state(self):
        self.assertTrue(hasattr(c,'NativeKernelPort'),'native spawn ownership source absent')
        b=InertBindings(); b.check_appliance=lambda:None; b.pin_programs=lambda pins:{c.NODE:19}
        pairs=iter(((20,21),(22,23),(24,25),(26,27)))
        b.os.pipe2=lambda flags:next(pairs); b.os.fork=lambda:501
        b.os.close=lambda fd: (_ for _ in ()).throw(OSError(9,'inert post-fork fault'))
        k=c.NativeKernelPort(b); launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        with self.assertRaises(c.RoleStartFailure) as failure: k.spawn_waiting(launch,lambda port:None)
        self.assertEqual(k._owned[failure.exception.owned]['outer'],501)
        self.assertEqual(failure.exception.owned.run_id,RUN)
    def test_R5_handled_helper_faults_stop_and_reap_original_inner_before_exit(self):
        # Break caught: handled post-fork helper errors discard original child
        # authority; cleanup must precede the sole proven-family terminal exit.
        launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        for fault in ('pin-close','stop-setup','stop-select','stop-read','wait'):
            with self.subTest(fault=fault):
                b,events=helper_branch(launch,fault)
                self.assertEqual([e for e in events if e[0]=='kill'],[('kill',701,b.signal.SIGKILL)])
                waited=[e for e in events if e[0]=='waitpid']
                self.assertTrue(waited); self.assertTrue(all(e[1]==701 and e[2] is b.os.WNOHANG for e in waited))
                self.assertEqual([e for e in events if e[0]=='exit'],[('exit',0)])
                self.assertLess(events.index(('kill',701,b.signal.SIGKILL)),events.index(('exit',0)))
    def test_R5_failed_helper_cleanup_is_bounded_and_never_claims_family_exit(self):
        launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        for cleanup in ('timeout','kill-error','kill-unexpected','wait-error','lost-child'):
            with self.subTest(cleanup=cleanup):
                b,events=helper_branch(launch,'pin-close',cleanup)
                self.assertEqual([e for e in events if e[0]=='kill'],[('kill',701,b.signal.SIGKILL)])
                self.assertTrue(any(e[0]=='waitpid' for e in events))
                self.assertEqual([e for e in events if e[0]=='exit'],[('exit',78)])
                self.assertLessEqual(b.clock,2.01)
                if cleanup=='timeout': self.assertGreaterEqual(b.clock,2)
    def test_R5_no_inner_child_or_lost_ownership_never_signals_a_pid(self):
        launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        for fault in ('before-inner','inner-fork','lost-child'):
            with self.subTest(fault=fault):
                b,events=helper_branch(launch,fault)
                self.assertFalse(any(e[0]=='kill' for e in events))
                self.assertEqual([e for e in events if e[0]=='exit'],[('exit',78)])
                if fault!='lost-child': self.assertFalse(any(e[0]=='waitpid' for e in events))
    def test_R5_STOP_reaps_nonblocking_and_natural_exit_never_resignals_recycled_identity(self):
        launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        b,events=helper_branch(launch,'STOP')
        self.assertEqual([e for e in events if e[0]=='kill'],[('kill',701,b.signal.SIGKILL)])
        self.assertEqual([e for e in events if e[0]=='exit'],[('exit',0)])
        self.assertTrue(all(e[2] is b.os.WNOHANG for e in events if e[0]=='waitpid'))
        b,events=helper_branch(launch,'natural-exit')
        self.assertFalse(any(e[0]=='kill' for e in events))
        self.assertEqual([e for e in events if e[0]=='exit'],[('exit',0)])
    def test_R1_inner_pid_is_single_observed_direct_child_not_a_racy_shared_pipe_frame(self):
        k=c.NativeKernelPort(InertBindings())
        self.assertTrue(callable(getattr(k,'_child_pid',None)),'independent owned child PID observation absent')
        paths=[]
        k.b.read_file=lambda path,limit:paths.append((path,limit)) or b'701\n'
        self.assertEqual(k._child_pid(501),701)
        self.assertEqual(paths,[('/proc/501/task/501/children',128)])
        for data in (b'',b'701 702',b'0',b'-1',b'x'):
            k.b.read_file=lambda *args,data=data:data
            with self.assertRaisesRegex(c.ConfinementError,'ROLE_START_FAILED'): k._child_pid(501)
    def test_R1_fixed_exec_uses_verified_fd_exact_argv_and_empty_environment(self):
        self.assertTrue(hasattr(c,'NativeChildPort'),'native pinned exec absent')
        b=InertBindings(); launch=c.prepare_role('VERIFIER',c.RoleConfig(self.config(),c.role_fds('VERIFIER',RUN)))
        p=c.NativeChildPort(b,launch,{c.NODE:19})
        b.os.execve=lambda fd,argv,env: (b.calls.append(('execve',(fd,argv,env))), (_ for _ in ()).throw(ExecBoundary()))[-1]
        with self.assertRaises(ExecBoundary): p.exec_pinned(launch.argv,launch.programs)
        self.assertEqual(b.calls[-1],('execve',(19,('/opt/acceptance/runtime/node/bin/node','/opt/acceptance/guest/verifier.cjs','--inherited'),{})))
        with self.assertRaisesRegex(c.ConfinementError,'PROGRAM_DENIED'): p.exec_pinned(('/bin/sh',),launch.programs)
    def test_R1_native_mount_view_is_private_readonly_base_and_role_only_tmpfs(self):
        self.assertTrue(hasattr(c,'NativeChildPort'),'native namespace/view source absent')
        b=InertBindings(); launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        b.os.makedirs=lambda path,mode,exist_ok:b.calls.append(('mkdir',(path,mode,exist_ok)))
        b.os.chroot=lambda path:b.calls.append(('chroot',(path,)))
        b.os.chdir=lambda path:b.calls.append(('chdir',(path,)))
        b.os.chown=lambda *a:b.calls.append(('chown',a))
        b.os.open=lambda *a:99
        p=c.NativeChildPort(b,launch,{})
        p.establish_views(launch.views)
        self.assertIn(('setsid',()),b.calls)
        raw=[x for x in b.calls if type(x[0]) is int]
        self.assertEqual(raw[0],(40,(None,b'/',None,278528,None)))
        # Approved storage contract: all writable paths stay on the existing
        # bounded /run tmpfs; allocating additional root tmpfs budgets is denied.
        self.assertFalse(any(args[0]==b'tmpfs' for nr,args in raw if nr==40))
        self.assertIn((40,(b'/opt',b'/run/acceptance/browser/.root/opt',None,4096,None)),raw)
        self.assertIn((40,(None,b'/run/acceptance/browser/.root/opt',None,4129,None)),raw)
        self.assertIn((40,(b'proc',b'/proc',b'proc',14,None)),raw)
        self.assertNotIn('chroot',[x[0] for x in b.calls])
        self.assertIn((41,(b'.',b'.')),raw)
    def view_port(self,role,fail=None):
        """NativeChildPort over InertBindings recording every establish_views effect in b.calls: makedirs as
        ('mkdir',...), chdir, chown, chroot, open (returns 99), raw syscalls as (nr,args). fail(entry) True records
        that effect, then raises OSError from it."""
        b=InertBindings(); launch=c.prepare_role(role,c.RoleConfig(self.config(),c.role_fds(role,RUN)))
        def record(entry,result=None):
            b.calls.append(entry)
            if fail is not None and fail(entry): raise OSError(1,'inert view fault')
            return result
        b.os.makedirs=lambda path,mode,exist_ok:record(('mkdir',(path,mode,exist_ok)))
        b.os.chdir=lambda path:record(('chdir',(path,)))
        b.os.chown=lambda *a:record(('chown',a))
        b.os.chroot=lambda path:record(('chroot',(path,)))
        b.os.open=lambda *a:record(('open',a),99)
        b.syscall=lambda nr,*args:record((nr,args),0)
        return b,launch,c.NativeChildPort(b,launch,{})
    def test_establish_views_pivots_into_self_bound_root_and_detaches_old_root(self):
        # E-1 (C6, Task 8b): a chrooted caller cannot create a user namespace (Linux 6.8
        # kernel/user_namespace.c:104-106), so every role enters its view by pivot_root in its private mount
        # namespace: self-bind of the view root, pivot_root(".", "."), umount2(".", MNT_DETACH). No chroot.
        for role in c.UIDS:
            with self.subTest(role=role):
                b,launch,p=self.view_port(role)
                p.establish_views(launch.views)
                R='/run/acceptance/'+role.lower()+'/.root'; RB=R.encode()
                raw=[x for x in b.calls if type(x[0]) is int]
                self.assertEqual(raw[0],(40,(None,b'/',None,278528,None)))
                self.assertEqual(raw[1],(40,(RB,RB,None,4096,None)))
                self.assertIn(('chdir',(R,)),b.calls)
                bind=b.calls.index(raw[1]); enter=b.calls.index(('chdir',(R,)))
                self.assertIn(('mkdir',(R,0o755,False)),b.calls[:bind])
                def under(value):
                    return (type(value) is str and (value==R or value.startswith(R+'/'))) or (
                        type(value) is bytes and (value==RB or value.startswith(RB+b'/')))
                def paths(entry):
                    if entry[0]=='mkdir': return (entry[1][0],)
                    if entry[0]==40: return entry[1][:2]
                    return ()
                self.assertEqual([e for e in b.calls[:bind] if e!=('mkdir',(R,0o755,False)) and
                                  any(under(v) for v in paths(e))],[])
                inside=[i for i,e in enumerate(b.calls) if e[0]==40 and i!=bind and under(e[1][1])]
                self.assertTrue(inside)
                self.assertEqual([i for i in inside if not bind<i<enter],[])
                self.assertEqual(b.calls[enter:],[
                    ('chdir',(R,)),(41,(b'.',b'.')),(39,(b'.',2)),('chdir',('/',)),
                    (40,(b'proc',b'/proc',b'proc',14,None)),
                    ('setrlimit',(b.resource.RLIMIT_CORE,(0,0))),('setrlimit',(b.resource.RLIMIT_NOFILE,(4096,4096)))])
                self.assertEqual([e for e in b.calls if e[0]==41],[(41,(b'.',b'.'))])
                self.assertEqual([e for e in b.calls if e[0]==39],[(39,(b'.',2))])
                self.assertEqual([e for e in b.calls if e[0] in ('chroot',51)],[])
    def test_establish_views_failure_codes_stop_the_sequence(self):
        # Each new effect fails closed with its own code; nothing after it runs and nothing falls back to chroot.
        for role in c.UIDS:
            R='/run/acceptance/'+role.lower()+'/.root'; RB=R.encode()
            for effect,target,code in ((4,(40,(RB,RB,None,4096,None)),'VIEW_ROOT_BIND_FAILED'),
                                       (6,('chdir',(R,)),'VIEW_PIVOT_FAILED'),
                                       (7,(41,(b'.',b'.')),'VIEW_PIVOT_FAILED'),
                                       (8,(39,(b'.',2)),'VIEW_OLD_ROOT_DETACH_FAILED'),
                                       (9,('chdir',('/',)),'VIEW_PIVOT_FAILED')):
                with self.subTest(role=role,effect=effect):
                    b,launch,p=self.view_port(role,fail=lambda entry,target=target:entry==target)
                    try: p.establish_views(launch.views)
                    except Exception as error: raised=error
                    else: raised=None
                    self.assertIs(type(raised),c.ConfinementError)
                    self.assertEqual(raised.args,(code,))
                    self.assertEqual(b.calls[-1],target)
                    self.assertEqual(b.calls.count(target),1)
                    self.assertNotIn((40,(b'proc',b'/proc',b'proc',14,None)),b.calls)
                    self.assertEqual([e for e in b.calls if e[0]=='setrlimit'],[])
                    self.assertEqual([e for e in b.calls if e[0] in ('chroot',51)],[])
    def test_outer_helper_makes_no_path_call_after_inner_fork(self):
        # K5 (Task 8b design note): pivot_root moves the root and cwd of every task on the old root, the outer
        # helper included, into the role view, so the helper must resolve no path after its inner fork. Fix round 1:
        # from its inner fork call until its _exit, the helper may touch only OUTER_HELPER_POST_FORK. Every
        # attribute read or write through its bindings, through the module objects confinement.py imports, and
        # every call of a PATH_BUILTINS name, is recorded and checked here; nothing is left to raise inside the
        # helper, whose except BaseException would swallow it. All helper_branch fault and cleanup modes run.
        launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        namespace=vars(c)
        self.assertIs(c.NativeKernelPort.spawn_waiting.__globals__,namespace)
        with self.subTest(check='no import statement in spawn_waiting'):
            # An import statement binds through the frame's builtins, which no module-level shadow can intercept.
            tree=ast.parse((ROOT/'guest/confinement.py').read_text())
            port=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='NativeKernelPort')
            spawn=next(n for n in port.body if isinstance(n,ast.FunctionDef) and n.name=='spawn_waiting')
            self.assertEqual([ast.unparse(n) for n in ast.walk(spawn) if isinstance(n,(ast.Import,ast.ImportFrom))],[])
        modules=sorted(name for name,value in namespace.items() if isinstance(value,types.ModuleType))
        self.assertTrue(modules)
        snapshot=dict(namespace)
        for fault in HELPER_FAULTS:
            for cleanup in HELPER_CLEANUPS:
                with self.subTest(fault=fault,cleanup=cleanup):
                    log=[]; state={'armed':False,'opened':False}
                    def install(b,events,state=state,log=log):
                        fork,leave,calls=b.os.fork,b.os._exit,[]
                        def counted_fork():
                            # helper_branch's second fork is the inner fork: the window opens at its call,
                            # before it can fail.
                            calls.append(None)
                            if len(calls)==2: state['armed']=state['opened']=True
                            return fork()
                        def closing_exit(code):
                            # The helper process ends at _exit; what the simulation runs after it is not helper code.
                            state['armed']=False
                            return leave(code)
                        b.os.fork,b.os._exit=counted_fork,closing_exit
                        return StrictSurface(b,'b',log,state)
                    def shadow(name,real,state=state,log=log):
                        def call(*args,**kwargs):
                            if state['armed']:
                                log.append('builtins.'+name); raise PermissionError('test: '+name+' after inner fork')
                            return real(*args,**kwargs)
                        return call
                    saved={name:namespace[name] for name in modules+list(PATH_BUILTINS) if name in namespace}
                    try:
                        for name in modules: namespace[name]=StrictSurface(saved[name],name,log,state)
                        for name in PATH_BUILTINS: namespace[name]=shadow(name,getattr(builtins,name))
                        b,events=helper_branch(launch,fault,cleanup,install=install)
                    finally:
                        for name in modules+list(PATH_BUILTINS):
                            if name in saved: namespace[name]=saved[name]
                            else: namespace.pop(name,None)
                    self.assertEqual([name for name in log if name not in OUTER_HELPER_POST_FORK],[])
                    self.assertEqual(len([e for e in events if e[0]=='exit']),1)
                    self.assertFalse(state['armed'])  # the window closed at the helper's own _exit
                    if fault=='before-inner':
                        self.assertFalse(state['opened'])  # unshare failed: no inner fork, no pivot
                    else:
                        self.assertTrue(state['opened']); self.assertIn('b.os._exit',log)
        # Every shadow is gone: the module globals are exactly the objects they were before the run.
        self.assertEqual(set(namespace),set(snapshot))
        self.assertEqual([name for name in snapshot if namespace[name] is not snapshot[name]],[])
    def test_R1_descriptor_close_ranges_keep_only_audited_and_CLOEXEC_pins(self):
        self.assertTrue(hasattr(c,'NativeChildPort'),'native close-range source absent')
        b=InertBindings(); launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        p=c.NativeChildPort(b,launch,{c.NODE:19},ready_fd=15)
        p.close_unaudited_fds(launch.fds)
        self.assertEqual([v for v in b.calls if v[0]==436],[(436,(5,14,0)),(436,(16,18,0)),(436,(20,4294967295,0))])
        self.assertIn(('set_inheritable',(19,False)),b.calls)
    def test_R1_probe_native_socket_and_io_uring_attempts_derive_denial_from_actual_result(self):
        s=importlib.util.spec_from_file_location('task8_native_probe',ROOT/'tests/guest/confinement_probe.py')
        probe=importlib.util.module_from_spec(s); s.loader.exec_module(probe)
        self.assertTrue(hasattr(probe,'NativeProbePort'),'actual adversarial operation source absent')
        calls=[]
        class Context:
            def syscall(self,nr,*args): calls.append((nr,args)); raise PermissionError(1,'inert denial')
            def receiver_count(self): return 0
            def fd_links(self): return ('/dev/null','pipe:[100]')
        fixture=types.SimpleNamespace(run_confined=lambda role,op,attempt:attempt(Context()))
        port=probe.NativeProbePort(fixture)
        result=port.attempt(probe.PROBES['vsock_browser_controller_verifier_denied'])
        self.assertEqual(calls,[(198,(40,1,0)),(199,(40,1,0,bytearray(8)))]*3)
        self.assertTrue(all(o['denied'] and o['attempted'] for o in result))
        calls.clear(); port.attempt(probe.PROBES['io_uring_setup_register_enter_and_inherited_ring_denied'])
        self.assertEqual([nr for nr,_ in calls],[425,427,426]*4) # inherited-ring uses separate real FD witness
    def test_R1_probe_fixture_setup_failure_reaps_original_owned_family(self):
        s=importlib.util.spec_from_file_location('task8_fixture_cleanup',ROOT/'tests/guest/confinement_probe.py')
        probe=importlib.util.module_from_spec(s); s.loader.exec_module(probe)
        self.assertTrue(hasattr(probe,'NativeProbeFixtures'),'native fixture subprocess source absent')
        b=InertBindings(); k=c.NativeKernelPort(b); config=self.config(k); stopped=[]
        b.os.path=types.SimpleNamespace(lexists=lambda path:False)
        b.os.unlink=lambda path:None; b.os.rmdir=lambda path:None
        owned=c.NativeOwned(501,RUN,'BROWSER',object(),object())
        k.spawn_waiting=lambda *a: (_ for _ in ()).throw(c.RoleStartFailure(owned))
        k.stop_owned=lambda child,deadline:stopped.append(child) or {'status':'STOPPED','pid':501,'run_id':RUN}
        authority=types.SimpleNamespace(**{n:lambda *a:None for n in
            ('receiver_count','foreign_pid','audit','helper_pin','audit_abi_termination','unsynchronized_thread','memory')})
        authority.approve_native_fixtures=lambda config:authority
        fixture=probe.NativeProbeFixtures(c,k,config,authority)
        with self.assertRaises(c.RoleStartFailure): fixture.run_confined('BROWSER','BROWSER.socket-AF_VSOCK',lambda context:None)
        self.assertEqual(stopped,[owned])
        b.os.path.lexists=lambda path:True
        stopped.clear()
        with self.assertRaises(probe.RuntimeGateUnavailable): fixture.run_confined('BROWSER','BROWSER.socket-AF_VSOCK',lambda context:None)
        self.assertEqual(stopped,[]) # pre-existing/historical role scope is untouched
    def test_R1_probe_proxy_actual_connect_vector_and_delivery_witness(self):
        s=importlib.util.spec_from_file_location('task8_proxy_vector',ROOT/'tests/guest/confinement_probe.py')
        probe=importlib.util.module_from_spec(s); s.loader.exec_module(probe); calls=[]
        class Context:
            def syscall(self,nr,*args): calls.append((nr,args)); return 9 if nr==198 else 5 if nr==64 else 0
            def close(self,fd): calls.append(('close',(fd,)))
            def receiver_count(self): return 1
        fixture=types.SimpleNamespace(run_confined=lambda role,op,attempt:attempt(Context()))
        probe.run_case('proxy_fixed_vsock_positive',probe.NativeProbePort(fixture))
        self.assertEqual(calls,[(198,(40,1,0)),(203,(9,bytes.fromhex('28000000d20f00000200000000000000'),16)),(64,(9,b'TASK8',5)),('close',(9,))])
    def test_R1_probe_invalid_argument_or_missing_feature_error_is_not_security_denial(self):
        s=importlib.util.spec_from_file_location('task8_probe_error',ROOT/'tests/guest/confinement_probe.py')
        probe=importlib.util.module_from_spec(s); s.loader.exec_module(probe)
        class Context:
            def syscall(self,*args): raise OSError(22,'inert EINVAL')
            def receiver_count(self): return 0
        fixture=types.SimpleNamespace(run_confined=lambda role,op,attempt:attempt(Context()))
        with self.assertRaisesRegex(probe.ProbeFailure,'UNEXPECTED_KERNEL_ERROR'):
            probe.NativeProbePort(fixture).attempt(probe.PROBES['vsock_browser_controller_verifier_denied'])
    def test_R1_probe_helper_launch_is_fixed_pinned_empty_env_and_owned_bounded(self):
        s=importlib.util.spec_from_file_location('task8_helper_exec',ROOT/'tests/guest/confinement_probe.py')
        probe=importlib.util.module_from_spec(s); s.loader.exec_module(probe)
        b=InertBindings(); effects=[]
        b.os.fork=lambda:0
        b.os.pipe2=lambda flags:(31,32)
        b.pin_sample=lambda path,sha:effects.append(('pin',path,sha)) or 19
        b.os.execve=lambda fd,argv,env: effects.append(('exec',fd,argv,env)) or (_ for _ in ()).throw(ExecBoundary())
        b.os._exit=lambda code: (_ for _ in ()).throw(ExecBoundary())
        pin=c.ProgramPin('/opt/acceptance/tests/fixtures/exec-vsock',hashlib.sha256(b'inert-approved-helper').hexdigest())
        authority=types.SimpleNamespace(helper_pin=lambda name:pin,run_fixed_helper=lambda *args:None)
        context=probe.NativeProbeContext(types.SimpleNamespace(b=b),authority,'BROWSER.exec.socket-AF_VSOCK')
        with self.assertRaises(ExecBoundary): context.helper('exec.socket-AF_VSOCK')
        self.assertEqual(effects,[('pin',pin.path,pin.sha256),('exec',19,(pin.path,),{})])
        with self.assertRaisesRegex(probe.ProbeFailure,'HELPER_DENIED'): context.helper('/bin/sh')
    def test_R1_bootstrap_probe_rejects_real_modified_launch_contract_before_effects(self):
        s=importlib.util.spec_from_file_location('task8_bootstrap_probe',ROOT/'tests/guest/confinement_probe.py')
        probe=importlib.util.module_from_spec(s); s.loader.exec_module(probe)
        b=InertBindings(); launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        authority=types.SimpleNamespace(attempt_bootstrap_rejection=lambda name:None)
        ctx=probe.NativeProbeContext(c.NativeChildPort(b,launch,{}),authority,'BROWSER.arbitrary-executable'); ctx.c=c
        for name in ('arbitrary-executable','arbitrary-argv','arbitrary-uid','arbitrary-fd'):
            with self.assertRaises(PermissionError): ctx.bootstrap_rejection(name)
        self.assertEqual(b.calls,[])
    def test_probe_contract_requires_attempt_and_no_receiver_delivery(self):
        probe_path=ROOT/'tests/guest/confinement_probe.py'
        self.assertTrue(probe_path.exists(),'Task8 probe attempt validation is absent')
        s=importlib.util.spec_from_file_location('task8_probe_contract',probe_path)
        probe=importlib.util.module_from_spec(s); s.loader.exec_module(probe)
        expected=('vsock_browser_controller_verifier_denied','child_fork_exec_network_gpu_crash_helper_inherits',
                  'proxy_fixed_vsock_positive','io_uring_setup_register_enter_and_inherited_ring_denied',
                  'alternate_ABI_denied','SCM_RIGHTS_proc_pidfd_ptrace_process_vm_theft_denied',
                  'privilege_gain_denied','no_console_or_bridge_fd','bootstrap_arbitrary_argv_denied',
                  'TSYNC_failure_abort','exact_fd_inventory',
                  'child_fork_exec_network_gpu_crash_helper_ipv4',
                  'child_fork_exec_network_gpu_crash_helper_ipv6','fixed_ip_denied')
        self.assertEqual(tuple(probe.PROBES),expected)
        # Fake probe observations exercise only result validation, never native qualification.
        port=types.SimpleNamespace(attempt=lambda case:tuple({'operation':op,'attempted':True,'denied':True,'receiver_count':0} for op in case.operations))
        self.assertEqual(len(probe.run_case('vsock_browser_controller_verifier_denied',port)),6)
        port.attempt=lambda case:tuple({'operation':op,'attempted':False,'denied':True,'receiver_count':0} for op in case.operations)
        with self.assertRaises(probe.ProbeFailure): probe.run_case('vsock_browser_controller_verifier_denied',port)
        port.attempt=lambda case:tuple({'operation':op,'attempted':True,'denied':True,'receiver_count':1} for op in case.operations)
        with self.assertRaises(probe.ProbeFailure): probe.run_case('vsock_browser_controller_verifier_denied',port)
    def test_probe_proxy_positive_requires_actual_delivery(self):
        p=ROOT/'tests/guest/confinement_probe.py'
        self.assertTrue(p.exists(),'Task8 proxy probe result validation is absent')
        s=importlib.util.spec_from_file_location('task8_proxy_probe_contract',p)
        probe=importlib.util.module_from_spec(s); s.loader.exec_module(probe)
        port=types.SimpleNamespace(attempt=lambda case:({'operation':'PROXY.fixed-vsock-CID2-port4050','attempted':True,'denied':False,'receiver_count':0},))
        with self.assertRaises(probe.ProbeFailure): probe.run_case('proxy_fixed_vsock_positive',port)
        port.attempt=lambda case:({'operation':'PROXY.fixed-vsock-CID2-port4050','attempted':True,'denied':False,'receiver_count':1},)
        self.assertEqual(len(probe.run_case('proxy_fixed_vsock_positive',port)),1)


COVERAGE_V2 = ROOT / 'appliance/abi-coverage-v2.json'


class BrowserSandboxFilterTests(unittest.TestCase):
    """E1 (contract C6, rulings R1 and R2): the BROWSER outer filter allows exactly what Chromium's namespace
    sandbox needs, and keeps every other denial; CONTROLLER, VERIFIER and PROXY keep their filter.

    Each vector runs the produced program through the independent interpreter above on synthetic seccomp_data.
    Syscall numbers, flags, families, types and return values are named and resolved from the committed coverage
    v2 (checked against the independent oracles by abi_coverage_test); a name absent from it fails the test.
    """
    SANDBOX = ('chroot', 'capset', 'setuid', 'setgid', 'setreuid', 'setregid', 'setresuid', 'setresgid',
               'setfsuid', 'setfsgid', 'setgroups')
    NAMESPACE = ('unshare', 'clone', 'clone3')
    OTHER_ROLES = ('CONTROLLER', 'VERIFIER', 'PROXY')

    @classmethod
    def setUpClass(cls):
        cls.V = {r['id']: r['value'] for r in json.loads(COVERAGE_V2.read_bytes())['records']}

    def v(self, *names):
        """OR of the coverage v2 values of NAMES."""
        value = 0
        for name in names:
            self.assertIn(name, self.V, f'{name}: absent from coverage v2')
            value |= self.V[name]
        return value

    def nr(self, name):
        return self.v('__NR_' + name)

    def returns(self):
        return self.v('SECCOMP_RET_ALLOW'), self.v('SECCOMP_RET_ERRNO', 'EPERM'), self.v('SECCOMP_RET_KILL_PROCESS')

    def test_browser_filter_allows_namespace_sandbox_syscalls(self):
        allow, eperm, _ = self.returns()
        namespaces = self.v('CLONE_NEWUSER', 'CLONE_NEWPID', 'CLONE_NEWNET')
        browser = c.build_filter('BROWSER')
        for name in self.SANDBOX:
            with self.subTest(role='BROWSER', syscall=name):
                self.assertEqual(evaluate(browser, self.nr(name)), allow)
        for name in self.NAMESPACE:
            with self.subTest(role='BROWSER', syscall=name):
                self.assertEqual(evaluate(browser, self.nr(name), (namespaces,)), allow)
        for role in self.OTHER_ROLES:
            program = c.build_filter(role)
            for name in self.SANDBOX:
                with self.subTest(role=role, syscall=name):
                    self.assertEqual(evaluate(program, self.nr(name)), eperm)
            for name in self.NAMESPACE:
                with self.subTest(role=role, syscall=name):
                    self.assertEqual(evaluate(program, self.nr(name), (namespaces,)), allow)

    def test_browser_filter_keeps_design_and_extra_denials(self):
        _, eperm, kill = self.returns()
        browser = c.build_filter('BROWSER')
        sockets = (('AF_VSOCK', 'SOCK_STREAM'), ('AF_PACKET', 'SOCK_RAW'), ('AF_PACKET', 'SOCK_DGRAM'),
                   ('AF_INET', 'SOCK_RAW'), ('AF_INET6', 'SOCK_RAW'))
        for call in ('socket', 'socketpair'):
            for family, kind in sockets:
                with self.subTest(syscall=call, family=family, kind=kind):
                    self.assertEqual(evaluate(browser, self.nr(call), (self.v(family), self.v(kind), 0)), eperm)
        # Design section 9.2 denials, then the R1 extras that stay denied for BROWSER.
        for name in ('io_uring_setup', 'io_uring_register', 'io_uring_enter', 'ptrace', 'process_vm_readv',
                     'process_vm_writev', 'pidfd_getfd', 'pidfd_open', 'mount', 'umount2', 'pivot_root', 'setns',
                     'mknodat'):
            with self.subTest(syscall=name):
                self.assertEqual(evaluate(browser, self.nr(name)), eperm)
        # Any arch other than AUDIT_ARCH_AARCH64 is killed before the E1 allowances are reached: zero, the bare
        # e_machine value, big-endian AArch64, x86_64 and 32-bit ARM.
        native = self.v('AUDIT_ARCH_AARCH64')
        for arch in (0, self.v('EM_AARCH64'), 0x800000b7, 0xc000003e, 0x40000028):
            self.assertNotEqual(arch, native)
            for name in ('chroot', 'setresuid', 'unshare'):
                with self.subTest(arch=hex(arch), syscall=name):
                    self.assertEqual(evaluate(browser, self.nr(name), arch=arch), kill)

    def test_browser_seccomp_flags_exact(self):
        allow, eperm, _ = self.returns()
        tsync, spec = self.v('SECCOMP_FILTER_FLAG_TSYNC'), self.v('SECCOMP_FILTER_FLAG_SPEC_ALLOW')
        log, listener = self.v('SECCOMP_FILTER_FLAG_LOG'), self.v('SECCOMP_FILTER_FLAG_NEW_LISTENER')
        esrch = self.v('SECCOMP_FILTER_FLAG_TSYNC_ESRCH')
        allowed = (0, tsync, spec, tsync | spec)
        denied = (log, listener, listener | tsync, listener | spec, listener | spec | tsync, esrch)
        self.assertEqual((allowed, denied), ((0, 1, 4, 5), (2, 8, 9, 12, 13, 16)))
        operation = self.v('SECCOMP_SET_MODE_FILTER')
        browser = c.build_filter('BROWSER')
        for flags in allowed:
            with self.subTest(role='BROWSER', flags=flags):
                self.assertEqual(evaluate(browser, self.nr('seccomp'), (operation, flags, 1234)), allow)
        for flags in denied:
            with self.subTest(role='BROWSER', flags=flags):
                self.assertEqual(evaluate(browser, self.nr('seccomp'), (operation, flags, 1234)), eperm)
        for role in self.OTHER_ROLES:
            program = c.build_filter(role)
            for flags in (0, tsync):
                with self.subTest(role=role, flags=flags):
                    self.assertEqual(evaluate(program, self.nr('seccomp'), (operation, flags, 1234)), allow)
            for flags in (spec, tsync | spec) + denied:
                with self.subTest(role=role, flags=flags):
                    self.assertEqual(evaluate(program, self.nr('seccomp'), (operation, flags, 1234)), eperm)


if __name__ == '__main__': unittest.main()
