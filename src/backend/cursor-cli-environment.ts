export function childEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const exactNames = new Set([
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'SHELL',
    'USER',
    'LOGNAME',
    'NODE_COMPILE_CACHE',
  ]);
  for (const name of (source.CURSOR_BRIDGE_CHILD_ENV_ALLOW ?? '').split(',')) {
    const trimmed = name.trim();
    if (trimmed) exactNames.add(trimmed);
  }

  const result: NodeJS.ProcessEnv = { NO_COLOR: '1' };
  for (const [name, value] of Object.entries(source)) {
    const allowedPrefix =
      name.startsWith('XDG_') || (name.startsWith('CURSOR_') && !name.startsWith('CURSOR_BRIDGE_'));
    if (value !== undefined && (exactNames.has(name) || allowedPrefix)) result[name] = value;
  }
  return result;
}
