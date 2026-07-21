import { type ConfigChangeEvent, configEventBus } from './config-event-bus.js';

export interface CliRuntimeProfileSubscriberOptions {
  onReload: (changedProfileIds: string[]) => Promise<void>;
  log: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
  };
}

export interface CliRuntimeProfileSubscriberHandle {
  unsubscribe(): void;
}

export function createCliRuntimeProfileSubscriber(
  options: CliRuntimeProfileSubscriberOptions,
): CliRuntimeProfileSubscriberHandle {
  let pending: Promise<void> = Promise.resolve();
  const listener = (event: ConfigChangeEvent): Promise<void> | void => {
    if (event.source !== 'cli-runtime-profiles') return;
    options.log.info(
      `[CliRuntimeProfileSubscriber] Profiles changed [${event.changedKeys.join(', ')}], syncing agent registry...`,
    );
    pending = pending
      .then(() => options.onReload(event.changedKeys))
      .catch((error) => options.log.warn('[CliRuntimeProfileSubscriber] Registry sync failed:', error));
    return pending;
  };
  const unsubscribe = configEventBus.onConfigChange(listener);
  return { unsubscribe };
}
