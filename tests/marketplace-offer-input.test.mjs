import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offerCents } from '../public/js/marketplace-offer.js';
test('offer form accepts signed decimal dollars, not malformed or out-of-range input', () => {
  for (const [input, expected] of [['-12.50', -1250], ['-$1,000.01', -100001], ['-0.01', -1], ['12.50',1250], ['0',0], ['',null], ['-10000000', -1000000000]]) assert.equal(offerCents(input), expected);
  for (const input of ['-', '1.005', '-1.005', '1e3', 'Infinity', '-10000000.01', '10000000.01']) assert.ok(Number.isNaN(offerCents(input)), input);
});
