import pino from 'pino';

// Central logger. NEVER log message bodies, phone numbers, or auth state at
// info level. Redaction paths catch accidental leaks if a raw object is logged.
export function makeLogger(level = 'info') {
  return pino({
    level,
    base: undefined, // drop pid/hostname noise
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'text',
        '*.text',
        'body',
        '*.body',
        'to',
        'from',
        '*.to',
        '*.from',
        'creds',
        '*.creds',
        'auth',
        '*.auth',
        'message',
        '*.message',
        'qr',
        '*.qr',
      ],
      censor: '[redacted]',
    },
  });
}
