import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { bookingParams, studentParams, passDescription, param, inr } = require('./src/lib/whatsapp.js');

let pass = 0, fail = 0;
const check = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};
const texts = a => a.map(p => p.text);

const event = {
  name: 'Youth Festival',
  dates: { display: 'Sunday, 13 September · 7:00 AM' },
  timing: 'Early morning · 7 AM to 12 PM',
  venue: 'Hare Krishna Vaikuntham, Visakhapatnam',
  tickets: [
    { key: 'general', name: 'General' },
    { key: 'student', name: 'Student' },
    { key: 'vip', name: 'VIP Darshan' },
    { key: 'couple', name: 'Couple' },
  ],
};

console.log('\n1) booking template: 8 slots, correct order, nothing empty');
{
  const row = { name: 'Ravi Kumar', ref: 'YJ-A1B2C3', total: 297,
    raw: { tickets: { general: 2, vip: 1 } } };
  const t = texts(bookingParams(row, event));
  check('exactly 8 parameters', t.length === 8, t.length);
  check('{{1}} name', t[0] === 'Ravi Kumar', t[0]);
  check('{{2}} event name', t[1] === 'Youth Festival', t[1]);
  check('{{3}} ref', t[2] === 'YJ-A1B2C3', t[2]);
  check('{{4}} passes use event tier names', t[3] === 'General × 2, VIP Darshan × 1', t[3]);
  check('{{5}} amount formatted', t[4] === '₹297', t[4]);
  check('{{6}} date', t[5] === 'Sunday, 13 September · 7:00 AM', t[5]);
  check('{{7}} timing', t[6] === 'Early morning · 7 AM to 12 PM', t[6]);
  check('{{8}} venue', t[7] === 'Hare Krishna Vaikuntham, Visakhapatnam', t[7]);
  check('no empty parameter', t.every(x => x.length > 0), JSON.stringify(t));
}

console.log('\n2) the bug this fixes: custom tiers used to render as "Pass"');
{
  const row = { raw: { tickets: { couple: 1 } } };
  check('couple tier named', passDescription(row, event) === 'Couple × 1', passDescription(row, event));
  const unknown = { raw: { tickets: { earlybird: 3 } } };
  check('unknown key still readable', passDescription(unknown, event) === 'Earlybird × 3', passDescription(unknown, event));
  check('zero counts skipped', passDescription({ raw: { tickets: { general: 0, student: 2 } } }, event) === 'Student × 2');
  check('legacy row falls back to qty fields',
    passDescription({ qty_general: 1, qty_student: 1 }, event) === 'General × 1, Student × 1');
}

console.log('\n3) a sparse event never produces an empty slot (Meta rejects those)');
{
  const bare = { name: 'Ramayana Circuit' };
  const t = texts(bookingParams({ ref: 'RC-XYZ' }, bare));
  check('still 8 parameters', t.length === 8, t.length);
  check('no empty parameter', t.every(x => x.length > 0), JSON.stringify(t));
  check('missing date -> fallback', t[5] === 'To be shared', t[5]);
  check('missing venue -> fallback', t[7] === 'To be shared', t[7]);
  check('missing name -> Devotee', t[0] === 'Devotee', t[0]);
  const none = texts(bookingParams({}, null));
  check('totally empty input is still sendable', none.length === 8 && none.every(x => x.length > 0), JSON.stringify(none));
}

console.log('\n4) parameter sanitising (Meta rejects newlines / tabs / 4+ spaces)');
{
  check('newlines collapsed', param('Hare\nKrishna') === 'Hare Krishna', JSON.stringify(param('Hare\nKrishna')));
  check('tabs collapsed', param('a\tb') === 'a b', JSON.stringify(param('a\tb')));
  check('4+ spaces reduced', !/ {4,}/.test(param('a      b')), JSON.stringify(param('a      b')));
  check('whitespace-only -> fallback', param('   ') === 'To be shared', param('   '));
  check('non-numeric amount -> fallback', inr('abc') === 'To be shared', inr('abc'));
  check('large amount grouped', inr(129900) === '₹1,29,900', inr(129900));
}

console.log('\n5) student templates: 4 slots each, event named in both');
{
  const row = { name: 'Anita', ref: 'YJ-STU001' };
  const ok = texts(studentParams(row, event, { approved: true }));
  check('approved has 4 params', ok.length === 4, ok.length);
  check('approved {{2}} is event', ok[1] === 'Youth Festival', ok[1]);
  check('approved {{4}} is date', ok[3] === 'Sunday, 13 September · 7:00 AM', ok[3]);

  const no = texts(studentParams(row, event, { approved: false, reason: 'Photo was blurred' }));
  check('rejected has 4 params', no.length === 4, no.length);
  check('rejected {{4}} is reason', no[3] === 'Photo was blurred', no[3]);
  const noReason = texts(studentParams(row, event, { approved: false }));
  check('rejected without reason still fine', noReason[3].length > 0, noReason[3]);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
