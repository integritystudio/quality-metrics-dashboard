#!/usr/bin/env npx tsx
"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Runs repomix --token-count-tree and writes docs/repomix/token-count-tree.txt
 */
var node_child_process_1 = require("node:child_process");
var node_fs_1 = require("node:fs");
var node_path_1 = require("node:path");
var ROOT = (0, node_path_1.resolve)(import.meta.dirname, '..');
var TREE_OUTPUT_PATH = (0, node_path_1.resolve)(ROOT, 'docs/repomix/token-count-tree.txt');
var REPOMIX_TIMEOUT_MS = 60000;
// Tree lines contain box-drawing connectors, not just horizontal dashes
var TREE_LINE_RE = /[│├└]/;
// NO_COLOR suppresses ANSI codes so no stripping is needed
var raw = (0, node_child_process_1.execSync)('npx repomix --token-count-tree --no-files -o /dev/null', {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: REPOMIX_TIMEOUT_MS,
    env: __assign(__assign({}, process.env), { NO_COLOR: '1' }),
});
var treeLines = raw.split('\n').filter(function (l) { return TREE_LINE_RE.test(l); });
if (treeLines.length === 0) {
    console.error('Could not find token count tree in repomix output');
    process.exit(1);
}
(0, node_fs_1.writeFileSync)(TREE_OUTPUT_PATH, treeLines.join('\n') + '\n');
