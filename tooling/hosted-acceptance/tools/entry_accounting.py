"""Reconcile sanitized boundary receipts; never read private response bodies."""
from collections import Counter
HOME={'/api/recommendations','/api/watchlist/default'}
MARKET='/api/market/status'
def reconcile(state,gateway,upstream,tls,browser):
 forwards=[x for x in gateway if x.get('event')=='forward' and x.get('route')=='market-status']
 assert [(x['phase'],x['method'],x['status'],x['cost']) for x in forwards]==[('PREFLIGHT','GET',401,0),('BEFORE','GET',200,1)]
 assert state['counts']['PREFLIGHT:market-status']==state['counts']['BEFORE:market-status']==1 and state['counts']['global:market-status']==2
 assert not any(x.get('path') in HOME and x.get('method')=='GET' and not x.get('queryPresent',False) for x in tls+gateway)
 application=[x for x in upstream if x.get('type')=='application' and x.get('host')=='backend']
 assert not any(x['path'] in HOME for x in application)
 assert [(x['method'],x['status']) for x in application if x['path']==MARKET]==[('GET',401),('GET',200)]
 assert len([x for x in tls if x.get('path')==MARKET])==2
 entry=[x for x in browser if x.get('type')=='entry-route']
 assert [(x['phase'],x['classification']) for x in entry if x['path']==MARKET and x['classification']=='forward']==[('PREFLIGHT','forward'),('BEFORE','forward')]
 denied=[x for x in entry if x['classification']=='transition-denied']
 assert Counter(x['path'] for x in denied)==Counter({p:1 for p in HOME}) and all(x['phase']=='AUTH' for x in denied)
 provider=[x for x in upstream if x.get('type')=='provider']
 counts=Counter(x['path'] for x in provider)
 expected={'/v2/account':8,'/v2/positions':3,'/v2/account/portfolio/history?period=1M&timeframe=1D&extended_hours=false':1,'/v2/clock':1}
 assert counts==Counter(expected) and all(x['method']=='GET' for x in provider)
 assert state['paperReserved']==6+len(provider)==19
 return {'passCheck':True,'providerReads':len(provider),'providerPaths':dict(counts),'gatewayReserved':state['paperReserved'],'historicalSyntheticOffset':6,'newlyReserved':len(provider),'preauth':{'backendRequests':1,'browserForwards':1,'status':401,'providerReads':0,'cost':0},'authenticated':{'backendRequests':1,'browserForwards':1,'status':200,'providerReads':1,'cost':1},'expectedDenied':dict(Counter(x['path'] for x in denied)),'deniedHomeTLSGatewayBackendRequests':0,'preauthReplays':sum(x['path']==MARKET and x['classification']=='replay' and x['phase']=='PREFLIGHT' for x in entry),'authenticatedReplays':sum(x['path']==MARKET and x['classification']=='replay' and x['phase'] in ['BEFORE','HOLD','AFTER'] for x in entry),'authTimerBlocks':sum(x['path']==MARKET and x['classification']=='block' for x in entry)}
def boundary_summary(gateway,upstream,tls):
 application=[x for x in upstream if x.get('type')=='application' and x.get('host')=='backend']
 return {'marketBackendStatuses':[x['status'] for x in application if x.get('path')==MARKET], 'marketGateway':[{'phase':x['phase'],'status':x['status'],'cost':x['cost']} for x in gateway if x.get('event')=='forward' and x.get('route')=='market-status'], 'marketTLSForwards':sum(x.get('path')==MARKET for x in tls), 'clockProviderReads':sum(x.get('type')=='provider' and x.get('path')=='/v2/clock' for x in upstream), 'totalProviderReads':sum(x.get('type')=='provider' for x in upstream), 'homeTLSForwards':sum(x.get('path') in HOME for x in tls), 'homeGatewayRequests':sum(x.get('path') in HOME and not x.get('queryPresent') for x in gateway), 'homeBackendRequests':sum(x.get('path') in HOME for x in application)}
