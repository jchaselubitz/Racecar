import { describe, expect, it } from 'vitest';
import { banner, option, parseArgs, requireOption } from './index.js';

describe('@racecar/cli scaffold', () => {
  it('renders a banner that references core', () => {
    expect(banner()).toContain('@racecar/core');
  });
});

describe('parseArgs', () => {
  it('parses positionals, --key value, --key=value, and boolean flags', () => {
    const parsed = parseArgs(['git', '--host', 'github.com', '--token=abc', '--stdin', '--next']);
    expect(parsed.positional).toEqual(['git']);
    expect(option(parsed, 'host')).toBe('github.com');
    expect(option(parsed, 'token')).toBe('abc');
    expect(parsed.options.get('stdin')).toBe(true);
    expect(parsed.options.get('next')).toBe(true);
  });

  it('requireOption throws when an option is missing, option throws for a bare flag', () => {
    const parsed = parseArgs(['--flag']);
    expect(() => requireOption(parsed, 'token')).toThrow(/--token is required/);
    expect(() => option(parsed, 'flag')).toThrow(/--flag requires a value/);
  });
});
