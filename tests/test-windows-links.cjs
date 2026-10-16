const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const build = path.join(root, 'build');
fs.mkdirSync(build, { recursive: true });
const temp = fs.mkdtempSync(path.join(build, 'junction-'));
try {
  const target = path.join(temp, 'target');
  const link = path.join(temp, 'link');
  fs.mkdirSync(target); fs.mkdirSync(path.join(target, 'nested'));
  fs.writeFileSync(path.join(target, 'entry.cjs'), 'module.exports = 42');
  fs.symlinkSync(target, link, 'junction');
  require('../app/server/windows-realpath.cjs');
  assert.equal(fs.realpathSync(link).toLowerCase(), fs.realpathSync.native(target).toLowerCase());
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(link, { bigint: true }).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(path.join(link, 'nested')).isSymbolicLink(), false, 'Children of a junction are regular directories');
  assert.equal(path.resolve(fs.readlinkSync(link)).toLowerCase(), fs.realpathSync.native(target).toLowerCase());
  assert(Buffer.isBuffer(fs.readlinkSync(link, { encoding: 'buffer' })));
  assert.throws(() => fs.readlinkSync(target), { code: 'EINVAL' });
  assert.equal(require(path.join(link, 'entry.cjs')), 42);
  console.log('PASS: native Windows junction identity, link reads, normal directories and linked module loading');
} finally {
  assert(path.resolve(temp).startsWith(path.resolve(build) + path.sep));
  fs.rmSync(temp, { recursive: true, force: true });
}
