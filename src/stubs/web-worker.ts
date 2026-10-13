// Browser has native Worker — stub out the Node.js polyfill that elkjs optionally imports.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- placeholder constructor; elkjs never instantiates it in the browser
export default typeof Worker !== 'undefined' ? Worker : class {};
