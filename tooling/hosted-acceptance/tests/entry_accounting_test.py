"""No Docker: replay safe runtime receipts and reject missing/extra effects."""
import importlib.util,pathlib,unittest,copy
ROOT=pathlib.Path(__file__).resolve().parents[1]
class EntryAccounting(unittest.TestCase):
 def module(self):
  spec=importlib.util.spec_from_file_location('entry_accounting',ROOT/'tools/entry_accounting.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
 def receipts(self):
  return {'state':{'paperReserved':19,'counts':{'PREFLIGHT:market-status':1,'BEFORE:market-status':1,'global:market-status':2}},'gateway':[{'event':'forward','route':'market-status','method':'GET','phase':p,'status':s,'cost':c} for p,s,c in [('PREFLIGHT',401,0),('BEFORE',200,1)]],'upstream':[{'type':'application','host':'backend','method':'GET','path':'/api/market/status','status':s} for s in [401,200]]+[{'type':'provider','method':'GET','path':p} for p,n in [('/v2/account',8),('/v2/positions',3),('/v2/account/portfolio/history?period=1M&timeframe=1D&extended_hours=false',1),('/v2/clock',1)] for _ in range(n)],'tls':[{'path':'/api/market/status','method':'GET','queryPresent':False} for _ in range(2)],'browser':[{'type':'entry-route','path':'/api/market/status','phase':p,'classification':'forward'} for p in ['PREFLIGHT','BEFORE']]+[{'type':'entry-route','path':p,'phase':'AUTH','classification':'transition-denied'} for p in ['/api/recommendations','/api/watchlist/default']]}
 def test_exact_reconciled_receipts(self):
  result=self.module().reconcile(**self.receipts());self.assertEqual(result['providerReads'],13);self.assertEqual(result['gatewayReserved'],19);self.assertEqual(result['preauth']['cost'],0);self.assertEqual(result['authenticated']['cost'],1)
 def test_extra_missing_or_wrong_phase_effects_fail_closed(self):
  m=self.module()
  for key,extra in [('upstream',{'type':'application','host':'backend','method':'GET','path':'/api/recommendations','status':200}),('tls',{'path':'/api/watchlist/default','method':'GET','queryPresent':False}),('gateway',{'event':'denied','path':'/api/recommendations','method':'GET','queryPresent':False}),('upstream',{'type':'provider','method':'GET','path':'/v2/clock'}),('browser',{'type':'entry-route','path':'/api/recommendations','phase':'AUTH','classification':'transition-denied'})]:
   r=self.receipts();r[key].append(extra)
   with self.subTest(key=key),self.assertRaises((AssertionError,RuntimeError)):m.reconcile(**r)
  for key in ['gateway','tls','browser']:
   r=self.receipts();r[key].pop(0)
   with self.subTest(missing=key),self.assertRaises((AssertionError,RuntimeError)):m.reconcile(**r)
 def test_partial_failure_summary_retains_exact_safe_boundary_counts(self):
  m=self.module();r=self.receipts();r['upstream'].append({'type':'application','host':'backend','method':'GET','path':'/private?secret=never-publish','status':401})
  result=m.boundary_summary(r['gateway'],r['upstream'],r['tls'])
  self.assertEqual(result['marketBackendStatuses'],[401,200]);self.assertEqual(result['clockProviderReads'],1);self.assertEqual(result['homeBackendRequests'],0);self.assertNotIn('never-publish',str(result))
 def test_db_baseline_covers_login_and_no_duplicate_robo_navigation(self):
  source=(ROOT/'run.py').read_text();self.assertLess(source.index('before=snapshot()'),source.index('\n operator()'))
  browser=(ROOT/'tools/browser.cjs').read_text();self.assertEqual(browser.count("view('/robo',robo,true)"),1)
if __name__=='__main__':unittest.main()
