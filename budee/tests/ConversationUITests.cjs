const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../assets/index.html'), 'utf8');
const start = html.indexOf('  const conversationLog =');
const end = html.indexOf('  const clock =', start);
assert(start > 0 && end > start, 'Could not locate Buddy conversation controls');

class Element {
  constructor() { this.listeners = {}; this.dataset = {}; this.hidden = false; this.disabled = false; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  dispatch(name, event = {}) { this.listeners[name]?.({ preventDefault() {}, ...event }); }
  setPointerCapture() {}
  setAttribute() {}
  append() {}
}

const elements = Object.fromEntries([
  'conversation-log', 'conversation-status', 'conversation-form', 'conversation-input',
  'conversation-send', 'mic', 'conversation-cancel', 'conversation-progress',
].map(id => [id, new Element()]));
const actions = [];
let holdTimer;
const context = {
  document: { getElementById: id => elements[id], createElement: () => new Element(), createTextNode: () => ({}) },
  window: { webkit: { messageHandlers: { buddy: { postMessage: message => actions.push(message.action) } } } },
  setTimeout: fn => { holdTimer = fn; return 1; },
  clearTimeout: () => { holdTimer = null; },
};
vm.runInNewContext(html.slice(start, end), context);
const mic = elements.mic;
const reset = () => context.window.buddySetConversation({ phase: 'idle' });

mic.dispatch('pointerdown', { pointerId: 1, button: 0 });
assert.deepEqual(actions, ['micStart']);
mic.dispatch('pointerup', { pointerId: 1 });
mic.dispatch('click', { detail: 1 });
assert.deepEqual(actions, ['micStart', 'micStop'], 'Quick hold sends on release exactly once');

reset();
mic.dispatch('pointerdown', { pointerId: 2, button: 0 });
holdTimer();
mic.dispatch('pointerup', { pointerId: 2 });
mic.dispatch('click', { detail: 1 });
assert.equal(mic.textContent, 'Stop');
assert.deepEqual(actions, ['micStart', 'micStop', 'micStart'], 'Long hold stays recording after release');
mic.dispatch('click', { detail: 1 });
assert.equal(actions.at(-1), 'micStop', 'Stop submits sticky recording');

reset();
mic.dispatch('click', { detail: 0 });
assert.equal(actions.at(-1), 'micStart', 'Keyboard click starts sticky recording');
mic.dispatch('click', { detail: 0 });
assert.equal(actions.at(-1), 'micStop', 'Keyboard click stops sticky recording');

context.window.buddySetConversation({ phase: 'hermes' });
assert.equal(mic.disabled, true);
assert.equal(elements['conversation-send'].disabled, true);
assert.equal(elements['conversation-progress'].hidden, false);
elements['conversation-cancel'].dispatch('click');
assert.equal(actions.at(-1), 'cancel');
assert.equal(elements['conversation-cancel'].disabled, true);
reset();
assert.equal(elements['conversation-progress'].hidden, true);
assert.equal(elements['conversation-send'].disabled, false);
console.log('Buddy hold-to-talk and cancellation controls: passed');
