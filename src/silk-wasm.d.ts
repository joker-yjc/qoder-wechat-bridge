/**
 * silk-wasm 的最小类型声明（包内未提供 "types" 字段）
 */
declare module 'silk-wasm' {
  export function encode(
    input: ArrayBufferView | ArrayBuffer,
    sampleRate: number,
  ): Promise<{ data: Uint8Array; duration: number }>;
  export function decode(
    input: ArrayBufferView | ArrayBuffer,
    sampleRate: number,
  ): Promise<{ data: Uint8Array; duration: number }>;
  export function getDuration(data: ArrayBufferView | ArrayBuffer, frameMs?: number): number;
  export function isWav(data: ArrayBufferView | ArrayBuffer): boolean;
  export function isSilk(data: ArrayBufferView | ArrayBuffer): boolean;
}
