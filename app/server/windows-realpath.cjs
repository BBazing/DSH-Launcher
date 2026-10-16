// Windows junctions may contain a Global\ drive prefix. On this system the
// JavaScript realpath implementation keeps their logical path, while the native
// implementation resolves it correctly. Resolving module identities natively
// prevents a linked DSH profile from loading another package's hoisted version.
if (process.platform === 'win32') {
  const fs = require('node:fs');
  const path = require('node:path');
  const { syncBuiltinESMExports } = require('node:module');
  const original = fs.realpathSync;
  function realpathSync(file, options) {
    try { return original.native(file, options); }
    catch { return original(file, options); }
  }
  realpathSync.native = original.native;
  fs.realpathSync = realpathSync;
  const originalLstat = fs.lstatSync;
  const originalReadlink = fs.readlinkSync;
  function junctionTarget(file) {
    try {
      const filename = file instanceof URL ? require('node:url').fileURLToPath(file) : String(file);
      const expected = path.join(original.native(path.dirname(filename)), path.basename(filename));
      const actual = original.native(filename);
      return expected.toLowerCase() !== actual.toLowerCase() ? actual : null;
    } catch { return null; }
  }
  fs.lstatSync = function lstatSync(file, options) {
    const stat = originalLstat(file, options);
    if (stat && !stat.isSymbolicLink() && stat.isDirectory() && junctionTarget(file)) {
      stat.isSymbolicLink = () => true;
      stat.isDirectory = () => false;
    }
    return stat;
  };
  fs.readlinkSync = function readlinkSync(file, options) {
    try { return originalReadlink(file, options); }
    catch (error) {
      const target = error.code === 'EINVAL' ? junctionTarget(file) : null;
      if (!target) throw error;
      return options === 'buffer' || options?.encoding === 'buffer' ? Buffer.from(target) : target;
    }
  };
  syncBuiltinESMExports();
}
