import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** 同 DSH CLI：有 dsh.bundle.patch 的依赖加入层栈，已移除的依赖离开层栈。 */
export function reconcileBundles(before, after, profileDir, runtimeBin) {
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}));
  const deps = Object.keys(after.dependencies ?? {});
  const bundles = [...(after.dsh?.profile?.bundles ?? [])];
  const anchors = [path.join(profileDir, 'package.json'), runtimeBin].filter(Boolean);
  const hasBundle = (name) => {
    for (const anchor of anchors) {
      const require = createRequire(anchor);
      for (const base of require.resolve.paths(name) ?? []) {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(base, name, 'package.json'), 'utf8'));
          return pkg.dsh?.bundle?.patch !== undefined;
        } catch { /* 下一个解析路径 */ }
      }
    }
    return false;
  };
  const status = new Map(deps.map((name) => [name, hasBundle(name)]));
  const next = bundles.filter((name) => !beforeDeps.has(name) && !deps.includes(name) || status.get(name));
  for (const name of deps) if (status.get(name) && !next.includes(name)) next.push(name);
  return { ...after, dsh: { ...after.dsh, profile: { ...after.dsh?.profile, bundles: next } } };
}
