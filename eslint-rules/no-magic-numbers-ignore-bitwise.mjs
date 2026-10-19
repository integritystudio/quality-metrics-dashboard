import tseslint from 'typescript-eslint';

// Copy of the parent's `local/no-magic-numbers-ignore-bitwise` (inline in its
// eslint.config.cjs, not exported): `@typescript-eslint/no-magic-numbers` with
// operands of bitwise math exempt. The parent's fixture variant is not copied.

export const MAGIC_NUMBERS_RULE = 'no-magic-numbers-ignore-bitwise';

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

export const noMagicNumbersIgnoreBitwise = {
  meta: baseNoMagicNumbersRule.meta,
  create(context) {
    const baseListeners = baseNoMagicNumbersRule.create(context);

    const isExempt = (node) => {
      if (typeof node.value !== 'number' && typeof node.value !== 'bigint') {
        return false;
      }
      return isBitwiseNode(node) || context.sourceCode.getAncestors(node).some(isBitwiseNode);
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
};
