/** Content classes that are never dropped while pinned (spec: Compaction core, Pins). */
export const PIN_CLASSES = ['user', 'error', 'modify', 'boundary', 'decision', 'instruction'] as const;
export type PinClass = (typeof PIN_CLASSES)[number];
