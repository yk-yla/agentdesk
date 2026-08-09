export class SingleFlight<T> {
  private currentPromise: Promise<T> | null = null;

  get active() {
    return this.currentPromise !== null;
  }

  get current() {
    return this.currentPromise;
  }

  run(factory: () => Promise<T>): Promise<T> {
    if (this.currentPromise) return this.currentPromise;
    const promise = Promise.resolve().then(factory);
    this.currentPromise = promise;
    void promise.finally(() => {
      if (this.currentPromise === promise) this.currentPromise = null;
    }).catch(() => undefined);
    return promise;
  }
}

export class CoalescingAsyncTask {
  private currentPromise: Promise<void> | null = null;
  private rerunRequested = false;

  request(task: () => Promise<void>): Promise<void> {
    if (this.currentPromise) {
      this.rerunRequested = true;
      return this.currentPromise;
    }
    const promise = (async () => {
      do {
        this.rerunRequested = false;
        await task();
      } while (this.rerunRequested);
    })();
    this.currentPromise = promise;
    void promise.finally(() => {
      if (this.currentPromise === promise) this.currentPromise = null;
    }).catch(() => undefined);
    return promise;
  }
}
