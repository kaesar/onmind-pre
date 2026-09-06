const colors = {
  red: "\x1b[38;2;255;20;60m", // errors
  yellow: "\x1b[33m", // warnings
  green: "\x1b[32m", // success
  blue: "\x1b[38;2;0;157;255m", // info
  reset: "\x1b[0m",
};

export function logError(message: string) {
  console.error(`${colors.red}${message}${colors.reset}`);
}

export function logWarning(message: string) {
  console.warn(`${colors.yellow}${message}${colors.reset}`);
}

export function logSuccess(message: string) {
  console.log(`${colors.green}${message}${colors.reset}`);
}

export function logInfo(message: string) {
  console.log(`${colors.blue}${message}${colors.reset}`);
}
