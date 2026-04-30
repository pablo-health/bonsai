import chalk from 'chalk';

export function log(...args: unknown[]): void {
  console.log(...args);
}

export function dim(str: string): string {
  return chalk.dim(str);
}

export function bold(str: string): string {
  return chalk.bold(str);
}

export function error(msg: string): void {
  console.error(chalk.red(`  ✖ ${msg}`));
}

export function success(msg: string): void {
  console.log(chalk.green(`  ✔ ${msg}`));
}

export function info(msg: string): void {
  console.log(chalk.blue(`  ℹ ${msg}`));
}

// Table output
export function table(rows: string[][], headers: string[]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] ?? '').length))
  );

  // Ensure all rows have correct column count
  const paddedRows = rows.map(row => {
    while (row.length < headers.length) row.push('');
    return row;
  });

  function pad(str: string, width: number): string {
    const s = String(str);
    if (s.length >= width) return s.slice(0, width - 2) + chalk.dim('…');
    return s + ' '.repeat(width - s.length);
  }

  // Header row
  const headerLine = headers.map((h, i) => chalk.bold(pad(h, widths[i]))).join(' │ ');
  const separator = widths.map(w => '─'.repeat(w)).join('-+-');

  console.log(headerLine);
  console.log(separator);

  for (const row of paddedRows) {
    const line = row.map((cell, i) => pad(cell, widths[i])).join(' │ ');
    console.log(line);
  }
}

export function jsonOutput(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function truncate(str: string | undefined, maxLen = 50): string {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '…';
}
