export interface HistoricalSessionRestoreOptions<TResume, TRead> {
  resume(): Promise<TResume>;
  applyResume(value: TResume): void;
  read(): Promise<TRead>;
  applyRead(value: TRead): void;
}

export async function restoreHistoricalSession<TResume, TRead>(options: HistoricalSessionRestoreOptions<TResume, TRead>) {
  const resumeValue = await options.resume();
  options.applyResume(resumeValue);
  const readValue = await options.read();
  options.applyRead(readValue);
}
