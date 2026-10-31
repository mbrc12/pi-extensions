import { EventEmitter } from "node:events";

/** A synchronous test bus matching Pi's extension event delivery. */
export function testEventBus() {
	const emitter = new EventEmitter();
	return {
		emit: (name: string, data: unknown) => { emitter.emit(name, data); },
		on: (name: string, handler: (data: unknown) => void) => {
			emitter.on(name, handler);
			return () => { emitter.off(name, handler); };
		},
	};
}
