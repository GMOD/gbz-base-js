export interface ByteSource {
  read(length: number, position: number): Promise<Uint8Array>
  stat(): Promise<{ size: number }>
}
