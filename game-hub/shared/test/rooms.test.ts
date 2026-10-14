import { describe, expect, it } from 'vitest';
import {
  generateRoomCode,
  isValidRoomCode,
  mulberry32,
  nicknameOrGuest,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  sanitizeChat,
  sanitizeNickname,
  TokenBucket,
} from '../src';

describe('room codes', () => {
  it('generates valid 6-char codes from the unambiguous alphabet', () => {
    const rnd = mulberry32(1);
    for (let i = 0; i < 500; i++) {
      const code = generateRoomCode(rnd);
      expect(code).toHaveLength(6);
      expect(isValidRoomCode(code)).toBe(true);
      for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch);
    }
  });

  it('normalises user input', () => {
    expect(normalizeRoomCode(' ab-c 12x9 ')).toBe('ABC12X');
    expect(isValidRoomCode('ABC12X')).toBe(false); // contains 1
    expect(isValidRoomCode('ABC23X')).toBe(true);
    expect(isValidRoomCode('ABCD')).toBe(false);
  });
});

describe('text sanitising', () => {
  it('cleans nicknames', () => {
    expect(sanitizeNickname('  Ada​ Lovelace!! ')).toBe('Ada Lovelace');
    expect(sanitizeNickname('<script>')).toBe('script');
    expect(sanitizeNickname('x'.repeat(40))).toHaveLength(16);
    expect(sanitizeNickname('Zoë_99')).toBe('Zoë_99');
  });

  it('falls back to a guest name', () => {
    expect(nicknameOrGuest('', () => 0.5)).toBe('Guest5500');
    expect(nicknameOrGuest('Bo')).toBe('Bo');
  });

  it('cleans chat', () => {
    expect(sanitizeChat('hi\n\nthere\u0007')).toBe('hi there');
    expect(sanitizeChat('a'.repeat(500)).length).toBe(120);
    expect(sanitizeChat(42)).toBe('');
  });
});

describe('TokenBucket', () => {
  it('allows bursts then throttles and refills', () => {
    const b = new TokenBucket(3, 1, 0);
    expect(b.take(1, 0)).toBe(true);
    expect(b.take(1, 0)).toBe(true);
    expect(b.take(1, 0)).toBe(true);
    expect(b.take(1, 0)).toBe(false);
    expect(b.take(1, 500)).toBe(false);
    expect(b.take(1, 1100)).toBe(true);
  });
});

describe('mulberry32', () => {
  it('is deterministic', () => {
    const a = mulberry32(99);
    const b = mulberry32(99);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });
});
