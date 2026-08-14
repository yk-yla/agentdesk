import type { DesktopPreferences } from "../shared/protocol";

interface PreferenceWriteTicket {
  versions: Map<keyof DesktopPreferences, number>;
}

export class PreferenceSaveCoordinator {
  private readonly versions = new Map<keyof DesktopPreferences, number>();

  begin(patch: Partial<DesktopPreferences>): PreferenceWriteTicket {
    const versions = new Map<keyof DesktopPreferences, number>();
    for (const key of Object.keys(patch) as Array<keyof DesktopPreferences>) {
      const version = (this.versions.get(key) || 0) + 1;
      this.versions.set(key, version);
      versions.set(key, version);
    }
    return { versions };
  }

  accept(ticket: PreferenceWriteTicket, snapshot: DesktopPreferences) {
    const accepted = Object.fromEntries([...ticket.versions.entries()]
      .filter(([key, version]) => this.versions.get(key) === version && snapshot[key] !== undefined)
      .map(([key]) => [key, snapshot[key]])) as Partial<DesktopPreferences>;
    return accepted;
  }
}
