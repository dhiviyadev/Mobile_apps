/**
 * Text sanitising for user-provided strings (nicknames, chat).
 * The client always renders with textContent, so this is about keeping
 * strings short, printable and free of layout-breaking characters.
 */
import { CHAT_MAX_LENGTH, NICKNAME_MAX_LENGTH, NICKNAME_MIN_LENGTH } from '../constants';

// Control chars, zero-width / bidi overrides and other invisible formatting.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g;

/** Collapses whitespace and removes invisible characters. */
export function cleanText(input: unknown, maxLength: number): string {
  if (typeof input !== 'string') return '';
  return input.replace(/\s+/g, ' ').replace(INVISIBLE, '').trim().slice(0, maxLength);
}

/** Nicknames: letters (any script), digits, space, _ - . only. */
export function sanitizeNickname(input: unknown): string {
  const cleaned = cleanText(input, NICKNAME_MAX_LENGTH * 2)
    .replace(/[^\p{L}\p{N} _.\-]/gu, '')
    .trim()
    .slice(0, NICKNAME_MAX_LENGTH);
  return cleaned;
}

export function isValidNickname(input: unknown): boolean {
  const s = sanitizeNickname(input);
  return s.length >= NICKNAME_MIN_LENGTH && s === (typeof input === 'string' ? input.trim() : '');
}

/** Falls back to a generated guest name when the nickname is unusable. */
export function nicknameOrGuest(input: unknown, random: () => number = Math.random): string {
  const s = sanitizeNickname(input);
  if (s.length >= NICKNAME_MIN_LENGTH) return s;
  return `Guest${Math.floor(1000 + random() * 9000)}`;
}

export function sanitizeChat(input: unknown): string {
  return cleanText(input, CHAT_MAX_LENGTH);
}
