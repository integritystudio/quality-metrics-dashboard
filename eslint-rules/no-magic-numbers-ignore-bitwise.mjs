import tseslint from 'typescript-eslint';

// Copy of the parent's `local/no-magic-numbers-ignore-bitwise` and
// `local/no-magic-numbers-ignore-fixtures` (inline in its eslint.config.cjs,
// not exported): `@typescript-eslint/no-magic-numbers` with operands of bitwise
// math exempt, and for test files also numbers written directly into a `const`
// object or array literal (fixture data). The fixture exemption is switched on
// by the config matching TEST_FILES, never by the rule sniffing the filename.

export const MAGIC_NUMBERS_RULE = 'no-magic-numbers-ignore-bitwise';
export const FIXTURE_MAGIC_NUMBERS_RULE = 'no-magic-numbers-ignore-fixtures';

export const MAGIC_NUMBERS_OPTIONS = {
  ignore: [0, 1, -1, 2, '0n', '-1n'],
  ignoreArrayIndexes: true,
  ignoreEnums: true,
  enforceConst: true,
};

const baseNoMagicNumbersRule = tseslint.plugin.rules['no-magic-numbers'];

const BITWISE_OPERATORS_BY_NODE_TYPE = new Map([
  ['BinaryExpression', new Set(['<<', '>>', '>>>', '|', '&', '^'])],
  ['AssignmentExpression', new Set(['<<=', '>>=', '>>>=', '|=', '&=', '^='])],
]);

const isBitwiseNode = node =>
  BITWISE_OPERATORS_BY_NODE_TYPE.get(node.type)?.has(node.operator) === true;

const isObjectOrArray = node =>
  node.type === 'ArrayExpression' || node.type === 'ObjectExpression';

// Structure a fixture literal may sit inside on the way up to its declarator:
// the collection itself, plus the wrappers TS and negative numbers add.
const FIXTURE_STRUCTURE_TYPES = new Set([
  'ArrayExpression',
  'ObjectExpression',
  'Property',
  'UnaryExpression',
  'BinaryExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
]);

const isCallArgument = (ancestor, child) =>
  ancestor.type === 'CallExpression' && ancestor.arguments.includes(child);

// Exempt numbers written directly into an object/array literal that is a `const`
// binding's initializer — not arbitrary literals in assertions or call
// arguments. Walking the ancestor chain tells those apart: in
// `const req = make({ ms: 5000 })` the object is the call's argument, not the
// declarator's initializer. A call argument counts only when the call is itself
// an element of such a collection (`const spans = [makeSpan({ ms: 500 })]`), so
// crossing a call resets the collection flag and one must be found above it.
const isInlineFixtureValue = (node, ancestors) => {
  let child = node;
  let insideCollection = false;

  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const ancestor = ancestors[i];

    if (FIXTURE_STRUCTURE_TYPES.has(ancestor.type)) {
      insideCollection = insideCollection || isObjectOrArray(ancestor);
      child = ancestor;
      continue;
    }

    if (isCallArgument(ancestor, child)) {
      insideCollection = false;
      child = ancestor;
      continue;
    }

    return (
      insideCollection &&
      ancestor.type === 'VariableDeclarator' &&
      ancestor.init === child &&
      ancestor.parent?.kind === 'const'
    );
  }

  return false;
};

const makeNoMagicNumbersRule = ({ allowInlineFixtures }) => ({
  meta: baseNoMagicNumbersRule.meta,
  create(context) {
    const baseListeners = baseNoMagicNumbersRule.create(context);

    const isExempt = (node) => {
      if (typeof node.value !== 'number' && typeof node.value !== 'bigint') {
        return false;
      }
      const ancestors = context.sourceCode.getAncestors(node);
      return (
        isBitwiseNode(node) ||
        ancestors.some(isBitwiseNode) ||
        (allowInlineFixtures && isInlineFixtureValue(node, ancestors))
      );
    };

    return {
      ...baseListeners,
      Literal(node) {
        if (!isExempt(node)) {
          baseListeners.Literal?.(node);
        }
      },
    };
  },
});

export const noMagicNumbersIgnoreBitwise = makeNoMagicNumbersRule({ allowInlineFixtures: false });
export const noMagicNumbersIgnoreFixtures = makeNoMagicNumbersRule({ allowInlineFixtures: true });

// One plugin object for every config block: flat config refuses to redefine
// `local` with a different object.
export const localPlugin = {
  rules: {
    [MAGIC_NUMBERS_RULE]: noMagicNumbersIgnoreBitwise,
    [FIXTURE_MAGIC_NUMBERS_RULE]: noMagicNumbersIgnoreFixtures,
  },
};
