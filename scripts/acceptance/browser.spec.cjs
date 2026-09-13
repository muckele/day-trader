const {test,expect}=require('../../frontend/node_modules/@playwright/test');
const {startHarness}=require('./harness.cjs');
let h;
test.beforeEach(async()=>{h=await startHarness();});
test.afterEach(async()=>{if(h)await h.close();});
async function login(page){await page.goto(h.baseURL+'/login');await page.getByPlaceholder('Username').fill('acceptance-owner');await page.getByPlaceholder('Password').fill('local-test-password');await page.getByRole('button',{name:'Log In',exact:true}).click();await expect(page).toHaveURL(h.baseURL+'/');}
test('real owner login, protected portfolio and persisted server logout revocation',async({page,context})=>{
 await page.goto(h.baseURL+'/portfolio');await expect(page).toHaveURL(/\/login$/);
 await login(page);await page.goto(h.baseURL+'/portfolio');await expect(page.getByRole('heading',{name:'Alpaca Paper',exact:true})).toBeVisible();
 const cookies=await context.cookies();
 const logout=await context.request.post(h.baseURL+'/api/logout',{headers:{origin:h.baseURL}});expect(logout.status()).toBe(200);
 await context.addCookies(cookies);await page.reload();await expect(page).toHaveURL(/\/login$/);
 const reg=await context.request.post(h.baseURL+'/api/register',{headers:{origin:h.baseURL},data:{username:'intruder',password:'not-allowed'}});expect(reg.status()).toBe(403);
});
test('pre-existing non-owner cannot log in through the actual form',async({page})=>{
 await page.goto(h.baseURL+'/login');await page.getByPlaceholder('Username').fill('other-user');await page.getByPlaceholder('Password').fill('other-password');await page.getByRole('button',{name:'Log In',exact:true}).click();await expect(page.getByText('Invalid credentials')).toBeVisible();expect(h.provider.state.posts).toHaveLength(0);
});
function field(page, label) { return page.locator('label').filter({hasText:label}).locator('xpath=following-sibling::input[1]'); }
async function ticket(page,qty=4){
 await page.goto(h.baseURL+'/stock/AAPL');
 await page.getByRole('button',{name:'Limit',exact:true}).click();
 await field(page,'Quantity').fill(String(qty));await field(page,'Limit Price ($)').fill('100');
 await page.getByLabel('Allow extended-hours fills when market is closed').uncheck();
 await page.getByRole('button',{name:'Review Paper Trade'}).click();
 const response=page.waitForResponse(r=>r.url().endsWith('/api/paper-trades/order')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Confirm',exact:true}).click();await response;
}
test('manual acknowledgement, partial/final fill, accounting and reload through real services',async({page})=>{
 await login(page);await ticket(page);
 await expect.poll(()=>h.provider.state.posts.length).toBe(1);
 await expect(page.getByTestId('paper-intent-status')).toContainText('acknowledged');
 const order=h.provider.state.orders[0];await h.control({fill:{id:order.id,qty:2,price:100}});await h.run('reconcile');
 await page.goto(h.baseURL+'/activity');await expect(page.getByText('Queued',{exact:true}).first()).toBeVisible();await expect(page.getByText('partially_filled',{exact:false}).first()).toBeVisible();
 await h.control({fill:{id:order.id,qty:4,price:100}});await h.run('reconcile');
 await page.goto(h.baseURL+'/portfolio');await expect(page.getByRole('heading',{name:'Alpaca Paper',exact:true})).toBeVisible();
 await page.reload();await expect(page.getByText('AAPL',{exact:true}).first()).toBeVisible();await expect(page.getByRole('row').filter({hasText:'AAPL'}).getByRole('cell',{name:'4',exact:true})).toBeVisible();
 const Intent=require('../../backend/models/OrderIntent');expect((await Intent.findOne({origin:'manual'})).filledQty).toBe(4);
 const Bucket=require('../../backend/models/SpendingBucket');expect((await Bucket.findOne({accountId:'acceptance-paper',period:'day'})).spentCents).toBe(40000);
 const Fill=require('../../backend/models/Fill');expect(await Fill.countDocuments({executionSource:'alpaca-paper'})).toBe(2);
 expect(h.provider.state.posts).toHaveLength(1);
});

test('accepted timeout reload and retry preserve one logical order, deliberate identical action creates another',async({page})=>{
 await h.control({patch:{mode:'timeout'}});await login(page);await ticket(page,1);
 await expect(page.getByTestId('paper-intent-status')).toContainText('confirmation pending');expect(h.provider.state.posts).toHaveLength(1);
 await page.reload();await expect(page.getByTestId('paper-intent-status')).toContainText('confirmation pending');
 await page.getByRole('button',{name:'Retry same order',exact:true}).click();expect(h.provider.state.posts).toHaveLength(1);
 await h.run('reconcile');await page.getByRole('button',{name:'Refresh order status',exact:true}).click();await expect(page.getByTestId('paper-intent-status')).toContainText('acknowledged');
 const order=h.provider.state.orders[0];await h.control({fill:{id:order.id,qty:1}});await h.run('reconcile');
 await page.getByRole('button',{name:'Refresh order status',exact:true}).click();await expect(page.getByTestId('paper-intent-status')).toContainText('trade filled');
 await page.getByRole('button',{name:'Prepare another identical order',exact:true}).click();expect(h.provider.state.posts).toHaveLength(1);
 await h.control({patch:{mode:'acknowledge'}});await page.getByRole('button',{name:'Submit prepared order',exact:true}).click();
 await expect.poll(()=>h.provider.state.posts.length).toBe(2);expect(h.provider.state.posts[0].client_order_id).not.toBe(h.provider.state.posts[1].client_order_id);
});
test('broker rejection is persisted and displayed without fabricated fill',async({page})=>{
 await h.control({patch:{mode:'reject'}});await login(page);await ticket(page,1);await expect(page.getByTestId('paper-intent-status')).toContainText('rejected');
 expect(h.provider.state.orders).toHaveLength(0);const Fill=require('../../backend/models/Fill');expect(await Fill.countDocuments({executionSource:'alpaca-paper'})).toBe(0);
});
test('partial fill then broker cancellation retains only confirmed spending and shows canceled remainder',async({page})=>{
 await login(page);await ticket(page,4);const o=h.provider.state.orders[0];await h.control({fill:{id:o.id,qty:2}});await h.run('reconcile');
 await h.control({orderStatus:{id:o.id,status:'canceled'}});await h.run('reconcile');await page.getByRole('button',{name:'Refresh order status',exact:true}).click();await expect(page.getByTestId('paper-intent-status')).toContainText('canceled');
 const Capacity=require('../../backend/models/AccountCapacity');const c=await Capacity.findOne({accountId:'acceptance-paper'});expect(c.reservedCents).toBe(0);expect(c.spentCents).toBe(20000);
});
test('coordinated browser close cancels only owned stop, confirms, then submits bounded exit',async({page})=>{
 await login(page);await page.goto(h.baseURL+'/stock/AAPL');await page.getByRole('button',{name:'Limit',exact:true}).click();await field(page,'Quantity').fill('2');await field(page,'Limit Price ($)').fill('100');await field(page,'Stop-Loss Price ($)').fill('90');await page.getByLabel('Allow extended-hours fills when market is closed').uncheck();
 await page.getByRole('button',{name:'Review Paper Trade'}).click();const response=page.waitForResponse(r=>r.url().endsWith('/api/paper-trades/order'));await page.getByRole('button',{name:'Confirm',exact:true}).click();await response;
 const entry=h.provider.state.orders[0];await h.control({fill:{id:entry.id,qty:2}});await h.run('reconcile');expect(h.provider.state.posts).toHaveLength(2);
 const stop=h.provider.state.orders.find(o=>o.type==='stop');expect(stop.qty).toBe('2');
 await page.goto(h.baseURL+'/portfolio');await page.getByRole('button',{name:'Review close AAPL'}).click();await page.getByRole('button',{name:'Confirm coordinated close'}).click();
 await expect.poll(()=>h.provider.state.posts.length).toBe(3);expect(stop.status).toBe('canceled');const close=h.provider.state.orders.find(o=>o.side==='sell'&&o.type==='market');expect(close.qty).toBe('2');
 await h.control({fill:{id:close.id,qty:2}});await h.run('reconcile');await page.getByRole('button',{name:'Refresh close status'}).click();await expect(page.getByTestId('position-close-status')).toContainText('filled');
});
test('core pages render authentic empty/provider data and provider outage stays explicit',async({page})=>{
 await login(page);
 for(const path of ['/watchlist','/stock/AAPL','/research/AAPL','/plan','/portfolio','/activity','/analytics','/robo','/trading-system']){
  await page.goto(h.baseURL+path);await expect(page.locator('main')).toBeVisible();await expect(page.locator('main')).not.toBeEmpty();await expect(page.getByRole('button',{name:'Sign Out'})).toBeVisible();
 }
 await h.control({patch:{unavailable:true}});await page.goto(h.baseURL+'/portfolio');await expect(page.getByRole('button',{name:'Retry',exact:true}).first()).toBeVisible();await expect(page.getByRole('heading',{name:'Alpaca Paper',exact:true})).toHaveCount(0);
});

test('real issued session expiration redirects browser without retaining portfolio',async({page})=>{
 await login(page);await page.goto(h.baseURL+'/portfolio');await expect(page.getByRole('heading',{name:'Alpaca Paper',exact:true})).toBeVisible();
 await h.advanceServerClock(3601000);await page.reload();await expect(page).toHaveURL(/\/login$/);await expect(page.getByRole('heading',{name:'Alpaca Paper',exact:true})).toHaveCount(0);
});

test('research workflow distinguishes recommendation from execution and shares spending',async({page})=>{
 await h.control({patch:{trend:true}});await login(page);await page.goto(h.baseURL+'/research/AAPL');await expect(page.getByText(/Research generated/)).toBeVisible();await expect(page.getByText('alpaca_daily_bars',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Trade',exact:true}).click();
 await page.getByLabel('Quantity',{exact:true}).fill('1');await page.getByLabel('Limit Price',{exact:true}).fill('100');
 await page.getByRole('button',{name:'Preview risk',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Eligible for paper execution',exact:true})).toBeVisible();expect(h.provider.state.posts).toHaveLength(0);
 await page.getByRole('button',{name:'Submit Paper Trade',exact:true}).click();await expect.poll(()=>h.provider.state.posts.length).toBe(1);
 await expect(page.getByTestId('paper-intent-status')).toContainText('acknowledged');const Intent=require('../../backend/models/OrderIntent');const intent=await Intent.findOne({origin:'research'});expect(intent.reservedCents).toBe(10000);
});

test('rapid double click produces one durable intent and one broker POST',async({page})=>{
 await h.control({patch:{delayAckMs:250}});await login(page);await page.goto(h.baseURL+'/stock/AAPL');
 await page.getByRole('button',{name:'Limit',exact:true}).click();await field(page,'Quantity').fill('1');await field(page,'Limit Price ($)').fill('100');await page.getByLabel('Allow extended-hours fills when market is closed').uncheck();
 await page.getByRole('button',{name:'Review Paper Trade'}).click();await page.getByRole('button',{name:'Confirm',exact:true}).dblclick();
 await expect(page.getByTestId('paper-intent-status')).toContainText('acknowledged');expect(h.provider.state.posts).toHaveLength(1);
 const Intent=require('../../backend/models/OrderIntent');expect(await Intent.countDocuments()).toBe(1);
});

test('unfilled canceled order releases reservation and displays zero fills',async({page})=>{
 await login(page);await ticket(page,1);await h.control({orderStatus:{id:h.provider.state.orders[0].id,status:'canceled'}});await h.run('reconcile');
 await page.getByRole('button',{name:'Refresh order status',exact:true}).click();await expect(page.getByTestId('paper-intent-status')).toContainText('canceled');
 const Capacity=require('../../backend/models/AccountCapacity');const c=await Capacity.findOne({accountId:'acceptance-paper'});expect(c.reservedCents).toBe(0);expect(c.spentCents).toBe(0);
 const Fill=require('../../backend/models/Fill');expect(await Fill.countDocuments()).toBe(0);
});

test('uncertain protection cancellation remains visible and blocks overlapping close submission',async({page})=>{
 await login(page);await page.goto(h.baseURL+'/stock/AAPL');await page.getByRole('button',{name:'Limit',exact:true}).click();await field(page,'Quantity').fill('2');await field(page,'Limit Price ($)').fill('100');await field(page,'Stop-Loss Price ($)').fill('90');await page.getByLabel('Allow extended-hours fills when market is closed').uncheck();
 await page.getByRole('button',{name:'Review Paper Trade'}).click();const response=page.waitForResponse(r=>r.url().endsWith('/api/paper-trades/order'));await page.getByRole('button',{name:'Confirm',exact:true}).click();await response;
 await h.control({fill:{id:h.provider.state.orders[0].id,qty:2}});await h.run('reconcile');const stop=h.provider.state.orders.find(o=>o.type==='stop');
 await h.control({patch:{cancelUncertain:true}});await page.goto(h.baseURL+'/portfolio');await page.getByRole('button',{name:'Review close AAPL'}).click();await page.getByRole('button',{name:'Confirm coordinated close'}).click();
 await expect(page.getByTestId('position-close-status')).toContainText('cancel');await expect(page.getByRole('button',{name:'Retry coordinated close'})).toBeEnabled();expect(h.provider.state.posts).toHaveLength(2);
 await page.getByRole('button',{name:'Retry coordinated close'}).click();await expect(page.getByRole('button',{name:'Retry coordinated close'})).toBeEnabled();expect(h.provider.state.posts).toHaveLength(2);
 await page.reload();await page.getByRole('button',{name:'Review close AAPL'}).click();await expect(page.getByTestId('position-close-status')).toContainText('cancel');
 await h.control({patch:{cancelUncertain:false},orderStatus:{id:stop.id,status:'canceled'}});await page.getByRole('button',{name:'Retry coordinated close'}).click();await expect.poll(()=>h.provider.state.posts.length).toBe(3);
 const Close=require('../../backend/models/PositionClose');expect(await Close.countDocuments()).toBe(1);expect(h.provider.state.posts[2].qty).toBe('2');
});

test('confirmed admission rejection permits a corrected ticket without weakening retry identity',async({page})=>{
 await login(page);await ticket(page,11);await expect(page.getByTestId('paper-intent-status')).toContainText('rejected');expect(h.provider.state.posts).toHaveLength(0);
 const Intent=require('../../backend/models/OrderIntent');const rejected=await Intent.findOne();expect(rejected.status).toBe('rejected');
 await ticket(page,1);await expect(page.getByTestId('paper-intent-status')).toContainText('acknowledged');expect(h.provider.state.posts).toHaveLength(1);
 const accepted=await Intent.findOne({status:'acknowledged'});expect(accepted.idempotencyKey).not.toBe(rejected.idempotencyKey);
});
