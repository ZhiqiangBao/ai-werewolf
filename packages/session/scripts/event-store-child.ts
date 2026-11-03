import { EventStorePrototype } from './event-store-prototype';
const [, , directory, mode] = process.argv;
const stop = () => { process.stdout.write('ready\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
const store = new EventStorePrototype(directory, undefined, mode === 'before-reply' ? stop : undefined);
store.commit('action-1', { set: { paused: true }, actions: [store.value().actions[0]] });
stop();
