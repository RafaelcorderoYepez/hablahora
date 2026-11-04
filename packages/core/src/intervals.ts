/** Aritmética de intervalos semiabiertos [start, end) en epoch ms. */

export type Interval = readonly [number, number];

export function normalize(list: Interval[]): Interval[] {
  const sorted = list
    .filter(([a, b]) => b > a)
    .slice()
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function union(a: Interval[], b: Interval[]): Interval[] {
  return normalize([...a, ...b]);
}

export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const x = normalize(a);
  const y = normalize(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const start = Math.max(x[i][0], y[j][0]);
    const end = Math.min(x[i][1], y[j][1]);
    if (end > start) out.push([start, end]);
    if (x[i][1] < y[j][1]) i++;
    else j++;
  }
  return out;
}

export function subtract(a: Interval[], b: Interval[]): Interval[] {
  let result = normalize(a);
  for (const [bs, be] of normalize(b)) {
    const next: Interval[] = [];
    for (const [as, ae] of result) {
      if (be <= as || bs >= ae) {
        next.push([as, ae]);
        continue;
      }
      if (bs > as) next.push([as, bs]);
      if (be < ae) next.push([be, ae]);
    }
    result = next;
  }
  return result;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

/** ¿[s,e) cabe completo dentro de algún intervalo de la lista? */
export function containedIn(s: number, e: number, list: Interval[]): boolean {
  return list.some(([a, b]) => s >= a && e <= b);
}
