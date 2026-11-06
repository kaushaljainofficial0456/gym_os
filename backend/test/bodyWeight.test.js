// Every schema that stores a body weight shares one rule (validate.js
// bodyWeight): 20-500 kg, rounded to two decimals. Found live: a member
// logging in pounds stored 0.181436948 kg and 45.31387776300001 kg through
// the measurement route, which took anything positive, and the coach's
// profile screen showed "45.31387776300001 CURRENT KG".
import test from 'node:test';
import assert from 'node:assert/strict';
import { schemas } from '../src/validate.js';

test('a body weight is rounded to two decimals wherever it is stored', () => {
  for (const name of ['weightLog', 'measurement', 'measurementUpdate']) {
    const r = schemas[name].safeParse({ weight: 45.31387776300001 });
    assert.equal(r.success, true, `${name}: ${JSON.stringify(r.error?.issues)}`);
    assert.equal(r.data.weight, 45.31, name);
  }
  const created = schemas.clientCreate.safeParse({ name: 'A', email: 'a@b.in', password: 'secret1', start_weight: 80.004, target_weight: 72.456 });
  assert.equal(created.success, true, JSON.stringify(created.error?.issues));
  assert.deepEqual([created.data.start_weight, created.data.target_weight], [80, 72.46]);
});

test('an impossible body weight (a unit mix-up) is refused on every route, not only the weight log', () => {
  for (const name of ['weightLog', 'measurement', 'measurementUpdate', 'measurementPatch']) {
    const r = schemas[name].safeParse({ weight: 0.18143694800000001 });
    assert.equal(r.success, false, `${name} accepted 0.18 kg`);
  }
  assert.equal(schemas.measurementPatch.safeParse({ weight: null }).success, true, 'clearing a weight still works');
});
