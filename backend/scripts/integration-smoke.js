// SK OS — End-to-end integration smoke test
// Run: node test/integration-smoke.js (requires backend on port 4000)
const BASE = 'http://localhost:4000/api';

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
  const res = await fetch(BASE + path, { ...opts, headers, credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

let passed = 0, failed = 0;
function ok(condition, msg) {
  if (condition) { passed++; console.log('  OK ' + msg); }
  else { failed++; console.error('  FAIL ' + msg); }
}

// === HEALTH ===
console.log('\n--- HEALTH ---');
let r = await api('/health');
ok(r.status === 200 && r.data.ok, 'health 200');
r = await api('/ready');
ok(r.status === 200 && r.data.ok, 'ready 200');

// === SETUP ORG ===
console.log('\n--- ORG SETUP ---');
r = await api('/auth/setup-org', { method: 'POST', body: JSON.stringify({ orgName: 'Alpha Gym', ownerName: 'Owner A', email: 'alpha@test.com', password: 'pass1234', type: 'gym' }) });
if (r.status === 409) {
  console.log('  (org already exists from previous run — logging in)');
  r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'alpha@test.com', password: 'pass1234' }) });
  ok(r.status === 200, 'owner login (existing org) 200');
} else {
  ok(r.status === 201, 'setup-org 201, got ' + r.status);
}
const ownerToken = r.data.token;
ok(!!ownerToken, 'owner token received');
ok(r.data.user.role === 'GYM_OWNER', 'owner role GYM_OWNER');

// === OWNER LOGIN ===
console.log('\n--- OWNER LOGIN ---');
r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'alpha@test.com', password: 'pass1234' }) });
ok(r.status === 200 && r.data.token, 'owner login 200');
const ownerJwt = r.data.token;

r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'alpha@test.com', password: 'wrong' }) });
ok(r.status === 401, 'wrong password 401, got ' + r.status);

// === AUTH /ME ===
console.log('\n--- AUTH ---');
r = await api('/auth/me', { token: ownerJwt });
ok(r.status === 200 && r.data.user.role === 'GYM_OWNER', '/auth/me owner');

r = await api('/auth/me');
ok(r.status === 401, 'no token 401');

// === CREATE CLIENT ===
console.log('\n--- CREATE CLIENT ---');
r = await api('/clients', { method: 'POST', token: ownerJwt, body: JSON.stringify({ name: 'Alice', email: 'alice@test.com', password: 'pass1234', goal: 'FAT_LOSS', age: 28, height_cm: 170, start_weight: 80, target_weight: 70 }) });
let clientId;
if (r.status === 409) {
  console.log('  (client already exists — looking up)');
  const list = await api('/clients', { token: ownerJwt });
  const existing = (list.data.clients || []).find(c => c.email === 'alice@test.com');
  clientId = existing && existing.id;
  ok(!!clientId, 'found existing client id');
} else {
  ok(r.status === 201, 'create client 201, got ' + r.status);
  clientId = r.data.client && r.data.client.id;
  ok(!!clientId, 'client id returned');
}

// === OWNER DASHBOARD ===
console.log('\n--- OWNER DASHBOARD ---');
r = await api('/dashboard/overview', { token: ownerJwt });
ok(r.status === 200, 'overview 200, got ' + r.status);
ok(r.data.kpis, 'kpis present');

r = await api('/dashboard/attention', { token: ownerJwt });
ok(r.status === 200, 'attention 200');

r = await api('/dashboard/adherence-trend', { token: ownerJwt });
ok(r.status === 200, 'adherence-trend 200');

// === CLIENT LOGIN + ENDPOINTS ===
console.log('\n--- CLIENT ENDPOINTS ---');
r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'alice@test.com', password: 'pass1234' }) });
ok(r.status === 200, 'client login 200');
const clientToken = r.data.token;
ok(r.data.user.role === 'CLIENT', 'client role CLIENT');

const clientEndpoints = [
  ['GET', '/me/profile'],
  ['GET', '/tracking/me/home'],
  ['GET', '/tracking/me/today'],
  ['GET', '/tracking/me/week'],
  ['GET', '/tracking/me/workouts'],
  ['GET', '/tracking/me/progress'],
  ['GET', '/me/permissions'],
  ['GET', '/me/metrics'],
  ['GET', '/me/dashboard'],
  ['GET', '/me/foods'],
  ['GET', '/me/meals'],
  ['GET', '/me/crowd'],
  ['GET', '/me/nutrition/targets'],
  ['GET', '/workouts/exercises'],
  ['GET', '/me/foods/search?q=rice'],
  ['GET', '/intel/foods?q=chicken'],
];

for (const [method, path] of clientEndpoints) {
  r = await api(path, { method, token: clientToken });
  ok(r.status === 200, path + ' 200, got ' + r.status);
}

// === NUTRITION TARGETS ===
console.log('\n--- NUTRITION TARGETS ---');
r = await api('/me/nutrition/targets', { token: clientToken });
ok(r.status === 200, 'targets 200');
if (r.data.targets) {
  r = await api('/me/nutrition/targets/confirm', { method: 'POST', token: clientToken, body: JSON.stringify(r.data.targets) });
  ok(r.status === 200, 'confirm targets 200, got ' + r.status);
}

// === CUSTOM MEALS ===
console.log('\n--- CUSTOM MEALS ---');
r = await api('/me/meals', { method: 'POST', token: clientToken, body: JSON.stringify({ name: 'Test Meal', slot: 'Lunch', calories: 500, protein: 30, carbs: 60, fat: 15 }) });
ok(r.status === 200, 'create meal 200, got ' + r.status);
const mealId = r.data.id;
ok(!!mealId, 'meal id returned');

r = await api('/me/meals/' + mealId + '/items', { token: clientToken });
ok(r.status === 200, 'get meal items 200, got ' + r.status);

r = await api('/me/meals/' + mealId + '/log', { method: 'POST', token: clientToken, body: '{}' });
ok(r.status === 200, 'log meal 200, got ' + r.status);

r = await api('/tracking/me/home', { token: clientToken });
const customLogs = (r.data.nutrition && r.data.nutrition.customLogs) || [];
ok(customLogs.some(function(l) { return l.name === 'Test Meal'; }), 'test meal in today nutrition');

// === MEAL LOG EDIT/DELETE ===
console.log('\n--- MEAL LOG EDIT/DELETE ---');
r = await api('/me/meals', { method: 'POST', token: clientToken, body: JSON.stringify({ name: 'Editable Meal', slot: 'Dinner', calories: 600, protein: 40, carbs: 50, fat: 20 }) });
const editableMealId = r.data.id;
r = await api('/me/meals/' + editableMealId + '/log', { method: 'POST', token: clientToken, body: '{}' });
ok(r.status === 200, 'log editable meal 200');

r = await api('/tracking/me/home', { token: clientToken });
const editableLog = ((r.data.nutrition && r.data.nutrition.customLogs) || []).find(function(l) { return l.name === 'Editable Meal'; });
ok(!!editableLog, 'editable meal found');

if (editableLog) {
  r = await api('/me/meal-logs/' + editableLog.id, { method: 'PUT', token: clientToken, body: JSON.stringify({ quantity: 200 }) });
  ok(r.status === 200, 'edit log 200, got ' + r.status);
  r = await api('/me/meal-logs/' + editableLog.id, { method: 'DELETE', token: clientToken });
  ok(r.status === 200, 'delete log 200, got ' + r.status);
}

// === DELETE SAVED MEAL ===
console.log('\n--- DELETE SAVED MEAL ---');
r = await api('/me/meals/' + mealId, { method: 'DELETE', token: clientToken });
ok(r.status === 200, 'delete meal 200, got ' + r.status);

// === NUTRITION PLAN ===
console.log('\n--- NUTRITION PLAN ---');
r = await api('/nutrition/plans', { method: 'POST', token: ownerJwt, body: JSON.stringify({ name: 'Fat Loss', calories: 1800, protein: 150, carbs: 180, fat: 60, meals: [{ slot: 'breakfast', name: 'Breakfast', calories: 450, protein: 35, carbs: 45, fat: 15 }] }) });
ok(r.status === 201, 'create plan 201, got ' + r.status);
const planId = r.data.id;

r = await api('/nutrition/plans', { token: ownerJwt });
ok(r.status === 200, 'list plans 200');

r = await api('/nutrition/clients/' + clientId + '/plan/assign', { method: 'POST', token: ownerJwt, body: JSON.stringify({ plan_id: planId }) });
ok(r.status === 201, 'assign plan 201, got ' + r.status);

r = await api('/nutrition/clients/' + clientId + '/meals', { token: ownerJwt });
ok(r.status === 200, 'client meals 200');

// === INSIGHTS ===
console.log('\n--- INSIGHTS ---');
r = await api('/insights/clients/' + clientId, { token: ownerJwt });
ok(r.status === 200, 'insights 200');

r = await api('/insights/clients/' + clientId + '/analyze', { method: 'POST', token: ownerJwt, body: '{}' });
ok(r.status === 201, 'analyze 201, got ' + r.status);

// === MESSAGES ===
console.log('\n--- MESSAGES ---');
r = await api('/messages?client_id=' + clientId, { token: ownerJwt });
ok(r.status === 200, 'list messages 200');

r = await api('/messages', { method: 'POST', token: ownerJwt, body: JSON.stringify({ client_id: clientId, type: 'message', body: 'Hello!' }) });
ok(r.status === 201, 'send message 201, got ' + r.status);

// === WATER + WEIGHT ===
console.log('\n--- TRACKING ---');
r = await api('/tracking/clients/' + clientId + '/water', { method: 'POST', token: ownerJwt, body: JSON.stringify({ litres: 2.5 }) });
ok(r.status === 200, 'water 200, got ' + r.status);

r = await api('/clients/' + clientId + '/weights', { method: 'POST', token: ownerJwt, body: JSON.stringify({ weight: 79.5 }) });
ok(r.status === 201, 'weight 201, got ' + r.status);

r = await api('/clients/' + clientId + '/weights', { token: ownerJwt });
ok(r.status === 200, 'list weights 200');

// === CROSS-GYM ISOLATION ===
console.log('\n--- SECURITY ---');
r = await api('/auth/setup-org', { method: 'POST', body: JSON.stringify({ orgName: 'Beta Gym', ownerName: 'Owner B', email: 'beta@test.com', password: 'pass1234', type: 'gym' }) });
let betaToken = r.data && r.data.token;
if (!betaToken) {
  r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'beta@test.com', password: 'pass1234' }) });
  betaToken = r.data && r.data.token;
}

r = await api('/clients/' + clientId + '/overview', { token: betaToken });
ok(r.status === 403 || r.status === 404, 'cross-gym blocked ' + r.status);

r = await api('/dashboard/overview', { token: betaToken });
ok(r.status === 200, 'beta dashboard 200');
ok(r.data.kpis.activeClients === 0 || (r.data.clients && r.data.clients.length === 0), 'beta has no clients');

// Client role restrictions
r = await api('/dashboard/overview', { token: clientToken });
ok(r.status === 403, 'client blocked /dashboard/overview ' + r.status);

r = await api('/dashboard/trainer', { token: clientToken });
ok(r.status === 403, 'client blocked /dashboard/trainer ' + r.status);

r = await api('/business/overview', { token: clientToken });
ok(r.status === 403, 'client blocked /business/overview ' + r.status);

r = await api('/nutrition/plans', { token: clientToken });
ok(r.status === 403, 'client blocked /nutrition/plans ' + r.status);

r = await api('/alerts', { token: clientToken });
ok(r.status === 403, 'client blocked /alerts ' + r.status);

// === ADMIN ===
console.log('\n--- ADMIN ---');
r = await api('/business/overview', { token: ownerJwt });
ok(r.status === 200, 'business overview 200');

r = await api('/business/packages', { token: ownerJwt });
ok(r.status === 200, 'packages 200');

r = await api('/business/settings', { token: ownerJwt });
ok(r.status === 200, 'settings 200');

// === CLIENT SELF-SERVICE WORKOUT ===
console.log('\n--- CLIENT WORKOUT ---');
// First get a real exercise from the library
const exList = await api('/workouts/exercises', { token: clientToken });
const exId = (exList.data.exercises && exList.data.exercises[0] && exList.data.exercises[0].id) || 'ex_bench_press';
r = await api('/me/workouts', { method: 'POST', token: clientToken, body: JSON.stringify({ name: 'My Day', exercises: [{ exercise_id: exId, name: 'Test Exercise', sets: 3, reps: '10', weight: '60', rest_sec: 90 }] }) });
ok(r.status === 200, 'create workout 200, got ' + r.status);

r = await api('/me/workouts', { token: clientToken });
ok(r.status === 200, 'list workouts 200');

// === FOOD SEARCH + INTEL ===
console.log('\n--- FOOD + INTEL ---');
r = await api('/intel/parse-food', { method: 'POST', token: clientToken, body: JSON.stringify({ text: '150g paneer' }) });
ok(r.status === 200 || r.status === 422, 'parse-food ' + r.status);

r = await api('/intel/exercises?q=bench', { token: clientToken });
ok(r.status === 200, 'intel exercises 200');

// === SUMMARY ===
console.log('\n' + '='.repeat(50));
console.log('RESULTS: ' + passed + ' passed, ' + failed + ' failed');
console.log('='.repeat(50));
process.exit(failed > 0 ? 1 : 0);
