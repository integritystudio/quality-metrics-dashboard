// Browser has native Worker — stub out the Node.js polyfill that elkjs optionally imports.
export default typeof Worker !== 'undefined' ? Worker : class {};
