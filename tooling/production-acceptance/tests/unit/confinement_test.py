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
import re
import struct
import sys
import threading
import types
import unittest
from unittest import mock


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
        self.assertIs(c.OfflineKernelPort(bindings).poll_role(owned),True)
        self.assertEqual(calls,[([result],[],[],0)])
        bindings.select=lambda reads,writes,errors,timeout:([],[],[])
        self.assertIs(c.OfflineKernelPort(bindings).poll_role(owned),False)

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
        b.os.listdir=lambda p:['0','1','2','3','4']+(['5'] if extra else []) if p.endswith('/fd') else ['proxy','crash'] if p.endswith('/run/acceptance') else old_list(p)
        b.os.readlink=lambda p:'socket:[50]' if p.endswith('/fd/5') else old_link(p)
        def stat(p):
            if '/fd/' in p:return types.SimpleNamespace(st_dev=2,st_ino=50 if p.endswith('/5') else 30 if p.endswith('/3') else 40 if p.endswith('/4') else 10)
            x=old_stat(p);x.st_uid=x.st_gid=10004;return x
        b.os.stat=stat;b.os.fstat=lambda fd:types.SimpleNamespace(st_dev=2,st_ino=50)
        proxy=c.NativeOwned(300,RUN,'PROXY',owned.command,owned.result,owned.identity)
        del k._owned[owned];k._owned[proxy]=s
        handoff=c.RoleHandoff(launch,c.RoleAttestation(**dict(pid=300,run_id=RUN,role='PROXY',uids=(10004,)*3,gids=(10004,)*3,groups=(),capabilities=(0,)*5,no_new_privs=1,seccomp=2,filter_digest=s['digest'],fds=launch.fds,views=launch.views,waiting=True,programs=launch.programs,seccomp_filters=1,tty_nr=0)),k,proxy)
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
        k=c.OfflineKernelPort(b);owned=c.NativeOwned(204,RUN,'PROXY',object(),result)
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
        b=InertBindings();k=c.OfflineKernelPort(b);owned=c.NativeOwned(201,RUN,'BROWSER',20,21)
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

    # Task 16c (P76, owner decision 2026-11-20): the bootstrap, not the uid-10002 worker, inspects the BROWSER
    # family. LAUNCH runs inside COMMIT_BROWSER after STARTED and before ACTIVE.
    def test_v1_original_roles_inspect_family_at_launch_before_active(self):
        roles,k,budget,proof,writes,init=self.setup_roles()
        reads=[];read=k.read_role
        def recorded(owned,limit):
            data=read(owned,limit);reads.append(json.loads(data[4:])['action']);return data
        k.read_role=recorded;owner=roles.prepare_browser(proof)
        k.family_probe=lambda:(owner._committed,list(reads),[v['action'] for _,v in writes if 'action' in v])
        self.assertEqual(roles.commit_browser(owner),{'status':'ACTIVE','generation':1})
        self.assertEqual([call[0] for call in k.family_calls],['LAUNCH'])
        point,limit,(committed,seen,sent),handoff=k.family_calls[0]
        self.assertIs(committed,False,'LAUNCH precedes the committed transition')
        self.assertEqual(seen,['PREPARED','REFRESH','STARTED'],'LAUNCH follows the worker STARTED')
        self.assertEqual(sent,['PREPARE','COMMIT','CURRENT'])
        self.assertIs(handoff,roles._handoffs['BROWSER'])
        self.assertTrue(0<limit<=1000);self.assertEqual(limit,1000)
        self.assertTrue(owner._committed);self.assertEqual(roles._family_ordinal,1)
        # The bound is the earliest of 1000 ms, the proof's monotonic deadline and its wall expiry.
        for name,wall,mono,want in (('monotonic deadline',100,8500,500),('wall expiry',8700,100,300)):
            with self.subTest(bound=name):
                roles,k,budget,proof,writes,init=self.setup_roles();owner=roles.prepare_browser(proof)
                budget.clock.wall,budget.clock.mono=wall,mono
                self.assertEqual(roles.commit_browser(owner),{'status':'ACTIVE','generation':1})
                self.assertEqual([call[:2] for call in k.family_calls],[('LAUNCH',want)])
        # A failed inspection: no ACTIVE, nothing committed, the role set terminal.
        for fault in ('FAMILY_DENIED','FAMILY_UNREADABLE','AUTHORITY_LOST'):
            with self.subTest(fault=fault):
                roles,k,budget,proof,writes,init=self.setup_roles();owner=roles.prepare_browser(proof)
                k.family_fault=lambda point,fault=fault:fault
                with self.assertRaisesRegex(c.ConfinementError,'^'+fault+'$'):roles.commit_browser(owner)
                self.assertFalse(owner._committed);self.assertTrue(roles._terminal)
                self.assertEqual(roles._family_ordinal,0)
        # Only the kernel port's exact clean result counts.
        clean=lambda point,**change:types.MappingProxyType(dict({'point':point,'members':5,'attempts':1},**change))
        for name,answer in (('another point',lambda point:clean('POST_LOAD')),('members 1',lambda point:clean(point,members=1)),
                            ('members 257',lambda point:clean(point,members=257)),('attempts 0',lambda point:clean(point,attempts=0)),
                            ('attempts 6',lambda point:clean(point,attempts=6)),('members text',lambda point:clean(point,members='5')),
                            ('a plain dict',lambda point:dict(clean(point))),('an extra key',lambda point:clean(point,status='CLEAN'))):
            with self.subTest(result=name):
                roles,k,budget,proof,writes,init=self.setup_roles();owner=roles.prepare_browser(proof);k.family_answer=answer
                with self.assertRaisesRegex(c.ConfinementError,'^AUTHORITY_LOST$'):roles.commit_browser(owner)
                self.assertFalse(owner._committed);self.assertTrue(roles._terminal)
        # No kernel-type gate: a kernel without the method fails closed.
        roles,k,budget,proof,writes,init=self.setup_roles();owner=roles.prepare_browser(proof)
        k.inspect_browser_family=None
        with self.assertRaisesRegex(c.ConfinementError,'^AUTHORITY_LOST$'):roles.commit_browser(owner)
        self.assertFalse(owner._committed);self.assertTrue(roles._terminal)

    @staticmethod
    def family_frame(roles,init,sequence,payload,*,role='BROWSER',key='CONTROLLER',action='BROWSER_FAMILY'):
        """One controller-channel request; key names the channel key that MACs it."""
        row=next(r for r in init['CONTROLLER']['roles'] if r['role']==role)
        value=dict(version=1,binding=roles.binding.to_record(),sequence=sequence,**row,action=action,payload=payload)
        value['mac']=hmac.new(bytes.fromhex(init[key]['channelKeyHex']),b'acceptance:bootstrap-composition:v1\0CONTROLLER:TO_BOOTSTRAP\0'+v1_bytes(value)[4:],hashlib.sha256).hexdigest()
        return v1_bytes(value)

    @staticmethod
    def family_result(init,data):
        value=json.loads(data[4:]);supplied=value.pop('mac')
        expected=hmac.new(bytes.fromhex(init['CONTROLLER']['channelKeyHex']),b'acceptance:bootstrap-composition:v1\0CONTROLLER:FROM_BOOTSTRAP\0'+v1_bytes(value)[4:],hashlib.sha256).hexdigest()
        assert supplied==expected
        return value

    def committed_roles(self):
        roles,k,budget,proof,writes,init=self.setup_roles();owner=roles.prepare_browser(proof);roles.commit_browser(owner)
        return roles,k,init

    def test_v1_browser_family_action_order_and_result(self):
        # Before COMMIT_BROWSER there is no committed preparation: terminal, no RESULT.
        roles,k,budget,proof,writes,init=self.setup_roles()
        with self.assertRaisesRegex(c.ConfinementError,'^AUTHORITY_LOST$'):
            roles.handle_controller(self.family_frame(roles,init,1,dict(generation=1,point='POST_LOAD')))
        self.assertTrue(roles._terminal);self.assertEqual(k.family_calls,[])
        # POST_LOAD, then FINAL: the fixed RESULT, with ordinals 2 and 3.
        roles,k,init=self.committed_roles()
        for sequence,point,ordinal in ((1,'POST_LOAD',2),(2,'FINAL',3)):
            value=self.family_result(init,roles.handle_controller(self.family_frame(roles,init,sequence,dict(generation=1,point=point))))
            self.assertEqual((value['action'],value['role']),('RESULT','BROWSER'))
            self.assertEqual(value['payload'],{'requestSequence':sequence,'result':{'members':5,'ordinal':ordinal,'point':point,'status':'CLEAN'}})
            self.assertEqual(k.family_calls[-1][:2],(point,1000))
            self.assertIs(k.family_calls[-1][3],roles._handoffs['BROWSER'])
        self.assertEqual([call[0] for call in k.family_calls],['LAUNCH','POST_LOAD','FINAL'])
        self.assertFalse(roles._terminal)
        # Out of order: POST_LOAD twice, FINAL before POST_LOAD, anything after FINAL.
        for name,points in (('POST_LOAD twice',('POST_LOAD','POST_LOAD')),('FINAL first',('FINAL',)),
                            ('FINAL twice',('POST_LOAD','FINAL','FINAL'))):
            with self.subTest(order=name):
                roles,k,init=self.committed_roles()
                for sequence,point in enumerate(points[:-1],1):
                    roles.handle_controller(self.family_frame(roles,init,sequence,dict(generation=1,point=point)))
                with self.assertRaisesRegex(c.ConfinementError,'^AUTHORITY_LOST$'):
                    roles.handle_controller(self.family_frame(roles,init,len(points),dict(generation=1,point=points[-1])))
                self.assertTrue(roles._terminal)
                self.assertEqual(len(k.family_calls),len(points),'no inspection runs for a refused request')
        # Malformed requests are FRAME_DENIED and terminal.
        for name,build in (
                ('extra key',lambda r,i:self.family_frame(r,i,1,dict(generation=1,point='POST_LOAD',members=5))),
                ('generation 2',lambda r,i:self.family_frame(r,i,1,dict(generation=2,point='POST_LOAD'))),
                ('generation true',lambda r,i:self.family_frame(r,i,1,dict(generation=True,point='POST_LOAD'))),
                ('unknown point',lambda r,i:self.family_frame(r,i,1,dict(generation=1,point='PERIODIC'))),
                ('LAUNCH point',lambda r,i:self.family_frame(r,i,1,dict(generation=1,point='LAUNCH'))),
                ('role VERIFIER',lambda r,i:self.family_frame(r,i,1,dict(generation=1,point='POST_LOAD'),role='VERIFIER')),
                ('BROWSER key',lambda r,i:self.family_frame(r,i,1,dict(generation=1,point='POST_LOAD'),key='BROWSER'))):
            with self.subTest(frame=name):
                roles,k,init=self.committed_roles()
                with self.assertRaisesRegex(c.ConfinementError,'^FRAME_DENIED$'):roles.handle_controller(build(roles,init))
                self.assertTrue(roles._terminal);self.assertEqual([call[0] for call in k.family_calls],['LAUNCH'])
        # A dirty family: no RESULT, the role set terminal, and the ordinal does not advance.
        for point,prior in (('POST_LOAD',()),('FINAL',('POST_LOAD',))):
            with self.subTest(dirty=point):
                roles,k,init=self.committed_roles()
                for sequence,earlier in enumerate(prior,1):
                    roles.handle_controller(self.family_frame(roles,init,sequence,dict(generation=1,point=earlier)))
                k.family_fault=lambda requested,point=point:'FAMILY_DENIED' if requested==point else None
                ordinal=roles._family_ordinal
                with self.assertRaisesRegex(c.ConfinementError,'^FAMILY_DENIED$'):
                    roles.handle_controller(self.family_frame(roles,init,len(prior)+1,dict(generation=1,point=point)))
                self.assertTrue(roles._terminal);self.assertEqual(roles._family_ordinal,ordinal)
                self.assertIsNotNone(roles._budget.deadline,'a failed inspection is terminal: the shared end starts')

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
            views=launch.views,waiting=True,programs=launch.programs,seccomp_filters=1,tty_nr=0))
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
    try: c.OfflineKernelPort(b if port is None else port).spawn_waiting(launch,lambda port:None)
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
# its _exit, derived from guest/confinement.py _KernelPortCore.spawn_waiting (outer-helper branch after
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
        # Task 16c (P14): the bootstrap's BROWSER family inspection, recorded. family_probe() runs at the call;
        # family_fault(point) names a code the inspection raises instead of the clean five-member result.
        self.family_calls = []
        self.family_probe = None
        self.family_fault = None
        self.family_answer = None   # family_answer(point): the result to return instead of the clean one

    def inspect_browser_family(self, handoff, point, *, limit_ms):
        self.family_calls.append((point, limit_ms, self.family_probe() if self.family_probe else None, handoff))
        code = self.family_fault(point) if self.family_fault else None
        if code: raise c.ConfinementError(code)
        if self.family_answer: return self.family_answer(point)
        return types.MappingProxyType({'point': point, 'members': 5, 'attempts': 1})

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


class StorageView:
    """One role's five scopes as that role sees them inside its own view (C7): fresh and empty, as at launch, the
    role-owned 0700 roots on the run (7), role tmpfs (9) and crash (8) devices. A descriptor-relative storage port
    double over confinement's own storage module, never a host filesystem: it records each root open and close in
    EVENTS, and the policy and kernel facts are the role's own (P17). Any content operation is a test failure."""
    DEVICES = {'/dev/shm': 9, '/run/acceptance/crash': 8}

    def __init__(self, role, events):
        self.role, self.uid, self.events = role, c.UIDS[role], events
        self.scopes = c.storage.ROLE_SCOPES[role]
        self.fds, self.next_fd, self.mounts = {}, 40, None

    def policy(self):
        return c.storage.StoragePolicy('a' * 64, True, 0, 'TMPFS', False, False, False, False, False, False,
                                       256 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024, 4096)

    def identity(self, path):
        return (path, self.DEVICES.get(path, 7), 500 + self.scopes.index(path))

    def digest(self):
        return c.storage.scope_digest(self.role, self.uid, tuple(self.identity(path) for path in self.scopes))

    def kernel_state(self):
        capacity = {'/dev/shm': 64 * 1024 * 1024, '/run/acceptance/crash': 1024 * 1024}
        rows = self.mounts or tuple((path, 'tmpfs', self.identity(path)[1], True,
                                     capacity.get(path, 256 * 1024 * 1024), 4096) for path in self.scopes)
        return c.storage.KernelStorageState(True, 0, (), (), False, False, False, (),
                                            tuple(c.storage.MountObservation(*row) for row in rows))

    def metadata(self, path):
        _, device, inode = self.identity(path)
        return c.storage.NodeMetadata('DIRECTORY', 0o700, self.uid, self.uid, device, inode, 1, 0, 0)

    def open_root(self, path):
        self.events.append(('open_root', path))
        parent, root = self.next_fd, self.next_fd + 1
        self.next_fd += 2
        self.fds[parent], self.fds[root] = ('parent', path), ('root', path)
        return parent, root, path.rsplit('/', 1)[1]

    def stat(self, fd): return self.metadata(self.fds[fd][1])
    def stat_child(self, fd, name): return self.metadata(self.fds[fd][1])
    def list_names(self, fd): return ()

    def close(self, fd):
        self.events.append(('close', fd))
        del self.fds[fd]

    def content(self, *args): raise AssertionError('empty scopes need no content operation')
    open_file = open_directory = readable = unlink = remove_directory = chmod = content


class ContentView(StorageView):
    """A StorageView whose run root holds Chromium-like profile content the role created after launch (P66): the
    Singleton* symlinks (their targets lie outside the five scopes, so here they are only links), a socket and a
    FIFO (kind OTHER), a 0500 directory holding a 0000 file, a 0644 file and nested directories. The role's owner
    bits apply: listing needs r, unlink and rmdir need w and x on the directory. A symlink is never opened as a
    directory (O_NOFOLLOW) and no file content is ever opened. Each content effect is recorded in EVENTS as
    ('content', operation, name or inode)."""
    def __init__(self, role, events):
        super().__init__(role, events)
        self.inodes = iter(range(900, 1000))
        def node(kind, mode, **children):
            return {'kind': kind, 'mode': mode, 'inode': next(self.inodes), 'children': children}
        self.tree = {'kind': 'DIRECTORY', 'mode': 0o700, 'inode': 500, 'children': {
            'SingletonLock': node('SYMLINK', 0o777), 'SingletonSocket': node('SYMLINK', 0o777),
            'SingletonCookie': node('SYMLINK', 0o777), 'socket': node('OTHER', 0o755), 'fifo': node('OTHER', 0o644),
            'Default': node('DIRECTORY', 0o500, Lock=node('FILE', 0o000), Preferences=node('FILE', 0o644),
                            Cache=node('DIRECTORY', 0o700, Cache_Data=node('DIRECTORY', 0o755,
                                                                           index=node('FILE', 0o600))))}}

    def node(self, fd):
        kind, value = self.fds[fd]
        if kind == 'node': return value
        if kind == 'root': return self.tree if value == self.scopes[0] else {'mode': 0o700, 'children': {}}
        return None

    def node_metadata(self, value):
        return c.storage.NodeMetadata(value['kind'], value['mode'], self.uid, self.uid, 7, value['inode'], 1, 0, 0)

    def need(self, value, bits):
        if (value['mode'] >> 6) & bits != bits: raise PermissionError(13, 'inert permission denied')

    def stat(self, fd):
        return self.node_metadata(self.fds[fd][1]) if self.fds[fd][0] == 'node' else super().stat(fd)

    def stat_child(self, fd, name):
        if self.fds[fd][0] == 'parent': return super().stat_child(fd, name)
        self.need(self.node(fd), 1)
        return self.node_metadata(self.node(fd)['children'][name])

    def list_names(self, fd):
        self.need(self.node(fd), 4)
        return tuple(self.node(fd)['children'])

    def open_directory(self, fd, name, expected):
        self.need(self.node(fd), 1)
        child = self.node(fd)['children'][name]
        if child['kind'] != 'DIRECTORY' or self.node_metadata(child) != expected:
            raise OSError(40, 'O_DIRECTORY|O_NOFOLLOW refused')
        self.events.append(('content', 'open_directory', name))
        descriptor = self.next_fd; self.next_fd += 1
        self.fds[descriptor] = ('node', child)
        return descriptor

    def chmod(self, fd, mode):
        self.events.append(('content', 'chmod', self.node(fd)['inode'], mode))
        self.node(fd)['mode'] = mode

    def unlink(self, fd, name, expected):
        self.need(self.node(fd), 3)
        if self.node(fd)['children'][name]['kind'] == 'DIRECTORY': raise IsADirectoryError(21, 'inert EISDIR')
        del self.node(fd)['children'][name]
        self.events.append(('content', 'unlink', name))

    def remove_directory(self, fd, name, expected):
        self.need(self.node(fd), 3)
        if self.node(fd)['children'][name]['children']: raise OSError(39, 'inert ENOTEMPTY')
        del self.node(fd)['children'][name]
        self.events.append(('content', 'rmdir', name))


class CleanupChild:
    """The child port a storage cleanup child runs over (C7, R8): it records each call, in order, in LOG; its storage
    side is a VIEW (StorageView by default) sharing LOG; FD4 writes go to OUT (the result pipe); FD3 yields the
    parent's EXIT; _exit ends the child. fail='uid' makes the port report UID 0, so admission must fail."""
    def __init__(self, launch, log, out, *, fail=None, view=None):
        self.launch, self.log, self.out, self.fail = launch, log, out, fail
        self.storage, self.ready = (view or StorageView)(launch.role, log), None
        uid = launch.uid
        self.facts = dict(pid=401, run_id=RUN, role=launch.role, uids=(uid,) * 3, gids=(uid,) * 3, groups=(),
                          capabilities=(0,) * 5, no_new_privs=1, seccomp=2,
                          filter_digest=hashlib.sha256(c.filter_bytes(launch.filter)).hexdigest(), fds=launch.fds,
                          views=launch.views, waiting=False, programs=launch.programs, seccomp_filters=1, tty_nr=0)
        def write(fd, data):
            log.append(('write', fd, data))
            if fd == 4: out.extend(data)
            return len(data)
        def read(fd, size):
            log.append(('read', fd, size)); return b'EXIT'
        def leave(code):
            log.append(('_exit', code)); raise ExecBoundary()
        self.b = types.SimpleNamespace(os=types.SimpleNamespace(write=write, read=read, _exit=leave))
    def establish_views(self, views, *, reuse_state=False): self.log.append(('establish_views', views, reuse_state))
    def close_unaudited_fds(self, fds): self.log.append(('close_unaudited_fds', fds))
    def drop_credentials(self, uid, gid): self.log.append(('drop_credentials', uid, gid))
    def clear_capabilities(self): self.log.append(('clear_capabilities',))
    def no_new_privs(self): self.log.append(('no_new_privs',))
    def install_seccomp(self, program, flags):
        self.log.append(('install_seccomp', flags)); return 0
    def inspect(self):
        self.log.append(('inspect',)); return dict(self.facts)
    def storage_ports(self):
        self.log.append(('storage_ports',)); return self.storage.policy(), self.storage
    def uid(self):
        self.log.append(('uid',)); return 0 if self.fail == 'uid' else self.launch.uid
    def observe(self):
        self.log.append(('observe',)); return self.storage.kernel_state()
    def write_ready(self, storage_digest):
        self.log.append(('write_ready', storage_digest)); self.ready = storage_digest
    def exec_pinned(self, *args):
        self.log.append(('exec',)); raise AssertionError('a storage cleanup child never execs')


class ChildKernel:
    def __init__(self, parent, pid, launch):
        self.parent, self.pid, self.launch = parent, pid, launch
        self.events = []
        self._storage, self.uid_override = None, None
        self.owned = types.SimpleNamespace(pid=pid, run_id=RUN, role=launch.role,
                                           command=object(), result=object())
        self.facts = {'pid': pid, 'run_id': RUN, 'role': launch.role,
                      'uids': (0, 0, 0), 'gids': (0, 0, 0), 'groups': (0,),
                      'capabilities': (1, 1, 1, 1, 1), 'no_new_privs': 0,
                      'seccomp': 0, 'filter_digest': '', 'fds': (),
                      'views': None, 'waiting': False, 'programs': launch.programs,
                      'seccomp_filters': 0, 'tty_nr': 0}
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
        # T8-08: the filter is reported installed whatever the TSYNC result, so the attestation cannot mask a
        # missing TSYNC result check (only exec_role's own check can refuse 901, -1 or True).
        self.events.append(('filter', flags))
        self.facts.update(seccomp=2, seccomp_filters=1, filter_digest=hashlib.sha256(b''.join(struct.pack('<HBBI', *i) for i in program)).hexdigest())
        return self.parent.tsync
    def inspect(self): return dict(self.facts, **self.parent.drift)
    # C7 (R8, P17): the child port's storage side, answered from the facts this child has reached so far.
    @property
    def storage(self):
        if self._storage is None: self._storage = StorageView(self.launch.role, self.events)
        return self._storage
    def storage_ports(self):
        self.events.append('storage'); return self.storage.policy(), self.storage
    def uid(self):
        self.events.append('uid')
        return self.facts['uids'][0] if self.uid_override is None else self.uid_override
    def observe(self):
        self.events.append('observe'); return self.storage.kernel_state()
    def exec_pinned(self, argv, programs, storage_digest=None):
        # The descriptors still open at exec are recorded with it: admission must have released every one.
        self.events.append(('exec', argv, programs, storage_digest,
                            tuple(self._storage.fds) if self._storage is not None else ()))
        self.facts['waiting'] = True
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
        files={base+'/status':b'Uid:\t10002 10002 10002 10002\nGid:\t10002 10002 10002 10002\nGroups:\nCapEff:\t0\nCapPrm:\t0\nCapInh:\t0\nCapAmb:\t0\nCapBnd:\t0\nNoNewPrivs:\t1\nSeccomp:\t2\nSeccomp_filters:\t1\n',
               base+'/stat':b'300 (node) S 1 300 300 0 -1 4194560\n',
               base+'/fdinfo/3':b'flags:\t00\n',base+'/fdinfo/4':b'flags:\t01\n',
               base+'/cmdline':b'/opt/acceptance/runtime/node/bin/node\0/opt/acceptance/guest/browser-worker.cjs\0--inherited\0'}
        # The Task 8b view (P47) with Task 14's role tmpfs and crash bind (P50): the self-bound root, the read-only
        # base, role state on the /run tmpfs (0:2), /dev/shm (0:3), /run/acceptance/crash (0:4), /dev/null, /proc.
        mounts='1 0 0:2 /acceptance/browser/.root / rw - tmpfs base rw\n'
        mounts+=''.join('1 0 0:1 / /'+d+' '+('rw' if drift=='readonly' and d=='opt' else 'ro')+' - ext4 base ro\n' for d in readonly)
        mounts+=''.join('1 0 0:2 / /'+d+' rw - '+('ext4' if drift=='tmpfs' else 'tmpfs')+' base rw\n' for d in ('tmp','var','run/acceptance/browser'))
        mounts+='1 0 0:3 / /dev/shm rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=65536k,mode=700,uid=10002,gid=10002\n'
        mounts+='1 0 0:4 /browser /run/acceptance/crash rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=1024k\n'
        mounts+='1 0 0:5 /null /dev/null rw - devtmpfs udev rw\n1 0 0:30 / /proc rw - proc proc rw\n'
        files[base+'/mountinfo']=mounts.encode()
        b.read_file=lambda path,*a:files[path]; b.run_device=2; b.crash_device=4
        b.os.listdir=lambda path:['0','1','2','3','4'] if path==base+'/fd' else ['null','shm'] if path==base+'/root/dev' else ['browser','crash']
        def link(path):
            if '/fd/' in path: return '/dev/null' if path[-1] in '012' else 'pipe:[30]' if path[-1]=='3' else 'pipe:[40]'
            return ('user:[1]' if path.endswith('/user') else ('pid:[1]' if path.startswith('/proc/self') else 'pid:[20]') if path.endswith('/pid') else ('mnt:[1]' if path.startswith('/proc/self') else 'mnt:[20]'))
        b.os.readlink=link
        b.os.stat=lambda path:types.SimpleNamespace(st_dev=1 if path.endswith('/exe') or path.endswith('/root') or path.endswith('/.root') else
                                                    3 if path.endswith('/dev/shm') else 4 if path.endswith('/run/acceptance/crash') else 2,
            st_ino=999 if path.endswith('/exe') else 555,st_mode=0o700,st_uid=10002,st_gid=10002)
        k=c.OfflineKernelPort(b); owned=c.NativeOwned(300,RUN,'BROWSER',object(),object())
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
    def test_filter_identical_for_every_helper_position_offline_proxy(self):
        # T8-07: an offline proxy only. A seccomp filter is inherited across fork and exec, so every helper position
        # of a role runs that role's one launch program; this evaluates that program per position and models no
        # descendant. Native inheritance is the gated guest probe child_fork_exec_network_gpu_crash_helper_inherits.
        h = self.api().start_roles(self.config())
        for role, positions in (('BROWSER', ('parent', 'fork', 'exec', 'network', 'gpu', 'crash')),
                                ('CONTROLLER', ('helper',)), ('VERIFIER', ('helper',))):
            program = h[role].launch.filter
            self.assertEqual(program, c.build_filter(role))
            self.assertEqual(h[role].attestation.filter_digest, hashlib.sha256(c.filter_bytes(program)).hexdigest())
            for position in positions:
                with self.subTest(role=role, position=position):
                    self.assertEqual(evaluate(program, 198, (40, 1, 0)), DENY)
        p = h['BROWSER'].launch.filter
        self.assertEqual(evaluate(p, 220, (17,)), ALLOW)
        self.assertEqual(evaluate(p, 221), ALLOW)
        self.assertEqual(h['BROWSER'].attestation.capabilities, (0,)*5)
    def test_proxy_fixed_vsock_positive(self):
        # P15: the deleted proxy_endpoint() had no caller; the fixed destination is proxy.py's own _HOST_CID and
        # _VSOCK_SERVICE, bound by abi_coverage_test VSOCK_CID_SITES ('proxy.py', '<module>').
        m = self.api()
        self.assertFalse(hasattr(m, 'proxy_endpoint'))
        self.assertEqual(evaluate(m.build_filter('PROXY'), 198, (40, 1, 0)), ALLOW)
        self.assertEqual(evaluate(m.build_filter('PROXY'), 199, (40, 1, 0)), DENY)
    def test_socket_domain_type_protocol_and_high_words(self):
        p = self.api().build_filter('BROWSER')
        for nr in (198,199):
            for args in ((1,1,0),(1,2,0),(1,5,0),(2,1,0),(2,2,0),(10,1,0),(10,2,0),(2,1|0x80800,0)):
                self.assertEqual(evaluate(p,nr,args),ALLOW, args)
            for args in ((17,1,0),(16,2,0),(41,1,0),(2,3,0),(1,1,99),(2,1|0x1000,0),(1<<32|1,1,0),(2,1<<32|1,0),(2,1,1<<32)):
                self.assertEqual(evaluate(p,nr,args),DENY,args)
    def test_all_nonzero_protocol_scalars_fail_closed_without_unreviewed_constants(self):
        # Task 8c (C6, owner decision 2026-11-20): the one reviewed nonzero scalar is IPPROTO_TCP, admitted for
        # BROWSER's AF_INET/AF_INET6 SOCK_STREAM only (BrowserSandboxFilterTests binds it by name). Every other
        # nonzero protocol, including IPPROTO_UDP, and IPPROTO_TCP with any other family or type, still fails closed,
        # now checked for every role. IPPROTO_TCP and IPPROTO_UDP are read from coverage v2; 1, 123, 0xffffffff and
        # 1<<32 stay raw arbitrary scalars.
        V={r['id']:r['value'] for r in json.loads(COVERAGE_V2.read_bytes())['records']}
        tcp_value,udp_value=V['IPPROTO_TCP'],V['IPPROTO_UDP']
        for role in ('CONTROLLER','BROWSER','VERIFIER','PROXY'):
            p=self.api().build_filter(role)
            for nr in (198,199):
                for family,kind in ((1,1),(1,2),(1,5),(2,1),(2,2),(10,1),(10,2)):
                    self.assertEqual(evaluate(p,nr,(family,kind,0)),ALLOW,(role,nr,family,kind))
                    for nonzero in (1,tcp_value,udp_value,123,0xffffffff,1<<32):
                        tcp=role=='BROWSER' and family in (2,10) and kind==1 and nonzero==tcp_value
                        self.assertEqual(evaluate(p,nr,(family,kind,nonzero)),ALLOW if tcp else DENY,
                                         (role,nr,family,kind,nonzero))
    def test_io_uring_setup_register_enter_and_inherited_ring_denied(self):
        for role in ('CONTROLLER','BROWSER','VERIFIER','PROXY'):
            for nr in (425,426,427):
                self.assertEqual(evaluate(self.api().build_filter(role),nr,(9,)),DENY)
        # T8-07: an inherited ring inside an otherwise valid inherited tuple, as an extra FD5 or replacing FD4's kind.
        config = self.config(); fds = c.role_fds('BROWSER',RUN)
        c.prepare_role('BROWSER',c.RoleConfig(config,fds))  # control: the valid tuple is admitted
        ring = c.Descriptor(5,'io_uring','ring','BOOTSTRAP',RUN)
        for name,changed in (('extra fd5',fds+(ring,)),('fd4 kind',fds[:4]+(dataclasses.replace(fds[4],kind='io_uring'),))):
            with self.subTest(ring=name), self.assertRaisesRegex(c.ConfinementError,'^FD_DENIED$'):
                c.prepare_role('BROWSER',c.RoleConfig(config,changed))
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
        # P15 (T8-07): the deleted validate_channel_message had no caller. Every role frame the bootstrap reads passes
        # _v1_decode, which refuses any ancillary record (an SCM_RIGHTS pretence) and any nonzero recvmsg flags.
        self.assertFalse(hasattr(m,'validate_channel_message'))
        frame=m._v1_encode({'version':1})
        self.assertEqual(m._v1_decode(frame),{'version':1})
        for ancillary,flags in ((((1,1,b'fd'),),0),((),8)):
            with self.subTest(ancillary=ancillary,flags=flags), self.assertRaisesRegex(m.ConfinementError,'^FRAME_DENIED$'):
                m._v1_decode(frame,ancillary,flags)
        # The launch contract; native observation of these views is bound by NativeAttestationTests.
        browser = m.start_roles(self.config())['BROWSER']
        self.assertEqual(browser.launch.views.visible_roles,('BROWSER',))
        self.assertFalse(browser.launch.views.console)
        self.assertEqual(browser.launch.views.private_mode,0o700)
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
        # T8-07: only `kind` varies, inside an otherwise valid inherited tuple; the unchanged tuple is admitted.
        m = self.api(); fds = m.role_fds('BROWSER',RUN)
        m.prepare_role('BROWSER',m.RoleConfig(self.config(),fds))
        for index in (3,4):
            for kind in ('console','tty','vsock','bridge','socket','io_uring'):
                with self.subTest(fd=index,kind=kind), self.assertRaisesRegex(m.ConfinementError,'^FD_DENIED$'):
                    changed=list(fds); changed[index]=dataclasses.replace(fds[index],kind=kind)
                    m.prepare_role('BROWSER',m.RoleConfig(self.config(),tuple(changed)))
    def test_descriptor_peer_is_bootstrap_for_every_role(self):
        # T8-10: the physical peer of FD0..4 is the bootstrap parent for every role, including its relay for the
        # browser (OriginalRoleSet). The exported handoff rows carry it to the host (VMHost validateRoles).
        m = self.api()
        for role in m.UIDS:
            with self.subTest(role=role):
                fds = m.role_fds(role,RUN)
                self.assertEqual([d.peer for d in fds],['BOOTSTRAP']*5)
                self.assertEqual([d.peer for d in m.prepare_role(role,m.RoleConfig(self.config(),fds)).fds],['BOOTSTRAP']*5)
                for peer in ('CONTROLLER',role,'PROXY'):
                    for index in (0,3,4):
                        changed=list(fds); changed[index]=dataclasses.replace(fds[index],peer=peer)
                        with self.subTest(peer=peer,fd=index), self.assertRaisesRegex(m.ConfinementError,'^FD_DENIED$'):
                            m.prepare_role(role,m.RoleConfig(self.config(),tuple(changed)))
    def test_tsync_result_checked_independently_of_seccomp_mode(self):
        # T8-08: the double reports the installed filter (seccomp 2 and its digest) whatever install_seccomp returns,
        # so only exec_role's own TSYNC result check can stop these execs.
        launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        for result in (901,-1,True):
            with self.subTest(result=result):
                child=ChildKernel(Kernel(tsync=result),201,launch)
                with self.assertRaisesRegex(c.ConfinementError,'^TSYNC_FAILED$'): c.exec_role(launch,kernel=child)
                self.assertEqual(child.facts['seccomp'],2)
                self.assertFalse(any(type(e) is tuple and e[0]=='exec' for e in child.events))
        child=ChildKernel(Kernel(),201,launch)
        with self.assertRaises(ExecBoundary): c.exec_role(launch,kernel=child)
        self.assertEqual(child.events[-1][0],'exec')
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
        # T8-05: no injected factory exists. To show that a failed gate precedes every effect, the test replaces
        # the module name LinuxBindings with a recorder (observation only) and checks it is never reached.
        self.assertTrue(hasattr(c,'select_native_kernel'),'required gated native KernelPort source absent')
        identity=c.GuestRuntimeIdentity(c.ProgramPin(c.PYTHON,'a'*64),
                                        c.ProgramPin('/usr/lib/aarch64-linux-gnu/libc.so.6','b'*64),'c'*64)
        def refuse(value): raise RuntimeError('inert validator failure')
        effect=[]
        with mock.patch.object(c,'LinuxBindings',side_effect=lambda runtime:effect.append(runtime)):
            for mode,value,validator in [('worker',identity,lambda x:x),('bootstrap-check',None,lambda x:x),
                                         ('bootstrap-check',object(),lambda x:None),('bootstrap-check',identity,lambda x:None),
                                         ('bootstrap-check',identity,lambda x:dataclasses.replace(x)),
                                         ('bootstrap-check',identity,refuse)]:
                with self.subTest(mode=mode,validator=validator),self.assertRaisesRegex(c.ConfinementError,'NATIVE_GATE_DENIED'):
                    c.select_native_kernel(mode,runtime_identity=value,validate_runtime=validator)
        self.assertEqual(effect,[])
    def test_R1_native_selector_rejects_boolean_or_unpinned_guest_identity(self):
        effects=[]
        with mock.patch.object(c,'LinuxBindings',side_effect=lambda runtime:effects.append(runtime)):
            for value in (True,object(),{'python':'unreviewed'}):
                with self.assertRaisesRegex(c.ConfinementError,'NATIVE_GATE_DENIED'):
                    c.select_native_kernel('bootstrap-check',runtime_identity=value,validate_runtime=lambda x:x)
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
        b=InertBindings(); k=c.OfflineKernelPort(b); owned=c.NativeOwned(201,RUN,'BROWSER',object(),object())
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
        b=InertBindings(); k=c.OfflineKernelPort(b)
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
        k=c.OfflineKernelPort(b); launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
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
        k=c.OfflineKernelPort(InertBindings())
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
        with self.assertRaises(ExecBoundary): p.exec_pinned(launch.argv,launch.programs,bytes(32))
        self.assertEqual(b.calls[-1],('execve',(19,('/opt/acceptance/runtime/node/bin/node','/opt/acceptance/guest/verifier.cjs','--inherited'),{})))
        with self.assertRaisesRegex(c.ConfinementError,'PROGRAM_DENIED'): p.exec_pinned(('/bin/sh',),launch.programs,bytes(32))
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
        # Approved storage contract (C7, E5): the only tmpfs a view mounts is the role's own 64 MiB /dev/shm with
        # the fixed data; every other writable path stays on the existing bounded /run tmpfs, and no other tmpfs
        # budget (a root or a second one) is ever allocated.
        self.assertEqual([args for nr,args in raw if nr==40 and b'tmpfs' in (args[0],args[2])],
                         [(b'tmpfs',b'/run/acceptance/browser/.root/dev/shm',b'tmpfs',14,
                           b'size=67108864,mode=0700,uid=10002,gid=10002')])
        # Every read-only base directory is bound once and remounted read-only right after its bind (Task 9:
        # reviewer M18 left /etc writable and survived the opt-only assertions).
        for directory in ('opt','usr','lib','lib64','etc'):
            target=('/run/acceptance/browser/.root/'+directory).encode()
            bind=(40,(('/'+directory).encode(),target,None,4096,None)); remount=(40,(None,target,None,4129,None))
            with self.subTest(directory=directory):
                self.assertEqual((raw.count(bind),raw.count(remount)),(1,1))
                self.assertEqual(raw.index(remount),raw.index(bind)+1)
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
        self.assertIs(c._KernelPortCore.spawn_waiting.__globals__,namespace)
        with self.subTest(check='no import statement in spawn_waiting'):
            # An import statement binds through the frame's builtins, which no module-level shadow can intercept.
            tree=ast.parse((ROOT/'guest/confinement.py').read_text())
            port=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='_KernelPortCore')
            spawn=next(n for n in port.body if isinstance(n,ast.FunctionDef) and n.name=='spawn_waiting')
            self.assertEqual([ast.unparse(n) for n in ast.walk(spawn) if isinstance(n,(ast.Import,ast.ImportFrom))],[])
        modules=sorted(name for name,value in namespace.items() if isinstance(value,types.ModuleType))
        self.assertTrue(modules)
        snapshot=dict(namespace)
        for fault in HELPER_FAULTS:
            for cleanup in HELPER_CLEANUPS:
                with self.subTest(fault=fault,cleanup=cleanup):
                    log=[]; state={'armed':False,'opened':False}; seen={}
                    def install(b,events,state=state,log=log,seen=seen):
                        seen['events']=events
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
                    escaped=None
                    try:
                        for name in modules: namespace[name]=StrictSurface(saved[name],name,log,state)
                        for name in PATH_BUILTINS: namespace[name]=shadow(name,getattr(builtins,name))
                        # An exception raised in the helper's own handlers escapes it; keep it so the
                        # recorded surface is still checked first, then fail on the escape itself.
                        try: helper_branch(launch,fault,cleanup,install=install)
                        except Exception as error: escaped=error
                    finally:
                        for name in modules+list(PATH_BUILTINS):
                            if name in saved: namespace[name]=saved[name]
                            else: namespace.pop(name,None)
                    self.assertEqual([name for name in log if name not in OUTER_HELPER_POST_FORK],[])
                    self.assertIsNone(escaped)  # the helper always ends in its own _exit, never by raising
                    self.assertEqual(len([e for e in seen['events'] if e[0]=='exit']),1)
                    self.assertFalse(state['armed'])  # the window closed at the helper's own _exit
                    if fault=='before-inner':
                        self.assertFalse(state['opened'])  # unshare failed: no inner fork, no pivot
                    else:
                        self.assertTrue(state['opened']); self.assertIn('b.os._exit',log)
        # Every shadow is gone: the module globals are exactly the objects they were before the run.
        self.assertEqual(set(namespace),set(snapshot))
        self.assertEqual([name for name in snapshot if namespace[name] is not snapshot[name]],[])
    # --- Task 14 (C7, E5, R8; P16, P17, P50) ------------------------------------------------------------------------
    def test_establish_views_mounts_role_shm_tmpfs_and_crash_bind(self):
        # C7 (P50): the role's /dev/shm is its own 64 MiB tmpfs mounted in place of (never stacked on) a state bind,
        # and /run/acceptance/crash is a bind of its own 0700 role-owned crash directory. Both are mounted after the
        # root self-bind and before chdir/pivot_root, targets under the view root: after the detach the crash
        # source would be unreachable (K6). reuse_state (the storage cleanup child only) re-binds existing state.
        for role,uid in c.UIDS.items():
            for reuse in (False,True):
                with self.subTest(role=role,reuse_state=reuse):
                    b,launch,p=self.view_port(role)
                    if reuse: p.establish_views(launch.views,reuse_state=True)
                    else: p.establish_views(launch.views)
                    name=role.lower(); R='/run/acceptance/'+name+'/.root'; RB=R.encode()
                    S='/run/acceptance/'+name+'/.state'; crash='/run/acceptance/crash/'+name
                    tmpfs=(40,(b'tmpfs',RB+b'/dev/shm',b'tmpfs',14,b'size=67108864,mode=0700,uid=%d,gid=%d'%(uid,uid)))
                    bind=(40,(crash.encode(),RB+b'/run/acceptance/crash',None,4096,None))
                    mounts=[e for e in b.calls if e[0]==40]
                    self.assertEqual([e for e in mounts if b'tmpfs' in (e[1][0],e[1][2])],[tmpfs])
                    # Nothing else is mounted on either target: the tmpfs replaces the old dev/shm state bind.
                    self.assertEqual([e for e in mounts if e[1][1]==RB+b'/dev/shm'],[tmpfs])
                    self.assertEqual([e for e in mounts if e[1][1]==RB+b'/run/acceptance/crash'],[bind])
                    self.assertEqual([e for e in mounts if e[1][0] is not None and e[1][0].startswith(S.encode())],
                                     [(40,((S+'/'+d).encode(),(R+'/'+d).encode(),None,4096,None))
                                      for d in ('tmp','var','run/acceptance/'+name)])
                    self_bind=b.calls.index((40,(RB,RB,None,4096,None))); enter=b.calls.index(('chdir',(R,)))
                    pivot=b.calls.index((41,(b'.',b'.'))); detach=b.calls.index((39,(b'.',2)))
                    for mount in (tmpfs,bind):
                        self.assertTrue(self_bind<b.calls.index(mount)<enter<pivot<detach,mount)
                    # The crash source: created 0700 and owned by the role before its bind; both targets fresh.
                    made=('mkdir',(crash,0o700,reuse)); owned=('chown',(crash,uid,uid))
                    self.assertEqual((b.calls.count(made),b.calls.count(owned)),(1,1))
                    self.assertLess(b.calls.index(made),b.calls.index(owned))
                    self.assertLess(b.calls.index(owned),b.calls.index(bind))
                    for target,mount in ((R+'/dev/shm',tmpfs),(R+'/run/acceptance/crash',bind)):
                        self.assertLess(b.calls.index(('mkdir',(target,0o755,False))),b.calls.index(mount))
                    # State: exactly tmp, var and the role's run directory (P50), each 0700 and role-owned.
                    state=[e for e in b.calls if e[0]=='mkdir' and (e[1][0]==S or e[1][0].startswith(S+'/'))]
                    self.assertEqual(state,[('mkdir',(path,0o700,reuse)) for path in
                                            (S,S+'/tmp',S+'/var',S+'/run/acceptance/'+name)])
                    # The view root and its skeleton are always fresh, reused state or not.
                    fresh=[e[1] for e in b.calls if e[0]=='mkdir' and (e[1][0]==R or e[1][0].startswith(R+'/'))]
                    self.assertEqual([(path,exist) for path,mode,exist in fresh if exist],
                                     [(R+'/'+d,True) for d in ('tmp','var','run/acceptance/'+name)])
    def test_pre_exec_storage_admission_runs_after_seccomp_before_exec(self):
        # C7 (E5, R8): the pre-exec helper admits the role's own storage as the role UID, inside its view, after
        # the filter and the attestation and before exec. Every descriptor admission opened is released, and only
        # the proof's fixed 32-byte digest reaches exec (P17).
        self.assertTrue(hasattr(c,'storage'),'confinement admits no per-role storage before exec')
        for role in c.UIDS:
            with self.subTest(role=role):
                launch=c.prepare_role(role,c.RoleConfig(self.config(),c.role_fds(role,RUN)))
                child=ChildKernel(Kernel(),201,launch)
                with self.assertRaises(ExecBoundary): c.exec_role(launch,kernel=child)
                steps=[e if type(e) is str else e[0] for e in child.events]
                self.assertEqual(steps[:9],['views','fds','credentials','caps','nnp','filter','storage','uid','observe'])
                self.assertEqual([e[1] for e in child.events if type(e) is tuple and e[0]=='open_root'],
                                 list(c.storage.ROLE_SCOPES[role]))
                self.assertEqual(steps[9:],['open_root']*5+['close']*10+['exec'])
                self.assertEqual(child.events[-1][3:],(child.storage.digest(),()))
        launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        def shm_on_run_device(child):
            child.storage.mounts=tuple((m.path,'tmpfs',7 if m.path=='/dev/shm' else m.device,True,m.capacity_bytes,4096)
                                       for m in child.storage.kernel_state().mounts)
        def unavailable(child):
            child.storage_ports=lambda: c._fail('NATIVE_STORAGE_PORT_UNAVAILABLE')
        for name,setup,code in (('uid is not the role',lambda child:setattr(child,'uid_override',0),'STORAGE_INVALID'),
                                ('/dev/shm on the run device',shm_on_run_device,'STORAGE_INVALID'),
                                ('native storage port unavailable',unavailable,'NATIVE_STORAGE_PORT_UNAVAILABLE')):
            with self.subTest(refused=name):
                child=ChildKernel(Kernel(),201,launch); setup(child)
                with self.assertRaisesRegex(c.ConfinementError,'^'+code+'$'): c.exec_role(launch,kernel=child)
                self.assertFalse(any(type(e) is tuple and e[0]=='exec' for e in child.events))
        child=ChildKernel(Kernel(tsync=901),201,launch)
        with self.assertRaisesRegex(c.ConfinementError,'^TSYNC_FAILED$'): c.exec_role(launch,kernel=child)
        self.assertNotIn('storage',child.events)
    def test_ready_frame_appends_and_bootstrap_validates_storage_digest(self):
        # P17: the storage-admission proof is a fixed 32-byte digest appended to the ready frame (64 hex filter
        # digest + 32 bytes = 96), which the bootstrap checks against the child's five scope roots as it observes
        # them itself through /proc/<child>/root.
        self.assertTrue(callable(getattr(c.NativeChildPort,'write_ready',None)),'no fixed ready frame writer')
        b=InertBindings(); launch=c.prepare_role('VERIFIER',c.RoleConfig(self.config(),c.role_fds('VERIFIER',RUN)))
        p=c.NativeChildPort(b,launch,{c.NODE:19},ready_fd=15); p.digest='d'*64
        writes=[]; b.os.write=lambda fd,data: writes.append((fd,data)) or len(data)
        b.os.execve=lambda fd,argv,env: (b.calls.append(('execve',fd)), (_ for _ in ()).throw(ExecBoundary()))[-1]
        digest=bytes(range(32))
        with self.assertRaises(ExecBoundary): p.exec_pinned(launch.argv,launch.programs,digest)
        self.assertEqual(writes,[(15,b'd'*64+digest)])
        for bad in (b'',bytes(31),bytes(33),'x'*32,bytearray(32),None):
            with self.subTest(storage_digest=bad):
                writes.clear(); b.calls.clear()
                with self.assertRaisesRegex(c.ConfinementError,'^STORAGE_INVALID$'):
                    p.exec_pinned(launch.argv,launch.programs,bad)
                self.assertEqual((writes,b.calls),([],[]))
        b.os.write=lambda fd,data: writes.append((fd,data)) or 64
        b.calls.clear()
        with self.assertRaisesRegex(c.ConfinementError,'^ROLE_START_FAILED$'): p.exec_pinned(launch.argv,launch.programs,digest)
        self.assertEqual(b.calls,[])
        # The bootstrap side: spawn_waiting accepts only the 96-byte frame whose last 32 bytes bind this child's view.
        view=StorageView('BROWSER',[])
        good=b'd'*64+view.digest()
        k,launch,seen=self.spawn_parent(good,view)
        owned=k.spawn_waiting(launch,lambda port:None)
        self.assertEqual((owned.pid,k._owned[owned]['digest']),(701,'d'*64))
        self.assertEqual(seen,['/proc/701/root'+path for path in c.storage.ROLE_SCOPES['BROWSER']])
        other=StorageView('VERIFIER',[])
        for name,frame in (('filter digest only (64 bytes)',b'd'*64),('zero storage digest',b'd'*64+bytes(32)),
                           ('another role view',b'd'*64+other.digest()),('truncated',good[:95])):
            with self.subTest(frame=name):
                k,launch,seen=self.spawn_parent(frame,view)
                with self.assertRaises(c.RoleStartFailure): k.spawn_waiting(launch,lambda port:None)
        moved=StorageView('BROWSER',[]); moved.DEVICES=dict(moved.DEVICES,**{'/dev/shm':7})
        with self.subTest(frame='a scope root the bootstrap sees elsewhere'):
            k,launch,seen=self.spawn_parent(good,moved)
            with self.assertRaises(c.RoleStartFailure): k.spawn_waiting(launch,lambda port:None)
    def spawn_parent(self,frame,view):
        """spawn_waiting's parent side over inert pipes: the helper forked as pid 501, its one child is pid 701, the
        ready pipe holds FRAME and the result pipe the worker's WAITING line. /proc/701/root/<scope> stats answer
        VIEW's identities; every stat path is recorded."""
        b=InertBindings(); b.check_appliance=lambda:None; b.pin_programs=lambda pins:{c.NODE:19}
        pairs=iter(((20,21),(22,23),(24,25),(26,27))); b.os.pipe2=lambda flags:next(pairs); b.os.fork=lambda:501
        b.os.close=lambda fd:None; b.os.set_blocking=lambda fd,flag:None
        b.os.fstat=lambda fd:types.SimpleNamespace(st_dev=254,st_ino=999)
        streams={26:bytearray(frame),22:bytearray(b'WAITING\n')}
        def select(reads,writes,errors,timeout):
            ready=[fd for fd in reads if streams.get(fd)]
            if not ready: b.advance(0.01)
            return ready,[],[]
        def read(fd,size):
            data=bytes(streams[fd][:size]); del streams[fd][:size]; return data
        b.select,b.os.read=select,read
        b.read_file=lambda path,limit=65536:{'/proc/501/task/501/children':b'701\n'}[path]
        b.os.readlink=lambda path:{'/proc/701/fd/3':'pipe:[30]','/proc/701/fd/4':'pipe:[40]'}[path]
        seen=[]
        def stat(path):
            seen.append(path)
            _,dev,ino=view.identity(path[len('/proc/701/root'):])
            return types.SimpleNamespace(st_dev=dev,st_ino=ino)
        b.os.stat=stat
        return c.OfflineKernelPort(b),c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN))),seen
    def test_child_port_uid_is_observed_and_native_storage_port_is_gated(self):
        # P17: storage keeps its own copy of the role list and never imports confinement; the child port reports
        # the UID Linux shows for it; the native storage port stays unavailable until Stage 2 qualifies one.
        self.assertTrue(hasattr(c,'storage'),'confinement has no storage module')
        self.assertEqual(dict(c.storage.UIDS),dict(c.UIDS))
        self.assertEqual(dict(c.storage.ROLE_SCOPES),{role:('/run/acceptance/'+role.lower(),'/tmp','/var','/dev/shm',
                                                           '/run/acceptance/crash') for role in c.UIDS})
        tree=ast.parse((ROOT/'guest/storage.py').read_text())
        imported=[ast.unparse(n) for n in ast.walk(tree) if isinstance(n,(ast.Import,ast.ImportFrom))]
        self.assertFalse([line for line in imported if 'confinement' in line or 'importlib' in line],imported)
        self.assertNotIn('spec_from_file_location',(ROOT/'guest/storage.py').read_text())
        b=InertBindings(); launch=c.prepare_role('VERIFIER',c.RoleConfig(self.config(),c.role_fds('VERIFIER',RUN)))
        p=c.NativeChildPort(b,launch,{})
        def status(uids):
            text='Name:\tpython3\nUid:\t'+uids+'\nGid:\t10003\t10003\t10003\t10003\n'
            b.read_file=lambda path,limit=65536:{'/proc/self/status':text.encode('ascii')}[path]
        status('10003\t10003\t10003\t10003')
        self.assertEqual(p.uid(),10003)
        for uids in ('0\t10003\t10003\t10003','10003\t0\t10003\t10003','10003\t10003\t0\t10003',
                     '10003\t10003\t10003\t0','10003\t10003\t10003','x\tx\tx\tx','010003\t010003\t010003\t010003'):
            with self.subTest(uid_line=uids):
                status(uids)
                with self.assertRaisesRegex(c.ConfinementError,'^UID_DENIED$'): p.uid()
        for name in ('storage_ports','observe'):
            with self.subTest(native=name), self.assertRaisesRegex(c.ConfinementError,'^NATIVE_STORAGE_PORT_UNAVAILABLE$'):
                getattr(p,name)()
        # A probe family admits nothing: its ready frame binds its own view from its own stats inside the view.
        view=StorageView('VERIFIER',[]); seen=[]
        def stat(path):
            seen.append(path); _,dev,ino=view.identity(path); return types.SimpleNamespace(st_dev=dev,st_ino=ino)
        b.os.stat=stat
        self.assertEqual(p.scope_digest(),view.digest())
        self.assertEqual(seen,list(c.storage.ROLE_SCOPES['VERIFIER']))
    def cleanup_port(self,*,live=None,fail=None,rmdir_fail=None,view=None):
        """An OfflineKernelPort whose four original role children are reaped (LIVE names one still running) and
        whose spawn_waiting runs the given entry, in process, over a CleanupChild double (pid 401) whose storage is
        VIEW (a StorageView by default). The parent's own effects and the child's calls share LOG; the child's FD4
        writes are the result pipe. self.budget is the run's one started-at-terminal cleanup budget (P67, C1); every
        wait the cleanup asks of this port is recorded in self.waits as (kind, allowance in ms)."""
        b=InertBindings(); log=[]; out=bytearray(); children={}
        self.budget=V1Budget(); self.waits=waits=[]
        def rmdir(path):
            log.append(('rmdir',path))
            if rmdir_fail is not None and rmdir_fail(path): raise OSError(39,'inert directory not empty')
        b.os.rmdir=rmdir; b.os.unlink=lambda path: log.append(('unlink',path))
        b.os.write=lambda fd,data: log.append(('parent-write',fd,data)) or len(data)
        k=c.OfflineKernelPort(b)
        launches={role:c.prepare_role(role,c.RoleConfig(self.config(k),c.role_fds(role,RUN))) for role in c.UIDS}
        for index,role in enumerate(c.UIDS):
            original=c.NativeOwned(301+index,RUN,role,'command','result')
            k._owned[original]={'outer':300+index,'child':301+index,'launch':launches[role],'terminal':
                                None if role==live else {'status':'STOPPED','pid':301+index,'run_id':RUN}}
        def spawn(launch,entry,*,limit_ms=None):
            log.append(('spawn',launch))
            waits.append(('start',None if limit_ms is None else limit_ms()))
            child=children[launch.role]=CleanupChild(launch,log,out,fail=fail,view=view)
            try: entry(child)
            except ExecBoundary: pass
            owned=c.NativeOwned(401,RUN,launch.role,'command2','result2')
            k._owned[owned]={'outer':400,'child':401,'launch':launch,'terminal':None}
            # As the real parent: the 96-byte ready frame, then the WAITING line, else the start failed.
            if child.ready is None or bytes(out[:8])!=b'WAITING\n': raise c.RoleStartFailure(owned)
            del out[:8]
            return owned
        def read_exact(fd,count,deadline,**kwargs):
            waits.append(('read',deadline))
            data=bytes(out[:count]); del out[:count]
            if fd!='result2' or len(data)!=count: c._fail('ROLE_START_FAILED')
            return data
        k.spawn_waiting,k._read_exact=spawn,read_exact
        k.wait_owned=lambda owned,ms: (log.append(('wait',owned.pid)), waits.append(('wait',ms)))[0] or {
            'status':'EXITED','pid':owned.pid,'run_id':RUN}
        k.stop_owned=lambda owned,ms: (log.append(('stop',owned.pid)), waits.append(('stop',ms)))[0] or {
            'status':'STOPPED','pid':owned.pid,'run_id':RUN}
        return k,b,log,launches,children
    @staticmethod
    def view_paths(role):
        name=role.lower(); R='/run/acceptance/'+name+'/.root'; S='/run/acceptance/'+name+'/.state'
        skeleton=[('unlink',R+'/dev/null')]+[('rmdir',R+suffix) for suffix in (
            '/run/acceptance/'+name,'/run/acceptance/crash','/run/acceptance','/run','/dev/shm','/dev','/proc',
            '/tmp','/var','/etc','/lib64','/lib','/usr','/opt','')]
        backing=[('rmdir',S+suffix) for suffix in ('/run/acceptance/'+name,'/run/acceptance','/run','/var','/tmp','')]
        return skeleton,backing+[('rmdir','/run/acceptance/crash/'+name)]
    def test_storage_cleanup_child_is_fixed_operation(self):
        # C7 (R8, P11): cleanup is one fixed operation in a fresh confined child with the role's views, UID and
        # filter: its own admission, a metadata-only crash aggregate, removal, one fixed result frame. No exec, no
        # caller entry, path or operation. Only after every child of that role's view has its terminal receipt
        # (its /dev/shm went with its mount namespace, P16) does the bootstrap remove its own root-owned skeleton.
        self.assertTrue(callable(getattr(c._KernelPortCore,'run_storage_cleanup',None)),'no per-role storage cleanup')
        parameters=inspect.signature(c._KernelPortCore.run_storage_cleanup).parameters
        self.assertEqual(list(parameters),['self','role','launch','budget'])  # P67: the caller's shared budget
        self.assertIs(parameters['budget'].kind,inspect.Parameter.KEYWORD_ONLY)
        self.assertIs(parameters['budget'].default,inspect.Parameter.empty)
        k,b,log,launches,children=self.cleanup_port()
        for role in c.UIDS:
            with self.subTest(role=role):
                del log[:]
                launch=launches[role]; child_uid=launch.uid
                result=k.run_storage_cleanup(role,launch,budget=self.budget)
                self.assertEqual(result,c.storage.CleanupResult(True,False,'COMPLETE'))
                skeleton,backing=self.view_paths(role)
                spawn=log.index(('spawn',launch))
                self.assertEqual(log[:spawn],skeleton)
                child=children[role]
                calls=[e for e in log[spawn+1:] if e[0] not in ('open_root','close')]
                frame=dict(version=1,kind='STORAGE_CLEANUP',role=role,removed=True,code='COMPLETE',
                           policyDigest='a'*64,fileCount=0,directoryCount=0,logicalBytes=0,allocatedBytes=0)
                self.assertEqual(calls[:13],[
                    ('establish_views',launch.views,True),('close_unaudited_fds',launch.fds),
                    ('drop_credentials',child_uid,child_uid),('clear_capabilities',),('no_new_privs',),
                    ('install_seccomp',1),('inspect',),('storage_ports',),('uid',),('observe',),
                    ('write_ready',child.storage.digest()),('write',4,b'WAITING\n'),('write',4,v1_bytes(frame))])
                self.assertEqual(calls[13:],[('read',3,4),('_exit',0),('parent-write','command2',b'EXIT'),
                                             ('wait',401)]+skeleton+backing)
                opened=[e[1] for e in log if e[0]=='open_root']
                self.assertEqual(opened,list(c.storage.ROLE_SCOPES[role]))
                self.assertEqual(sum(e[0]=='close' for e in log),10)
                self.assertNotIn('exec',[e[0] for e in log])
                # P16: the bootstrap never unmounts (nor makes any raw syscall); teardown reclaimed /dev/shm.
                self.assertEqual([e for e in b.calls if type(e[0]) is int],[])
        self.assertEqual(k.crash_summary(),c.storage.CrashAggregate('a'*64,0,0,0,0,False))
    # --- P67 (C1): every cleanup wait is clamped to the run's one shared cleanup budget --------------------------------
    def test_storage_cleanup_normal_child_completes_well_inside_the_shared_budget(self):
        # A normal child completes, and every wait it was given is the shared end's remainder, never a fixed 30 s:
        # the start step is min(2000, remaining), the result frame waits are the remaining allowance itself.
        k,b,log,launches,children=self.cleanup_port()
        self.budget.start_terminal(); self.budget.clamp_end(self.budget.clock.mono+5000)
        self.assertEqual(k.run_storage_cleanup('PROXY',launches['PROXY'],budget=self.budget),
                         c.storage.CleanupResult(True,False,'COMPLETE'))
        self.assertEqual(self.waits,[('start',5000),('read',5000),('read',5000),('wait',2000)])
        self.assertEqual(self.budget.remaining(),5000)  # the shared end was neither moved nor reallocated
    def sim_port(self,stage,budget_ms):
        """The real spawn_waiting, _read_exact and stop_owned over inert pipes and a simulated clock, which advances
        only while a wait polls (10 ms per empty poll), with topology's real CleanupBudget on the same clock: started
        once (the run's terminal event) and clamped to BUDGET_MS. STAGE 'ready': no cleanup child ever writes its
        ready frame. STAGE 'result': each child starts (a valid ready frame for its own view, then WAITING) but never
        writes its result frame. Returns (port, launches, budget, now_ms, writes, spawned)."""
        topology=topology_module()
        b=InertBindings(); b.check_appliance=lambda:None; b.pin_programs=lambda pins:{c.NODE:19}
        fds=iter(range(20,4000,2)); pids=iter(range(501,600)); pairs=[]; streams={}; spawned=[]; writes=[]; role=[None]
        def pipe2(flags):
            n=next(fds); pairs.append((n,n+1)); return (n,n+1)
        def fork():
            outer=next(pids); spawned.append(outer)
            command,result,stop,ready=pairs[-4:]
            if stage=='result':
                view=StorageView(role[0],[])
                streams[ready[0]]=bytearray(b'd'*64+view.digest()); streams[result[0]]=bytearray(b'WAITING\n')
            return outer
        def select(reads,writes_,errors,timeout):
            ready=[fd for fd in reads if streams.get(fd)]
            if not ready: b.advance(0.01)
            return ready,[],[]
        def read(fd,size):
            data=bytes(streams[fd][:size]); del streams[fd][:size]; return data
        def stat(path):
            _,dev,ino=StorageView(role[0],[]).identity(path.split('/root',1)[1])
            return types.SimpleNamespace(st_dev=dev,st_ino=ino)
        b.os.pipe2,b.os.fork,b.select,b.os.read,b.os.stat=pipe2,fork,select,read,stat
        b.os.close=b.os.unlink=b.os.rmdir=lambda path:None; b.os.set_blocking=lambda fd,flag:None
        b.os.fstat=lambda fd:types.SimpleNamespace(st_dev=254,st_ino=999)
        b.os.write=lambda fd,data: writes.append((fd,data)) or len(data)
        b.read_file=lambda path,limit=65536:(str(int(path.split('/')[2])+200)+'\n').encode()
        b.os.readlink=lambda path:'pipe:[30]' if path.endswith('/3') else 'pipe:[40]'
        k=c.OfflineKernelPort(b)
        spawn=k.spawn_waiting
        def spawn_as(launch,entry,**kwargs):
            role[0]=launch.role; return spawn(launch,entry,**kwargs)
        k.spawn_waiting=spawn_as
        now=lambda:int(round(b.clock*1000))
        budget=topology.CleanupBudget(types.SimpleNamespace(sample=lambda:(now(),now())),real_clock=now)
        budget.start_terminal(); budget.clamp_end(now()+budget_ms)
        launches={name:c.prepare_role(name,c.RoleConfig(self.config(k),c.role_fds(name,RUN))) for name in c.UIDS}
        return k,launches,budget,now,writes,spawned
    def test_storage_cleanup_stalled_child_is_stopped_within_the_shared_budget(self):
        # A child that never writes its ready frame, or never its result frame, is stopped (its helper kills it) and
        # the cleanup returns TIMEOUT and sticky-incomplete within the shared budget plus one poll (10 ms).
        timeout=c.storage.CleanupResult(False,False,'CLEANUP_TIMEOUT')
        for stage in ('ready','result'):
            with self.subTest(stall=stage):
                k,launches,budget,now,writes,spawned=self.sim_port(stage,300)
                end=budget.deadline; start=now()
                self.assertEqual(k.run_storage_cleanup('BROWSER',launches['BROWSER'],budget=budget),timeout)
                self.assertGreaterEqual(now()-start,290)          # it did wait for the child, up to the shared end
                self.assertLessEqual(now()-start,300+10)
                self.assertEqual(budget.deadline,end)
                owned=next(o for o,s in k._owned.items() if s['outer']==spawned[0])
                self.assertIn((k._owned[owned]['stop'],b'STOP'),writes)  # the original child was stopped
                self.assertEqual(k.run_storage_cleanup('BROWSER',launches['BROWSER'],budget=budget),
                                 c.storage.CleanupResult(False,False,'CLEANUP_INCOMPLETE'))  # sticky, one use
    def test_storage_cleanup_of_four_roles_never_exceeds_the_one_shared_budget(self):
        # C1: the four roles' cleanups share the run's one budget. The first stalled child uses all of it; the
        # others find it exhausted and return TIMEOUT at once, spawning nothing. The end is never moved or renewed.
        k,launches,budget,now,writes,spawned=self.sim_port('ready',400)
        end=budget.deadline; start=now()
        results=[k.run_storage_cleanup(role,launches[role],budget=budget) for role in c.UIDS]
        self.assertEqual(results,[c.storage.CleanupResult(False,False,'CLEANUP_TIMEOUT')]*4)
        self.assertLessEqual(now()-start,400+10)
        self.assertEqual(len(spawned),1)
        self.assertEqual(budget.deadline,end)
        self.assertEqual(budget.remaining(),0)
    def test_storage_cleanup_refuses_anything_that_is_not_a_cleanup_budget(self):
        k,b,log,launches,children=self.cleanup_port()
        for budget in (None,object(),types.SimpleNamespace(remaining=lambda:60000)):
            with self.subTest(budget=budget):
                self.assertEqual(k.run_storage_cleanup('BROWSER',launches['BROWSER'],budget=budget),
                                 c.storage.CleanupResult(False,False,'CLEANUP_INCOMPLETE'))
                self.assertEqual(log,[])
    def test_storage_cleanup_removes_role_created_content_without_admission_strictness(self):
        # P66: the cleanup child verifies its scope roots as admitted, then removes whatever the role created there
        # (symlinks as links, sockets, FIFOs, a 0500 directory made u+rwx through its descriptor, a 0000 file),
        # never through a symlink and never by opening content. The pre-exec admission still refuses that content.
        self.assertTrue(callable(getattr(c.storage,'verify_role_scopes',None)),'no cleanup scope verification')
        k,b,log,launches,children=self.cleanup_port(view=ContentView)
        self.assertEqual(k.run_storage_cleanup('BROWSER',launches['BROWSER'],budget=self.budget),c.storage.CleanupResult(True,False,'COMPLETE'))
        view=children['BROWSER'].storage
        self.assertEqual(view.tree['children'],{})
        content=[e[1:] for e in log if e[0]=='content']
        default=ContentView('BROWSER',[]).tree['children']['Default']['inode']  # the numbering is deterministic
        self.assertEqual([e for e in content if e[0]=='chmod'],[('chmod',default,0o700)])
        self.assertEqual(sorted(e[1] for e in content if e[0]=='unlink'),
                         sorted(('SingletonLock','SingletonSocket','SingletonCookie','socket','fifo','Lock','Preferences','index')))
        self.assertEqual(sorted(e[1] for e in content if e[0]=='rmdir'),['Cache','Cache_Data','Default'])
        self.assertEqual(sorted(e[1] for e in content if e[0]=='open_directory'),['Cache','Cache_Data','Default'])
        frame=[e for e in log if e[:2]==('write',4) and e[2]!=b'WAITING\n']
        self.assertEqual(json.loads(frame[0][2][4:])['removed'],True)
        # The same content before exec: the strict admission refuses it and the role never execs.
        launch=c.prepare_role('BROWSER',c.RoleConfig(self.config(),c.role_fds('BROWSER',RUN)))
        child=ChildKernel(Kernel(),201,launch); child._storage=ContentView('BROWSER',child.events)
        with self.assertRaisesRegex(c.ConfinementError,'^STORAGE_INVALID$'): c.exec_role(launch,kernel=child)
        self.assertFalse(any(type(e) is tuple and e[0]=='exec' for e in child.events))
        self.assertEqual(len(child._storage.tree['children']),6)
    def test_storage_cleanup_preconditions_and_failures_stay_incomplete(self):
        self.assertTrue(callable(getattr(c._KernelPortCore,'run_storage_cleanup',None)),'no per-role storage cleanup')
        incomplete=c.storage.CleanupResult(False,False,'CLEANUP_INCOMPLETE')
        # A role child still running holds its view and /dev/shm: nothing is touched (P16).
        k,b,log,launches,children=self.cleanup_port(live='BROWSER')
        self.assertEqual(k.run_storage_cleanup('BROWSER',launches['BROWSER'],budget=self.budget),incomplete)
        self.assertEqual(log,[])
        # Launch records not recomputed from the role's own contract, and another role's launch.
        k,b,log,launches,children=self.cleanup_port()
        for name,role,launch in (('forged uid','BROWSER',dataclasses.replace(launches['BROWSER'],uid=0)),
                                 ('unsealed','BROWSER',dataclasses.replace(launches['BROWSER'],_seal=None)),
                                 ('another role','PROXY',launches['BROWSER']),('unknown role','ROOT',launches['BROWSER'])):
            with self.subTest(launch=name):
                self.assertEqual(k.run_storage_cleanup(role,launch,budget=self.budget),incomplete)
                self.assertEqual(log,[])
        # One-use per role.
        self.assertEqual(k.run_storage_cleanup('BROWSER',launches['BROWSER'],budget=self.budget).code,'COMPLETE')
        del log[:]
        self.assertEqual(k.run_storage_cleanup('BROWSER',launches['BROWSER'],budget=self.budget),incomplete)
        self.assertEqual(log,[])
        # A child that cannot admit never writes its ready frame: it is stopped, nothing is recorded.
        k,b,log,launches,children=self.cleanup_port(fail='uid')
        self.assertEqual(k.run_storage_cleanup('VERIFIER',launches['VERIFIER'],budget=self.budget),incomplete)
        self.assertIn(('stop',401),log); self.assertIn(('_exit',78),log)
        self.assertNotIn(('wait',401),log)
        with self.assertRaisesRegex(c.ConfinementError,'^CLEANUP_INCOMPLETE$'): k.crash_summary()
        # The bootstrap cannot clear the old skeleton: no child is spawned.
        k,b,log,launches,children=self.cleanup_port(rmdir_fail=lambda path: path.endswith('/.root/dev/shm'))
        self.assertEqual(k.run_storage_cleanup('PROXY',launches['PROXY'],budget=self.budget),incomplete)
        self.assertFalse(any(e[0]=='spawn' for e in log))
        # Backing state the child left behind keeps the result incomplete (sticky), after the child has exited.
        k,b,log,launches,children=self.cleanup_port(rmdir_fail=lambda path: path.endswith('/.state/tmp'))
        self.assertEqual(k.run_storage_cleanup('CONTROLLER',launches['CONTROLLER'],budget=self.budget),incomplete)
        self.assertIn(('wait',401),log)
        # Only the four role summaries combine.
        k,b,log,launches,children=self.cleanup_port()
        for role in ('CONTROLLER','BROWSER','VERIFIER'): k.run_storage_cleanup(role,launches[role],budget=self.budget)
        with self.assertRaisesRegex(c.ConfinementError,'^CLEANUP_INCOMPLETE$'): k.crash_summary()
    def test_role_shm_is_reclaimed_by_namespace_teardown_never_unmounted(self):
        # P16 (C7): a parent cannot unmount a mount of a child's private mount namespace; the role's /dev/shm
        # tmpfs is reclaimed when that namespace is torn down. The probe family owner stops (and so tears down)
        # its family first, then removes only directories, crash directory included, with no unmount at all.
        probe=probe_module('task14_p16_probe')
        b=InertBindings(); log=[]
        b.os.rmdir=lambda path: log.append(('rmdir',path)); b.os.unlink=lambda path: log.append(('unlink',path))
        b.os.path=types.SimpleNamespace(lexists=lambda path: log.append(('lexists',path)) and False)
        b.syscall=lambda nr,*args: log.append(('syscall',nr,args))
        stop=lambda owned,ms: log.append(('stop',owned.pid)) or {'status':'STOPPED','pid':owned.pid,'run_id':RUN}
        fixtures=types.SimpleNamespace(kernel=types.SimpleNamespace(b=b,stop_owned=stop))
        R,S='/run/acceptance/browser/.root','/run/acceptance/browser/.state'
        family=probe._ProbeFamilyOwner(fixtures,'BROWSER.case','BROWSER',R,S,None)
        family.owned=c.NativeOwned(301,RUN,'BROWSER','command','result')
        family.stop_owned(probe.PROBE_FAMILY_STOP_MS)
        skeleton,backing=self.view_paths('BROWSER')
        self.assertEqual(log,[('stop',301)]+skeleton+backing+[('lexists',R),('lexists',S),
                                                                 ('lexists','/run/acceptance/crash/browser')])
        self.assertEqual([e for e in log if e[0]=='syscall'],[])
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
        self.assertTrue(hasattr(probe,'OfflineProbeFixtures'),'offline fixture subprocess source absent')
        b=InertBindings(); k=c.OfflineKernelPort(b); config=self.config(k); stopped=[]
        b.os.path=types.SimpleNamespace(lexists=lambda path:False)
        b.os.unlink=lambda path:None; b.os.rmdir=lambda path:None
        owned=c.NativeOwned(501,RUN,'BROWSER',object(),object())
        k.spawn_waiting=lambda *a: (_ for _ in ()).throw(c.RoleStartFailure(owned))
        k.stop_owned=lambda child,deadline:stopped.append(child) or {'status':'STOPPED','pid':501,'run_id':RUN}
        # Task 10: every fixture-authority method is required (foreign_pid and audit are retired).
        authority=types.SimpleNamespace(**{n:lambda *a:None for n in probe._FIXTURE_AUTHORITY})
        authority.approve_offline_fixtures=lambda config:authority
        fixture=probe.OfflineProbeFixtures(c,k,config,authority)
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
                  'child_fork_exec_network_gpu_crash_helper_ipv6','fixed_ip_denied',
                  'browser_user_namespace_available')  # P49
        self.assertEqual(tuple(probe.PROBES),expected)
        # Fake probe observations exercise only result validation, never native qualification. Each result carries
        # its operation's basis (Task 10).
        port=types.SimpleNamespace(attempt=lambda case:tuple({'operation':op,'attempted':True,'denied':True,'receiver_count':0,'basis':'KERNEL_ERRNO'} for op in case.operations))
        self.assertEqual(len(probe.run_case('vsock_browser_controller_verifier_denied',port)),6)
        port.attempt=lambda case:tuple({'operation':op,'attempted':False,'denied':True,'receiver_count':0,'basis':'KERNEL_ERRNO'} for op in case.operations)
        with self.assertRaises(probe.ProbeFailure): probe.run_case('vsock_browser_controller_verifier_denied',port)
        port.attempt=lambda case:tuple({'operation':op,'attempted':True,'denied':True,'receiver_count':1,'basis':'KERNEL_ERRNO'} for op in case.operations)
        with self.assertRaises(probe.ProbeFailure): probe.run_case('vsock_browser_controller_verifier_denied',port)
    def test_probe_proxy_positive_requires_actual_delivery(self):
        p=ROOT/'tests/guest/confinement_probe.py'
        self.assertTrue(p.exists(),'Task8 proxy probe result validation is absent')
        s=importlib.util.spec_from_file_location('task8_proxy_probe_contract',p)
        probe=importlib.util.module_from_spec(s); s.loader.exec_module(probe)
        port=types.SimpleNamespace(attempt=lambda case:({'operation':'PROXY.fixed-vsock-CID2-port4050','attempted':True,'denied':False,'receiver_count':0,'basis':'OBSERVED'},))
        with self.assertRaises(probe.ProbeFailure): probe.run_case('proxy_fixed_vsock_positive',port)
        port.attempt=lambda case:({'operation':'PROXY.fixed-vsock-CID2-port4050','attempted':True,'denied':False,'receiver_count':1,'basis':'OBSERVED'},)
        self.assertEqual(len(probe.run_case('proxy_fixed_vsock_positive',port)),1)
    def test_native_kernel_port_requires_seal(self):
        # T8-05 (review demonstration D5): NativeKernelPort over injected bindings used to pass as native.
        with self.subTest(construct='D5: NativeKernelPort(SimpleNamespace())'):
            with self.assertRaisesRegex(c.ConfinementError, '^NATIVE_GATE_DENIED$'):
                c.NativeKernelPort(types.SimpleNamespace())
        unvalidated = c.LinuxBindings.__new__(c.LinuxBindings)
        # Each clause of the seal alone (Task 9 mutants D5-seal, D5-type): private module objects are forged here
        # only so that exactly one condition is false in each construction.
        identity = c.GuestRuntimeIdentity(c.ProgramPin(c.PYTHON, 'a' * 64),
                                          c.ProgramPin('/usr/lib/aarch64-linux-gnu/libc.so.6', 'b' * 64), 'c' * 64)
        validated = c._ValidatedRuntime(identity, c._NATIVE_SEAL)
        forged = c.LinuxBindings.__new__(c.LinuxBindings); forged._runtime = validated
        carrying = InertBindings(); carrying._runtime = validated
        for name, make in (('inert bindings', lambda: c.NativeKernelPort(InertBindings())),
                           ('LinuxBindings with a validated runtime, without the seal', lambda: c.NativeKernelPort(forged)),
                           ('seal over inert bindings carrying a validated runtime',
                            lambda: c.NativeKernelPort(carrying, seal=c._NATIVE_KERNEL_SEAL)),
                           ('foreign seal', lambda: c.NativeKernelPort(InertBindings(), seal=object())),
                           ('seal over inert bindings',
                            lambda: c.NativeKernelPort(InertBindings(), seal=c._NATIVE_KERNEL_SEAL)),
                           ('seal over unvalidated LinuxBindings',
                            lambda: c.NativeKernelPort(unvalidated, seal=c._NATIVE_KERNEL_SEAL))):
            with self.subTest(construct=name), self.assertRaisesRegex(c.ConfinementError, '^NATIVE_GATE_DENIED$'):
                make()
        with self.subTest(construct='subclass'), self.assertRaises(TypeError):
            type('ForgedNative', (c.NativeKernelPort,), {})
        # Only select_native_kernel seals, over its own LinuxBindings; it takes no injected factory, and offline
        # (this host is not the pinned Linux guest) its own loader refuses before any effect.
        self.assertNotIn('bindings_factory', inspect.signature(c.select_native_kernel).parameters)
        with self.assertRaisesRegex(c.ConfinementError, '^NATIVE_GATE_DENIED$'):
            c.select_native_kernel('bootstrap-check', runtime_identity=identity, validate_runtime=lambda value: value)
        # The offline port is a distinct, unsealed type: never a NativeKernelPort, never a subclass of it.
        offline = c.OfflineKernelPort(InertBindings())
        self.assertIsNot(type(offline), c.NativeKernelPort)
        self.assertNotIsInstance(offline, c.NativeKernelPort)
        self.assertFalse(issubclass(c.NativeKernelPort, c.OfflineKernelPort))
        # NativeProbeFixtures accepts only the sealed native port; OfflineProbeFixtures only the offline one.
        spec = importlib.util.spec_from_file_location('task9_seal_probe', ROOT / 'tests/guest/confinement_probe.py')
        probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
        authority = types.SimpleNamespace(**{n: (lambda *a: None) for n in probe._FIXTURE_AUTHORITY})
        authority.approve_native_fixtures = authority.approve_offline_fixtures = lambda config: authority
        config = self.config(offline)
        with self.subTest(fixtures='native over offline port'):
            with self.assertRaisesRegex(probe.RuntimeGateUnavailable, '^NATIVE_FIXTURES_UNAVAILABLE$'):
                probe.NativeProbeFixtures(c, offline, config, authority)
        self.assertIs(type(probe.OfflineProbeFixtures(c, offline, config, authority)), probe.OfflineProbeFixtures)
        class SubPort(c.OfflineKernelPort): pass
        for name, kernel in (('subclass of the offline port', SubPort(InertBindings())), ('finite double', Kernel())):
            with self.subTest(fixtures=name):
                with self.assertRaisesRegex(probe.RuntimeGateUnavailable, '^OFFLINE_FIXTURES_UNAVAILABLE$'):
                    probe.OfflineProbeFixtures(c, kernel, config, authority)


class LiteralProc:
    """Literal Linux 6.8 /proc text and view stat facts for one confined role (Task 9: T8-04, T8-09, P47).

    Read only through the bindings a port reads: read_file, os.listdir, os.readlink and os.stat. The parent view is
    the role child pid 300 as the bootstrap sees it: /proc/<pid>/root is the role's self-bound view root (Task 8b)
    and the bootstrap's own /proc/self/ns are the initial namespaces. local=True is the child's own view after
    pivot_root (pid 201, the InertBindings getpid), with the bootstrap's initial namespaces kept on the bindings.
    Formats: fs/proc/array.c proc_pid_status and do_task_stat (tty_nr is the fifth field after the closing
    parenthesis of comm, which may itself hold ')' and spaces); fs/proc_namespace.c show_mountinfo (mount points
    relative to the target task's root). Tests change exactly one fact before the port reads it.
    """
    INITIAL = {'pid': 'pid:[4026531836]', 'mnt': 'mnt:[4026531841]', 'user': 'user:[4026531837]'}
    ROLE = {'pid': 'pid:[4026532301]', 'mnt': 'mnt:[4026532300]', 'user': 'user:[4026531837]'}
    # The /run tmpfs, the bootstrap's 1 MiB crash tmpfs, and the role's own 64 MiB /dev/shm tmpfs (Task 14, C7).
    RUN_DEV, CRASH_DEV, SHM_DEV = 25, 26, 41
    SOURCES = {'tmpfs': 'tmpfs', 'ext4': '/dev/vda', 'devtmpfs': 'devtmpfs', 'proc': 'proc', 'sysfs': 'sysfs'}

    def __init__(self, role='BROWSER', *, local=False):
        self.role, self.local, self.name = role, local, role.lower()
        self.uid, self.pid = c.UIDS[role], 201 if local else 300
        self.base = '/proc/%d' % self.pid
        self.launch = c.prepare_role(role, c.RoleConfig(ConfinementTests().config(), c.role_fds(role, RUN)))
        self.digest = hashlib.sha256(c.filter_bytes(self.launch.filter)).hexdigest()
        ids = '\t'.join((str(self.uid),) * 4)
        self.status = {'Name': 'node', 'Umask': '0022', 'State': 'S (sleeping)', 'Tgid': str(self.pid), 'Ngid': '0',
                       'Pid': str(self.pid), 'PPid': '1', 'TracerPid': '0', 'Uid': ids, 'Gid': ids, 'FDSize': '64',
                       'Groups': ' ', 'CapInh': '0' * 16, 'CapPrm': '0' * 16, 'CapEff': '0' * 16, 'CapBnd': '0' * 16,
                       'CapAmb': '0' * 16, 'NoNewPrivs': '1', 'Seccomp': '2', 'Seccomp_filters': '1',
                       'Speculation_Store_Bypass': 'thread vulnerable'}
        self.comm, self.tty_nr = 'node', 0
        self.cmdline = list(self.launch.argv)
        # fd -> (link, st_dev, st_ino, fdinfo flags): /dev/null on devtmpfs, the FD3 read end, the FD4 write end.
        self.fds = {0: ('/dev/null', 5, 6, 2), 1: ('/dev/null', 5, 6, 2), 2: ('/dev/null', 5, 6, 2),
                    3: ('pipe:[30]', 13, 30, 0), 4: ('pipe:[40]', 13, 40, 1)}
        self.namespaces = dict(self.ROLE)                                   # /proc/<pid>/ns
        self.self_namespaces = dict(self.ROLE if local else self.INITIAL)  # /proc/self/ns of the reader
        self.initial = dict(self.INITIAL)                                  # bindings.initial_namespaces
        self.root = self.view_root = (self.RUN_DEV, 555)
        self.dev, self.run = ['null', 'shm'], [self.name, 'crash']
        self.crash_device = self.CRASH_DEV                                  # bindings.crash_device (check_appliance)
        state = ('/tmp', '/var', '/run/acceptance/' + self.name)
        self.tmpfs = {path: dict(mode=0o40700, uid=self.uid, gid=self.uid, dev=self.RUN_DEV) for path in state}
        self.tmpfs['/dev/shm'] = dict(mode=0o40700, uid=self.uid, gid=self.uid, dev=self.SHM_DEV)
        self.tmpfs['/run/acceptance/crash'] = dict(mode=0o40700, uid=self.uid, gid=self.uid, dev=self.CRASH_DEV)
        # (mount point, root within its filesystem, mount options, fstype, st_dev text[, super options]): the Task 8b
        # view with Task 14's role tmpfs and crash bind (P50). Super options follow mm/shmem.c shmem_show_options
        # (size in KiB, then mode, uid, gid, inode64); a row without them shows only ro/rw.
        role_tmpfs = 'rw,size=65536k,mode=700,uid=%d,gid=%d,inode64' % (self.uid, self.uid)
        self.mounts = ([('/', '/acceptance/' + self.name + '/.root', 'rw,relatime', 'tmpfs', '0:25')] +
                       [('/' + d, '/' + d, 'ro,relatime', 'ext4', '254:0') for d in ('opt', 'usr', 'lib', 'lib64', 'etc')] +
                       [(p, '/acceptance/' + self.name + '/.state' + p, 'rw,relatime', 'tmpfs', '0:25') for p in state] +
                       [('/dev/shm', '/', 'rw,nosuid,nodev,noexec,relatime', 'tmpfs', '0:41', role_tmpfs),
                        ('/run/acceptance/crash', '/' + self.name, 'rw,nosuid,nodev,noexec,relatime', 'tmpfs', '0:26',
                         'rw,size=1024k,inode64'),
                        ('/dev/null', '/null', 'rw,nosuid', 'devtmpfs', '0:5'),
                        ('/proc', '/', 'rw,nosuid,nodev,noexec,relatime', 'proc', '0:30')])

    def mountinfo(self):
        return ''.join('%d %d %s %s %s %s - %s %s %s\n' % (
            200 + index, 199 if index == 0 else 200, row[4], row[1], row[0], row[2], row[3], self.SOURCES[row[3]],
            row[5] if len(row) > 5 else 'ro' if row[2].startswith('ro') else 'rw')
            for index, row in enumerate(self.mounts)).encode('ascii')

    def files(self):
        tail = ['S', '1', str(self.pid), str(self.pid), str(self.tty_nr), '-1', '4194560'] + ['0'] * 43
        files = {self.base + '/status': ''.join(k + ':\t' + v + '\n' for k, v in self.status.items()).encode('ascii'),
                 self.base + '/stat': ('%d (%s) %s\n' % (self.pid, self.comm, ' '.join(tail))).encode('ascii'),
                 self.base + '/cmdline': b''.join(arg.encode() + b'\0' for arg in self.cmdline),
                 self.base + '/mountinfo': self.mountinfo()}
        for fd, (link, dev, ino, flags) in self.fds.items():
            files[self.base + '/fdinfo/%d' % fd] = (
                'pos:\t0\nflags:\t0%o\nmnt_id:\t%d\nino:\t%d\n' % (flags, dev, ino)).encode('ascii')
        return files

    def read_file(self, path, limit=65536):
        data = self.files().get(path)
        if data is None: raise FileNotFoundError(path)
        if len(data) > limit: raise c.ConfinementError('OBSERVATION_LIMIT')
        return data

    def listdir(self, path):
        view = '' if self.local else self.base + '/root'
        # Locally the held node pin is fd 19, and listing opens one transient directory fd (7) that is gone again.
        listing = {self.base + '/fd': [str(fd) for fd in sorted(self.fds)] + (['19', '7'] if self.local else []),
                   view + '/dev': list(self.dev), view + '/run/acceptance': list(self.run)}
        if path not in listing: raise FileNotFoundError(path)
        return listing[path]

    def readlink(self, path):
        if path.startswith('/proc/self/ns/'): return self.self_namespaces[path[len('/proc/self/ns/'):]]
        if path.startswith(self.base + '/ns/'): return self.namespaces[path[len(self.base + '/ns/'):]]
        if path.startswith(self.base + '/fd/'):
            fd = int(path.rsplit('/', 1)[1])
            if fd in self.fds: return self.fds[fd][0]
            if self.local and fd == 19: return c.NODE
        raise FileNotFoundError(path)

    def stat(self, path):
        def node(dev, ino, mode=0o40755, uid=0, gid=0):
            return types.SimpleNamespace(st_dev=dev, st_ino=ino, st_mode=mode, st_uid=uid, st_gid=gid)
        view = '' if self.local else self.base + '/root'
        if path == self.base + '/root': return node(*self.root)
        if path == self.launch.views.root + '/.root': return node(*self.view_root)
        if path == self.base + '/exe': return node(254, 999, 0o100755)
        if path.startswith(self.base + '/fd/') and int(path.rsplit('/', 1)[1]) in self.fds:
            link, dev, ino, flags = self.fds[int(path.rsplit('/', 1)[1])]
            return node(dev, ino, 0o10600)
        for name, fact in self.tmpfs.items():
            if path == view + name: return node(fact['dev'], 600, fact['mode'], fact['uid'], fact['gid'])
        raise FileNotFoundError(path)

    def bind(self, b):
        b.read_file, b.run_device, b.crash_device = self.read_file, self.RUN_DEV, self.crash_device
        b.os.listdir, b.os.readlink, b.os.stat = self.listdir, self.readlink, self.stat
        if self.local: b.initial_namespaces = dict(self.initial)
        return b

    def port(self):
        """An OfflineKernelPort holding this child as its unbound original, in the state spawn_waiting leaves."""
        k = c.OfflineKernelPort(self.bind(InertBindings()))
        owned = c.NativeOwned(self.pid, RUN, self.role, object(), object())
        k._owned[owned] = {'outer': 200, 'child': self.pid, 'terminal': None, 'launch': self.launch,
                           'digest': self.digest, 'links': ('pipe:[30]', 'pipe:[40]'), 'exec_identity': (254, 999)}
        return k, owned

    def handoff(self, k, owned, pid=None):
        attestation = c._attestation(k.inspect(self.pid))
        if pid is not None: attestation = dataclasses.replace(attestation, pid=pid)
        return c.RoleHandoff(self.launch, attestation, k, owned)

    def child(self):
        """The role's own NativeChildPort (local view) after its filter is installed."""
        port = c.NativeChildPort(self.bind(InertBindings()), self.launch, {c.NODE: 19})
        port.digest = self.digest
        return port


class NativeAttestationTests(unittest.TestCase):
    """T8-04, T8-09 and P47 (Task 9): every native attestation check, bound by literal /proc through OfflineKernelPort.

    Each subtest changes exactly one literal kernel fact and expects that check's own code. The control subtests
    admit the unchanged facts, so no case can pass because the fixture itself is broken. No inspect is replaced.
    """
    def setUp(self):
        self.assertTrue(hasattr(c, 'OfflineKernelPort'), 'no unsealed OfflineKernelPort for literal /proc tests')

    def parent(self, change=None, *, waiting=True):
        proc = LiteralProc()
        if change: change(proc)
        k, owned = proc.port()
        c._check(c._attestation(k.inspect(proc.pid)), proc.launch, waiting=waiting)

    def local(self, change=None):
        proc = LiteralProc(local=True)
        if change: change(proc)
        c._check(c._attestation(proc.child().inspect()), proc.launch, waiting=False)

    @staticmethod
    def remount(point, options):
        def change(proc):
            proc.mounts = [(m[0], m[1], options if m[0] == point else m[2], *m[3:]) for m in proc.mounts]
        return change

    def test_native_observe_rejects_each_attestation_drift(self):
        def drop(point):
            return lambda proc: setattr(proc, 'mounts', [m for m in proc.mounts if m[0] != point])
        def stack(point):
            return lambda proc: proc.mounts.append(next(m for m in proc.mounts if m[0] == point))
        def attach(row):
            return lambda proc: proc.mounts.append(row)
        def status(**values):
            return lambda proc: proc.status.update(values)
        def supers(point, options):
            return lambda proc: setattr(proc, 'mounts', [m[:5] + (options,) if m[0] == point else m for m in proc.mounts])
        def retype(point, fstype):
            return lambda proc: setattr(proc, 'mounts', [m[:3] + (fstype,) + m[4:] if m[0] == point else m
                                                         for m in proc.mounts])
        uid = str(c.UIDS['BROWSER'])
        parent_cases = (
            ('M1 extra /dev entry', lambda p: p.dev.append('console'), 'VIEW_DENIED'),
            ('M2 pid namespace equals the parent', lambda p: p.namespaces.update(pid=p.INITIAL['pid']), 'VIEW_DENIED'),
            ('M2 mnt namespace equals the parent', lambda p: p.namespaces.update(mnt=p.INITIAL['mnt']), 'VIEW_DENIED'),
            ('M3 user namespace differs', lambda p: p.namespaces.update(user='user:[4026532302]'), 'VIEW_DENIED'),
            ('M4 /proc/<pid>/root inode differs', lambda p: setattr(p, 'root', (p.RUN_DEV, 556)), 'VIEW_DENIED'),
            ('M4 /proc/<pid>/root device differs', lambda p: setattr(p, 'root', (26, 555)), 'VIEW_DENIED'),
            *(('M5 fd%d is not /dev/null' % fd, lambda p, fd=fd: p.fds.update({fd: ('/dev/console',) + p.fds[fd][1:]}),
               'FD_DENIED') for fd in (0, 1, 2)),
            ('M7 cmdline differs from argv', lambda p: p.cmdline.append('--no-sandbox'), 'PROGRAM_DENIED'),
            ('M8 extra /run/acceptance entry', lambda p: p.run.append('controller'), 'VIEW_DENIED'),
            ('M9 tmpfs directory mode 0755', lambda p: p.tmpfs['/tmp'].update(mode=0o40755), 'VIEW_DENIED'),
            ('M9 tmpfs directory uid', lambda p: p.tmpfs['/tmp'].update(uid=0), 'VIEW_DENIED'),
            ('M9 tmpfs directory gid', lambda p: p.tmpfs['/tmp'].update(gid=0), 'VIEW_DENIED'),
            ('M9 tmpfs directory st_dev', lambda p: p.tmpfs['/tmp'].update(dev=26), 'VIEW_DENIED'),
            ('M10 extra fd 5', lambda p: p.fds.update({5: ('socket:[50]', 8, 50, 2)}), 'FD_DENIED'),
            ('M14 non-empty groups', status(Groups=uid + ' '), 'ATTESTATION_FAILED'),
            ('M15 wrong gids', status(Gid='\t'.join((uid, '0', uid, uid))), 'ATTESTATION_FAILED'),
            *(('M16 %s nonzero' % cap, status(**{cap: '0000000000000001'}), 'ATTESTATION_FAILED')
              for cap in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb')),
            ('M18 /etc bind left rw', self.remount('/etc', 'rw,relatime'), 'VIEW_DENIED'),
            # P47: exactly the twelve view mounts, each once.
            ('P47 missing / row', drop('/'), 'VIEW_DENIED'),
            ('P47 missing /proc row', drop('/proc'), 'VIEW_DENIED'),
            ('P47 missing /dev/null row', drop('/dev/null'), 'VIEW_DENIED'),
            ('P47 duplicate / row (a mount stacked on the root)', stack('/'), 'VIEW_DENIED'),
            ('P47 duplicate /proc row', stack('/proc'), 'VIEW_DENIED'),
            ('M19 old-root /run left attached', attach(('/run', '/', 'rw,nosuid,nodev,relatime', 'tmpfs', '0:25')),
             'VIEW_DENIED'),
            ('M19 old-root /dev left attached', attach(('/dev', '/', 'rw,nosuid,relatime', 'devtmpfs', '0:5')),
             'VIEW_DENIED'),
            ('M19 /sys left attached', attach(('/sys', '/', 'rw,nosuid,nodev,noexec,relatime', 'sysfs', '0:20')),
             'VIEW_DENIED'),
            # Task 14 (C7, P50): /dev/shm is the role's own 64 MiB tmpfs (size=65536k: mm/shmem.c:4223-4224 prints
            # K(max_blocks)), nosuid, nodev, noexec, rw, never a bind of the run tmpfs; /run/acceptance/crash is
            # the role's 0700 directory of the bootstrap's 1 MiB crash tmpfs.
            ('T14 /dev/shm a bind on the run device', lambda p: p.tmpfs['/dev/shm'].update(dev=p.RUN_DEV), 'VIEW_DENIED'),
            ('T14 /dev/shm on the crash device', lambda p: p.tmpfs['/dev/shm'].update(dev=p.CRASH_DEV), 'VIEW_DENIED'),
            ('T14 /dev/shm stacked on a state bind', stack('/dev/shm'), 'VIEW_DENIED'),
            ('T14 /dev/shm not 64 MiB', supers('/dev/shm', 'rw,size=65537k,mode=700,uid=%s,gid=%s,inode64' % (uid, uid)),
             'VIEW_DENIED'),
            ('T14 /dev/shm default size', supers('/dev/shm', 'rw,mode=700,uid=%s,gid=%s,inode64' % (uid, uid)),
             'VIEW_DENIED'),
            *(('T14 /dev/shm without ' + flag, self.remount('/dev/shm', ','.join(
                f for f in ('rw', 'nosuid', 'nodev', 'noexec', 'relatime') if f != flag)), 'VIEW_DENIED')
              for flag in ('rw', 'nosuid', 'nodev', 'noexec')),
            ('T14 /dev/shm not tmpfs', retype('/dev/shm', 'ext4'), 'VIEW_DENIED'),
            ('T14 /dev/shm mode 0755', lambda p: p.tmpfs['/dev/shm'].update(mode=0o40755), 'VIEW_DENIED'),
            ('T14 /dev/shm uid', lambda p: p.tmpfs['/dev/shm'].update(uid=0), 'VIEW_DENIED'),
            ('T14 /dev/shm gid', lambda p: p.tmpfs['/dev/shm'].update(gid=0), 'VIEW_DENIED'),
            ('T14 crash on the run device', lambda p: p.tmpfs['/run/acceptance/crash'].update(dev=p.RUN_DEV),
             'VIEW_DENIED'),
            ('T14 crash not the bootstrap crash tmpfs', lambda p: setattr(p, 'crash_device', 27), 'VIEW_DENIED'),
            ('T14 no bootstrap crash device', lambda p: setattr(p, 'crash_device', None), 'VIEW_DENIED'),
            ('T14 crash not 1 MiB', supers('/run/acceptance/crash', 'rw,size=2048k,inode64'), 'VIEW_DENIED'),
            ('T14 crash not tmpfs', retype('/run/acceptance/crash', 'ext4'), 'VIEW_DENIED'),
            ('T14 crash mode 0755', lambda p: p.tmpfs['/run/acceptance/crash'].update(mode=0o40755), 'VIEW_DENIED'),
            ('T14 crash uid', lambda p: p.tmpfs['/run/acceptance/crash'].update(uid=0), 'VIEW_DENIED'),
            ('T14 crash gid', lambda p: p.tmpfs['/run/acceptance/crash'].update(gid=0), 'VIEW_DENIED'),
            ('T14 missing crash row', drop('/run/acceptance/crash'), 'VIEW_DENIED'),
            ('T14 crash missing from /run/acceptance', lambda p: p.run.remove('crash'), 'VIEW_DENIED'),
        )
        with self.subTest(case='control parent view'): self.parent()
        with self.subTest(case='control local view'): self.local()
        for name, change, code in parent_cases:
            with self.subTest(case=name), self.assertRaisesRegex(c.ConfinementError, '^' + code + '$'):
                self.parent(change)
        # M11: the child's own namespaces against the bootstrap's initial ones (local view).
        for name, change in (
                ('M11 pid namespace is the initial one', lambda p: p.self_namespaces.update(pid=p.INITIAL['pid'])),
                ('M11 mnt namespace is the initial one', lambda p: p.self_namespaces.update(mnt=p.INITIAL['mnt'])),
                ('M11 user namespace is not the initial one',
                 lambda p: p.self_namespaces.update(user='user:[4026532302]'))):
            with self.subTest(case=name), self.assertRaisesRegex(c.ConfinementError, '^VIEW_DENIED$'):
                self.local(change)
        # M17: an exit receipt names the original owned child; one for any other pid is denied.
        proc = LiteralProc(); k, owned = proc.port()
        with self.subTest(case='control exit receipt'):
            self.assertEqual(dict(proc.handoff(k, owned).wait_exit(1)), {'status': 'TIMEOUT', 'pid': 300, 'run_id': RUN})
        with self.subTest(case='M17 exit receipt for a pid other than the attested one'):
            with self.assertRaisesRegex(c.ConfinementError, '^EXIT_DENIED$'):
                proc.handoff(k, owned, pid=301).wait_exit(1)

    def test_waiting_attestation_requires_seccomp_filters_1_and_observed_tty(self):
        # T8-09: Seccomp_filters and tty_nr are observed from /proc, never echoed from the launch.
        for filters, waiting in (('1', True), ('2', False), ('0', False)):
            with self.subTest(unbound_filters=filters):
                proc = LiteralProc(); proc.status['Seccomp_filters'] = filters
                k, owned = proc.port(); facts = k.inspect(proc.pid)
                # An unbound runtime's waiting is observed (one filter over the exact inherited set), never forced.
                self.assertIs(facts['waiting'], waiting)
                self.assertEqual(facts['seccomp_filters'], int(filters))
                if waiting:
                    c._check(c._attestation(facts), proc.launch, waiting=True)
                else:
                    with self.assertRaisesRegex(c.ConfinementError, '^ATTESTATION_FAILED$'):
                        c._check(c._attestation(facts), proc.launch, waiting=True)
        # _check: a waiting attestation needs exactly one filter; any other needs at least one.
        proc = LiteralProc(); k, owned = proc.port(); facts = k.inspect(proc.pid)
        for filters, waiting, admitted in ((1, True, True), (2, True, False), (0, True, False),
                                           (1, False, True), (3, False, True), (0, False, False)):
            with self.subTest(check_filters=filters, waiting=waiting):
                attestation = c._attestation(dict(facts, seccomp_filters=filters, waiting=waiting))
                if admitted:
                    c._check(attestation, proc.launch, waiting=waiting)
                else:
                    with self.assertRaisesRegex(c.ConfinementError, '^ATTESTATION_FAILED$'):
                        c._check(attestation, proc.launch, waiting=waiting)
        # tty_nr is read from /proc/<pid>/stat after the last ')'; a comm holding ')' and digits cannot supply it.
        for comm, tty, admitted in (('node', 0, True), ('node', 1088, False),
                                    ('x) S 1 1 1 7 0', 0, True), ('x) S 1 1 1 0 0', 1088, False)):
            with self.subTest(comm=comm, tty_nr=tty):
                proc = LiteralProc(); proc.comm, proc.tty_nr = comm, tty
                k, owned = proc.port(); facts = k.inspect(proc.pid)
                self.assertEqual(facts['tty_nr'], tty)
                if admitted:
                    c._check(c._attestation(facts), proc.launch, waiting=True)
                else:
                    with self.assertRaisesRegex(c.ConfinementError, '^ATTESTATION_FAILED$'):
                        c._check(c._attestation(facts), proc.launch, waiting=True)
        # Bound runtimes: lifecycle WAITING needs exactly one filter; SERVICE admits a stacked one, never none.
        proc = LiteralProc(); k, owned = proc.port(); handoff = proc.handoff(k, owned); owner = object()
        k.bind_runtime_owner(handoff, 'WAITING', owner, '1' * 32, '2' * 32, 1)
        self.assertEqual(k.inspect_runtime(handoff, 'WAITING', owner)['lifecycle'], 'WAITING')
        self.assertIs(k.inspect(proc.pid)['waiting'], True)
        proc.status['Seccomp_filters'] = '2'
        with self.subTest(bound='WAITING', filters=2), self.assertRaisesRegex(c.ConfinementError, '^ATTESTATION_FAILED$'):
            k.inspect_runtime(handoff, 'WAITING', owner)
        # Task 7 carried observation: CONTROLLER is bound as SERVICE through observed facts, not a forced waiting.
        proc = LiteralProc('CONTROLLER'); k, owned = proc.port(); handoff = proc.handoff(k, owned); owner = object()
        k.bind_runtime_owner(handoff, 'SERVICE', owner, '3' * 32, '4' * 32, 1)
        for filters, admitted in (('1', True), ('3', True), ('0', False)):
            proc.status['Seccomp_filters'] = filters
            with self.subTest(bound='SERVICE', filters=filters):
                if admitted:
                    self.assertEqual(k.inspect_runtime(handoff, 'SERVICE', owner)['lifecycle'], 'SERVICE')
                    self.assertIs(k.inspect(proc.pid)['waiting'], False)
                else:
                    with self.assertRaisesRegex(c.ConfinementError, '^ATTESTATION_FAILED$'):
                        k.inspect_runtime(handoff, 'SERVICE', owner)

class FamilyProc:
    """Literal Linux 6.8 /proc for the BROWSER family as the root bootstrap reads it (Task 16c, P73-P80).

    Bindings: exactly the six inspect_browser_family may use (read_file, os.listdir, os.readlink, os.stat, monotonic
    and sleep; the clock is a fake in seconds). Anything else is an AttributeError. The family: 101 the worker root,
    child of the outer helper 100; 202 Chromium (child of 101); 203 (child of 202) in its own network and user
    namespace (netns SANDBOX); 204 (child of 203); 205 (child of 204). 203-205 are non-dumpable, so their
    /proc/<pid>/fd is owned by uid 0 mode 0500 (K1); root reads them anyway (K2-K4). Pid 1, the outer helper 100 and a
    CONTROLLER process 300 are outside the family. Formats: fs/proc/array.c task_state and task_seccomp (tab
    separated rows, the 6.8 state strings), net/socket.c:362 `socket:[%lu]`, fs/pipe.c `pipe:[%lu]`,
    net/unix/af_unix.c:3282-3318 (`%pK: %08X %08X %08X %04X %02X %5lu`, then a space and the raw path),
    net/ipv4/tcp_ipv4.c:2896 and :2945-2947 (the inode is the tenth field; TIME_WAIT rows carry inode 0). Every
    operation is appended to `events` before it is served; each `before` hook then runs and may change the state or
    raise. Device numbers are test values: only their equality with /dev/null's matters.
    """
    ROOT, OUTER = 101, 100
    NULL_RDEV, HVC0_RDEV, VDA_RDEV = 259, 58624, 64768
    CHR, BLK, FIFO, SOCK, REG, ANON, DIR = 0o20666, 0o60660, 0o10600, 0o140777, 0o100600, 0o600, 0o40500
    NULL = ('/dev/null', CHR, NULL_RDEV)
    HEADERS = {
        'unix': 'Num       RefCount Protocol Flags    Type St Inode Path',
        'tcp': '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode' + ' ' * 22,
        'tcp6': '  sl  local_address                         remote_address                        st tx_queue rx_queue '
                'tr tm->when retrnsmt   uid  timeout inode',
        'udp': '   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref '
               'pointer drops' + ' ' * 12,
        'udp6': '  sl  local_address                         remote_address                        st tx_queue rx_queue '
                'tr tm->when retrnsmt   uid  timeout inode ref pointer drops'}

    @staticmethod
    def pipe(inode): return ('pipe:[%d]' % inode, FamilyProc.FIFO, 0)
    @staticmethod
    def sock(inode): return ('socket:[%d]' % inode, FamilyProc.SOCK, 0)
    @staticmethod
    def anon(name): return ('anon_inode:[%s]' % name, FamilyProc.ANON, 0)
    @staticmethod
    def file(path): return (path, FamilyProc.REG, 0)
    @staticmethod
    def unix(inode, path=''):
        return '0000000000000000: 00000002 00000000 00000000 0001 03 %5d%s' % (inode, ' ' + path if path else '')
    @staticmethod
    def tcp(inode, state='01'):
        return ('   0: 0100007F:E0A2 0100007F:0C38 %s 00000000:00000000 00:00000000 00000000 10002        0 %d 1 '
                '0000000000000000 20 4 30 10 -1' % (state, inode))

    def __init__(self):
        self.clock, self.events, self.sleeps, self.before = 0.0, [], [], []
        self.procs, self.extra, self.header = {}, {}, {}
        self.exe = (254, 999)
        self.add(1, 0, name='init', uid=0, nnp='0', seccomp='0', filters='0', owner=0)
        self.add(100, 1, name='python3', uid=0, nnp='0', seccomp='0', filters='0', owner=0)
        self.add(300, 299, name='node', uid=10001, filters='1', owner=10001,
                 fds={0: self.NULL, 1: self.NULL, 2: self.NULL, 3: self.pipe(50), 4: self.pipe(51)})
        self.add(101, 100, name='node', filters='1', fds={
            0: self.NULL, 1: self.NULL, 2: self.NULL, 3: self.pipe(30), 4: self.pipe(40),
            5: self.anon('eventpoll'), 6: self.pipe(31), 7: self.sock(5001)})
        self.add(202, 101, fds={
            0: self.NULL, 1: self.pipe(31), 2: self.NULL, 3: self.sock(5002), 4: self.sock(6001),
            5: self.anon('eventfd'), 6: self.file('/memfd:shared_memory (deleted)')})
        self.add(203, 202, filters='3', ns='SANDBOX', owner=0, fds={
            0: self.NULL, 3: self.sock(7001), 4: self.file('/dev/shm/.org.chromium.Chromium.Ab12Cd (deleted)')})
        self.add(204, 203, filters='3', ns='SANDBOX', owner=0, fds={
            0: self.NULL, 3: self.sock(7002), 4: self.anon('eventfd'), 5: self.sock(5002)})
        self.add(205, 204, filters='3', ns='SANDBOX', owner=0, fds={0: self.NULL, 3: self.sock(7001)})
        self.tables = {
            'ROOT': {'unix': [self.unix(5001), self.unix(5002, '@chromium-sandbox-ipc')],
                     'tcp': [self.tcp(6001), '   1: 0100007F:E0A4 0100007F:0C38 06 00000000:00000000 03:00000F9F '
                             '00000000     0        0 0 3 0000000000000000'],
                     'tcp6': [], 'udp': [], 'udp6': []},
            'SANDBOX': {'unix': [self.unix(7001), self.unix(7002)], 'tcp': [], 'tcp6': [], 'udp': [], 'udp6': []}}

    def add(self, pid, ppid, *, name='chrome', uid=10002, nnp='1', seccomp='2', filters='2', ns='ROOT', owner=10002,
            fds=()):
        ids = '\t'.join([str(uid)] * 4)
        self.procs[pid] = dict(ppid=ppid, name=name, state='S (sleeping)', ids=ids, nnp=nnp, seccomp=seccomp,
                               filters=filters, ns=ns, owner=owner, fds=dict(fds), status={}, rows=[],
                               cap='000001ffffffffff' if uid == 0 else '0' * 16)

    def event(self, kind, path):
        self.events.append((kind, path))
        for hook in list(self.before): hook(self, kind, path)

    def attempts(self):
        """Root identity steps (one per attempt): a read of the root's fd 3 link not followed by its stat (step 3)."""
        events = self.events + [None]
        return sum(1 for at, event in enumerate(self.events)
                   if event == ('readlink', '/proc/101/fd/3') and events[at + 1] != ('stat', '/proc/101/fd/3'))
    def count(self, kind, path): return self.events.count((kind, path))

    def member(self, path):
        parts = path.split('/')
        if len(parts) < 3 or parts[0] or parts[1] != 'proc' or not parts[2].isdigit(): raise FileNotFoundError(path)
        pid = int(parts[2])
        if pid not in self.procs: raise FileNotFoundError(path)
        return pid, self.procs[pid], '/' + '/'.join(parts[3:])

    def status(self, pid):
        p = self.procs[pid]
        rows = {'Name': p['name'], 'Umask': '0077', 'State': p['state'], 'Tgid': str(pid), 'Ngid': '0',
                'Pid': str(pid), 'PPid': str(p['ppid']), 'TracerPid': '0', 'Uid': p['ids'], 'Gid': p['ids'],
                'FDSize': '64', 'Groups': '', 'CapInh': '0' * 16, 'CapPrm': p['cap'], 'CapEff': p['cap'],
                'CapBnd': '000001ffffffffff', 'CapAmb': '0' * 16, 'NoNewPrivs': p['nnp'], 'Seccomp': p['seccomp'],
                'Seccomp_filters': p['filters'], 'Speculation_Store_Bypass': 'thread vulnerable'}
        rows.update(p['status'])
        lines = [key + ':\t' + value for key, value in rows.items() if value is not None] + p['rows']
        return ('\n'.join(lines) + '\n').encode('latin-1')

    def read_file(self, path, limit=65536):
        self.event('read', path)
        pid, p, rest = self.member(path)
        if rest == '/status': data = self.status(pid)
        elif rest.startswith('/net/') and rest[5:] in self.HEADERS:
            table = rest[5:]
            rows = self.tables[p['ns']][table] + self.extra.get((pid, table), [])
            data = (self.header.get((pid, table), self.HEADERS[table]) + '\n'
                    + ''.join(row + '\n' for row in rows)).encode('latin-1')
        else: raise FileNotFoundError(path)
        if len(data) > limit: raise c.ConfinementError('OBSERVATION_LIMIT')
        return data

    def listdir(self, path):
        self.event('listdir', path)
        if path == '/proc': return [str(pid) for pid in self.procs] + ['self', 'thread-self', 'net', 'sys', 'cpuinfo']
        pid, p, rest = self.member(path)
        if rest == '/fd': return [str(fd) for fd in p['fds']]
        raise FileNotFoundError(path)

    def readlink(self, path):
        self.event('readlink', path)
        pid, p, rest = self.member(path)
        if rest.startswith('/fd/') and int(rest[4:]) in p['fds']: return p['fds'][int(rest[4:])][0]
        raise FileNotFoundError(path)

    def stat(self, path):
        self.event('stat', path)
        def node(mode, rdev=0, dev=7, ino=1, uid=0):
            return types.SimpleNamespace(st_mode=mode, st_rdev=rdev, st_dev=dev, st_ino=ino, st_uid=uid, st_gid=uid)
        if path == '/dev/null': return node(self.CHR, self.NULL_RDEV, 5, 6)
        pid, p, rest = self.member(path)
        if rest == '/exe': return node(0o100755, 0, *(self.exe if pid == self.ROOT else (254, 998)))
        if rest == '/fd': return node(self.DIR, uid=p['owner'])
        if rest.startswith('/fd/') and int(rest[4:]) in p['fds']:
            link, mode, rdev = p['fds'][int(rest[4:])]
            return node(mode, rdev, ino=int(rest[4:]))
        raise FileNotFoundError(path)

    def sleep(self, seconds):
        self.events.append(('sleep', seconds)); self.sleeps.append(seconds); self.clock += seconds

    def bindings(self):
        return types.SimpleNamespace(os=types.SimpleNamespace(listdir=self.listdir, readlink=self.readlink,
                                                              stat=self.stat),
                                     read_file=self.read_file, monotonic=lambda: self.clock, sleep=self.sleep)

    def port(self):
        k = c.OfflineKernelPort(self.bindings())
        launch = c.prepare_role('BROWSER', c.RoleConfig(ConfinementTests().config(), c.role_fds('BROWSER', RUN)))
        digest = hashlib.sha256(c.filter_bytes(launch.filter)).hexdigest()
        owned = c.NativeOwned(self.ROOT, RUN, 'BROWSER', object(), object())
        k._owned[owned] = {'outer': self.OUTER, 'child': self.ROOT, 'terminal': None, 'launch': launch,
                           'digest': digest, 'links': ('pipe:[30]', 'pipe:[40]'), 'exec_identity': (254, 999)}
        attestation = c.RoleAttestation(pid=self.ROOT, run_id=RUN, role='BROWSER', uids=(10002,) * 3,
            gids=(10002,) * 3, groups=(), capabilities=(0,) * 5, no_new_privs=1, seccomp=2, filter_digest=digest,
            fds=launch.fds, views=launch.views, waiting=True, programs=launch.programs, seccomp_filters=1, tty_nr=0)
        return k, c.RoleHandoff(launch, attestation, k, owned)

    def inspect(self, point='LAUNCH', limit_ms=1000):
        k, handoff = self.port()
        return k.inspect_browser_family(handoff, point, limit_ms=limit_ms)


def once(kind, path, action):
    """A FamilyProc hook that runs ACTION(proc) at the first (KIND, PATH) operation only."""
    fired = []
    def hook(proc, k, p):
        if (k, p) == (kind, path) and not fired:
            fired.append(1); action(proc)
    return hook


def raising(error):
    def action(proc): raise error
    return action


class BrowserFamilyInspectionTests(unittest.TestCase):
    """Task 16c (owner decision 2026-11-20, P73-P80): the bootstrap's BROWSER family inventory over literal /proc.

    Each case changes literal kernel facts before or during the read; the clean family is the control.
    """
    CLEAN = {'point': 'LAUNCH', 'members': 5, 'attempts': 1}

    def setUp(self):
        self.assertTrue(hasattr(c._KernelPortCore, 'inspect_browser_family'), 'no bootstrap family inspection (Task 16c)')

    def denied(self, proc, code, attempts, **inspect):
        with self.assertRaisesRegex(c.ConfinementError, '^' + code + '$'): proc.inspect(**inspect)
        self.assertEqual(proc.attempts(), attempts)

    def test_browser_family_inspection_reads_every_member_as_root(self):
        proc = FamilyProc(); result = proc.inspect()
        self.assertIs(type(result), types.MappingProxyType)
        self.assertEqual(dict(result), self.CLEAN)
        touched = [path for kind, path in proc.events if kind != 'sleep']
        for pid in (101, 202, 203, 204, 205):
            with self.subTest(member=pid):
                self.assertEqual(proc.count('listdir', '/proc/%d/fd' % pid), 1)
                for fd in proc.procs[pid]['fds']:
                    for kind in ('readlink', 'stat'):
                        # The root identity step reads the two control links once more.
                        want = 2 if (pid, kind) == (101, 'readlink') and fd in (3, 4) else 1
                        self.assertEqual(proc.count(kind, '/proc/%d/fd/%d' % (pid, fd)), want, (kind, fd))
                for table in ('unix', 'tcp', 'tcp6', 'udp', 'udp6'):
                    self.assertEqual(proc.count('read', '/proc/%d/net/%s' % (pid, table)), 1, table)
                self.assertEqual(proc.count('read', '/proc/%d/status' % pid), 2, 'one status read per scan')
        # Every listing precedes every table read (concern 3).
        last_listing = max(i for i, (kind, path) in enumerate(proc.events) if path.endswith('/fd') and kind == 'listdir')
        first_table = min(i for i, (kind, path) in enumerate(proc.events) if '/net/' in path)
        self.assertLess(last_listing, first_table)
        self.assertEqual(proc.count('listdir', '/proc'), 2, 'two full /proc scans per attempt')
        self.assertFalse([p for p in touched if p.startswith('/proc/net') or p.startswith('/proc/self')
                          or p.startswith('/proc/thread-self')])
        outside = [p for p in touched if p.split('/')[2:3] in (['1'], ['100'], ['300']) and not p.endswith('/status')]
        self.assertEqual(outside, [], 'outside the family only status (PPid) is read')
        self.assertEqual(proc.sleeps, [])
        for point in ('POST_LOAD', 'FINAL'):
            with self.subTest(point=point):
                self.assertEqual(dict(FamilyProc().inspect(point)), dict(self.CLEAN, point=point))
        # Capabilities are not required to be empty (the zygote holds them in its own user namespace).
        proc = FamilyProc(); proc.procs[203]['cap'] = '000001ffffffffff'
        self.assertEqual(dict(proc.inspect()), self.CLEAN)

    def test_browser_family_preconditions_are_authority_lost(self):
        def other_kernel(proc, k, h): return c.RoleHandoff(h.launch, h.attestation, c.OfflineKernelPort(proc.bindings()), h._owned)
        def terminal(proc, k, h): k._owned[h._owned]['terminal'] = {'status': 'EXITED'}; return h
        def child(proc, k, h): k._owned[h._owned]['child'] = 102; return h
        def role(proc, k, h):
            return c.RoleHandoff(dataclasses.replace(h.launch, role='VERIFIER'), h.attestation, k, h._owned)
        cases = [('point ' + repr(point), dict(point=point)) for point in ('PERIODIC', 'launch', None)]
        cases += [('limit ' + repr(limit), dict(limit_ms=limit)) for limit in (0, -1, 1001, True, 1.0, '1000')]
        cases += [(name, dict(handoff=change)) for name, change in (
            ('other kernel', other_kernel), ('terminal state', terminal), ('child mismatch', child), ('role', role),
            ('not a handoff', lambda proc, k, h: {'handoff': h}))]
        for name, change in cases:
            with self.subTest(case=name):
                proc = FamilyProc(); k, h = proc.port()
                handoff = change['handoff'](proc, k, h) if 'handoff' in change else h
                with self.assertRaisesRegex(c.ConfinementError, '^AUTHORITY_LOST$'):
                    k.inspect_browser_family(handoff, change.get('point', 'LAUNCH'), limit_ms=change.get('limit_ms', 1000))
                self.assertEqual(proc.events, [], 'no read before the preconditions hold')

    def test_browser_family_forbidden_descriptors_fail(self):
        P = FamilyProc
        cases = (
            ('vsock-like socket on 205 (no table)', lambda p: p.procs[205]['fds'].update({6: P.sock(9999)}), 5),
            ('/dev/hvc0 on 204', lambda p: p.procs[204]['fds'].update({6: ('/dev/hvc0', P.CHR, P.HVC0_RDEV)}), 1),
            ('character device at a non-/dev path', lambda p: p.procs[204]['fds'].update(
                {6: ('/run/acceptance/browser/profile/console', P.CHR, P.HVC0_RDEV)}), 1),
            ('block device', lambda p: p.procs[204]['fds'].update({6: ('/dev/vda', P.BLK, P.VDA_RDEV)}), 1),
            # Fix round 1 (review I-1): every block device, even one numbered like /dev/null (brd's /dev/ram3, b 1:3).
            ("block device numbered like /dev/null", lambda p: p.procs[204]['fds'].update(
                {6: ('/dev/ram3', P.BLK, P.NULL_RDEV)}), 1),
            ("the root's control pipe held by 203", lambda p: p.procs[203]['fds'].update({6: P.pipe(40)}), 1),
            ("the root's other control pipe held by 202", lambda p: p.procs[202]['fds'].update({8: P.pipe(30)}), 1),
            ('netlink-like socket on 202 (no table read)', lambda p: p.procs[202]['fds'].update({7: P.sock(9998)}), 5))
        for name, change, attempts in cases:
            with self.subTest(case=name):
                proc = FamilyProc(); change(proc)
                self.denied(proc, 'FAMILY_DENIED', attempts)
                self.assertEqual(proc.sleeps, [0.05] * (attempts - 1))
        # Controls: the root's own control pipes and a /dev/null anywhere are clean.
        proc = FamilyProc(); proc.procs[205]['fds'].update({1: P.NULL, 2: ('/dev/null', P.CHR, P.NULL_RDEV)})
        proc.procs[101]['fds'].update({8: P.pipe(30), 9: P.pipe(40)})
        self.assertEqual(dict(proc.inspect()), self.CLEAN)
        # /dev/null itself must be a character device.
        proc = FamilyProc(); stat = proc.stat
        proc.stat = lambda path: types.SimpleNamespace(st_mode=P.REG, st_rdev=0) if path == '/dev/null' else stat(path)
        self.denied(proc, 'FAMILY_UNREADABLE', 0)

    def test_browser_family_status_rules(self):
        def row(name, value): return lambda p: p.procs[204]['status'].update({name: value})
        def ids(name, index, value):
            return row(name, '\t'.join(value if at == index else '10002' for at in range(4)))
        denied = [('Seccomp 0', row('Seccomp', '0')), ('Seccomp 1', row('Seccomp', '1')),
                  ('Seccomp_filters 0', row('Seccomp_filters', '0')), ('NoNewPrivs 0', row('NoNewPrivs', '0'))]
        denied += [('Uid field %d' % i, ids('Uid', i, '0')) for i in range(4)]
        denied += [('Gid field %d' % i, ids('Gid', i, '10003')) for i in range(4)]
        unreadable = [('Seccomp row missing', row('Seccomp', None)), ('Seccomp 02', row('Seccomp', '02')),
                      ('Seccomp row duplicate', lambda p: p.procs[204]['rows'].append('Seccomp:\t2')),
                      ('Uid row missing', row('Uid', None)), ('Gid row duplicate',
                       lambda p: p.procs[204]['rows'].append('Gid:\t' + '\t'.join(['10002'] * 4))),
                      ('Seccomp_filters row missing', row('Seccomp_filters', None)),
                      ('NoNewPrivs 01', row('NoNewPrivs', '01')), ('Uid three fields', row('Uid', '10002\t10002\t10002')),
                      ('Uid space separated', row('Uid', '10002 10002 10002 10002')),
                      ('State row missing', row('State', None)), ('State unknown', row('State', 'Q (queued)')),
                      ('PPid row missing', row('PPid', None)), ('PPid 0203', row('PPid', '0203'))]
        for code, cases in (('FAMILY_DENIED', denied), ('FAMILY_UNREADABLE', unreadable)):
            for name, change in cases:
                with self.subTest(case=name):
                    proc = FamilyProc(); change(proc)
                    self.denied(proc, code, 1)
        # Controls: a deeper filter stack and a zombie member are clean.
        proc = FamilyProc(); proc.procs[204]['filters'] = '7'
        self.assertEqual(dict(proc.inspect()), self.CLEAN)
        proc = FamilyProc(); proc.procs[205].update(state='Z (zombie)', fds={})
        self.assertEqual(dict(proc.inspect()), self.CLEAN)
        self.assertEqual([p for k, p in proc.events if p.startswith('/proc/205/net/')], [], 'no zombie table read')

    def test_browser_family_per_member_netns_tables(self):
        proc = FamilyProc()
        proc.procs[204]['fds'][7] = FamilyProc.sock(7100); proc.extra[(204, 'unix')] = [FamilyProc.unix(7100, '@renderer')]
        proc.procs[202]['fds'][7] = FamilyProc.sock(6100); proc.extra[(202, 'tcp')] = [FamilyProc.tcp(6100, '08')]
        self.assertEqual(dict(proc.inspect()), self.CLEAN)
        # The same inode in two families is unreadable.
        proc = FamilyProc(); proc.extra[(203, 'udp')] = [
            '  101: 0100007F:D431 00000000:0000 07 00000000:00000000 00:00000000 00000000 10002        0 7001 2 '
            '0000000000000000 0']
        self.denied(proc, 'FAMILY_UNREADABLE', 1)

    def test_browser_family_tables_read_after_listings(self):
        proc = FamilyProc(); proc.procs[204]['fds'][7] = FamilyProc.sock(7300)
        proc.before.append(once('listdir', '/proc/204/fd',
                                lambda p: p.tables['SANDBOX']['unix'].append(FamilyProc.unix(7300))))
        self.assertEqual(dict(proc.inspect()), self.CLEAN)
        self.assertEqual(proc.sleeps, [])

    def test_browser_family_bounded_retry_on_transients_only(self):
        P = FamilyProc
        with self.subTest(case='(a) unattributed on attempt 1, attributed on attempt 2'):
            proc = P(); proc.procs[205]['fds'][6] = P.sock(8001)
            def late(p, kind, path):
                # From attempt 2's scan A (the third full /proc listing) on.
                if p.count('listdir', '/proc') == 3 and P.unix(8001) not in p.tables['SANDBOX']['unix']:
                    p.tables['SANDBOX']['unix'].append(P.unix(8001))
            proc.before.append(late)
            self.assertEqual(dict(proc.inspect()), dict(self.CLEAN, attempts=2))
            self.assertEqual(proc.sleeps, [0.05])
        with self.subTest(case='(b) 205 vanishes mid-attempt'):
            proc = P(); proc.before.append(once('listdir', '/proc/204/fd', lambda p: p.procs.pop(205)))
            self.assertEqual(dict(proc.inspect()), dict(self.CLEAN, members=4))
        for fds, outcome in (({0: P.NULL}, dict(self.CLEAN, members=6, attempts=2)), ({0: P.NULL, 3: P.sock(9999)}, None)):
            with self.subTest(case='(c) a new member only in scan B', vsock=outcome is None):
                proc = P(); scans = []
                def spawn(p, kind, path, fds=fds):
                    if (kind, path) == ('listdir', '/proc'):
                        scans.append(1)
                        if len(scans) == 2: p.add(206, 204, filters='3', ns='SANDBOX', owner=0, fds=fds)
                proc.before.append(spawn)
                if outcome is not None: self.assertEqual(dict(proc.inspect()), outcome)
                else: self.denied(proc, 'FAMILY_DENIED', 5)
        # Fix round 1 (review M-1): a member of A absent from B is dropped only when proven gone or exited. Here 206's
        # parent 205 is reaped during scan B, so the live 206 drops out of B; on the next attempt it is reparented to
        # the namespace init (the root, kernel/exit.c:623-656) and inspected.
        for fds, state, outcome in (({0: P.NULL}, 'S (sleeping)', dict(self.CLEAN, attempts=2)),
                                    ({0: P.NULL, 3: P.sock(9999)}, 'S (sleeping)', None),
                                    ({0: P.NULL}, 'Z (zombie)', dict(self.CLEAN, members=4))):
            with self.subTest(case='(c2) a member of A absent from B', state=state, vsock=outcome is None):
                proc = P(); proc.add(206, 205, filters='3', ns='SANDBOX', owner=0, fds=fds); scans = []
                def orphan(p, kind, path, state=state):
                    if (kind, path) == ('listdir', '/proc'):
                        scans.append(1)
                        if len(scans) == 2:
                            p.procs.pop(205); p.procs[206]['state'] = state
                            if state.startswith('Z'): p.procs[206]['fds'] = {}
                        if len(scans) == 3 and 206 in p.procs: p.procs[206]['ppid'] = 101
                proc.before.append(orphan)
                if outcome is not None:
                    self.assertEqual(dict(proc.inspect()), outcome)
                    if not state.startswith('Z'): self.assertEqual(proc.count('listdir', '/proc/206/fd'), 2, 'read in both attempts')
                else: self.denied(proc, 'FAMILY_DENIED', 5)
        with self.subTest(case='(d) a closed descriptor, absent from the second listing, is dropped'):
            def close(p): p.procs[204]['fds'].pop(4); raise FileNotFoundError('/proc/204/fd/4')
            proc = P(); proc.before.append(once('readlink', '/proc/204/fd/4', close))
            self.assertEqual(dict(proc.inspect()), self.CLEAN)
            self.assertEqual(proc.count('listdir', '/proc/204/fd'), 2)
        with self.subTest(case='(d) present in the second listing, so re-read'):
            def reopen(p): p.procs[204]['fds'][4] = ('/dev/hvc0', P.CHR, P.HVC0_RDEV); raise FileNotFoundError('fd 4')
            proc = P(); proc.before.append(once('stat', '/proc/204/fd/4', reopen))
            self.denied(proc, 'FAMILY_DENIED', 1)
            self.assertEqual(proc.count('listdir', '/proc/204/fd'), 2)
        with self.subTest(case='(d) present and unreadable twice: transient'):
            proc = P(); failures = []
            def twice(p, kind, path):
                if (kind, path) == ('readlink', '/proc/204/fd/4') and len(failures) < 2:
                    failures.append(1); raise FileNotFoundError(path)
            proc.before.append(twice)
            self.assertEqual(dict(proc.inspect()), dict(self.CLEAN, attempts=2))
        with self.subTest(case='(e) a socket permanently unattributed'):
            proc = P(); proc.procs[205]['fds'][6] = P.sock(9999)
            self.denied(proc, 'FAMILY_DENIED', 5)
            self.assertEqual(proc.sleeps, [0.05] * 4); self.assertLessEqual(proc.clock, 1.0)
        with self.subTest(case='(f) a new member in every scan B'):
            proc = P(); scans = []
            def churn(p, kind, path):
                if (kind, path) == ('listdir', '/proc'):
                    scans.append(1)
                    if len(scans) % 2 == 0: p.add(400 + len(scans), 204, filters='3', ns='SANDBOX', owner=0, fds={0: P.NULL})
            proc.before.append(churn)
            self.denied(proc, 'FAMILY_UNREADABLE', 5)
        with self.subTest(case='(h) a clean attempt that ends past the limit'):
            proc = P(); scans = []
            def slow(p, kind, path):
                if (kind, path) == ('listdir', '/proc'):
                    scans.append(1)
                    if len(scans) == 2: p.clock += 1.5   # scan B of attempt 1 starts 1.5 s in
            proc.before.append(slow)
            self.denied(proc, 'FAMILY_UNREADABLE', 1)
            self.assertEqual(proc.sleeps, [])
        with self.subTest(case='(g) limit_ms=120'):
            proc = P(); proc.procs[205]['fds'][6] = P.sock(9999); seen = []
            proc.before.append(lambda p, kind, path: seen.append(p.clock))
            self.denied(proc, 'FAMILY_DENIED', 3, limit_ms=120)
            self.assertLessEqual(max(seen + [proc.clock]), 0.120)
            self.assertEqual(proc.sleeps, [0.05, 0.05])

    def test_browser_family_non_transient_errors_fail_without_retry(self):
        P = FamilyProc
        def remove(*pids):
            def action(p):
                for pid in pids: p.procs.pop(pid)
            return action
        def header(pid, table, text): return lambda p, kind, path: p.header.update({(pid, table): text})
        cases = (
            ('PermissionError on a live member fd listing', 'FAMILY_UNREADABLE',
             once('listdir', '/proc/204/fd', raising(PermissionError('/proc/204/fd')))),
            ('PermissionError on a live member fd entry', 'FAMILY_UNREADABLE',
             once('readlink', '/proc/204/fd/3', raising(PermissionError('/proc/204/fd/3')))),
            ('PermissionError on a live member table', 'FAMILY_UNREADABLE',
             once('read', '/proc/204/net/tcp', raising(PermissionError('/proc/204/net/tcp')))),
            ('an OSError that is neither class', 'FAMILY_UNREADABLE',
             once('readlink', '/proc/203/fd/3', raising(OSError('inert I/O failure')))),
            ('a ProcessLookupError on an fd entry', 'FAMILY_UNREADABLE',
             once('stat', '/proc/203/fd/3', raising(ProcessLookupError('inert')))),
            ('a unix row split by a newline in its path', 'FAMILY_UNREADABLE',
             lambda p, k, path: p.tables['SANDBOX']['unix'].append(P.unix(7003, '@x\nB')) if (k, path) == ('listdir', '/proc') and P.unix(7003, '@x\nB') not in p.tables['SANDBOX']['unix'] else None),
            ('a unix row with an unpadded inode', 'FAMILY_UNREADABLE',
             lambda p, k, path: p.tables['ROOT']['unix'].append('0000000000000000: 00000002 00000000 00000000 0001 03 77') if (k, path) == ('listdir', '/proc') and len(p.tables['ROOT']['unix']) == 2 else None),
            ('a unix row with a lowercase field', 'FAMILY_UNREADABLE',
             lambda p, k, path: p.tables['ROOT']['unix'].append('0000000000000000: 0000000a 00000000 00000000 0001 03 77777') if (k, path) == ('listdir', '/proc') and len(p.tables['ROOT']['unix']) == 2 else None),
            ('a table header mismatch', 'FAMILY_UNREADABLE',
             header(204, 'unix', 'Num       RefCount Protocol Flags    Type Inode St Path')),
            ('a tcp row with a non-canonical inode', 'FAMILY_UNREADABLE',
             lambda p, k, path: p.extra.update({(202, 'tcp6'): ['   0: 00000000000000000000000001000000:E0A6 00000000000000000000000001000000:0C38 01 00000000:00000000 00:00000000 00000000 10002        0 06002 1 0000000000000000 20 4 30 10 -1']})),
            ('a table over 1 MiB', 'FAMILY_UNREADABLE',
             lambda p, k, path: p.extra.update({(203, 'udp6'): [' ' * 1048576]})),
            ('a status over 8 KiB', 'FAMILY_UNREADABLE',
             lambda p, k, path: p.procs[203]['rows'].__setitem__(slice(None), ['Pad:\t' + 'x' * 8192])),
            ('a malformed fd name', 'FAMILY_UNREADABLE',
             lambda p, k, path: p.procs[204]['fds'].update({'07': P.NULL}) if '07' not in p.procs[204]['fds'] else None),
            ('a malformed socket link', 'FAMILY_UNREADABLE',
             lambda p, k, path: p.procs[204]['fds'].update({8: ('socket:[007]', P.SOCK, 0)})),
            ('the root gone', 'FAMILY_UNREADABLE',
             once('readlink', '/proc/101/fd/3', raising(FileNotFoundError('/proc/101/fd/3')))),
            ('the root gone during scan A', 'FAMILY_UNREADABLE', once('listdir', '/proc', remove(101))),
            ("the root's fd listing gone", 'FAMILY_UNREADABLE',
             once('listdir', '/proc/101/fd', raising(FileNotFoundError('/proc/101/fd')))),
            ("the root's fd 3 link changed", 'AUTHORITY_LOST', lambda p, k, path: p.procs[101]['fds'].update({3: P.pipe(33)})),
            ("the root's fd 4 link changed", 'AUTHORITY_LOST', lambda p, k, path: p.procs[101]['fds'].update({4: P.pipe(44)})),
            ("the root's executable identity changed", 'AUTHORITY_LOST', lambda p, k, path: setattr(p, 'exe', (254, 998))),
            ("the root's PPid changed", 'AUTHORITY_LOST', lambda p, k, path: p.procs[101].update(ppid=1)),
            ('only the root present', 'FAMILY_DENIED', once('listdir', '/proc', remove(202, 203, 204, 205))))
        for name, code, hook in cases:
            with self.subTest(case=name):
                proc = P(); proc.before.append(hook)
                self.denied(proc, code, 1)
                self.assertEqual(proc.sleeps, [])
        # A PermissionError for a member that is gone (K3: a vanished task reads EACCES): dropped, never terminal.
        for kind, path in (('listdir', '/proc/205/fd'), ('readlink', '/proc/205/fd/3'), ('read', '/proc/205/net/udp')):
            with self.subTest(case='PermissionError, member gone', at=path):
                def vanish(p, path=path): p.procs.pop(205); raise PermissionError(path)
                proc = P(); proc.before.append(once(kind, path, vanish))
                self.assertEqual(dict(proc.inspect()), dict(self.CLEAN, members=4))
        # FileNotFoundError on a live, non-zombie member's table: it is exiting, so the attempt is retried.
        proc = P(); proc.before.append(once('read', '/proc/204/net/unix', raising(FileNotFoundError('net'))))
        self.assertEqual(dict(proc.inspect()), dict(self.CLEAN, attempts=2))

COVERAGE_V2 = ROOT / 'appliance/abi-coverage-v2.json'


class BrowserSandboxFilterTests(unittest.TestCase):
    """E1 (contract C6, rulings R1 and R2): the BROWSER outer filter allows exactly what Chromium's namespace
    sandbox needs, and keeps every other denial; CONTROLLER, VERIFIER and PROXY keep their filter. Task 8c (C6,
    owner decision 2026-11-20) adds one BROWSER admission: IPPROTO_TCP for AF_INET/AF_INET6 SOCK_STREAM.

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

    def socket_names(self):
        """(IPPROTO_TCP, SOCK_STREAM, SOCK_DGRAM, SOCK_CLOEXEC|SOCK_NONBLOCK, AF_INET, AF_INET6), from coverage v2."""
        return (self.v('IPPROTO_TCP'), self.v('SOCK_STREAM'), self.v('SOCK_DGRAM'),
                self.v('SOCK_CLOEXEC', 'SOCK_NONBLOCK'), self.v('AF_INET'), self.v('AF_INET6'))

    def test_browser_admits_ipproto_tcp_stream_only(self):
        """Task 8c (contract C6, owner decision 2026-11-20): BROWSER may open AF_INET/AF_INET6 SOCK_STREAM sockets
        with protocol IPPROTO_TCP, which selects the same protocol as 0. IPPROTO_TCP with any other type or family,
        any other nonzero protocol and a nonzero protocol high word stay ERRNO|EPERM; protocol 0 is unchanged.

        IPPROTO_UDP is named from coverage v2 (no IPPROTO_UDP is added, C6). 255 is a raw unknown protocol value: the
        test claims no IPPROTO_* name for it."""
        allow, eperm, _ = self.returns()
        tcp, stream, dgram, flags, inet, inet6 = self.socket_names()
        cloexec, nonblock = self.v('SOCK_CLOEXEC'), self.v('SOCK_NONBLOCK')
        raw, seqpacket = self.v('SOCK_RAW'), self.v('SOCK_SEQPACKET')
        udp = self.v('IPPROTO_UDP')
        unknown = 255  # a raw unknown protocol value, outside the admitted set; no IPPROTO_* name is claimed
        self.assertNotIn(udp, (0, tcp))
        self.assertNotIn(unknown, (0, tcp, udp))
        high = 1 << 32
        browser = c.build_filter('BROWSER')
        # Chromium's calls, with and without the SOCK_NONBLOCK/SOCK_CLOEXEC type flags.
        for args in ((inet, stream, tcp), (inet6, stream | flags, tcp), (inet6, stream, tcp), (inet, stream | flags, tcp),
                     (inet, stream | cloexec, tcp), (inet6, stream | nonblock, tcp)):
            with self.subTest(expect='allow', args=args):
                self.assertEqual(evaluate(browser, self.nr('socket'), args), allow)
        # IPPROTO_TCP is admitted exactly where protocol 0 is admitted for a stream type, for socket and socketpair.
        for call in ('socket', 'socketpair'):
            for family in (inet, inet6):
                for kind in (stream, stream | flags):
                    with self.subTest(call=call, family=family, kind=kind, expect='same as protocol 0'):
                        self.assertEqual(evaluate(browser, self.nr(call), (family, kind, 0)), allow)
                        self.assertEqual(evaluate(browser, self.nr(call), (family, kind, tcp)), allow)
        # Protocol 0 is unchanged: stream and datagram, with or without the flags.
        for family in (inet, inet6):
            for kind in (stream, dgram, stream | flags, dgram | flags):
                with self.subTest(expect='allow', protocol=0, family=family, kind=kind):
                    self.assertEqual(evaluate(browser, self.nr('socket'), (family, kind, 0)), allow)
        denied = (
            # IPPROTO_TCP with a type other than SOCK_STREAM.
            (inet, dgram, tcp), (inet6, dgram, tcp), (inet, dgram | flags, tcp), (inet6, dgram | nonblock, tcp),
            (inet, raw, tcp), (inet6, raw, tcp), (inet, seqpacket, tcp), (inet6, seqpacket | cloexec, tcp),
            # IPPROTO_TCP with a family other than AF_INET/AF_INET6.
            (self.v('AF_UNIX'), stream, tcp), (self.v('AF_VSOCK'), stream, tcp), (self.v('AF_PACKET'), stream, tcp),
            # IPPROTO_UDP, for stream and datagram (no IPPROTO_UDP is added).
            (inet, stream, udp), (inet6, stream, udp), (inet, dgram, udp), (inet6, dgram | flags, udp),
            # The raw unknown protocol value, and two raw neighbours of IPPROTO_TCP.
            (inet, stream, unknown), (inet6, stream | flags, unknown), (inet, stream, tcp | 0x100), (inet, stream, tcp - 1),
            # A nonzero protocol high word, with IPPROTO_TCP and with 0 in the low word.
            (inet, stream, high | tcp), (inet6, stream | flags, high | tcp), (inet, stream, high),
            (inet6, stream, (0xffffffff << 32) | tcp),
            # Unchanged: AF_VSOCK, AF_PACKET and raw sockets with protocol 0.
            (self.v('AF_VSOCK'), stream, 0), (self.v('AF_PACKET'), raw, 0), (self.v('AF_PACKET'), dgram, 0),
            (inet, raw, 0), (inet6, raw, 0),
        )
        for call in ('socket', 'socketpair'):
            for args in denied:
                with self.subTest(call=call, expect='eperm', args=args):
                    self.assertEqual(evaluate(browser, self.nr(call), args), eperm)

    def test_other_roles_still_require_protocol_zero(self):
        """Task 8c: the IPPROTO_TCP admission is BROWSER's only. CONTROLLER, VERIFIER and PROXY still give
        ERRNO|EPERM for AF_INET/AF_INET6 SOCK_STREAM with IPPROTO_TCP, and still allow protocol 0."""
        allow, eperm, _ = self.returns()
        tcp, stream, dgram, flags, inet, inet6 = self.socket_names()
        for role in self.OTHER_ROLES:
            program = c.build_filter(role)
            for call in ('socket', 'socketpair'):
                for family in (inet, inet6):
                    for kind in (stream, stream | flags):
                        with self.subTest(role=role, call=call, family=family, kind=kind):
                            self.assertEqual(evaluate(program, self.nr(call), (family, kind, tcp)), eperm)
                            self.assertEqual(evaluate(program, self.nr(call), (family, kind, 0)), allow)
                    with self.subTest(role=role, call=call, family=family, kind=dgram):
                        self.assertEqual(evaluate(program, self.nr(call), (family, dgram, tcp)), eperm)


def probe_module(name):
    """The guest probe module, loaded fresh under NAME."""
    spec_ = importlib.util.spec_from_file_location(name, ROOT / 'tests/guest/confinement_probe.py')
    module = importlib.util.module_from_spec(spec_)
    spec_.loader.exec_module(module)
    return module


def topology_module():
    """guest/topology.py, once per process, for its real CleanupBudget (Task 2, C1) in the P67 cleanup tests."""
    name = 'task14_cleanup_budget_topology'
    if name not in sys.modules:
        spec_ = importlib.util.spec_from_file_location(name, ROOT / 'guest/topology.py')
        module = importlib.util.module_from_spec(spec_)
        sys.modules[name] = module
        spec_.loader.exec_module(module)
    return sys.modules[name]


# Linux 6.8 values the Task 10 probe tests name, transcribed from the pinned archive; abi_coverage_test binds the
# probe's own literals to coverage v2. include/uapi/linux/ptrace.h:22,53; include/uapi/asm-generic/errno-base.h:6,12,
# 13,17,26; include/uapi/asm-generic/errno.h:21,71,94; include/uapi/asm-generic/signal.h:22,46; include/linux/socket.h:177,
# 332; include/uapi/asm-generic/socket.h:9; include/uapi/linux/sched.h:31.
PTRACE_ATTACH, PTRACE_SEIZE = 16, 0x4206
EPERM, ENOENT, ENOEXEC, EBADF, EACCES, EINVAL, ELOOP, ENOTSOCK, ECONNREFUSED = 1, 2, 8, 9, 13, 22, 40, 88, 111
SIGSEGV, SIGSYS = 11, 31
SOL_SOCKET, SCM_RIGHTS, MSG_CMSG_CLOEXEC, CLONE_NEWUSER = 1, 1, 0x40000000, 0x10000000
# Task 10 fixture processes of other roles' UIDs inside the probing family's own PID namespace.
FOREIGN = {'CONTROLLER': 7, 'PROXY': 8}
DONORS = {'CONTROLLER': '\0donor-controller', 'PROXY': '/run/acceptance/proxy/donor'}
TRUSTED_NAMES = ('\0acceptance-trusted', '/run/acceptance/controller/trusted.sock')


def denied(code, text='inert denial'):
    """An answer that raises OSError(CODE), the way a native wrapper reports a refused call."""
    def answer(*args): raise OSError(code, text)
    return answer


class ProbeRecorder:
    """Inert recorder bindings for the Task 10 probe tests, in the style of the Task 8 reviewer's
    probe_semantics.py: each syscall and open is recorded and answered by ANSWER(kind, args), where kind is the
    syscall number or 'open'; closes are recorded. The default answer is EPERM. /proc lists LISTING; this family is
    pid 1 and /proc/7 and /proc/8 are the fixture processes of the controller and proxy UIDs (OWNERS)."""
    def __init__(self, answer=None, *, listing=('1', 'self', 'thread-self'), owners=None, links=None):
        self.calls, self.opens, self.closed = [], [], []
        self.answer = answer or denied(EPERM)
        owners = {'/proc/7': c.UIDS['CONTROLLER'], '/proc/8': c.UIDS['PROXY']} if owners is None else owners
        def stat(path):
            if path not in owners: raise FileNotFoundError(ENOENT, path)
            return types.SimpleNamespace(st_uid=owners[path])
        def open_(path, flags):
            self.opens.append((path, flags))
            return self.answer('open', (path, flags))
        self.b = types.SimpleNamespace(syscall=self.syscall, os=types.SimpleNamespace(
            getpid=lambda: 1, listdir=lambda path: list(listing) if path == '/proc' else ['0', '1', '2', '3', '4'],
            stat=stat, open=open_, close=self.closed.append,
            readlink=lambda path: (links or {}).get(path, '/dev/null')))
    def syscall(self, nr, *args):
        self.calls.append((nr, args))
        return self.answer(nr, args)


def probe_authority(**changes):
    """Inert fixture authority with every Task 10 method (absence is unavailability). correlate_inventory is a
    rubber stamp: it always returns the authority, so only the probe's own observation can refuse. confirm_reachable
    (P54) answers True and is recorded. foreign_pid and audit are the retired Task 8 methods; the probe must not
    depend on either. kernel_feature (retired by P53) is absent, so any remaining use of it fails."""
    calls = []
    authority = types.SimpleNamespace(
        calls=calls, receiver_count=lambda operation: 0, helper_pin=lambda name: None,
        audit_abi_termination=lambda *args: calls.append(('audit_abi_termination',) + args) or authority,
        unsynchronized_thread=lambda port: None, memory=lambda value: value,
        foreign_uid_process_in_role_ns=lambda role: FOREIGN[role],
        trusted_unix_names=lambda: TRUSTED_NAMES, scm_rights_donor=lambda role: DONORS[role],
        confirm_reachable=lambda name: calls.append(('confirm_reachable', name)) or True,
        correlate_inventory=lambda role, digest: calls.append(('correlate_inventory', role, digest)) or authority,
        foreign_pid=lambda role: 500, audit=lambda port: None)
    authority.approve_offline_fixtures = lambda config: authority
    for key, value in changes.items(): setattr(authority, key, value)
    return authority


class ChildExit(BaseException):
    """A recorded _exit of the helper's forked child: real _exit never returns."""


class ProbeFamily:
    """OfflineProbeFixtures whose kernel runs the real probe child entry in this process over a finite port, then
    leaves the waiting family that the parent observes through literal Linux 6.8 /proc (LiteralProc, pid 300), as it
    would natively (T8-03). A probe family never execs, so its cmdline is the bootstrap's own. CHANGE(proc) alters
    one literal fact before the parent reads it. Nothing forks, opens or signals."""
    BOOTSTRAP_ARGV = ('/opt/acceptance/runtime/python/bin/python3', '/opt/acceptance/guest/bootstrap.py')

    def __init__(self, probe, authority, change=None, syscall=None):
        self.change, self.buffer, self.spawns = change, bytearray(), 0
        self.b = b = InertBindings()
        if syscall is not None: b.syscall = syscall
        b.os.write, b.os.read, b.os.close = self.write, lambda fd, size: b'EXIT', lambda fd: None
        b.os.unlink = b.os.rmdir = lambda path: None
        b.os.path = types.SimpleNamespace(lexists=lambda path: False)
        b.os._exit = self.leave
        self.kernel = c.OfflineKernelPort(b)
        self.kernel.spawn_waiting, self.kernel._read_exact = self.spawn, self.read_exact
        self.kernel.wait_owned = lambda owned, ms: {'status': 'EXITED', 'pid': owned.pid, 'run_id': RUN}
        self.kernel.stop_owned = lambda owned, ms: {'status': 'STOPPED', 'pid': owned.pid, 'run_id': RUN}
        self.fixtures = probe.OfflineProbeFixtures(c, self.kernel, ConfinementTests().config(self.kernel), authority)

    def spawn(self, launch, entry):
        self.spawns += 1
        proc = LiteralProc(launch.role)
        proc.cmdline = list(self.BOOTSTRAP_ARGV)
        if self.change: self.change(proc)
        b = proc.bind(self.b)
        files = proc.read_file
        cmdline = b''.join(arg.encode() + b'\0' for arg in self.BOOTSTRAP_ARGV)
        b.read_file = lambda path, limit=65536: cmdline if path == '/proc/self/cmdline' else files(path, limit)
        owned = c.NativeOwned(proc.pid, RUN, launch.role, 'command', 'result')
        self.kernel._owned[owned] = {'child': proc.pid, 'terminal': None, 'launch': launch, 'digest': proc.digest,
                                     'links': ('pipe:[30]', 'pipe:[40]')}
        facts = dict(pid=proc.pid, run_id=RUN, role=launch.role, uids=(launch.uid,) * 3, gids=(launch.uid,) * 3,
                     groups=(), capabilities=(0,) * 5, no_new_privs=1, seccomp=2, filter_digest=proc.digest,
                     fds=launch.fds, views=launch.views, waiting=False, programs=launch.programs,
                     seccomp_filters=1, tty_nr=0)
        port = types.SimpleNamespace(b=b, launch=launch, pins={}, ready_fd=30, digest=proc.digest,
                                     establish_views=lambda value: None, close_unaudited_fds=lambda value: None,
                                     drop_credentials=lambda *args: None, clear_capabilities=lambda: None,
                                     no_new_privs=lambda: None, install_seccomp=lambda *args: 0, inspect=lambda: facts,
                                     scope_digest=lambda: bytes(32))
        try: entry(port)
        except ExecBoundary: pass
        return owned

    def write(self, fd, data):
        if fd == 4 and data != b'WAITING\n': self.buffer.extend(data)
        return len(data)

    def read_exact(self, endpoint, count, deadline):
        data = bytes(self.buffer[:count]); del self.buffer[:count]
        if len(data) != count: raise AssertionError('the probe child wrote no result')
        return data

    @staticmethod
    def leave(code): raise ExecBoundary()


class ProbeHonestyTests(unittest.TestCase):
    """Task 10 (T8-01, T8-02, T8-03, T8-12, T8-13; Option A I1 and m4; P27, P48, P49): each guest probe attempts what
    it claims against a real foreign object and accepts only its exactly bound denial. Inert recorder bindings;
    nothing real runs. Outcomes are compared as values, so a missing interface fails an assertion, not setup."""

    def setUp(self):
        self.probe = probe_module('task10_probe_honesty')

    # The UNIX targets the trusted parent confirms for a family (P54), as run_confined hands them to the child.
    TARGETS = {'controller-SCM_RIGHTS': (DONORS['CONTROLLER'],), 'proxy-SCM_RIGHTS': (DONORS['PROXY'],),
               'trusted-unix-names-unreachable': TRUSTED_NAMES}

    def context(self, name, answer=None, authority=None, role='BROWSER', targets=None, **recorder):
        rec = ProbeRecorder(answer, **recorder)
        ctx = self.probe.NativeProbeContext(types.SimpleNamespace(b=rec.b), authority or probe_authority(),
                                            role + '.' + name, c)
        ctx.unix_targets = self.TARGETS.get(name) if targets is None else targets
        return rec, ctx

    def port(self):
        return self.probe.NativeProbePort(types.SimpleNamespace(run_confined=lambda *args: None))

    def denial(self, name, error):
        try: return self.port()._denial(name, error)
        except Exception as failure: return failure

    def attempt(self, name, ctx):
        """(denied, basis) the probe derives from its own attempt, (False, None) for no denial, or the exception."""
        try: self.port()._operation(name, ctx)
        except OSError as error: return True, self.denial(name, error)
        except Exception as error: return error
        return False, None

    def assertOutcome(self, outcome, kind, code):
        self.assertEqual((type(outcome).__name__, str(outcome)), (kind, code))

    def assertFailure(self, outcome, code):
        self.assertOutcome(outcome, 'ProbeFailure', code)

    def test_theft_probes_target_real_foreign_objects(self):
        p = self.probe
        names = ('proc-enumeration-family-only', 'controller-SCM_RIGHTS', 'proxy-SCM_RIGHTS',
                 'trusted-unix-names-unreachable', 'proc-controller-fd', 'proc-proxy-fd', 'pidfd_open-getfd',
                 'ptrace-attach', 'ptrace-seize', 'process_vm_readv', 'process_vm_writev')
        self.assertEqual(p.PROBES['SCM_RIGHTS_proc_pidfd_ptrace_process_vm_theft_denied'].operations,
                         tuple('BROWSER.' + name for name in names))
        # ptrace: PTRACE_ATTACH or PTRACE_SEIZE, never request 0 (PTRACE_TRACEME ignores the pid, Option A m4),
        # against the fixture process of the controller UID inside this family's own PID namespace.
        for name, request in (('ptrace-attach', PTRACE_ATTACH), ('ptrace-seize', PTRACE_SEIZE)):
            with self.subTest(op=name):
                rec, ctx = self.context(name)
                self.assertEqual(self.attempt(name, ctx), (True, 'KERNEL_ERRNO'))
                self.assertEqual(rec.calls, [(117, (request, FOREIGN['CONTROLLER'], 0, 0))])
                self.assertNotEqual(rec.calls[0][1][0], 0)
        # pidfd_getfd receives the pidfd that pidfd_open returned (never -1), for the foreign process's FD3.
        def pidfd(nr, args):
            if nr == 434: return 77
            raise PermissionError(EPERM, 'inert denial')
        rec, ctx = self.context('pidfd_open-getfd', pidfd)
        self.assertEqual(self.attempt('pidfd_open-getfd', ctx), (True, 'KERNEL_ERRNO'))
        self.assertEqual(rec.calls, [(434, (FOREIGN['CONTROLLER'], 0)), (438, (77, 3, 0))])
        self.assertEqual(rec.closed, [77])
        # process_vm_readv/writev: one local and one remote iovec, each of non-zero length (a zero total returns 0
        # before the kernel resolves the pid).
        for name, nr in (('process_vm_readv', 270), ('process_vm_writev', 271)):
            with self.subTest(op=name):
                rec, ctx = self.context(name)
                self.assertEqual(self.attempt(name, ctx), (True, 'KERNEL_ERRNO'))
                self.assertEqual([call[0] for call in rec.calls], [nr])
                pid, local, local_count, remote, remote_count, flags = rec.calls[0][1]
                self.assertEqual((pid, local_count, remote_count, flags), (FOREIGN['CONTROLLER'], 1, 1, 0))
                for vector in (local, remote):
                    self.assertIs(type(vector), c.NativeMemory)
                    self.assertGreater(struct.unpack('<QQ', bytes(vector.data))[1], 0)
                self.assertEqual(len(local.pointers[0].data), struct.unpack('<QQ', bytes(local.data))[1])
        # /proc/<pid>/fd/3 of the controller's and the proxy's fixture processes in this namespace; ENOENT, which a
        # wrong-namespace pid would give, is no longer a denial for these two.
        for name, role in (('proc-controller-fd', 'CONTROLLER'), ('proc-proxy-fd', 'PROXY')):
            with self.subTest(op=name):
                rec, ctx = self.context(name, denied(EACCES))
                self.assertEqual(self.attempt(name, ctx), (True, 'KERNEL_ERRNO'))
                self.assertEqual([path for path, flags in rec.opens], ['/proc/%d/fd/3' % FOREIGN[role]])
                self.assertFailure(self.denial(name, FileNotFoundError(ENOENT, 'absent')), 'UNEXPECTED_KERNEL_ERROR')
        # The two SCM_RIGHTS cases: FD3 is the bootstrap pipe (ENOTSOCK), then each connects an AF_UNIX stream socket
        # to its own role's fixture donor, which would send one descriptor.
        targets = {}
        for name, role in (('controller-SCM_RIGHTS', 'CONTROLLER'), ('proxy-SCM_RIGHTS', 'PROXY')):
            with self.subTest(op=name):
                def scm(nr, args):
                    if nr == 212: raise OSError(ENOTSOCK, 'inert pipe')
                    if nr == 198: return 20
                    raise OSError(ECONNREFUSED, 'inert refusal')
                rec, ctx = self.context(name, scm)
                self.assertEqual(self.attempt(name, ctx), (True, 'KERNEL_ERRNO'))
                self.assertEqual([call[0] for call in rec.calls], [212, 198, 203])
                self.assertEqual((rec.calls[0][1][0], rec.calls[0][1][2]), (3, MSG_CMSG_CLOEXEC))
                self.assertEqual(rec.calls[1][1], (1, 1, 0))  # AF_UNIX, SOCK_STREAM, protocol 0
                address, length = rec.calls[2][1][1:]
                raw = DONORS[role].encode() + (b'' if DONORS[role][0] == '\0' else b'\0')
                self.assertEqual((address, length), (struct.pack('<H108s', 1, raw), 2 + len(raw)))
                self.assertEqual(rec.closed, [20])
                targets[name] = address
        self.assertNotEqual(targets['controller-SCM_RIGHTS'], targets['proxy-SCM_RIGHTS'])
        # EBADF (an absent or closed descriptor) never counts as a denial (T8-01).
        for name in names:
            with self.subTest(ebadf=name):
                self.assertFailure(self.denial(name, OSError(EBADF, 'inert EBADF')), 'UNEXPECTED_KERNEL_ERROR')
        rec, ctx = self.context('controller-SCM_RIGHTS', denied(EBADF))
        self.assertFailure(self.attempt('controller-SCM_RIGHTS', ctx), 'UNEXPECTED_KERNEL_ERROR')
        # The target must really be foreign: a pid owned by another UID, absent, or this family itself is
        # unavailability, before any attempt.
        for name, owners in (('another uid', {'/proc/7': c.UIDS['BROWSER']}), ('absent', {})):
            with self.subTest(foreign=name):
                rec, ctx = self.context('ptrace-attach', owners=owners)
                self.assertOutcome(self.attempt('ptrace-attach', ctx), 'RuntimeGateUnavailable',
                                   'FOREIGN_IDENTITY_UNAVAILABLE')
                self.assertEqual(rec.calls, [])
        rec, ctx = self.context('ptrace-attach', authority=probe_authority(foreign_uid_process_in_role_ns=lambda role: 1))
        self.assertOutcome(self.attempt('ptrace-attach', ctx), 'RuntimeGateUnavailable', 'FOREIGN_IDENTITY_UNAVAILABLE')
        self.assertEqual(rec.calls, [])

    def test_scm_rights_donor_fd_received_is_failure(self):
        def reachable(fds):
            def answer(nr, args):
                if nr == 212 and args[0] == 3: raise OSError(ENOTSOCK, 'inert pipe')
                if nr == 198: return 20
                if nr == 203: return 0
                if nr == 212: return received(args, fds)
                raise AssertionError(nr)
            return answer
        def received(args, fds):
            # recvmsg returns one byte; the kernel fills the control buffer and always writes back msg_controllen
            # (offset 40 of struct user_msghdr): CMSG_SPACE(sizeof(int)) for one descriptor, else 0.
            message = args[1]
            if fds:
                control = message.pointers[32]
                control.data[:20] = struct.pack('<Qii', 20, SOL_SOCKET, SCM_RIGHTS) + struct.pack('<i', fds[0])
            struct.pack_into('<Q', message.data, 40, 24 if fds else 0)
            return 1
        for name in ('controller-SCM_RIGHTS', 'proxy-SCM_RIGHTS'):
            with self.subTest(op=name, received=True):
                rec, ctx = self.context(name, reachable((55,)))
                self.assertFailure(self.attempt(name, ctx), 'FD_DONOR_REACHED')
                self.assertEqual((rec.calls[-1][0], rec.calls[-1][1][0], rec.calls[-1][1][2]), (212, 20, MSG_CMSG_CLOEXEC))
                self.assertEqual(sorted(rec.closed), [20, 55])
            with self.subTest(op=name, received=False):
                rec, ctx = self.context(name, reachable(()))
                self.assertFailure(self.attempt(name, ctx), 'DONOR_ENDPOINT_REACHED')
                self.assertEqual(rec.closed, [20])
        # An inherited FD3 that is a socket is a finding, never the pipe's ENOTSOCK denial.
        rec, ctx = self.context('controller-SCM_RIGHTS', lambda nr, args: received(args, ()))
        self.assertFailure(self.attempt('controller-SCM_RIGHTS', ctx), 'INHERITED_SOCKET_ENDPOINT')
        self.assertEqual([call[0] for call in rec.calls], [212])
        # Every name a trusted role creates must refuse this family; one that connects is a finding.
        def names(reached):
            def answer(nr, args):
                if nr == 198: return 21
                if nr == 203 and args[1] == struct.pack('<H108s', 1, reached): return 0
                raise OSError(ENOENT if args[1][2:3] == b'/' else ECONNREFUSED, 'inert refusal')
            return answer
        rec, ctx = self.context('trusted-unix-names-unreachable', names(b'none'))
        self.assertEqual(self.attempt('trusted-unix-names-unreachable', ctx), (True, 'KERNEL_ERRNO'))
        self.assertEqual([call[1][1] for call in rec.calls if call[0] == 203],
                         [struct.pack('<H108s', 1, b'\0acceptance-trusted'),
                          struct.pack('<H108s', 1, b'/run/acceptance/controller/trusted.sock\0')])
        rec, ctx = self.context('trusted-unix-names-unreachable', names(b'\0acceptance-trusted'))
        self.assertFailure(self.attempt('trusted-unix-names-unreachable', ctx), 'TRUSTED_UNIX_NAME_REACHED')
        # Without targets confirmed by the trusted parent (P54) the family attempts nothing.
        for name in ('trusted-unix-names-unreachable', 'controller-SCM_RIGHTS'):
            with self.subTest(unconfirmed=name):
                rec, ctx = self.context(name, denied(ENOTSOCK), targets=())  # FD3 is the pipe; then no target
                self.assertOutcome(self.attempt(name, ctx), 'RuntimeGateUnavailable', 'FIXTURE_UNAVAILABLE')
                self.assertEqual([call[0] for call in rec.calls if call[0] != 212], [])

    def test_proc_enumeration_reports_non_family_pid(self):
        rec, ctx = self.context('proc-enumeration-family-only', listing=('1', 'self', 'thread-self', 'sys', 'meminfo'))
        self.assertEqual(self.attempt('proc-enumeration-family-only', ctx), (True, 'OBSERVED'))
        for listing in (('1', '42', 'self'), ('1', '7'), ('42',), ()):
            with self.subTest(listing=listing):
                rec, ctx = self.context('proc-enumeration-family-only', listing=listing)
                self.assertFailure(self.attempt('proc-enumeration-family-only', ctx), 'NON_FAMILY_PROCESS_VISIBLE')

    def abi_helper(self, name, code, *, marker=b'ATTEMPTED\n'):
        """The probe's real helper control flow for NAME over the Task 8 reviewer's D1 bindings: the forked process
        writes MARKER and ends with waitstatus_to_exitcode CODE; the termination audit is a rubber stamp. The
        authority has no kernel_feature: the outcome alone decides (P53)."""
        os_ns = types.SimpleNamespace(pipe2=lambda flags: (31, 32), fork=lambda: 4242, close=lambda fd: None,
                                      read=lambda fd, size: marker[:size], waitpid=lambda pid, flags: (4242, 0),
                                      waitstatus_to_exitcode=lambda status: code, WNOHANG=1, kill=lambda *args: None,
                                      write=lambda fd, data: len(data))
        b = types.SimpleNamespace(os=os_ns, signal=types.SimpleNamespace(SIGKILL=9), monotonic=lambda: 0.0,
                                  select=lambda r, w, e, t: (r, [], []), sleep=lambda s: None,
                                  pin_sample=lambda path, sha: 19, syscall=lambda *args: 0)
        sample = {'AArch32-audit': 'aarch32-syscall', 'alternate-syscall-entry': 'alternate-entry'}[name]
        pin = c.ProgramPin('/opt/acceptance/tests/fixtures/' + sample, 'a' * 64)
        authority = probe_authority(helper_pin=lambda name: pin)
        ctx = self.probe.NativeProbeContext(types.SimpleNamespace(b=b), authority, 'BROWSER.' + name, c)
        try: ctx.helper(name)
        except OSError as error: return (True, self.denial(name, error)), authority.calls
        except Exception as error: return error, authority.calls
        return (False, None), authority.calls

    def exec_child_exit(self, name, code):
        """The exit status the helper's forked pre-exec child chooses when exec of NAME's pinned sample fails with
        CODE (the child branch of the real helper, fork returning 0)."""
        exits = []
        def leave(status): exits.append(status); raise ChildExit()
        def execve(fd, argv, env): raise OSError(code, 'inert exec refusal')
        os_ns = types.SimpleNamespace(pipe2=lambda flags: (31, 32), fork=lambda: 0, close=lambda fd: None,
                                      dup2=lambda *args: None, set_inheritable=lambda *args: None, execve=execve,
                                      _exit=leave, write=lambda fd, data: len(data))
        b = types.SimpleNamespace(os=os_ns, signal=types.SimpleNamespace(SIGKILL=9), monotonic=lambda: 0.0,
                                  select=lambda r, w, e, t: (r, [], []), sleep=lambda s: None,
                                  pin_sample=lambda path, sha: 19, syscall=lambda *args: 0)
        sample = {'AArch32-audit': 'aarch32-syscall', 'alternate-syscall-entry': 'alternate-entry'}[name]
        pin = c.ProgramPin('/opt/acceptance/tests/fixtures/' + sample, 'a' * 64)
        ctx = self.probe.NativeProbeContext(types.SimpleNamespace(b=b), probe_authority(helper_pin=lambda name: pin),
                                            'BROWSER.' + name, c)
        try: ctx.helper(name)
        except ChildExit: pass
        except Exception as error: return error
        return exits[0] if exits else None

    def test_abi_probe_requires_sigsys(self):
        for name, kill in (('AArch32-audit', 'SECCOMP_ARCH_KILL'), ('alternate-syscall-entry', 'SECCOMP_KILL')):
            # D1: a sample that dies by any other signal (SIGSEGV, SIGKILL), or exits, even with code 23 or the exec
            # refusal status 24, is not the KILL_PROCESS denial; the rubber-stamp termination audit is never consulted.
            for code in (-SIGSEGV, -9, 23, 24, 0):
                with self.subTest(op=name, code=code):
                    outcome, calls = self.abi_helper(name, code)
                    self.assertFailure(outcome, 'ABI_ATTEMPT_UNPROVED')
                    self.assertEqual(calls, [])
            with self.subTest(op=name, code=-SIGSYS):
                outcome, calls = self.abi_helper(name, -SIGSYS)
                self.assertEqual(outcome, (True, kill))
                self.assertEqual(calls, [('audit_abi_termination', name, 4242, 0)])
            with self.subTest(op=name, unproved='no marker'):
                outcome, calls = self.abi_helper(name, -SIGSYS, marker=b'')
                self.assertFailure(outcome, 'HELPER_ATTEMPT_UNPROVED')

    def test_abi_catalogue_has_no_unrealisable_cases(self):
        p = self.probe
        self.assertEqual(p.PROBES['alternate_ABI_denied'].operations,
                         ('BROWSER.AArch32-audit', 'BROWSER.alternate-syscall-entry'))
        operations = {op.partition('.')[2] for case in p.PROBES.values() for op in case.operations}
        for gone in ('x86_64-audit', 'unknown-audit'):
            with self.subTest(op=gone):
                self.assertNotIn(gone, operations)
                self.assertNotIn(gone, p.HELPER_SAMPLES)
                rec, ctx = self.context(gone)
                self.assertOutcome(self.attempt(gone, ctx), 'RuntimeGateUnavailable', 'NATIVE_OPERATION_UNAVAILABLE')
                try: ctx.helper(gone)
                except Exception as error: outcome = error
                else: outcome = None
                self.assertFailure(outcome, 'HELPER_DENIED')
        self.assertEqual({key: p.HELPER_SAMPLES[key] for key in ('AArch32-audit', 'alternate-syscall-entry')},
                         {'AArch32-audit': 'aarch32-syscall', 'alternate-syscall-entry': 'alternate-entry'})

    def test_aarch32_outcome_requires_sigsys_or_observed_exec_refusal(self):
        # P53 (I-2; replaces the CONFIG_COMPAT-keyed test_aarch32_without_compat_requires_observed_exec_refusal): the
        # observed outcome decides. linux-6.8/arch/arm64/kernel/process.c:601-620 refuses an AArch32 exec with ENOEXEC
        # without CONFIG_COMPAT or without 32-bit EL0 on the CPU, so no fixture answer can predict it.
        p = self.probe
        self.assertNotIn('kernel_feature', p._FIXTURE_AUTHORITY)
        self.assertFalse(hasattr(p.NativeProbeContext, 'kernel_feature'))
        self.assertEqual(p.allowed_bases('AArch32-audit'), ('SECCOMP_ARCH_KILL', 'AARCH32_EXEC_UNAVAILABLE'))
        self.assertEqual(p.allowed_bases('alternate-syscall-entry'), ('SECCOMP_KILL',))
        # No sample code ran (no marker) and the pre-exec child's fixed refusal exit 24: the observed exec refusal.
        outcome, calls = self.abi_helper('AArch32-audit', 24, marker=b'')
        self.assertEqual(outcome, (True, 'AARCH32_EXEC_UNAVAILABLE'))
        self.assertEqual(calls, [])
        # The sample started and died by SIGSYS: the filter's arch kill.
        outcome, calls = self.abi_helper('AArch32-audit', -SIGSYS)
        self.assertEqual(outcome, (True, 'SECCOMP_ARCH_KILL'))
        # Every other outcome fails: a marker-less end other than 24, a refusal status after the sample started,
        # SIGSEGV or any other signal, any exit code, success.
        for code, marker, failure in ((78, b'', 'HELPER_ATTEMPT_UNPROVED'), (23, b'', 'HELPER_ATTEMPT_UNPROVED'),
                                      (0, b'', 'HELPER_ATTEMPT_UNPROVED'), (-SIGSYS, b'', 'HELPER_ATTEMPT_UNPROVED'),
                                      (-SIGSEGV, b'', 'HELPER_ATTEMPT_UNPROVED'),
                                      (24, b'ATTEMPTED\n', 'ABI_ATTEMPT_UNPROVED'),
                                      (-SIGSEGV, b'ATTEMPTED\n', 'ABI_ATTEMPT_UNPROVED'),
                                      (0, b'ATTEMPTED\n', 'ABI_ATTEMPT_UNPROVED')):
            with self.subTest(code=code, marker=marker):
                outcome, calls = self.abi_helper('AArch32-audit', code, marker=marker)
                self.assertFailure(outcome, failure)
        # The alternate-entry sample is native AArch64: an exec refusal is never its denial.
        outcome, calls = self.abi_helper('alternate-syscall-entry', 24, marker=b'')
        self.assertFailure(outcome, 'HELPER_ATTEMPT_UNPROVED')
        # The pre-exec child maps exactly an ENOEXEC exec failure of the AArch32 sample to 24.
        for name, code, status in (('AArch32-audit', ENOEXEC, 24), ('AArch32-audit', EACCES, 78),
                                   ('AArch32-audit', EINVAL, 78), ('alternate-syscall-entry', ENOEXEC, 78)):
            with self.subTest(child=name, errno=code):
                self.assertEqual(self.exec_child_exit(name, code), status)

    def test_exact_fd_inventory_probe_observes_parent_side(self):
        p = self.probe
        def run(change=None):
            authority = probe_authority()
            try: family = ProbeFamily(p, authority, change)
            except Exception as error: self.fail('offline fixtures refused the Task 10 authority: ' + repr(error))
            try: rows = p.NativeProbePort(family.fixtures).attempt(p.PROBES['exact_fd_inventory'])
            except Exception as error: rows = error
            return rows, family, authority
        # D4: with a rubber-stamp authority, a family whose observed facts differ from the exact waiting contract
        # fails, and the authority is never asked.
        uid = '\t'.join(('0',) * 4)
        for name, change in (
                ('extra fd 5', lambda proc: proc.fds.update({5: ('socket:[50]', 8, 50, 2)})),
                ('uid 0', lambda proc: proc.status.update(Uid=uid)),
                ('a capability held', lambda proc: proc.status.update(CapEff='0000000000000001')),
                ('two seccomp filters', lambda proc: proc.status.update(Seccomp_filters='2')),
                ('no_new_privs clear', lambda proc: proc.status.update(NoNewPrivs='0')),
                ('the family exec\'d a role program', lambda proc: setattr(proc, 'cmdline', list(proc.launch.argv))),
                ('pid namespace shared with the bootstrap', lambda proc: proc.namespaces.update(pid=proc.INITIAL['pid'])),
                ('/sys left attached', lambda proc: proc.mounts.append(('/sys', '/', 'rw', 'sysfs', '0:20'))),
                ('FD3 replaced since spawn', lambda proc: proc.fds.update({3: ('pipe:[31]',) + proc.fds[3][1:]}))):
            with self.subTest(drift=name):
                rows, family, authority = run(change)
                self.assertFailure(rows, 'PARENT_INVENTORY_DENIED')
                self.assertEqual([call for call in authority.calls if call[0] == 'correlate_inventory'], [])
        # Control: each role's waiting family is observed by the parent; the authority only correlates the digest
        # of the facts the parent observed, and the family keeps that digest.
        rows, family, authority = run()
        self.assertIs(type(rows), tuple, rows)
        self.assertEqual([(row['denied'], row.get('basis')) for row in rows], [(False, 'OBSERVED')] * 4)
        correlated = [call for call in authority.calls if call[0] == 'correlate_inventory']
        self.assertEqual([call[1] for call in correlated], ['CONTROLLER', 'BROWSER', 'VERIFIER', 'PROXY'])
        self.assertTrue(all(re.fullmatch('[0-9a-f]{64}', call[2]) for call in correlated), correlated)
        self.assertEqual(len({call[2] for call in correlated}), 4)
        self.assertEqual([getattr(owner, 'facts_digest', None) for owner in family.fixtures.family_owners],
                         [call[2] for call in correlated])
        # A correlation that is not the authority itself is refused.
        family = ProbeFamily(p, probe_authority(correlate_inventory=lambda role, digest: object()))
        try: outcome = p.NativeProbePort(family.fixtures).attempt(p.PROBES['exact_fd_inventory'])
        except Exception as error: outcome = error
        self.assertFailure(outcome, 'INVENTORY_CORRELATION_DENIED')

    def test_console_probe_opens_read_and_write(self):
        # T8-12: a node that refuses reads but accepts writes is still a console.
        read_flags, write_flags = 0o100000 | 0o2000000, 1 | 0o100000 | 0o2000000  # O_NOFOLLOW|O_CLOEXEC, +O_WRONLY
        for name, path in (('dev-console-open', '/dev/console'), ('dev-hvc-open', '/dev/hvc0')):
            with self.subTest(op=name, opened='neither'):
                rec, ctx = self.context(name, denied(ENOENT))
                self.assertEqual(self.attempt(name, ctx), (True, 'KERNEL_ERRNO'))
                self.assertEqual(rec.opens, [(path, read_flags), (path, write_flags)])
            with self.subTest(op=name, opened='write only'):
                def write_only(kind, args):
                    if args[1] & 3 == 1: return 40
                    raise PermissionError(EACCES, 'inert read refusal')
                rec, ctx = self.context(name, write_only)
                self.assertFailure(self.attempt(name, ctx), 'CONSOLE_OPENED')
                self.assertEqual(rec.closed, [40])
        # proc-console-reopen is attempted in both directions too; it follows the magic link (P52, the next test).
        rec, ctx = self.context('proc-console-reopen', denied(EACCES))
        self.assertEqual(self.attempt('proc-console-reopen', ctx), (True, 'KERNEL_ERRNO'))
        self.assertEqual([flags & 3 for path, flags in rec.opens], [0, 1])
        def write_reached(kind, args):
            if args[1] & 3 == 1: return 42
            raise PermissionError(EACCES, 'inert read refusal')
        rec, ctx = self.context('proc-console-reopen', write_reached)
        self.assertFailure(self.attempt('proc-console-reopen', ctx), 'CONSOLE_REACHED')
        self.assertEqual(rec.closed, [42])

    def test_console_reopen_follows_the_console_roles_magic_link(self):
        # P52 (I-1): the real reopen attack. The console is the CONTROLLER role's (appliance consoleRole); a family's
        # /proc is its own PID namespace, where pid 1 is the family itself (linux-6.8/fs/proc/root.c:252), so the
        # target is the controller-UID fixture process's fd 0, through its magic link, FOLLOWED: without O_NOFOLLOW,
        # which on an S_IFLNK fd entry (fs/proc/fd.c:206) only ever gives ELOOP (fs/open.c:1307-1308,
        # fs/namei.c:3247-3248). Only the 6.8 refusals of a non-owner (EACCES: proc_fd_permission fs/proc/fd.c:332-349,
        # proc_pid_get_link fs/proc/base.c:1738-1759) or an invisible pid (ENOENT: proc_pid_lookup fs/proc/base.c:3449)
        # deny; an open reaches the console.
        nofollow, cloexec, wronly = 0o100000, 0o2000000, 1
        target = '/proc/%d/fd/0' % FOREIGN['CONTROLLER']
        for errno_ in (EACCES, ENOENT):
            with self.subTest(refused=errno_):
                rec, ctx = self.context('proc-console-reopen', denied(errno_))
                self.assertEqual(self.attempt('proc-console-reopen', ctx), (True, 'KERNEL_ERRNO'))
                self.assertEqual(rec.opens, [(target, cloexec), (target, wronly | cloexec)])
                self.assertFalse(any(flags & nofollow for path, flags in rec.opens))
        for errno_ in (ELOOP, EPERM, EBADF, EINVAL):
            with self.subTest(unexpected=errno_):
                rec, ctx = self.context('proc-console-reopen', denied(errno_))
                self.assertFailure(self.attempt('proc-console-reopen', ctx), 'UNEXPECTED_KERNEL_ERROR')
        for direction, answer in (('read', lambda kind, args: 43),
                                  ('write', lambda kind, args: 43 if args[1] & 3 == 1 else
                                   (_ for _ in ()).throw(PermissionError(EACCES, 'inert')))):
            with self.subTest(reached=direction):
                rec, ctx = self.context('proc-console-reopen', answer)
                self.assertFailure(self.attempt('proc-console-reopen', ctx), 'CONSOLE_REACHED')
                self.assertEqual(rec.closed, [43])
        # The target is really the console role's: another owner, or no such process, is unavailability before any
        # open; pid 1, this family itself, is never the target.
        for name, owners in (('another uid', {'/proc/7': c.UIDS['VERIFIER']}), ('absent', {})):
            with self.subTest(foreign=name):
                rec, ctx = self.context('proc-console-reopen', owners=owners)
                self.assertOutcome(self.attempt('proc-console-reopen', ctx), 'RuntimeGateUnavailable',
                                   'FOREIGN_IDENTITY_UNAVAILABLE')
                self.assertEqual(rec.opens, [])
        rec, ctx = self.context('proc-console-reopen', denied(EACCES))
        self.attempt('proc-console-reopen', ctx)
        self.assertNotIn('/proc/1/fd/0', [path for path, flags in rec.opens])

    def test_check_appliance_uses_last_mountinfo_row(self):
        # T8-12: path lookup reaches only the last mount on a mount point; an earlier row proves nothing.
        root_ro = '20 1 254:0 / / ro,relatime - ext4 /dev/vda ro\n'
        root_rw = '31 20 0:40 / / rw,relatime - tmpfs tmpfs rw\n'
        run_tmpfs = '22 20 0:25 / /run rw,nosuid,nodev - tmpfs tmpfs rw\n'
        run_ext4 = '32 22 254:0 / /run rw,relatime - ext4 /dev/vda rw\n'
        # Task 14 (C7): the bootstrap's 1 MiB crash tmpfs, on which each role's crash directory is made.
        crash_tmpfs = '23 22 0:26 / /run/acceptance/crash rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=1024k\n'
        crash_ext4 = '33 23 254:0 / /run/acceptance/crash rw,relatime - ext4 /dev/vda rw\n'
        devices = {'/run': 25, '/run/acceptance/crash': 26}
        def appliance(rows):
            files = {'/proc/self/mountinfo': ''.join(rows).encode('ascii'),
                     '/proc/swaps': b'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n'}
            b = types.SimpleNamespace(read_file=lambda path, *limit: files[path], os=types.SimpleNamespace(
                listdir=lambda path: ['lo'], stat=lambda path: types.SimpleNamespace(st_dev=devices[path]),
                readlink=lambda path: 'ns:[1]'))
            try: c.LinuxBindings.check_appliance(b)
            except c.ConfinementError as error: return str(error)
            self.assertEqual((b.run_device, getattr(b, 'crash_device', None)), (25, 26))
            return 'ADMITTED'
        for name, rows, verdict in (('control', (root_ro, run_tmpfs, crash_tmpfs), 'ADMITTED'),
                                    ('rw root stacked on the ro root', (root_ro, root_rw, run_tmpfs, crash_tmpfs), 'APPLIANCE_DENIED'),
                                    ('ro root stacked last', (root_rw, root_ro, run_tmpfs, crash_tmpfs), 'ADMITTED'),
                                    ('ext4 stacked on the /run tmpfs', (root_ro, run_tmpfs, run_ext4, crash_tmpfs), 'APPLIANCE_DENIED'),
                                    ('no /run', (root_ro, crash_tmpfs), 'APPLIANCE_DENIED'),
                                    ('no crash tmpfs', (root_ro, run_tmpfs), 'APPLIANCE_DENIED'),
                                    ('ext4 stacked on the crash tmpfs', (root_ro, run_tmpfs, crash_tmpfs, crash_ext4), 'APPLIANCE_DENIED')):
            with self.subTest(mounts=name):
                self.assertEqual(appliance(rows), verdict)

    def test_library_recheck_cases_are_labelled(self):
        # T8-13: the bootstrap-contract and TSYNC probes re-check library code in a probe family; they are labelled
        # so, and the empty-fprog case is named for what it is (EINVAL), not a TSYNC failure.
        p = self.probe
        self.assertEqual(p.PROBES['TSYNC_failure_abort'].operations,
                         ('BOOTSTRAP.invalid-filter-einval', 'BOOTSTRAP.TSYNC-unsynchronized-tid'))
        self.assertNotIn('TSYNC-error', {op.partition('.')[2] for case in p.PROBES.values() for op in case.operations})
        basis = getattr(p, 'BASIS', {})
        names = ('arbitrary-executable', 'arbitrary-argv', 'arbitrary-uid', 'arbitrary-fd',
                 'invalid-filter-einval', 'TSYNC-unsynchronized-tid')
        self.assertEqual({name: basis.get(name) for name in names}, dict.fromkeys(names, 'LIBRARY_RECHECK'))
        self.assertEqual(sorted(name for name, label in basis.items() if label == 'LIBRARY_RECHECK'), sorted(names))
        # The real library rejections run in the probe context and carry that basis.
        b = InertBindings()
        launch = c.prepare_role('BROWSER', c.RoleConfig(ConfinementTests().config(), c.role_fds('BROWSER', RUN)))
        for name in ('arbitrary-executable', 'arbitrary-argv', 'arbitrary-uid', 'arbitrary-fd'):
            with self.subTest(op=name):
                ctx = p.NativeProbeContext(c.NativeChildPort(b, launch, {}), probe_authority(), 'BROWSER.' + name, c)
                self.assertEqual(self.attempt(name, ctx), (True, 'LIBRARY_RECHECK'))
        self.assertEqual(self.denial('invalid-filter-einval', PermissionError(EPERM, 'BOOTSTRAP_BOUNDARY_DENIED')),
                         'LIBRARY_RECHECK')
        rec, ctx = self.context('TSYNC-error')
        self.assertOutcome(self.attempt('TSYNC-error', ctx), 'RuntimeGateUnavailable', 'NATIVE_OPERATION_UNAVAILABLE')

    def test_browser_credential_probes_are_kernel_credential_checks(self):
        # P27, P48: E1 lets capset, setresuid and chroot through the BROWSER filter, so their denial is the kernel's
        # capability check (no initial-namespace capability), which answers exactly EPERM.
        p = self.probe
        self.assertEqual(p.PROBES['privilege_gain_denied'].operations,
                         ('BROWSER.setuid-helper', 'BROWSER.capability-file', 'BROWSER.initial-namespace-capability',
                          'BROWSER.setresuid-root', 'BROWSER.chroot-initial-namespace'))
        browser = c.build_filter('BROWSER')
        for name, nr, args in (('setresuid-root', 147, (0, 0, 0)), ('chroot-initial-namespace', 51, (b'/',)),
                               ('initial-namespace-capability', 91, None)):
            with self.subTest(op=name):
                self.assertEqual(evaluate(browser, nr), ALLOW)
                rec, ctx = self.context(name)
                self.assertEqual(self.attempt(name, ctx), (True, 'KERNEL_CREDENTIAL_CHECK'))
                self.assertEqual([call[0] for call in rec.calls], [nr])
                if args is not None: self.assertEqual(rec.calls[0][1], args)
                self.assertFailure(self.denial(name, PermissionError(EACCES, 'inert')), 'UNEXPECTED_KERNEL_ERROR')
                rec, ctx = self.context(name, lambda nr, args: 0)
                self.assertEqual(self.attempt(name, ctx), (False, None))
        rec, ctx = self.context('initial-namespace-capability')
        self.attempt('initial-namespace-capability', ctx)
        header, data = rec.calls[0][1]
        self.assertEqual(bytes(header), struct.pack('<II', 0x20080522, 0))
        self.assertEqual(struct.unpack('<6I', bytes(data))[:2], (1, 1))  # CAP_CHOWN effective and permitted

    def test_browser_user_namespace_available_probe(self):
        # P49: unshare(CLONE_NEWUSER) succeeds in a fresh BROWSER probe family after seccomp; anything else is
        # USER_NAMESPACE_UNAVAILABLE.
        p = self.probe
        self.assertEqual(p.PROBES.get('browser_user_namespace_available'),
                         p.ProbeCase(('BROWSER.unshare-CLONE_NEWUSER',), False, 0))
        self.assertEqual(evaluate(c.build_filter('BROWSER'), 97, (CLONE_NEWUSER,)), ALLOW)
        rec, ctx = self.context('unshare-CLONE_NEWUSER', lambda nr, args: 0)
        self.assertEqual(self.attempt('unshare-CLONE_NEWUSER', ctx), (False, None))
        self.assertEqual(rec.calls, [(97, (CLONE_NEWUSER,))])
        for name, answer in (('EPERM', denied(EPERM)), ('EINVAL', denied(EINVAL)), ('nonzero', lambda nr, args: 1)):
            with self.subTest(answer=name):
                rec, ctx = self.context('unshare-CLONE_NEWUSER', answer)
                self.assertFailure(self.attempt('unshare-CLONE_NEWUSER', ctx), 'USER_NAMESPACE_UNAVAILABLE')

    def unix_family(self, operation, authority, syscall):
        """OPERATION run through the real OfflineProbeFixtures.run_confined (P54: the parent's control happens there)
        over the ProbeFamily transport, the child answering every syscall with SYSCALL. Returns the parent's outcome,
        the probe failure the child raised (if any), and the family."""
        try: family = ProbeFamily(self.probe, authority, syscall=syscall)
        except Exception as error: self.fail('offline fixtures refused the P54 authority: ' + repr(error))
        port = self.probe.NativeProbePort(family.fixtures)
        raised = []
        def attempt(context):
            try: denied, basis = self.probe._outcome(port, operation.partition('.')[2], context)
            except self.probe.ProbeFailure as failure: raised.append(str(failure)); raise
            return dict(operation=operation, attempted=True, denied=denied, receiver_count=0, basis=basis)
        try: outcome = family.fixtures.run_confined('BROWSER', operation, attempt)
        except Exception as error: outcome = error
        return outcome, raised, family

    @staticmethod
    def unix_kernel(reached=(), fds=()):
        """Inert kernel for the UNIX-name probes: FD3 is the pipe (ENOTSOCK), an AF_UNIX socket is fd 20, a connect
        to an address in REACHED succeeds and every other one is ECONNREFUSED; a reached donor sends FDS."""
        calls = []
        def syscall(nr, *args):
            calls.append((nr, args))
            if nr == 212 and args[0] == 3: raise OSError(ENOTSOCK, 'inert pipe')
            if nr == 198: return 20
            if nr == 203:
                if args[1] in reached: return 0
                raise OSError(ECONNREFUSED, 'inert refusal')
            if nr == 212:
                message = args[1]
                if fds:
                    message.pointers[32].data[:20] = (struct.pack('<Qii', 20, SOL_SOCKET, SCM_RIGHTS)
                                                      + struct.pack('<i', fds[0]))
                struct.pack_into('<Q', message.data, 40, 24 if fds else 0)
                return 1
            raise AssertionError(nr)
        syscall.calls = calls
        return syscall

    def test_donor_probe_requires_parent_positive_control(self):
        # P54 (I-3): only after the trusted parent confirmed the donor exists and is reachable does the family's
        # ENOENT/ECONNREFUSED count as isolation; a failed control is FIXTURE_UNAVAILABLE, never a denial.
        donor = lambda role: struct.pack('<H108s', 1, DONORS[role].encode() + (b'' if DONORS[role][0] == '\0' else b'\0'))
        for name, role in (('controller-SCM_RIGHTS', 'CONTROLLER'), ('proxy-SCM_RIGHTS', 'PROXY')):
            operation = 'BROWSER.' + name
            with self.subTest(op=name, donor='absent'):
                authority = probe_authority(confirm_reachable=lambda target: False)
                kernel = self.unix_kernel()
                outcome, raised, family = self.unix_family(operation, authority, kernel)
                self.assertOutcome(outcome, 'RuntimeGateUnavailable', 'FIXTURE_UNAVAILABLE')
                self.assertEqual((family.spawns, kernel.calls), (0, []))
            with self.subTest(op=name, donor='present, child refused'):
                authority = probe_authority()
                kernel = self.unix_kernel()
                outcome, raised, family = self.unix_family(operation, authority, kernel)
                self.assertEqual((outcome.get('denied'), outcome.get('basis')), (True, 'KERNEL_ERRNO'), outcome)
                # Confirmed before and after the family, for this role's own donor; the child attempts exactly it.
                self.assertEqual([call for call in authority.calls if call[0] == 'confirm_reachable'],
                                 [('confirm_reachable', DONORS[role])] * 2)
                self.assertEqual([call[1][1] for call in kernel.calls if call[0] == 203], [donor(role)])
            with self.subTest(op=name, donor='present, descriptor received'):
                kernel = self.unix_kernel(reached=(donor(role),), fds=(55,))
                outcome, raised, family = self.unix_family(operation, probe_authority(), kernel)
                self.assertEqual(raised, ['FD_DONOR_REACHED'])
                self.assertFailure(outcome, 'PROBE_OPERATION_FAILED')
            with self.subTest(op=name, donor='vanished during the family'):
                answers = iter((True, False))
                authority = probe_authority(confirm_reachable=lambda target: next(answers))
                outcome, raised, family = self.unix_family(operation, authority, self.unix_kernel())
                self.assertOutcome(outcome, 'RuntimeGateUnavailable', 'FIXTURE_UNAVAILABLE')
                self.assertEqual(family.spawns, 1)
            with self.subTest(op=name, control='answers truthy, not True'):
                authority = probe_authority(confirm_reachable=lambda target: 1)
                outcome, raised, family = self.unix_family(operation, authority, self.unix_kernel())
                self.assertOutcome(outcome, 'RuntimeGateUnavailable', 'FIXTURE_UNAVAILABLE')
                self.assertEqual(family.spawns, 0)

    def test_trusted_name_probe_requires_parent_positive_control(self):
        # P54 (I-3): the same three outcomes for the trusted UNIX names.
        operation = 'BROWSER.trusted-unix-names-unreachable'
        address = lambda name: struct.pack('<H108s', 1, name.encode() + (b'' if name[0] == '\0' else b'\0'))
        with self.subTest(name='one absent'):
            authority = probe_authority(confirm_reachable=lambda target: target != TRUSTED_NAMES[1])
            kernel = self.unix_kernel()
            outcome, raised, family = self.unix_family(operation, authority, kernel)
            self.assertOutcome(outcome, 'RuntimeGateUnavailable', 'FIXTURE_UNAVAILABLE')
            self.assertEqual((family.spawns, kernel.calls), (0, []))
        with self.subTest(name='present, child refused'):
            authority = probe_authority()
            kernel = self.unix_kernel()
            outcome, raised, family = self.unix_family(operation, authority, kernel)
            self.assertEqual((outcome.get('denied'), outcome.get('basis')), (True, 'KERNEL_ERRNO'), outcome)
            self.assertEqual([call[1] for call in authority.calls if call[0] == 'confirm_reachable'],
                             list(TRUSTED_NAMES) * 2)
            self.assertEqual([call[1][1] for call in kernel.calls if call[0] == 203],
                             [address(name) for name in TRUSTED_NAMES])
        with self.subTest(name='present, child connects'):
            kernel = self.unix_kernel(reached=(address(TRUSTED_NAMES[0]),))
            outcome, raised, family = self.unix_family(operation, probe_authority(), kernel)
            self.assertEqual(raised, ['TRUSTED_UNIX_NAME_REACHED'])
            self.assertFailure(outcome, 'PROBE_OPERATION_FAILED')
        for name, names in (('empty', ()), ('duplicate', (TRUSTED_NAMES[0],) * 2), ('list', list(TRUSTED_NAMES))):
            with self.subTest(names=name):
                authority = probe_authority(trusted_unix_names=lambda: names)
                outcome, raised, family = self.unix_family(operation, authority, self.unix_kernel())
                self.assertOutcome(outcome, 'RuntimeGateUnavailable', 'TRUSTED_UNIX_NAMES_UNAVAILABLE')
                self.assertEqual(family.spawns, 0)
        # Other operations ask the control nothing.
        authority = probe_authority()
        family = ProbeFamily(self.probe, authority)
        self.assertIsNone(family.fixtures._confirm_reachable('BROWSER.ptrace-attach'))
        self.assertEqual(authority.calls, [])

    def test_result_basis_is_bound_for_every_operation(self):
        p = self.probe
        operations = {op.partition('.')[2] for case in p.PROBES.values() for op in case.operations}
        basis = getattr(p, 'BASIS', {})
        self.assertEqual(set(basis), operations)
        self.assertEqual(set(basis.values()), {'KERNEL_ERRNO', 'KERNEL_CREDENTIAL_CHECK', 'SECCOMP_KILL',
                                               'SECCOMP_ARCH_KILL', 'HELPER_EXIT', 'LIBRARY_RECHECK', 'OBSERVED'})
        self.assertEqual(p.BASES, frozenset(basis.values()) | {'AARCH32_EXEC_UNAVAILABLE'})
        # run_case accepts only the operation's own basis (AArch32 alone may also say AARCH32_EXEC_UNAVAILABLE).
        def port(label):
            return types.SimpleNamespace(attempt=lambda case: tuple(
                {'operation': op, 'attempted': True, 'denied': True, 'receiver_count': 0, 'basis': label(op)}
                for op in case.operations))
        own = lambda op: basis.get(op.partition('.')[2])
        try: outcome = len(p.run_case('privilege_gain_denied', port(own)))
        except Exception as error: outcome = error
        self.assertEqual(outcome, 5)
        for wrong in ('KERNEL_ERRNO', 'AARCH32_EXEC_UNAVAILABLE', 'CONFIG_COMPAT_ABSENT', None):
            with self.subTest(basis=wrong):
                try: p.run_case('privilege_gain_denied', port(lambda op: wrong))
                except Exception as error: outcome = error
                else: outcome = None
                self.assertFailure(outcome, 'PROBE_BOUNDARY_FAILED')
        for label, admitted in (('SECCOMP_ARCH_KILL', True), ('AARCH32_EXEC_UNAVAILABLE', True),
                                ('SECCOMP_KILL', False), ('CONFIG_COMPAT_ABSENT', False)):
            with self.subTest(aarch32=label):
                labels = {'BROWSER.AArch32-audit': label, 'BROWSER.alternate-syscall-entry': 'SECCOMP_KILL'}
                try: outcome = len(p.run_case('alternate_ABI_denied', port(labels.get)))
                except Exception as error: outcome = error
                if admitted: self.assertEqual(outcome, 2)
                else: self.assertFailure(outcome, 'PROBE_BOUNDARY_FAILED')

    def test_gated_guest_driver_covers_catalogue_and_stays_unavailable(self):
        # The gated native driver names every catalogue case, the P49 case included, and without an injected
        # native port it is unavailable, never a skip or a pass.
        with mock.patch.dict(sys.modules, {'confinement_probe': self.probe}):
            spec_ = importlib.util.spec_from_file_location('task10_gated_driver', ROOT / 'tests/guest/confinement_test.py')
            driver = importlib.util.module_from_spec(spec_)
            spec_.loader.exec_module(driver)
        cases = {name[len('test_'):] for name in dir(driver.ConfinementGuestTests) if name.startswith('test_')}
        self.assertIn('browser_user_namespace_available', cases)
        self.assertEqual(cases, set(self.probe.PROBES))
        test = driver.ConfinementGuestTests('test_browser_user_namespace_available'
                                            if 'browser_user_namespace_available' in cases else 'test_exact_fd_inventory')
        with self.assertRaisesRegex(self.probe.RuntimeGateUnavailable, '^NATIVE_GUEST_PROBE_PORT_UNAVAILABLE$'):
            test.setUp()


if __name__ == '__main__': unittest.main()
