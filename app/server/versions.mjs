/** SemVer precedence: a release follows all prereleases; build metadata is ignored. */
export function compareVersions(a, b) {
  const parse = value => /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value));
  const left = parse(a), right = parse(b);
  if (!left || !right) return String(a).localeCompare(String(b), 'en', { numeric: true });
  for (let index = 1; index <= 3; index++) if (Number(left[index]) !== Number(right[index])) return Number(left[index]) - Number(right[index]);
  if (!left[4] || !right[4]) return left[4] ? -1 : right[4] ? 1 : 0;
  const lhs = left[4].split('.'), rhs = right[4].split('.');
  for (let index = 0; index < Math.max(lhs.length, rhs.length); index++) {
    if (lhs[index] === undefined || rhs[index] === undefined) return lhs[index] === undefined ? -1 : 1;
    if (lhs[index] === rhs[index]) continue;
    const ln = /^\d+$/.test(lhs[index]), rn = /^\d+$/.test(rhs[index]);
    if (ln && rn) return Number(lhs[index]) - Number(rhs[index]);
    if (ln !== rn) return ln ? -1 : 1;
    return lhs[index] < rhs[index] ? -1 : 1;
  }
  return 0;
}
