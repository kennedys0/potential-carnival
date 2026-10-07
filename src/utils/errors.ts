export class LiveTradingDisabledError extends Error {
  constructor(message: string = 'Live trading is currently disabled via global configuration.') {
    super(message);
    this.name = 'LiveTradingDisabledError';
  }
}

export class KillSwitchActiveError extends Error {
  constructor(message: string = 'Trading kill-switch is currently active. New entries are rejected.') {
    super(message);
    this.name = 'KillSwitchActiveError';
  }
}
