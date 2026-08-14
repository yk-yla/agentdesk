export interface HistoricalSessionRestoreOptions<TResume, TRead> {
  resume(): Promise<TResume>;
  applyResume(value: TResume): void;
  read(): Promise<TRead>;
  applyRead(value: TRead): void;
}

export async function registerHistoricalWorkspace(registerWorkspace: (cwd: string) => Promise<string | null>, cwd: string) {
  const registeredCwd = await registerWorkspace(cwd);
  if (!registeredCwd) throw new Error("历史会话工作区不存在或未获授权。");
  return registeredCwd;
}

export async function restoreHistoricalSession<TResume, TRead>(options: HistoricalSessionRestoreOptions<TResume, TRead>) {
  const resumeValue = await options.resume();
  options.applyResume(resumeValue);
  const readValue = await options.read();
  options.applyRead(readValue);
}
