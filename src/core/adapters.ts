/** Adapters are trusted host extensions, never loaded from authored artwork. */
export type AdapterContext = { signal: AbortSignal; log: (message: string) => void };
export interface AdapterProbe { available: boolean; version?: string; reason?: string }
export interface SourceAdapter {
  id: string;
  probe(): Promise<AdapterProbe>;
  accepts(filename: string): boolean;
  /** Return a browser entry without modifying source. Never run package scripts. */
  prepare(source: string, context: AdapterContext): Promise<{ entry: string; dispose(): Promise<void> }>;
}
export interface RenderAdapter {
  id: string;
  probe(): Promise<AdapterProbe>;
  render(input: { source: string; width: number; height: number; time: number; seed: number }, context: AdapterContext): Promise<{ file: string; width: number; height: number }>;
}
export interface ExportAdapter {
  id: string;
  probe(): Promise<AdapterProbe>;
  /** Caller must obtain explicit user approval before launching an executable. */
  export(input: { source: string; destination: string }, context: AdapterContext): Promise<{ file: string; warnings: string[] }>;
}
