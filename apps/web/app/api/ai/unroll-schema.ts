// Meta's Model API rejects JSON Schemas that are recursive ("Recursive JSON schemas are not
// currently supported") or nested deeper than 10 levels. AG Studio's built-in tools (execute_query,
// configure_widget, …) use deep and recursive definitions, so before forwarding a request the proxy
// rewrites each schema to a finite one of bounded depth:
//   - a $ref whose definition fits in the remaining depth stays a shared $ref (no size blow-up);
//   - otherwise the definition is inlined and the walk continues one level deeper;
//   - at the depth limit the subtree is replaced by an open schema ({}), and the tool is sent
//     non-strict. Studio still validates the arguments the model returns and reports issues back to
//     the model, so nothing invalid is ever applied.
type Json = Record<string, unknown>;

const CHILD_MAPS = ['properties', 'patternProperties', '$defs', 'definitions'];
const CHILD_LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];
const CHILD_ONE = ['items', 'additionalProperties', 'not', 'contains'];

const refName = (ref: string) => ref.split('/').pop()!;

/** Nesting depth of a schema node with refs followed (Infinity for recursion). */
function makeDepth(defs: Record<string, unknown>) {
  const memo = new Map<string, number>();
  const depthOf = (node: unknown, stack: string[]): number => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return 0;
    const n = node as Json;
    if (typeof n.$ref === 'string') {
      const name = refName(n.$ref);
      if (stack.includes(name)) return Infinity;
      if (memo.has(name)) return memo.get(name)!;
      const d = depthOf(defs[name], [...stack, name]);
      memo.set(name, d);
      return d;
    }
    let child = 0;
    for (const k of CHILD_MAPS) if (k !== '$defs' && k !== 'definitions' && n[k] && typeof n[k] === 'object') for (const v of Object.values(n[k] as Json)) child = Math.max(child, depthOf(v, stack));
    for (const k of CHILD_LISTS) if (Array.isArray(n[k])) for (const v of n[k] as unknown[]) child = Math.max(child, depthOf(v, stack));
    for (const k of CHILD_ONE) if (n[k] && typeof n[k] === 'object') child = Math.max(child, depthOf(n[k], stack));
    return 1 + child;
  };
  return depthOf;
}

export function schemaDepth(schema: Json): number {
  const defs = (schema.$defs ?? schema.definitions ?? {}) as Record<string, unknown>;
  return makeDepth(defs)(schema, []);
}

export function isRecursive(schema: unknown): boolean {
  return !!schema && typeof schema === 'object' && schemaDepth(schema as Json) === Infinity;
}

export function boundSchemaDepth(schema: Json, maxDepth = 8): { schema: Json; changed: boolean } {
  const defs = (schema.$defs ?? schema.definitions ?? {}) as Record<string, unknown>;
  const depthOf = makeDepth(defs);
  if (depthOf(schema, []) <= maxDepth) return { schema, changed: false };
  let changed = false;
  const keptDefs = new Set<string>();

  // `level` = depth of this node (root = 1).
  const walk = (node: unknown, level: number): unknown => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    const n = node as Json;
    if (level > maxDepth) {
      changed = true;
      return {};
    }
    if (typeof n.$ref === 'string') {
      const name = refName(n.$ref);
      if (level - 1 + depthOf(n, []) <= maxDepth) {
        keptDefs.add(name);
        return { $ref: `#/$defs/${name}` };
      }
      changed = true;
      const { $ref: _r, ...siblings } = n; // eslint-disable-line @typescript-eslint/no-unused-vars
      return { ...(walk(defs[name], level) as Json), ...siblings };
    }
    const out: Json = {};
    for (const [k, v] of Object.entries(n)) {
      if (k === '$defs' || k === 'definitions') continue;
      if (CHILD_MAPS.includes(k) && v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, walk(pv, level + 1)]));
      else if (CHILD_LISTS.includes(k) && Array.isArray(v)) out[k] = v.map((x) => walk(x, level + 1));
      else if (CHILD_ONE.includes(k) && v && typeof v === 'object') out[k] = walk(v, level + 1);
      else out[k] = v;
    }
    return out;
  };

  const root = walk(schema, 1) as Json;
  // Shared definitions referenced by kept $refs (and transitively by them) are copied as-is: they fit.
  const outDefs: Record<string, unknown> = {};
  const queue = [...keptDefs];
  while (queue.length) {
    const name = queue.pop()!;
    if (name in outDefs || !(name in defs)) continue;
    outDefs[name] = defs[name];
    JSON.stringify(defs[name]).replace(/"\$ref":"[^"]*\/([^"/]+)"/g, (_m, r) => (queue.push(r), ''));
  }
  // Rewrite #/definitions/X refs inside copied defs to #/$defs/X.
  const fixed = JSON.parse(JSON.stringify(outDefs).replace(/"#\/definitions\//g, '"#/$defs/'));
  return { schema: Object.keys(fixed).length ? { ...root, $defs: fixed } : root, changed };
}
