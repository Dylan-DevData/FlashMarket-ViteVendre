function write(level, message, details = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...details,
  };
  const output = level === 'error' ? process.stderr : process.stdout;
  output.write(`${JSON.stringify(record)}\n`);
}

module.exports = {
  info: (message, details) => write('info', message, details),
  warn: (message, details) => write('warn', message, details),
  error: (message, details) => write('error', message, details),
};
